import { eq } from 'drizzle-orm';
import { nodes, workloads } from '@yoal/db';
import {
	rebalanceRequestSchema,
	workloadMoveRequestSchema,
	type ClusterConfig,
	type PackingStrategy,
	type Principal,
	type RebalanceResult,
	type SchedulingMoveView,
	type SchedulingPlanView,
	type SchedulingView,
	type WorkloadMoveResult,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { planRebalance, type BalancePlan } from './rebalance.ts';
import { parseJson } from './util.ts';
import type { ReplicaCopy } from './workloads.ts';

export const SCHEDULING_AUTO_KEY = 'scheduling:last_auto_move';

/**
 * Fleet scheduling (docs/CLUSTERING.md §3.10, D214).
 *
 * Placement is still one recorded decision per copy, but it is no longer final: this service
 * shows how full each node is, plans the moves that would even the fleet out (or pack it), and
 * applies them through the same admission and move path a drain uses. Every move it starts is
 * tracked by the failover controller, which completes it, times it out or rolls it back.
 */
export class SchedulingService {
	constructor(private readonly ctx: CoreContext) {}

	view(principal: Principal): SchedulingView {
		if (!this.ctx.platformIam.canView(principal))
			throw new CoreError('forbidden', 'Platform admin permission required.', 403);
		const config = this.ctx.cluster.get().scheduling;
		const snapshot = this.ctx.workloads.balanceSnapshot();
		const plan = this.#plan(config.strategy, snapshot);
		const rows = new Map(this.ctx.db.select().from(nodes).all().map((row) => [row.id, row]));
		return {
			generatedAt: new Date(this.ctx.now()).toISOString(),
			strategy: config.strategy,
			memoryOvercommitPercent: config.memoryOvercommitPercent,
			cpuOvercommitPercent: config.cpuOvercommitPercent,
			autoRebalance: config.autoRebalance,
			rebalanceThresholdPercent: config.rebalanceThresholdPercent,
			nodes: snapshot.nodes.map((node) => {
				const row = rows.get(node.id);
				const stats = parseJson<Record<string, unknown> | null>(row?.statsJson ?? null, null);
				const mb = (value: unknown): number | null =>
					typeof value === 'number' && Number.isFinite(value) ? Math.round(value / (1024 * 1024)) : null;
				const mine = snapshot.units.filter((unit) => unit.nodeId === node.id);
				return {
					id: node.id,
					name: node.name,
					zone: node.zone,
					status: row?.status ?? 'offline',
					eligible: node.eligible,
					sliceMemoryMb: row?.sliceMemoryMb ?? node.capacityMb,
					capacityMb: node.capacityMb,
					reservedMb: node.reservedMb,
					reservedPercent: plan.before.find((entry) => entry.nodeId === node.id)?.percent ?? 0,
					usedMemoryMb: mb(stats?.memoryBytes),
					totalMemoryMb: mb(stats?.memoryTotalBytes),
					cpuPercent: typeof stats?.cpuPercent === 'number' ? Math.round(stats.cpuPercent * 10) / 10 : null,
					cpuCapacityMillis: node.cpuCapacityMillis,
					reservedCpuMillis: node.reservedCpuMillis,
					copies: mine.length,
					movable: mine.filter((unit) => !unit.blocker).length,
				};
			}),
			units: snapshot.units.map((unit) => ({
				id: unit.id,
				label: unit.label,
				nodeId: unit.nodeId,
				memoryMb: unit.memoryMb,
				cpuMillis: unit.cpuMillis,
				blocker: unit.blocker,
			})),
			plan: this.#planView(plan, snapshot.nodes),
		};
	}

	/** Preview a rebalance, or apply it. Applying is a fleet change: a signed-in platform admin only. */
	rebalance(principal: Principal, raw: unknown): RebalanceResult {
		const input = rebalanceRequestSchema.parse(raw ?? {});
		if (input.apply ? !this.ctx.platformIam.allows(principal, 'platform:drain') : !this.ctx.platformIam.canView(principal))
			throw new CoreError(
				'forbidden',
				principal.platformAdmin
					? 'Fleet changes need a platform admin role signed in to the dashboard (not an API key or MCP token).'
					: 'Platform admin permission required.',
				403,
			);
		const strategy = input.strategy ?? this.ctx.cluster.get().scheduling.strategy;
		const snapshot = this.ctx.workloads.balanceSnapshot();
		const plan = this.#plan(strategy, snapshot);
		const view = this.#planView(plan, snapshot.nodes);
		if (!input.apply) return { applied: false, plan: view, moved: [], skipped: [] };
		const { moved, skipped } = this.#apply(view.moves, 'rebalance', `Rebalance (${strategy}) by ${principalLabel(principal)}.`);
		this.ctx.audit.record({
			principal,
			action: 'scheduling.rebalance',
			resource: 'cluster',
			resourceId: 'scheduling',
			args: { strategy, planned: view.moves.length, moved: moved.length, skipped: skipped.length },
			result: 'ok',
		});
		return { applied: true, plan: view, moved, skipped };
	}

	/** Move one project's workload to another node: the scheduler's choice, or the one named. */
	move(principal: Principal, slug: string, raw: unknown): WorkloadMoveResult {
		const input = workloadMoveRequestSchema.parse(raw ?? {});
		const project = this.ctx.projects.requireRow(principal, slug);
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		const workload = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
		if (!workload?.nodeId) throw new ValidationError(`"${project.slug}" has not been deployed yet.`);
		const copy = this.ctx.workloads.replicaCopies().find((entry) => entry.single && entry.id === workload.id);
		if (!copy)
			throw new ConflictError(
				`"${project.slug}" runs as a spread replica set, or this fleet has one compute node. Drain a node or rebalance to move its copies.`,
			);
		if (this.ctx.failover.movingCopyIds().has(copy.id)) throw new ConflictError(`"${project.slug}" is already moving.`);
		let target: string | undefined;
		if (input.node) {
			const node = this.ctx.db
				.select({ id: nodes.id, name: nodes.name })
				.from(nodes)
				.all()
				.find((row) => row.id === input.node || row.name === input.node);
			if (!node) throw new NotFoundError('Node');
			if (node.id === workload.nodeId) throw new ConflictError(`"${project.slug}" already runs on ${node.name}.`);
			target = node.id;
		}
		const plan = this.ctx.workloads.planReplicaMove(copy.id, new Set(), target);
		if (!plan.ok)
			throw new ConflictError(
				`${plan.message.replace(/^placement_blocked: /, '')}${/app volumes/.test(plan.message) ? ' Move it with its data instead (it is stopped for the copy).' : ''}`,
			);
		const from = workload.nodeId;
		this.ctx.workloads.moveReplica(copy.id, plan.nodeId, 'manual');
		this.ctx.failover.trackMove(copy, plan.nodeId, plan.nodeName, 'manual', `Moved by ${principalLabel(principal)}.`);
		const surge = Boolean(
			this.ctx.db.select({ from: workloads.movingFromNodeId }).from(workloads).where(eq(workloads.id, workload.id)).get()?.from,
		);
		this.ctx.audit.record({
			principal,
			action: 'project.move',
			resource: 'project',
			resourceId: project.id,
			args: { slug: project.slug, from, to: plan.nodeId, mode: surge ? 'surge' : 'restart' },
			result: 'ok',
		});
		return {
			project: project.slug,
			from: { id: from, name: this.#nodeName(from) },
			to: { id: plan.nodeId, name: plan.nodeName },
			mode: surge ? 'surge' : 'restart',
		};
	}

	/**
	 * The controller's own rebalance: at most one move per interval, and only while the fleet is
	 * settled (every node online, nothing else moving). Called under the failover lease.
	 */
	autoTick(now: number, config: ClusterConfig, fleetUnsettled: boolean): SchedulingMoveView | null {
		const scheduling = config.scheduling;
		if (!scheduling.autoRebalance || fleetUnsettled) return null;
		const last = Number(
			this.ctx.sqlite.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(SCHEDULING_AUTO_KEY)
				?.value ?? 0,
		);
		if (now - last < scheduling.rebalanceIntervalMinutes * 60_000) return null;
		if (this.ctx.failover.movingCopyIds().size > 0) return null;
		const snapshot = this.ctx.workloads.balanceSnapshot();
		const plan = planRebalance({
			...snapshot,
			strategy: scheduling.strategy,
			thresholdPercent: scheduling.rebalanceThresholdPercent,
			maxMoves: 1,
		});
		const first = this.#planView(plan, snapshot.nodes).moves[0];
		if (!first) return null;
		const { moved } = this.#apply([first], 'rebalance', `Automatic rebalance (${scheduling.strategy}).`);
		// Stamp even when admission refused the move, so a move that cannot run is not retried every tick.
		this.ctx.sqlite.run(
			'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
			[SCHEDULING_AUTO_KEY, String(now), now],
		);
		return moved[0] ?? null;
	}

	#plan(strategy: PackingStrategy, snapshot: ReturnType<CoreContext['workloads']['balanceSnapshot']>): BalancePlan {
		const scheduling = this.ctx.cluster.get().scheduling;
		const moving = this.ctx.failover.movingCopyIds();
		return planRebalance({
			nodes: snapshot.nodes,
			units: snapshot.units.map((unit) => (moving.has(unit.id) ? { ...unit, blocker: 'it is already moving' } : unit)),
			strategy,
			thresholdPercent: scheduling.rebalanceThresholdPercent,
			maxMoves: scheduling.maxMovesPerRebalance,
		});
	}

	#planView(plan: BalancePlan, snapshotNodes: Array<{ id: string; name: string }>): SchedulingPlanView {
		const name = (id: string) => snapshotNodes.find((node) => node.id === id)?.name ?? id;
		return {
			strategy: plan.strategy,
			moves: plan.moves.map((move) => ({
				unitId: move.unitId,
				label: move.label,
				fromNodeId: move.fromNodeId,
				fromNodeName: name(move.fromNodeId),
				toNodeId: move.toNodeId,
				toNodeName: name(move.toNodeId),
				memoryMb: move.memoryMb,
			})),
			gapBefore: plan.gapBefore,
			gapAfter: plan.gapAfter,
			after: plan.after.map((entry) => ({ nodeId: entry.nodeId, reservedMb: entry.reservedMb, percent: entry.percent })),
			freedNodeIds: plan.freedNodeIds,
			summary: plan.summary,
		};
	}

	/** Apply planned moves one by one; each is admitted again, because the fleet may have changed. */
	#apply(
		moves: SchedulingMoveView[],
		why: 'rebalance',
		detail: string,
	): { moved: SchedulingMoveView[]; skipped: Array<{ label: string; reason: string }> } {
		const copies = new Map<string, ReplicaCopy>(this.ctx.workloads.replicaCopies().map((copy) => [copy.id, copy]));
		const moved: SchedulingMoveView[] = [];
		const skipped: Array<{ label: string; reason: string }> = [];
		const busyWorkloads = new Set<string>();
		for (const move of moves) {
			const copy = copies.get(move.unitId);
			if (!copy || copy.nodeId !== move.fromNodeId) {
				skipped.push({ label: move.label, reason: 'It moved or was removed since the plan was made.' });
				continue;
			}
			if (busyWorkloads.has(copy.workloadId)) {
				skipped.push({ label: move.label, reason: 'Another copy of this workload is moving; rebalance again once it is up.' });
				continue;
			}
			const plan = this.ctx.workloads.planReplicaMove(copy.id, new Set(), move.toNodeId);
			if (!plan.ok) {
				skipped.push({ label: move.label, reason: plan.message.replace(/^placement_blocked: /, '') });
				continue;
			}
			this.ctx.workloads.moveReplica(copy.id, plan.nodeId, why);
			this.ctx.failover.trackMove(copy, plan.nodeId, plan.nodeName, why, detail);
			busyWorkloads.add(copy.workloadId);
			moved.push(move);
		}
		return { moved, skipped };
	}

	#nodeName(id: string): string {
		return this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, id)).get()?.name ?? id;
	}
}

function principalLabel(principal: Principal): string {
	return `${principal.kind} ${principal.userId}`;
}
