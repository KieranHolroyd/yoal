import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
	databaseReplicas,
	databases,
	nodeRollouts,
	nodes,
	projects,
	workloadReplicas,
	workloads,
} from '@yoal/db';
import {
	compareSemver,
	isActiveRollout,
	nodeRolloutCreateSchema,
	nodeRolloutLimits,
	nodeRolloutNodeStates,
	nodeRolloutResumeSchema,
	parseSemver,
	type NodeRolloutNodeState,
	type NodeRolloutOptions,
	type NodeRolloutPhase,
	type NodeRolloutPlanView,
	type NodeRolloutStatus,
	type NodeRolloutView,
	type Principal,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { flow, type FlowDefinition, type FlowOutcome, type FlowSignal } from './flows/types.ts';
import { OFFLINE_AFTER_MS } from './nodes.ts';
import {
	describeGroups,
	exposedGroups,
	planRollout,
	resolveRolloutOptions,
	type ResolvedRolloutOptions,
	type RolloutFacts,
	type RolloutPlan,
} from './node-rollout-plan.ts';
import { newId, parseJson } from './util.ts';

export const NODE_ROLLOUT_FLOW = 'node.rollout';
/** One active rollout at a time: every run uses this flow key. */
const FLOW_KEY = 'fleet';
/** Every external event reaches the run as this one signal, so any wait can hear a cancel. */
const EVENT = 'event';
/** How often a waiting step re-reads the fleet when no heartbeat signal arrives. */
const POLL_MS = 30_000;
const DRAIN_POLL_MS = 15_000;

type RolloutRow = typeof nodeRollouts.$inferSelect;
type NodeRow = typeof nodes.$inferSelect;

type RolloutEvent =
	| { type: 'node-settled'; nodeId: string }
	| { type: 'resume'; retryFailed: boolean; by: string }
	| { type: 'cancel'; by: string };

interface RolloutFlowState {
	rolloutId: string;
	/** When the current wave first found a redundant group exposed. */
	blockedSince?: number | null;
	/** Why the rollout paused: a failed wave (`failures`) or a group that stayed exposed (`blocked`). */
	pausedFor?: 'failures' | 'blocked' | null;
}

/** One node's progress, stored in `node_rollouts.nodes_json`. */
export interface RolloutNodeRecord {
	nodeId: string;
	name: string;
	wave: number;
	state: NodeRolloutNodeState;
	fromVersion: string | null;
	guarded: boolean;
	attempts: number;
	generation: number | null;
	/** Units (`workload:<id>`, `replica:<id>`) that ran here before the update. */
	runningBefore: string[];
	/** The rollout cordoned this node, so it lifts the cordon afterwards. */
	drainedByRollout: boolean;
	error: string | null;
	startedAt: number | null;
	finishedAt: number | null;
}

/**
 * Fleet node updates (docs/CLUSTERING.md §3.11, D217).
 *
 * A rollout is a `node_rollouts` row driven by a `node.rollout` flow run. Each wave: check that no
 * redundant group would lose every online member, optionally drain, ask each node for the release
 * through the D99 path (`NodeService.scheduleUpdate`), wait for the heartbeat to report the new
 * version or a failure, hold for the soak, then verify the node is still online, still on the new
 * version (a node whose new agent never confirmed rolls itself back) and still running what it ran
 * before. Failures beyond `maxFailures` pause the rollout for an operator to retry, skip or cancel.
 *
 * Nodes act on their own: the control plane only records desired state, so a cancel stops further
 * waves but never interrupts a node already installing.
 */
export class NodeRolloutService {
	constructor(private readonly ctx: CoreContext) {}

	// ---------------------------------------------------------------- reads

	list(principal: Principal, limit = 20): NodeRolloutView[] {
		this.assertView(principal);
		return this.ctx.db
			.select()
			.from(nodeRollouts)
			.orderBy(desc(nodeRollouts.createdAt))
			.limit(Math.max(1, Math.min(100, limit)))
			.all()
			.map((row) => this.view(row));
	}

	get(principal: Principal, id: string): NodeRolloutView {
		this.assertView(principal);
		return this.view(this.require(id));
	}

	/** The running or paused rollout, if any. */
	active(principal: Principal): NodeRolloutView | null {
		this.assertView(principal);
		const row = this.activeRow();
		return row ? this.view(row) : null;
	}

	/** Preview the waves a rollout with these options would run now. */
	plan(principal: Principal, raw: unknown): NodeRolloutPlanView {
		this.assertView(principal);
		const input = this.parseCreate(raw);
		const target = this.target();
		const options = resolveRolloutOptions(input);
		return this.planView(target, options, this.computePlan(target, options, input.nodeIds));
	}

	// --------------------------------------------------------------- writes

	start(principal: Principal, raw: unknown): NodeRolloutView {
		this.assertAdmin(principal);
		const input = this.parseCreate(raw);
		return this.begin(input, { trigger: 'manual', principal });
	}

	resume(principal: Principal, id: string, raw: unknown = {}): NodeRolloutView {
		this.assertAdmin(principal);
		const parsed = nodeRolloutResumeSchema.safeParse(raw ?? {});
		if (!parsed.success) throw new ValidationError('Invalid resume request.', parsed.error.issues);
		const row = this.require(id);
		if (row.status !== 'paused') throw new ConflictError(`This rollout is ${row.status}, not paused.`);
		this.ctx.audit.record({
			principal,
			action: 'node.rollout.resume',
			resource: 'node',
			resourceId: id,
			args: { retryFailed: parsed.data.retryFailed },
			result: 'ok',
		});
		this.send(row, { type: 'resume', retryFailed: parsed.data.retryFailed, by: principal.userId });
		return this.view(this.require(id));
	}

	cancel(principal: Principal, id: string): NodeRolloutView {
		this.assertAdmin(principal);
		const row = this.require(id);
		if (!isActiveRollout(row.status)) throw new ConflictError(`This rollout already ${row.status}.`);
		this.ctx.audit.record({
			principal,
			action: 'node.rollout.cancel',
			resource: 'node',
			resourceId: id,
			args: {},
			result: 'ok',
		});
		if (!this.send(row, { type: 'cancel', by: principal.userId })) this.finishCancelled(row, principal.userId);
		return this.view(this.require(id));
	}

	/** From the heartbeat: an outstanding update on this node succeeded or failed. */
	nodeSettled(nodeId: string): void {
		const row = this.activeRow();
		if (!row || row.status !== 'running') return;
		const record = this.records(row).find((entry) => entry.nodeId === nodeId);
		if (!record || record.state !== 'updating') return;
		this.send(row, { type: 'node-settled', nodeId });
	}

	/**
	 * From the maintenance sweep: start a rollout when `updates.autoRollout` is on and the control
	 * plane runs a release some node lacks (once per version), and fail a row whose flow is gone.
	 */
	tick(): { started: string | null } {
		const active = this.activeRow();
		if (active) {
			if (active.flowId && !this.ctx.flows.findActive(NODE_ROLLOUT_FLOW, FLOW_KEY)) {
				this.finish(active, 'failed', 'The flow driving this rollout ended without finishing it.');
			}
			return { started: null };
		}
		const config = this.ctx.cluster.get().updates;
		if (!config.autoRollout) return { started: null };
		const target = parseSemver(this.ctx.config.desiredAgentVersion)?.version;
		if (!target) return { started: null };
		const tried = this.ctx.db
			.select({ id: nodeRollouts.id })
			.from(nodeRollouts)
			.where(and(eq(nodeRollouts.targetVersion, target), eq(nodeRollouts.trigger, 'auto')))
			.get();
		if (tried) return { started: null };
		const { autoRollout: _auto, ...options } = config;
		const plan = this.computePlan(target, resolveRolloutOptions(options), undefined);
		if (plan.waves.length === 0) return { started: null };
		const view = this.begin(options, { trigger: 'auto' });
		return { started: view.id };
	}

	// --------------------------------------------------------------- flow

	rolloutFlow(): FlowDefinition<RolloutFlowState> {
		const handle =
			(fallback: (state: RolloutFlowState, signal: RolloutEvent) => FlowOutcome | null) =>
			({ state }: { state: RolloutFlowState }, signal: FlowSignal): FlowOutcome | null => {
				const event = signal.payload as RolloutEvent | null;
				if (event?.type === 'cancel') return this.cancelOutcome(state, event.by);
				return event ? fallback(state, event) : null;
			};
		const again = (step: string) => () => flow.next(step);
		return {
			kind: NODE_ROLLOUT_FLOW,
			title: 'Fleet node update',
			steps: {
				wave: {
					run: ({ state, now }) => this.stepWave(state, now),
					onSignal: handle(() => flow.next('wave')),
					onTimeout: again('wave'),
				},
				drain: {
					run: ({ state, now }) => this.stepDrain(state, now),
					onSignal: handle(() => null),
					onTimeout: again('drain'),
				},
				update: { run: ({ state, now }) => this.stepUpdate(state, now) },
				await: {
					run: ({ state, now }) => this.stepAwait(state, now),
					onSignal: handle((_, event) => (event.type === 'node-settled' ? flow.next('await') : null)),
					onTimeout: again('await'),
				},
				soak: {
					run: ({ state, now }) => this.stepSoak(state, now),
					onSignal: handle(() => null),
					onTimeout: again('verify'),
				},
				verify: { run: ({ state, now }) => this.stepVerify(state, now) },
				paused: {
					run: ({ state }) => {
						const row = this.require(state.rolloutId);
						return flow.wait(EVENT, {
							timeoutMs: nodeRolloutLimits.pausedTimeoutMs,
							detail: row.detail ?? 'Paused.',
						});
					},
					onSignal: handle((state, event) => (event.type === 'resume' ? this.resumeOutcome(state, event) : null)),
					onTimeout: ({ state }) => {
						const row = this.require(state.rolloutId);
						this.finish(row, 'failed', 'Paused for 7 days without a resume or cancel.');
						return flow.fail('Paused for 7 days without a resume or cancel.');
					},
				},
			},
			onFailure: ({ state }, error) => {
				const row = this.ctx.db.select().from(nodeRollouts).where(eq(nodeRollouts.id, state.rolloutId)).get();
				if (row && isActiveRollout(row.status)) this.finish(row, 'failed', error);
			},
		};
	}

	private stepWave(state: RolloutFlowState, now: number): FlowOutcome {
		const row = this.require(state.rolloutId);
		if (!isActiveRollout(row.status)) return flow.succeed({ status: row.status });
		const plan = this.waves(row);
		if (row.currentWave >= plan.length) {
			this.finish(row, 'succeeded', null);
			return flow.succeed({ status: 'succeeded' }, `Every wave finished on ${row.targetVersion}.`);
		}
		const records = this.records(row);
		const target = row.targetVersion;
		const wave = new Set(plan[row.currentWave]);
		const rows = this.nodeRows();
		for (const record of records) {
			if (!wave.has(record.nodeId) || record.state !== 'pending') continue;
			const node = rows.get(record.nodeId);
			if (!node) Object.assign(record, { state: 'skipped', error: 'The node was removed.', finishedAt: now });
			else if (isCurrent(node, target)) Object.assign(record, { state: 'done', error: null, finishedAt: now });
			else if (!this.isOnline(node, now))
				Object.assign(record, { state: 'skipped', error: 'It was offline when its wave started.', finishedAt: now });
		}
		const active = records.filter((record) => wave.has(record.nodeId) && record.state === 'pending');
		if (active.length === 0) {
			this.save(row, { nodes: records, currentWave: row.currentWave + 1, waveStartedAt: null, soakUntil: null });
			return flow.next('wave', { state: { blockedSince: null } });
		}

		const options = this.options(row);
		if (options.strategy !== 'parallel') {
			const exposed = exposedGroups(new Set(active.map((record) => record.nodeId)), this.facts(target));
			if (exposed.length > 0) {
				const since = state.blockedSince ?? now;
				const detail = `Wave ${row.currentWave + 1} waits: updating ${names(active)} now would leave no online node for ${describeGroups(exposed)}.`;
				if (now - since >= nodeRolloutLimits.blockedTimeoutMs) {
					this.save(row, { nodes: records, status: 'paused', phase: 'paused', detail: `${detail} Paused after ${nodeRolloutLimits.blockedTimeoutMs / 60_000} minutes.` });
					return flow.next('paused', { state: { blockedSince: null, pausedFor: 'blocked' } });
				}
				this.save(row, { nodes: records, phase: 'blocked', detail });
				return flow.wait(EVENT, { timeoutMs: POLL_MS, detail, state: { blockedSince: since } });
			}
		}

		if (options.drain) {
			for (const record of active) {
				const node = rows.get(record.nodeId)!;
				if (node.status !== 'draining') {
					this.setDraining(node.id, true);
					record.drainedByRollout = true;
				}
				record.state = 'draining';
				record.startedAt = now;
			}
			this.save(row, {
				nodes: records,
				phase: 'draining',
				waveStartedAt: now,
				detail: `Wave ${row.currentWave + 1} of ${plan.length}: draining ${names(active)}.`,
			});
			return flow.next('drain', { state: { blockedSince: null } });
		}
		this.save(row, { nodes: records, waveStartedAt: now });
		return flow.next('update', { state: { blockedSince: null } });
	}

	private stepDrain(state: RolloutFlowState, now: number): FlowOutcome {
		const row = this.require(state.rolloutId);
		const records = this.records(row);
		const draining = records.filter((record) => record.state === 'draining');
		const ids = new Set(draining.map((record) => record.nodeId));
		const { units } = this.ctx.workloads.balanceSnapshot();
		// Movable units, and units already on their way (blocked only because they are moving).
		const left = units.filter(
			(unit) => ids.has(unit.nodeId) && (unit.blocker === null || unit.blocker === 'it is already moving'),
		);
		const elapsed = now - (row.waveStartedAt ?? now);
		if (left.length === 0 || elapsed >= nodeRolloutLimits.drainTimeoutMs) {
			if (left.length > 0)
				this.save(row, {
					detail: `The drain left ${left.length} workload${left.length === 1 ? '' : 's'} (${left
						.slice(0, 5)
						.map((unit) => unit.label)
						.join(', ')}) after ${nodeRolloutLimits.drainTimeoutMs / 60_000} minutes; updating anyway, since an agent update stops no workload.`,
				});
			return flow.next('update');
		}
		const detail = `Wave ${row.currentWave + 1}: moving ${left.length} workload${left.length === 1 ? '' : 's'} off ${names(draining)}.`;
		this.save(row, { phase: 'draining', detail });
		return flow.wait(EVENT, { timeoutMs: DRAIN_POLL_MS, detail });
	}

	private stepUpdate(state: RolloutFlowState, now: number): FlowOutcome {
		const row = this.require(state.rolloutId);
		const records = this.records(row);
		const rows = this.nodeRows();
		const starting = records.filter(
			(record) => record.wave === row.currentWave && (record.state === 'pending' || record.state === 'draining'),
		);
		for (const record of starting) {
			const node = rows.get(record.nodeId);
			if (!node) {
				Object.assign(record, { state: 'skipped', error: 'The node was removed.', finishedAt: now });
				continue;
			}
			if (isCurrent(node, row.targetVersion)) {
				Object.assign(record, { state: 'verifying', error: null, startedAt: record.startedAt ?? now });
				continue;
			}
			record.runningBefore = this.runningUnits(node.id);
			record.generation = this.ctx.nodes.scheduleUpdate(node.id, row.targetVersion, { rolloutId: row.id });
			record.state = 'updating';
			record.startedAt = now;
			record.attempts += 1;
			record.error = null;
		}
		this.save(row, {
			nodes: records,
			phase: 'updating',
			detail: `Wave ${row.currentWave + 1} of ${this.waves(row).length}: updating ${names(starting)} to ${row.targetVersion}.`,
		});
		return flow.next('await');
	}

	private stepAwait(state: RolloutFlowState, now: number): FlowOutcome {
		const row = this.require(state.rolloutId);
		const records = this.records(row);
		const rows = this.nodeRows();
		for (const record of records) {
			if (record.state !== 'updating') continue;
			const node = rows.get(record.nodeId);
			if (!node) Object.assign(record, { state: 'failed', error: 'The node was removed.', finishedAt: now });
			else if (isCurrent(node, row.targetVersion)) record.state = 'verifying';
			else if (record.generation !== null && node.updateFailedGeneration >= record.generation)
				Object.assign(record, {
					state: 'failed',
					error: node.updateError ?? 'The node reported a failure without a reason.',
					finishedAt: now,
				});
			else if (now - (record.startedAt ?? now) >= nodeRolloutLimits.nodeTimeoutMs)
				Object.assign(record, {
					state: 'failed',
					error: `No answer within ${nodeRolloutLimits.nodeTimeoutMs / 60_000} minutes: the node never reported ${row.targetVersion}.`,
					finishedAt: now,
				});
		}
		const waiting = records.filter((record) => record.state === 'updating');
		if (waiting.length === 0) {
			this.save(row, { nodes: records });
			return flow.next('soak');
		}
		const detail = `Wave ${row.currentWave + 1}: waiting for ${names(waiting)} to restart on ${row.targetVersion}.`;
		this.save(row, { nodes: records, phase: 'updating', detail });
		return flow.wait(EVENT, { timeoutMs: POLL_MS, detail });
	}

	private stepSoak(state: RolloutFlowState, now: number): FlowOutcome {
		const row = this.require(state.rolloutId);
		const verifying = this.records(row).filter((record) => record.state === 'verifying');
		const soakMs = this.options(row).soakSeconds * 1000;
		if (verifying.length === 0 || soakMs === 0) return flow.next('verify');
		const until = row.soakUntil ?? now + soakMs;
		if (until <= now) return flow.next('verify');
		const detail = `Wave ${row.currentWave + 1}: ${names(verifying)} on ${row.targetVersion}; watching for ${Math.ceil((until - now) / 1000)} s before the next wave.`;
		this.save(row, { phase: 'soaking', soakUntil: until, detail });
		return flow.wait(EVENT, { timeoutMs: until - now, detail });
	}

	private stepVerify(state: RolloutFlowState, now: number): FlowOutcome {
		const row = this.require(state.rolloutId);
		const records = this.records(row);
		const rows = this.nodeRows();
		for (const record of records) {
			if (record.state !== 'verifying') continue;
			const node = rows.get(record.nodeId);
			const problem = !node
				? 'The node was removed.'
				: !this.isOnline(node, now)
					? `It stopped heartbeating after it reported ${row.targetVersion}.`
					: !isCurrent(node, row.targetVersion)
						? `It reported ${row.targetVersion}, then came back on ${node.agentVersion ?? 'an unknown version'} (the rollback guard restored the previous release).`
						: this.stoppedSince(record);
			Object.assign(record, problem ? { state: 'failed', error: problem } : { state: 'done', error: null }, { finishedAt: now });
		}
		// Lift the cordons this wave put on, whatever the outcome: the operator did not ask for them.
		for (const record of records) {
			if (record.wave !== row.currentWave || !record.drainedByRollout) continue;
			if (rows.get(record.nodeId)?.status === 'draining') this.setDraining(record.nodeId, false);
			record.drainedByRollout = false;
		}
		const failedNow = records.filter((record) => record.wave === row.currentWave && record.state === 'failed').length;
		const failures = row.failures + failedNow;
		const options = this.options(row);
		if (failedNow > 0 && failures > options.maxFailures) {
			const failed = records.filter((record) => record.wave === row.currentWave && record.state === 'failed');
			this.save(row, {
				nodes: records,
				failures,
				soakUntil: null,
				status: 'paused',
				phase: 'paused',
				detail: `Paused: ${names(failed)} failed (${failed[0]?.error ?? 'no reason'}). Retry, skip or cancel.`,
			});
			return flow.next('paused', { state: { pausedFor: 'failures' } });
		}
		this.save(row, { nodes: records, failures, soakUntil: null, waveStartedAt: null, currentWave: row.currentWave + 1 });
		return flow.next('wave');
	}

	private resumeOutcome(state: RolloutFlowState, event: Extract<RolloutEvent, { type: 'resume' }>): FlowOutcome {
		const row = this.require(state.rolloutId);
		if (row.status !== 'paused') return flow.next('wave');
		const records = this.records(row);
		const plan = this.waves(row);
		let currentWave = row.currentWave;
		if (state.pausedFor !== 'blocked') {
			const failed = records.filter((record) => record.wave === row.currentWave && record.state === 'failed');
			currentWave += 1;
			if (event.retryFailed && failed.length > 0) {
				plan.splice(currentWave, 0, failed.map((record) => record.nodeId));
				// Later waves shift by one.
				for (const record of records) if (record.wave >= currentWave && record.state === 'pending') record.wave += 1;
				for (const record of failed) Object.assign(record, { state: 'pending', wave: currentWave, error: null, finishedAt: null });
			}
		}
		this.save(row, {
			nodes: records,
			plan,
			currentWave,
			failures: 0,
			status: 'running',
			phase: 'starting',
			detail: `Resumed by ${event.by}${event.retryFailed ? ', retrying the failed nodes' : ''}.`,
		});
		return flow.next('wave', { state: { pausedFor: null, blockedSince: null } });
	}

	private cancelOutcome(state: RolloutFlowState, by: string): FlowOutcome {
		const row = this.require(state.rolloutId);
		this.finishCancelled(row, by);
		return flow.succeed({ status: 'cancelled' }, `Cancelled by ${by}.`);
	}

	// ------------------------------------------------------------ lifecycle

	private begin(
		input: NodeRolloutOptions & { nodeIds?: string[] },
		by: { trigger: 'manual' | 'auto'; principal?: Principal },
	): NodeRolloutView {
		const existing = this.activeRow();
		if (existing)
			throw new ConflictError(`Rollout ${existing.id} to ${existing.targetVersion} is ${existing.status}; finish or cancel it first.`);
		const target = this.target();
		const options = resolveRolloutOptions(input);
		const plan = this.computePlan(target, options, input.nodeIds);
		if (plan.waves.length === 0)
			throw new ConflictError(
				plan.skipped.length > 0
					? `No node can be updated to ${target} now: ${plan.skipped.map((entry) => `${entry.name} (${entry.reason})`).join('; ')}`
					: `Every node already runs ${target}.`,
			);
		const facts = this.facts(target);
		const byId = new Map(facts.nodes.map((node) => [node.id, node]));
		const records: RolloutNodeRecord[] = [];
		plan.waves.forEach((wave, index) => {
			for (const nodeId of wave.nodeIds) {
				const node = byId.get(nodeId)!;
				records.push({
					nodeId,
					name: node.name,
					wave: index,
					state: 'pending',
					fromVersion: node.agentVersion,
					guarded: node.guarded,
					attempts: 0,
					generation: null,
					runningBefore: [],
					drainedByRollout: false,
					error: null,
					startedAt: null,
					finishedAt: null,
				});
			}
		});
		for (const entry of plan.skipped)
			records.push({
				nodeId: entry.nodeId,
				name: entry.name,
				wave: -1,
				state: 'skipped',
				fromVersion: byId.get(entry.nodeId)?.agentVersion ?? null,
				guarded: byId.get(entry.nodeId)?.guarded ?? false,
				attempts: 0,
				generation: null,
				runningBefore: [],
				drainedByRollout: false,
				error: entry.reason,
				startedAt: null,
				finishedAt: null,
			});
		const now = this.ctx.now();
		const id = newId('nro_');
		const createdBy = by.principal?.userId ?? 'system';
		this.ctx.db
			.insert(nodeRollouts)
			.values({
				id,
				status: 'running',
				phase: 'starting',
				detail: `${plan.waves.length} wave${plan.waves.length === 1 ? '' : 's'} to ${target}.`,
				targetVersion: target,
				trigger: by.trigger,
				optionsJson: JSON.stringify(options),
				planJson: JSON.stringify(plan.waves.map((wave) => wave.nodeIds)),
				nodesJson: JSON.stringify(records),
				createdBy,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		this.ctx.audit.record({
			...(by.principal ? { principal: by.principal } : {}),
			action: 'node.rollout.start',
			resource: 'node',
			resourceId: id,
			args: { target, trigger: by.trigger, ...options, waves: plan.waves.map((wave) => wave.nodeIds) },
			result: 'ok',
		});
		const started = this.ctx.flows.start<RolloutFlowState>({
			kind: NODE_ROLLOUT_FLOW,
			key: FLOW_KEY,
			input: { rolloutId: id },
			subject: { kind: 'node-rollout', id },
			createdBy,
			detail: `Update ${records.filter((record) => record.wave >= 0).length} node(s) to ${target} (${options.strategy}).`,
		});
		if (!started.created) {
			this.finish(this.require(id), 'failed', 'Another fleet update flow is still active.');
			throw new ConflictError('Another fleet update is still running.');
		}
		this.ctx.db.update(nodeRollouts).set({ flowId: started.id }).where(eq(nodeRollouts.id, id)).run();
		void started.settled.catch((error: unknown) => console.error('[rollouts] start', error));
		return this.view(this.require(id));
	}

	private finish(row: RolloutRow, status: Extract<NodeRolloutStatus, 'succeeded' | 'failed' | 'cancelled'>, error: string | null): void {
		const now = this.ctx.now();
		const records = this.records(row);
		for (const record of records) {
			if (record.drainedByRollout) {
				if (this.nodeRows().get(record.nodeId)?.status === 'draining') this.setDraining(record.nodeId, false);
				record.drainedByRollout = false;
			}
			if (status !== 'succeeded' && (record.state === 'pending' || record.state === 'draining'))
				Object.assign(record, { state: 'skipped', error: status === 'cancelled' ? 'The rollout was cancelled.' : 'The rollout stopped.' });
		}
		const done = records.filter((record) => record.state === 'done').length;
		this.save(row, {
			nodes: records,
			status,
			phase: 'done',
			error,
			finishedAt: now,
			currentWave: status === 'succeeded' ? this.waves(row).length : row.currentWave,
			detail:
				status === 'succeeded'
					? `${done} node${done === 1 ? '' : 's'} updated to ${row.targetVersion}.`
					: status === 'cancelled'
						? `Cancelled. Nodes already installing finish on their own.`
						: (error ?? 'Failed.'),
		});
		this.ctx.audit.record({
			action: 'node.rollout.done',
			resource: 'node',
			resourceId: row.id,
			args: { status, target: row.targetVersion, done },
			result: status === 'failed' ? 'error' : 'ok',
			...(error ? { error } : {}),
		});
	}

	private finishCancelled(row: RolloutRow, by: string): void {
		const fresh = this.require(row.id);
		if (!isActiveRollout(fresh.status)) return;
		this.finish(fresh, 'cancelled', null);
		this.save(this.require(row.id), { detail: `Cancelled by ${by}. Nodes already installing finish on their own.` });
	}

	/** Deliver an event to the rollout's flow. False when no flow is active to hear it. */
	private send(row: RolloutRow, event: RolloutEvent): boolean {
		if (!row.flowId || !this.ctx.flows.findActive(NODE_ROLLOUT_FLOW, FLOW_KEY)) return false;
		void this.ctx.flows.signalRun(row.flowId, EVENT, event).catch((error: unknown) => console.error('[rollouts] signal', error));
		return true;
	}

	// ------------------------------------------------------------ facts

	private target(): string {
		const target = parseSemver(this.ctx.config.desiredAgentVersion)?.version;
		if (!target)
			throw new ConflictError(
				`The control plane's version (${this.ctx.config.desiredAgentVersion ?? 'unknown'}) is not a release version, so there is no signed release to install.`,
			);
		return target;
	}

	private computePlan(target: string, options: ResolvedRolloutOptions, nodeIds: string[] | undefined): RolloutPlan {
		const facts = this.facts(target);
		if (nodeIds) {
			const known = new Set(facts.nodes.map((node) => node.id));
			const unknown = nodeIds.filter((id) => !known.has(id));
			if (unknown.length > 0) throw new NotFoundError(`Node ${unknown.join(', ')}`);
		}
		return planRollout(facts, options, nodeIds ? new Set(nodeIds) : null);
	}

	/** What the planner needs: every node, and the redundant groups across the fleet. */
	facts(target: string): RolloutFacts {
		const now = this.ctx.now();
		const rows = [...this.nodeRows().values()].filter((row) => row.status !== 'pending');
		const views = new Map(rows.map((row) => [row.id, this.ctx.nodes.view(row)]));
		const groups: RolloutFacts['groups'] = [];
		const roleGroup = (role: string) => ({
			key: role,
			nodeIds: rows.filter((row) => views.get(row.id)!.roles.includes(role as never)).map((row) => row.id),
		});
		groups.push(roleGroup('ingress'), roleGroup('control'));

		const live = this.ctx.db
			.select({ id: workloads.id, nodeId: workloads.nodeId, slug: projects.slug })
			.from(workloads)
			.innerJoin(projects, eq(projects.id, workloads.projectId))
			.where(isNull(projects.deletedAt))
			.all();
		const copies = this.ctx.db.select({ workloadId: workloadReplicas.workloadId, nodeId: workloadReplicas.nodeId }).from(workloadReplicas).all();
		const copyNodes = new Map<string, Set<string>>();
		for (const copy of copies) copyNodes.set(copy.workloadId, (copyNodes.get(copy.workloadId) ?? new Set()).add(copy.nodeId));
		const singles = new Map<string, number>();
		for (const workload of live) {
			const spread = copyNodes.get(workload.id);
			if (spread && spread.size > 1) groups.push({ key: `workload:${workload.slug}`, nodeIds: [...spread] });
			else if (workload.nodeId) singles.set(workload.nodeId, (singles.get(workload.nodeId) ?? 0) + 1);
		}
		const dbRows = this.ctx.db
			.select({ id: databases.id, name: databases.name, nodeId: databases.nodeId })
			.from(databases)
			.where(isNull(databases.deletedAt))
			.all();
		const replicaRows = this.ctx.db
			.select({ databaseId: databaseReplicas.databaseId, nodeId: databaseReplicas.nodeId, status: databaseReplicas.status })
			.from(databaseReplicas)
			.all()
			.filter((replica) => replica.status !== 'failed' && replica.status !== 'stopped');
		for (const db of dbRows) {
			const members = new Set([db.nodeId, ...replicaRows.filter((replica) => replica.databaseId === db.id).map((replica) => replica.nodeId)]);
			if (members.size > 1) groups.push({ key: `database:${db.name}`, nodeIds: [...members] });
		}

		return {
			nodes: rows.map((row) => {
				const view = views.get(row.id)!;
				return {
					id: row.id,
					name: row.name,
					zone: row.zone,
					roles: view.roles,
					online: this.isOnline(row, now),
					agentVersion: row.agentVersion,
					canUpdate: view.capabilities.includes('node-update'),
					guarded: view.capabilities.includes('node-update-guard'),
					current: isCurrent(row, target),
					singleCopies: singles.get(row.id) ?? 0,
				};
			}),
			groups,
		};
	}

	/** Units running on a node now, to tell afterwards whether the update stopped any. */
	private runningUnits(nodeId: string): string[] {
		const replicas = this.ctx.db
			.select({ id: workloadReplicas.id })
			.from(workloadReplicas)
			.where(and(eq(workloadReplicas.nodeId, nodeId), eq(workloadReplicas.status, 'running')))
			.all()
			.map((row) => `replica:${row.id}`);
		const singles = this.ctx.db
			.select({ id: workloads.id })
			.from(workloads)
			.where(and(eq(workloads.nodeId, nodeId), eq(workloads.status, 'running')))
			.all()
			.map((row) => `workload:${row.id}`);
		return [...replicas, ...singles];
	}

	/** A failure message when a unit that ran before the update is on this node and not running now. */
	private stoppedSince(record: RolloutNodeRecord): string | null {
		const stopped: string[] = [];
		const replicaIds = record.runningBefore.filter((unit) => unit.startsWith('replica:')).map((unit) => unit.slice(8));
		const workloadIds = record.runningBefore.filter((unit) => unit.startsWith('workload:')).map((unit) => unit.slice(9));
		if (replicaIds.length > 0)
			for (const row of this.ctx.db.select().from(workloadReplicas).where(inArray(workloadReplicas.id, replicaIds)).all())
				if (row.nodeId === record.nodeId && row.status !== 'running') stopped.push(`replica ${row.replicaIndex} of ${row.workloadId}`);
		if (workloadIds.length > 0)
			for (const row of this.ctx.db.select().from(workloads).where(inArray(workloads.id, workloadIds)).all())
				if (row.nodeId === record.nodeId && row.status !== 'running') stopped.push(row.id);
		if (stopped.length === 0) return null;
		return `${stopped.length} workload${stopped.length === 1 ? '' : 's'} that ran before the update ${stopped.length === 1 ? 'is' : 'are'} not running: ${stopped.slice(0, 5).join(', ')}.`;
	}

	private isOnline(node: NodeRow, now: number): boolean {
		return (
			(node.status === 'online' || node.status === 'draining') &&
			node.lastHeartbeatAt !== null &&
			now - node.lastHeartbeatAt < OFFLINE_AFTER_MS
		);
	}

	private setDraining(nodeId: string, draining: boolean): void {
		this.ctx.db
			.update(nodes)
			.set({ status: draining ? 'draining' : 'online', updatedAt: this.ctx.now() })
			.where(eq(nodes.id, nodeId))
			.run();
		this.ctx.nodes.bump();
	}

	// ------------------------------------------------------------ rows

	private nodeRows(): Map<string, NodeRow> {
		return new Map(this.ctx.db.select().from(nodes).all().map((row) => [row.id, row]));
	}

	private activeRow(): RolloutRow | null {
		return (
			this.ctx.db
				.select()
				.from(nodeRollouts)
				.where(inArray(nodeRollouts.status, ['running', 'paused']))
				.orderBy(desc(nodeRollouts.createdAt))
				.get() ?? null
		);
	}

	private require(id: string): RolloutRow {
		const row = this.ctx.db.select().from(nodeRollouts).where(eq(nodeRollouts.id, id)).get();
		if (!row) throw new NotFoundError('Rollout');
		return row;
	}

	private records(row: RolloutRow): RolloutNodeRecord[] {
		return parseJson<RolloutNodeRecord[]>(row.nodesJson, []);
	}

	private waves(row: RolloutRow): string[][] {
		return parseJson<string[][]>(row.planJson, []);
	}

	private options(row: RolloutRow): ResolvedRolloutOptions {
		return resolveRolloutOptions(parseJson<ResolvedRolloutOptions>(row.optionsJson, {} as ResolvedRolloutOptions));
	}

	private save(
		row: RolloutRow,
		patch: {
			nodes?: RolloutNodeRecord[];
			plan?: string[][];
			status?: NodeRolloutStatus;
			phase?: NodeRolloutPhase;
			detail?: string;
			currentWave?: number;
			failures?: number;
			waveStartedAt?: number | null;
			soakUntil?: number | null;
			error?: string | null;
			finishedAt?: number;
		},
	): void {
		const { nodes: records, plan, ...rest } = patch;
		this.ctx.db
			.update(nodeRollouts)
			.set({
				...rest,
				...(records ? { nodesJson: JSON.stringify(records) } : {}),
				...(plan ? { planJson: JSON.stringify(plan) } : {}),
				updatedAt: this.ctx.now(),
			})
			.where(eq(nodeRollouts.id, row.id))
			.run();
	}

	view(row: RolloutRow): NodeRolloutView {
		const records = this.records(row);
		const rows = this.nodeRows();
		const counts = Object.fromEntries(nodeRolloutNodeStates.map((state) => [state, 0])) as Record<NodeRolloutNodeState, number>;
		for (const record of records) counts[record.state] += 1;
		const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());
		return {
			id: row.id,
			flowId: row.flowId,
			status: row.status,
			phase: (row.phase as NodeRolloutPhase | null) ?? null,
			detail: row.detail,
			targetVersion: row.targetVersion,
			options: this.options(row),
			currentWave: row.currentWave,
			waves: this.waves(row).length,
			nodes: records.map((record) => ({
				nodeId: record.nodeId,
				name: rows.get(record.nodeId)?.name ?? record.name,
				wave: record.wave,
				state: record.state,
				fromVersion: record.fromVersion,
				version: rows.get(record.nodeId)?.agentVersion ?? null,
				guarded: record.guarded,
				attempts: record.attempts,
				error: record.error,
				startedAt: iso(record.startedAt),
				finishedAt: iso(record.finishedAt),
			})),
			counts,
			failures: records.filter((record) => record.state === 'failed').length,
			error: row.error,
			trigger: row.trigger,
			createdBy: row.createdBy,
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
			finishedAt: iso(row.finishedAt),
		};
	}

	private planView(target: string, options: ResolvedRolloutOptions, plan: RolloutPlan): NodeRolloutPlanView {
		const facts = this.facts(target);
		const byId = new Map(facts.nodes.map((node) => [node.id, node]));
		const groupsOf = new Map<string, string[]>();
		for (const group of facts.groups) {
			if (new Set(group.nodeIds).size < 2) continue;
			for (const id of group.nodeIds) groupsOf.set(id, [...(groupsOf.get(id) ?? []), group.key]);
		}
		return {
			targetVersion: target,
			strategy: options.strategy,
			options,
			waves: plan.waves.map((wave, index) => ({
				index,
				reason: wave.reason,
				nodes: wave.nodeIds.map((id) => {
					const node = byId.get(id)!;
					return {
						id,
						name: node.name,
						zone: node.zone,
						roles: node.roles,
						agentVersion: node.agentVersion,
						guarded: node.guarded,
						groups: groupsOf.get(id) ?? [],
						singleCopies: node.singleCopies,
					};
				}),
			})),
			skipped: plan.skipped,
			current: plan.current,
			warnings: plan.warnings,
		};
	}

	/** A request's options over the configured defaults (`updates` in the cluster configuration). */
	private parseCreate(raw: unknown) {
		const { autoRollout: _auto, ...defaults } = this.ctx.cluster.get().updates;
		const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
		const merged: Record<string, unknown> = { ...defaults, ...input };
		if (merged.canary === undefined) delete merged.canary;
		const parsed = nodeRolloutCreateSchema.safeParse(raw === undefined || raw === null || typeof raw === 'object' ? merged : raw);
		if (!parsed.success) throw new ValidationError('Invalid rollout request.', parsed.error.issues);
		return parsed.data;
	}

	private assertView(principal: Principal): void {
		if (!this.ctx.platformIam.canView(principal))
			throw new CoreError('forbidden', 'Platform admin permission required to view fleet updates.', 403);
	}

	private assertAdmin(principal: Principal): void {
		if (this.ctx.platformIam.allows(principal, 'platform:updates')) return;
		throw new CoreError(
			'forbidden',
			principal.platformAdmin
				? 'Fleet updates need a platform admin role signed in to the dashboard (not an API key or MCP token).'
				: 'Platform admin permission required.',
			403,
		);
	}
}

function isCurrent(node: NodeRow, target: string): boolean {
	const running = parseSemver(node.agentVersion);
	return running !== null && compareSemver(running, target) >= 0;
}

function names(records: Array<{ name: string }>): string {
	const list = records.map((record) => record.name);
	return list.length <= 3 ? list.join(', ') : `${list.slice(0, 3).join(', ')} and ${list.length - 3} more`;
}
