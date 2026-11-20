import {
	databaseRewindActivationSchema,
	type DatabaseMemberReport,
	type DatabaseRewindResult,
	type DatabaseSwitchoverResult,
	type DatabaseSyncResult,
	type DesiredState,
} from '@yoal/contracts';
import type { HelperApi } from './helper-client.ts';

/**
 * The node half of W10 (H23 sync set, planned switchover and rewind). It applies the fixed helper
 * verbs the control plane asks for through desired state and reports structured outcomes:
 *
 * - `databaseSyncTasks` — set or clear `synchronous_standby_names`, write the barrier and report its
 *   LSN. The *decision* to open/close is the lease's (`database-sync.ts`); this only executes.
 * - `databaseSwitchovers` — drain (`checkpoint`, stop writes, report the primary LSN) and resume.
 *   Promotion itself reuses the existing `databaseReplicaPromotions` task.
 * - `databaseRewindTasks` — fetch the new primary's replication password, `pg_rewind`, and report
 *   `rewound` or `rebuild`.
 * - `databaseMembers` — probe each member on this node for role, generation and replay position.
 *
 * Lane A owns the keeper/fence machine (`database-member.ts`); this runner is the seam it consumes,
 * and it never decides a promotion.
 */

export interface DatabaseDurabilityRunnerOptions {
	controlUrl: string;
	nodeToken: string;
	nodeId: string;
	helper: Pick<
		HelperApi,
		'syncConfigure' | 'syncBarrier' | 'writesStop' | 'writesResume' | 'memberStatus' | 'replicationStatus' | 'replicaRewind'
	>;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	now?: () => number;
	fetch?: typeof fetch;
}

export class DatabaseDurabilityRunner {
	private readonly controlUrl: string;
	private readonly nodeToken: string;
	private readonly nodeId: string;
	private readonly helper: DatabaseDurabilityRunnerOptions['helper'];
	private readonly log: NonNullable<DatabaseDurabilityRunnerOptions['log']>;
	private readonly now: () => number;
	private readonly fetcher: typeof fetch;
	private readonly syncResults = new Map<string, DatabaseSyncResult>();
	private readonly switchoverResults = new Map<string, DatabaseSwitchoverResult>();
	private readonly rewindResults = new Map<string, DatabaseRewindResult>();
	private readonly appliedSync = new Set<string>();
	private readonly inFlight = new Set<string>();

	constructor(options: DatabaseDurabilityRunnerOptions) {
		this.controlUrl = options.controlUrl;
		this.nodeToken = options.nodeToken;
		this.nodeId = options.nodeId;
		this.helper = options.helper;
		this.log = options.log ?? (() => undefined);
		this.now = options.now ?? Date.now;
		this.fetcher = options.fetch ?? fetch;
	}

	async runOnce(state: DesiredState, signal: AbortSignal): Promise<void> {
		await this.#sync(state, signal);
		await this.#switchovers(state, signal);
		await this.#rewinds(state, signal);
		// Forget results whose instruction is gone (the control plane applied or abandoned it).
		this.#prune(this.syncResults, new Set((state.databaseSyncTasks ?? []).map((task) => `${task.databaseId}:${task.version}`)));
		this.#prune(this.switchoverResults, new Set((state.databaseSwitchovers ?? []).map((task) => `${task.switchoverId}:${task.step}`)));
		this.#prune(this.rewindResults, new Set((state.databaseRewindTasks ?? []).map((task) => task.databaseId)));
	}

	/** One probe per member on this node. Safe to call every heartbeat. */
	async memberReports(state: DesiredState): Promise<DatabaseMemberReport[]> {
		const reports: DatabaseMemberReport[] = [];
		for (const desired of state.databaseMembers ?? []) {
			const member = desired.members.find((item) => item.nodeId === this.nodeId);
			if (!member) continue;
			const workload = workloadForMember(state, desired.databaseId);
			if (!workload) continue;
			try {
				const status = await this.helper.memberStatus(workload);
				reports.push({
					databaseId: desired.databaseId,
					role: status.inRecovery ? (status.streaming ? 'streaming' : 'rewind') : 'primary',
					generation: desired.generation,
					epoch: 0,
					streaming: status.streaming,
					inRecovery: status.inRecovery,
					lsn: status.lsn,
					durabilityEffective: desired.durabilityEffective,
					syncState: desired.syncState,
					observedAt: new Date(this.now()).toISOString(),
				});
			} catch (error) {
				this.log('warn', `Could not probe ${desired.databaseId} on ${this.nodeId}: ${errorText(error)}`);
			}
		}
		return reports.slice(0, 50);
	}

	pendingSyncResults(): DatabaseSyncResult[] {
		return [...this.syncResults.values()].slice(0, 20);
	}

	pendingSwitchoverResults(): DatabaseSwitchoverResult[] {
		return [...this.switchoverResults.values()].slice(0, 20);
	}

	pendingRewindResults(): DatabaseRewindResult[] {
		return [...this.rewindResults.values()].slice(0, 20);
	}

