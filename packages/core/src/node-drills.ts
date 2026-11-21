import { randomInt } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { failoverEvents, nodeDrills, nodes } from '@yoal/db';
import {
	OFFLINE_DRILL_CAPABILITY,
	nodeDrillLimits,
	nodeDrillStartSchema,
	type NodeDrillCandidate,
	type NodeDrillEvent,
	type NodeDrillListView,
	type NodeDrillObservations,
	type NodeDrillStartRequest,
	type NodeDrillView,
	type NodeOfflineDrillDesired,
	type Principal,
} from '@yoal/contracts';
import { nodeHasCapability } from './capability-gate.ts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError } from './errors.ts';
import { nodeRoles } from './ingress.ts';
import { OFFLINE_AFTER_MS } from './nodes.ts';
import { newId, parseJson } from './util.ts';

type DrillRow = typeof nodeDrills.$inferSelect;
type NodeRow = typeof nodes.$inferSelect;

const EVENT_CAP = 50;

/**
 * Node offline drills (D235, docs/CLUSTERING.md §12.7).
 *
 * `start` picks a node (at random unless one is named), records the drill and bumps desired state;
 * the node's agent sees `offlineDrill` on its next pull and goes dark until `endsAt`. Nothing here
 * moves a workload or fails anything over: the failover controller, alerts and run-lease fencing
 * do exactly what they would for a real loss, which is the point. This service only watches:
 * `tick` records when the node was marked offline and fails a drill whose node never came back,
 * and `onHeartbeat` closes it with the detection and recovery times and the failover events the
 * controller wrote in the window.
 *
 * One drill at a time, never the last online node, and the control-plane host only when asked.
 */
export class NodeDrillService {
	constructor(private readonly ctx: CoreContext) {}

	view(principal: Principal, limit = 10): NodeDrillListView {
		this.#assert(principal);
		const rows = this.ctx.db
			.select()
			.from(nodeDrills)
			.orderBy(desc(nodeDrills.startedAt))
			.limit(Math.max(1, Math.min(50, limit)))
			.all();
		const running = this.#running();
		return {
			running: running ? this.#view(running) : null,
			recent: rows.map((row) => this.#view(row)),
			candidates: this.#candidates(false),
			limits: nodeDrillLimits,
		};
	}

	get(principal: Principal, id: string): NodeDrillView {
		this.#assert(principal);
		const row = this.ctx.db.select().from(nodeDrills).where(eq(nodeDrills.id, id)).get();
		if (!row) throw new NotFoundError('Drill');
		return this.#view(row);
	}

	start(principal: Principal, request: NodeDrillStartRequest): NodeDrillView {
		this.#assert(principal);
		const input = nodeDrillStartSchema.parse(request);
		const running = this.#running();
		if (running)
			throw new ConflictError(`A drill is already running on ${running.nodeName}; cancel it or wait until it ends.`);

		const candidates = this.#candidates(input.includeControlNode);
		let picked: NodeDrillCandidate | undefined;
		if (input.node) {
			picked = candidates.find((candidate) => candidate.nodeId === input.node || candidate.nodeName === input.node);
			if (!picked) throw new NotFoundError('Node');
			if (!picked.eligible) throw new ConflictError(`${picked.nodeName} cannot be drilled: ${picked.reason}.`);
		} else {
			const eligible = candidates.filter((candidate) => candidate.eligible);
			if (eligible.length === 0)
				throw new ConflictError(
					`No node can be drilled right now. ${candidates.map((candidate) => `${candidate.nodeName}: ${candidate.reason}`).join('; ') || 'There are no nodes.'}`,
				);
			picked = eligible[randomInt(eligible.length)]!;
		}

		const now = this.ctx.now();
		const row: DrillRow = {
			id: newId('drl_'),
			nodeId: picked.nodeId,
			nodeName: picked.nodeName,
			status: 'running',
			random: !input.node,
			durationSeconds: input.durationSeconds,
			startedAt: now,
			endsAt: now + input.durationSeconds * 1000,
			offlineAt: null,
			cancelledAt: null,
			restoredAt: null,
			finishedAt: null,
			observationsJson: null,
			message: null,
			createdBy: principal.userId ?? principal.kind,
		};
		this.ctx.db.insert(nodeDrills).values(row).run();
		this.ctx.audit.record({
			principal,
			action: 'ha.drill.start',
			resource: 'node',
			resourceId: picked.nodeId,
			args: { drillId: row.id, random: row.random, durationSeconds: row.durationSeconds },
			result: 'ok',
		});
		// The agent long-polls desired state, so it goes dark within about a second.
		this.ctx.nodes.bump();
		return this.#view(row);
	}

	cancel(principal: Principal, id: string): NodeDrillView {
		this.#assert(principal);
		const row = this.ctx.db.select().from(nodeDrills).where(eq(nodeDrills.id, id)).get();
		if (!row) throw new NotFoundError('Drill');
		if (row.status !== 'running') throw new ConflictError(`The drill already ended (${row.status}).`);
		const now = this.ctx.now();
		const next = { status: 'cancelled' as const, cancelledAt: now, message: 'Cancelled before the end; the node comes back on its next poll (≤5 s).' };
		this.ctx.db.update(nodeDrills).set(next).where(eq(nodeDrills.id, id)).run();
		this.ctx.audit.record({
			principal,
			action: 'ha.drill.cancel',
			resource: 'node',
			resourceId: row.nodeId,
			args: { drillId: id },
			result: 'ok',
		});
		this.ctx.nodes.bump();
		return this.#view({ ...row, ...next });
	}

	/** Desired state's `offlineDrill` for this node, while one runs. */
	desiredForNode(nodeId: string): NodeOfflineDrillDesired | null {
		const row = this.#running();
		if (!row || row.nodeId !== nodeId || row.endsAt <= this.ctx.now()) return null;
		return { id: row.id, endsAt: row.endsAt };
	}

	/** `GET /api/agent/drill`: a dark agent's cancel check. Deliberately not a heartbeat. */
	poll(token: string): { drill: NodeOfflineDrillDesired | null } {
		const node = this.ctx.nodes.authenticate(token);
		return { drill: this.desiredForNode(node.id) };
	}

	/** True while a drill runs on this node (alerts say so rather than looking like a real outage). */
	isRunningOn(nodeId: string): boolean {
		return this.#running()?.nodeId === nodeId;
	}

	/**
	 * A node heartbeated. Closes its drill once it is back; a heartbeat in the middle of a running
	 * drill means the agent did not go dark (restarted, or a build without `offline-drill`).
	 */
	onHeartbeat(nodeId: string): void {
		const row = this.ctx.db
			.select()
			.from(nodeDrills)
			.where(and(eq(nodeDrills.nodeId, nodeId), isNull(nodeDrills.restoredAt), inArray(nodeDrills.status, ['running', 'cancelled', 'failed'])))
			.orderBy(desc(nodeDrills.startedAt))
			.get();
		if (!row) return;
		const now = this.ctx.now();
		if (row.status === 'running' && now < row.endsAt) {
			if (now - row.startedAt < nodeDrillLimits.startGraceMs) return;
			this.#finish(row, now, {
				status: 'failed',
				message: 'The node heartbeated during the drill: its agent restarted or did not go dark.',
			});
			return;
		}
		this.#finish(row, now, row.status === 'running' ? { status: 'completed', message: null } : { status: row.status, message: row.message });
	}

	/** Every few seconds on the primary: note the offline mark, fail a drill whose node never returned. */
	tick(): void {
		const row = this.#running();
		if (!row) return;
		const now = this.ctx.now();
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, row.nodeId)).get();
		if (!node) {
			this.#finish(row, now, { status: 'failed', message: 'The node was removed during the drill.' });
			return;
		}
		if (row.offlineAt === null && node.status === 'offline') {
			// The failover controller stamps `updatedAt` when it marks the node offline.
			const offlineAt = Math.max(row.startedAt, node.updatedAt ?? now);
			this.ctx.db.update(nodeDrills).set({ offlineAt }).where(eq(nodeDrills.id, row.id)).run();
		}
		if (now > row.endsAt + nodeDrillLimits.returnGraceMs)
			this.#finish(row, now, {
				status: 'failed',
				message: `The node did not heartbeat within ${Math.round(nodeDrillLimits.returnGraceMs / 60_000)} min of the drill's end. Check its agent (journalctl -u yoal-agent).`,
				keepWaiting: true,
			});
	}

	// ---------------------------------------------------------------- internals

	#assert(principal: Principal): void {
		if (this.ctx.platformIam.allows(principal, 'platform:ha')) return;
		throw new CoreError('forbidden', 'Drills need a platform admin or operator.', 403);
	}

	#running(): DrillRow | undefined {
		return this.ctx.db.select().from(nodeDrills).where(eq(nodeDrills.status, 'running')).orderBy(desc(nodeDrills.startedAt)).get();
	}

	#isControlNode(node: NodeRow): boolean {
		return node.mode === 'edge' || nodeRoles(node).includes('control');
	}

	/** Every node with whether it may be drilled now; a fleet must keep one other node online. */
	#candidates(includeControlNode: boolean): NodeDrillCandidate[] {
		const now = this.ctx.now();
		const rows = this.ctx.db.select().from(nodes).all();
		const fresh = (node: NodeRow) => node.status === 'online' && now - (node.lastHeartbeatAt ?? 0) < OFFLINE_AFTER_MS;
		const online = rows.filter(fresh);
		return rows
			.map((node): NodeDrillCandidate => {
				const controlNode = this.#isControlNode(node);
				const blocker = !fresh(node)
					? `it is ${node.status === 'online' ? 'not heartbeating' : node.status}`
					: !nodeHasCapability(node, OFFLINE_DRILL_CAPABILITY)
						? 'its agent predates offline drills; update it first'
						: online.length < 2
							? 'it is the only online node, so nothing could take over'
							: null;
				const needsControlOptIn = blocker === null && controlNode && !includeControlNode;
				const reason = blocker ?? (needsControlOptIn ? 'it hosts the control plane (allow it explicitly)' : null);
				return { nodeId: node.id, nodeName: node.name, eligible: reason === null, reason, controlNode, needsControlOptIn };
			})
			.sort((a, b) => a.nodeName.localeCompare(b.nodeName));
	}

	#finish(
		row: DrillRow,
		now: number,
		outcome: { status: DrillRow['status']; message: string | null; keepWaiting?: boolean },
	): void {
		// `keepWaiting` fails a drill whose node is still dark but leaves `restoredAt` open, so a late
		// heartbeat still records when it came back.
		const restoredAt = outcome.keepWaiting ? null : now;
		const observations = this.#observe({ ...row, restoredAt }, now);
		this.ctx.db
			.update(nodeDrills)
			.set({
				status: outcome.status,
				message: outcome.message,
				restoredAt,
				finishedAt: row.finishedAt ?? now,
				observationsJson: JSON.stringify(observations),
			})
			.where(eq(nodeDrills.id, row.id))
			.run();
		this.ctx.audit.record({
			action: `ha.drill.${outcome.status === 'running' ? 'update' : outcome.status}`,
			resource: 'node',
			resourceId: row.nodeId,
			args: {
				drillId: row.id,
				offlineDetectedAfterMs: observations.offlineDetectedAfterMs,
				backOnlineAfterMs: observations.backOnlineAfterMs,
				events: observations.events.length + observations.moreEvents,
			},
			result: outcome.status === 'failed' ? 'error' : 'ok',
			...(outcome.status === 'failed' && outcome.message ? { error: outcome.message } : {}),
		});
	}

	#observe(row: DrillRow, now: number): NodeDrillObservations {
		const end = row.cancelledAt ?? row.endsAt;
		const rows = this.ctx.db
			.select()
			.from(failoverEvents)
			.where(and(gte(failoverEvents.detectedAt, row.startedAt), lte(failoverEvents.detectedAt, now)))
			.orderBy(failoverEvents.detectedAt)
			.all();
		const names = new Map(this.ctx.db.select({ id: nodes.id, name: nodes.name }).from(nodes).all().map((node) => [node.id, node.name]));
		const name = (id: string | null) => (id ? (names.get(id) ?? id) : null);
		const events: NodeDrillEvent[] = rows.slice(0, EVENT_CAP).map((event) => ({
			kind: event.kind,
			status: event.status,
			stage: event.stage,
			subject: event.subjectName ?? event.subjectId,
			fromNode: name(event.fromNodeId),
			toNode: name(event.toNodeId),
			reason: event.reason,
			detectedAt: event.detectedAt,
		}));
		return {
			offlineDetectedAfterMs: row.offlineAt === null ? null : row.offlineAt - row.startedAt,
			backOnlineAfterMs: row.restoredAt === null ? null : Math.max(0, row.restoredAt - end),
			events,
			moreEvents: Math.max(0, rows.length - EVENT_CAP),
		};
	}

	#view(row: DrillRow): NodeDrillView {
		return {
			id: row.id,
			nodeId: row.nodeId,
			nodeName: row.nodeName,
			status: row.status,
			random: row.random,
			durationSeconds: row.durationSeconds,
			startedAt: row.startedAt,
			endsAt: row.cancelledAt ?? row.endsAt,
			offlineAt: row.offlineAt,
			cancelledAt: row.cancelledAt,
			restoredAt: row.restoredAt,
			finishedAt: row.finishedAt,
			message: row.message,
			createdBy: row.createdBy,
			observations: parseJson<NodeDrillObservations | null>(row.observationsJson, null),
		};
	}
}