	async #sync(state: DesiredState, signal: AbortSignal): Promise<void> {
		for (const task of state.databaseSyncTasks ?? []) {
			if (signal.aborted) return;
			const key = `${task.databaseId}:${task.version}`;
			if (this.appliedSync.has(key) || this.syncResults.has(key) || this.inFlight.has(key)) continue;
			this.inFlight.add(key);
			try {
				await this.helper.syncConfigure(task.databaseId, task.sync);
				if (task.step === 'set-sync') {
					const lsn = await this.helper.syncBarrier(task.databaseId);
					const status = await this.helper.memberStatus(task.databaseId).catch(() => null);
					this.syncResults.set(key, {
						databaseId: task.databaseId,
						step: task.step,
						status: 'ok',
						lsn,
						replayLsn: status?.lsn ?? lsn,
					});
					this.log('info', `Sync set for ${task.databaseId} applied; barrier at ${lsn}`);
				} else {
					this.syncResults.set(key, { databaseId: task.databaseId, step: task.step, status: 'ok', lsn: null });
				}
				this.appliedSync.add(key);
			} catch (error) {
				this.syncResults.set(key, {
					databaseId: task.databaseId,
					step: task.step,
					status: 'failed',
					error: errorText(error).slice(0, 2_000),
				});
				this.log('error', `Sync set for ${task.databaseId} failed: ${errorText(error)}`);
			} finally {
				this.inFlight.delete(key);
			}
		}
	}

	async #switchovers(state: DesiredState, signal: AbortSignal): Promise<void> {
		for (const task of state.databaseSwitchovers ?? []) {
			if (signal.aborted) return;
			const key = `${task.switchoverId}:${task.step}`;
			if (this.switchoverResults.has(key) || this.inFlight.has(key)) continue;
			this.inFlight.add(key);
			try {
				if (task.step === 'drain') {
					await this.helper.writesStop(task.databaseId);
					const status = await this.helper.memberStatus(task.databaseId);
					// A fresh `pg_stat_replication` sample is what proves the target has the primary's
					// final LSN; the replica row's last sample may be up to 30 s old.
					const slots = await this.helper.replicationStatus(task.databaseId).catch(() => []);
					const target = task.replicaSlot ? slots.find((slot) => slot.slot === task.replicaSlot) : undefined;
					this.switchoverResults.set(key, {
						switchoverId: task.switchoverId,
						step: 'drain',
						status: 'ok',
						lsn: status.lsn,
						replayLsn: target?.replayLsn ?? null,
					});
					this.log('info', `Drained ${task.databaseId} at ${status.lsn ?? 'unknown LSN'} (replica ${target?.replayLsn ?? 'unknown'})`);
				} else {
					await this.helper.writesResume(task.databaseId);
					this.switchoverResults.set(key, { switchoverId: task.switchoverId, step: 'resume', status: 'ok' });
					this.log('info', `Resumed writes for ${task.databaseId}`);
				}
			} catch (error) {
				this.switchoverResults.set(key, {
					switchoverId: task.switchoverId,
					step: task.step,
					status: 'failed',
					error: errorText(error).slice(0, 2_000),
				});
				this.log('error', `Switchover ${task.step} for ${task.databaseId} failed: ${errorText(error)}`);
			} finally {
				this.inFlight.delete(key);
			}
		}
	}

	async #rewinds(state: DesiredState, signal: AbortSignal): Promise<void> {
		for (const task of state.databaseRewindTasks ?? []) {
			if (signal.aborted) return;
			if (this.rewindResults.has(task.databaseId) || this.inFlight.has(task.databaseId)) continue;
			this.inFlight.add(task.databaseId);
			try {
				const response = await this.fetcher(
					`${this.controlUrl}/api/agent/database-rewind/${encodeURIComponent(task.databaseId)}`,
					{ headers: { authorization: `Bearer ${this.nodeToken}`, accept: 'application/json' }, signal },
				);
				if (!response.ok) throw new Error(`rewind activation -> ${response.status}`);
				const activation = databaseRewindActivationSchema.parse(await response.json());
				const result = await this.helper.replicaRewind(task.databaseId, {
					databaseId: task.databaseId,
					source: { host: activation.source.address ?? '', port: activation.source.port, user: 'yoal_repl', database: 'postgres' },
					password: activation.password,
					image: activation.image,
				});
				this.rewindResults.set(task.databaseId, {
					databaseId: task.databaseId,
					status: result.status,
					...(result.error ? { error: result.error.slice(0, 2_000) } : {}),
				});
				this.log(
					result.status === 'rewound' ? 'info' : 'warn',
					`${task.databaseId} ${result.status === 'rewound' ? 'rewound and follows the new primary' : 'could not rewind; rebuilding'}`,
				);
			} catch (error) {
				this.rewindResults.set(task.databaseId, {
					databaseId: task.databaseId,
					status: 'rebuild',
					error: errorText(error).slice(0, 2_000),
				});
				this.log('error', `Rewind for ${task.databaseId} failed: ${errorText(error)}`);
			} finally {
				this.inFlight.delete(task.databaseId);
			}
		}
	}

	#prune<T>(results: Map<string, T>, present: Set<string>): void {
		for (const key of results.keys()) if (!present.has(key)) results.delete(key);
	}
}

/** The workload id on this node that runs a database's member (`db_<id>` or its replica). */
function workloadForMember(state: DesiredState, databaseId: string): string | null {
	const own = state.workloads.find((workload) => workload.id === `db_${databaseId}`);
	if (own) return own.id;
	const replica = state.workloads.find(
		(workload) => workload.database?.engine === 'postgres' && workload.projectId === databaseId,
	);
	return replica?.id ?? null;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
