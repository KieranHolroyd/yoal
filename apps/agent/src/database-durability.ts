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
		'syncConfigure' | 'syncBarrier' | 'writesStop' | 'writesResume' | 'checkpoint' | 'memberStatus' | 'replicationStatus' | 'replicaRewind'
	>;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	now?: () => number;
	fetch?: typeof fetch;
	/** Wait between `pg_stat_replication` samples while the target catches up to the barrier. */
	sleep?: (ms: number) => Promise<void>;
	/** How long the target gets to replay the barrier before the result is a failure. */
	barrierWaitMs?: number;
	pollMs?: number;
}

export class DatabaseDurabilityRunner {
	private readonly controlUrl: string;
	private readonly nodeToken: string;
	private readonly nodeId: string;
	private readonly helper: DatabaseDurabilityRunnerOptions['helper'];
	private readonly log: NonNullable<DatabaseDurabilityRunnerOptions['log']>;
	private readonly now: () => number;
	private readonly fetcher: typeof fetch;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly barrierWaitMs: number;
	private readonly pollMs: number;
	private readonly syncResults = new Map<string, DatabaseSyncResult>();
	private readonly switchoverResults = new Map<string, DatabaseSwitchoverResult>();
	private readonly rewindResults = new Map<string, DatabaseRewindResult>();
	private readonly appliedSync = new Set<string>();
	private readonly inFlight = new Set<string>();
	/** First observation of "the named synchronous standby is not streaming", per database. */
	private readonly syncLostSince = new Map<string, number>();

	constructor(options: DatabaseDurabilityRunnerOptions) {
		this.controlUrl = options.controlUrl;
		this.nodeToken = options.nodeToken;
		this.nodeId = options.nodeId;
		this.helper = options.helper;
		this.log = options.log ?? (() => undefined);
		this.now = options.now ?? Date.now;
		this.fetcher = options.fetch ?? fetch;
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.barrierWaitMs = options.barrierWaitMs ?? 5_000;
		this.pollMs = options.pollMs ?? 100;
	}

	async runOnce(state: DesiredState, signal: AbortSignal): Promise<void> {
		await this.#sync(state, signal);
		await this.#watchdog(state, signal);
		await this.#switchovers(state, signal);
		await this.#rewinds(state, signal);
		// Forget results whose instruction is gone (the control plane applied or abandoned it).
		// A watchdog result has no task, so its own desired entry keeps it until the next heartbeat
		// applies it or the lease snapshot changes.
		const present = new Set((state.databaseSyncTasks ?? []).map((task) => `${task.databaseId}:${task.version}`));
		for (const desired of state.databaseMembers ?? []) {
			if (desired.holderNodeId === this.nodeId) present.add(`watchdog:${desired.databaseId}:${desired.leaseEtag ?? ''}`);
		}
		this.#prune(this.syncResults, present);
		this.#prune(this.switchoverResults, new Set((state.databaseSwitchovers ?? []).map((task) => `${task.switchoverId}:${task.version}`)));
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
				// Never synthesise a role: a member still in recovery is a replica; a primary that
				// carries the leaky read-only flag is fenced for writes (W10 review major 14).
				const role = status.inRecovery
					? status.streaming
						? 'streaming'
						: 'rewind'
					: status.readOnly
						? 'fenced'
						: 'primary';
				reports.push({
					databaseId: desired.databaseId,
					role,
					generation: desired.generation,
					epoch: desired.leaseEpoch,
					streaming: status.streaming,
					inRecovery: status.inRecovery,
					lsn: status.lsn,
					readOnly: status.readOnly,
					fenced: status.readOnly && !status.inRecovery,
					leaseGeneration: desired.leaseGeneration,
					leaseEpoch: desired.leaseEpoch,
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
				const applied = [...task.sync];
				if (task.step === 'set-sync') {
					// Before writing the barrier, the target row must already be `sync`: that is the
					// proof `synchronous_standby_names` took effect, not just that it was written.
					const beforeSlots = await this.helper.replicationStatus(task.databaseId).catch(() => []);
					const before = task.sync[0] ? beforeSlots.find((slot) => slot.slot === task.sync[0]) : undefined;
					if (before?.syncState !== 'sync') {
						this.syncResults.set(key, {
							databaseId: task.databaseId,
							version: task.version,
							step: task.step,
							status: 'failed',
							replayLsn: before?.replayLsn ?? null,
							targetSyncState: before?.syncState ?? null,
							leaseEtag: task.leaseEtag,
							applied,
							error: `The target slot was not sync before the barrier (sync_state ${before?.syncState ?? 'missing'}).`,
						});
						continue;
					}
					const lsn = await this.helper.syncBarrier(task.databaseId);
					// The barrier's LSN is the primary's position. The proof the TARGET has it is the
					// target slot's own `replay_lsn`, polled until it reaches the barrier. The primary's
					// own position is never used here.
					const target = await this.#waitForReplay(task.databaseId, task.sync[0], lsn);
					if (!target?.replayLsn || !lsnReached(target.replayLsn, lsn) || target.syncState !== 'sync') {
						this.syncResults.set(key, {
							databaseId: task.databaseId,
							version: task.version,
							step: task.step,
							status: 'failed',
							lsn,
							replayLsn: target?.replayLsn ?? null,
							targetSyncState: target?.syncState ?? null,
							leaseEtag: task.leaseEtag,
							applied,
							error: `The target did not replay the barrier (barrier ${lsn}, target ${target?.replayLsn ?? 'missing'}, sync_state ${target?.syncState ?? 'missing'}).`,
						});
						continue;
					}
					this.syncResults.set(key, {
						databaseId: task.databaseId,
						version: task.version,
						step: task.step,
						status: 'ok',
						lsn,
						replayLsn: target.replayLsn,
						targetSyncState: target.syncState,
						leaseEtag: task.leaseEtag,
						applied,
					});
					this.log('info', `Sync set for ${task.databaseId} applied; barrier at ${lsn}, target replay ${target.replayLsn}`);
				} else {
					this.syncResults.set(key, {
						databaseId: task.databaseId,
						version: task.version,
						step: task.step,
						status: 'ok',
						lsn: null,
						leaseEtag: task.leaseEtag,
						applied,
					});
				}
				this.appliedSync.add(key);
			} catch (error) {
				this.syncResults.set(key, {
					databaseId: task.databaseId,
					version: task.version,
					step: task.step,
					status: 'failed',
					leaseEtag: task.leaseEtag,
					applied: [...task.sync],
					error: errorText(error).slice(0, 2_000),
				});
				this.log('error', `Sync set for ${task.databaseId} failed: ${errorText(error)}`);
			} finally {
				this.inFlight.delete(key);
			}
		}
	}

	/** Poll the target's `pg_stat_replication` row until it replays `barrierLsn` (bounded). */
	async #waitForReplay(databaseId: string, slot: string | undefined, barrierLsn: string) {
		if (!slot) return undefined;
		const deadline = this.now() + this.barrierWaitMs;
		for (;;) {
			const slots = await this.helper.replicationStatus(databaseId).catch(() => []);
			const target = slots.find((item) => item.slot === slot);
			if (target?.replayLsn && lsnReached(target.replayLsn, barrierLsn)) return target;
			if (this.now() >= deadline) return target;
			await this.sleep(this.pollMs);
		}
	}

	/**
	 * The node-hosted sync-loss watchdog (W9-SPEC §5.5, I11). The primary's node decides from its
	 * own fresh slot sample whether the named synchronous standby is still streaming; it does not
	 * wait for the control plane. It acts only on the lease snapshot in desired state (the ETag is
	 * its ownership token), so a stale snapshot can never clear a newer set. `downgrade` clears the
	 * setting locally; `block` leaves it named and reports so writes wait as configured.
	 */
	async #watchdog(state: DesiredState, signal: AbortSignal): Promise<void> {
		for (const desired of state.databaseMembers ?? []) {
			if (signal.aborted) return;
			if (desired.holderNodeId !== this.nodeId || desired.durability !== 'sync' || desired.syncState !== 'steady') {
				this.syncLostSince.delete(desired.databaseId);
				continue;
			}
			if (desired.durabilityEffective !== 'sync' || desired.sync.length === 0) {
				this.syncLostSince.delete(desired.databaseId);
				continue;
			}
			// No lease token means this node cannot prove which lease it is acting on; fail closed
			// and let the control plane's tick apply the policy.
			if (!desired.leaseEtag) {
				this.syncLostSince.delete(desired.databaseId);
				continue;
			}
			const key = `watchdog:${desired.databaseId}:${desired.leaseEtag ?? ''}`;
			if (this.syncResults.has(key) || this.inFlight.has(key)) continue;
			let slots;
			try {
				slots = await this.helper.replicationStatus(desired.databaseId);
			} catch {
				continue;
			}
			const named = desired.members.filter((member) => desired.sync.includes(member.nodeId));
			const held = named.some((member) => {
				const slot = member.slot ? slots.find((item) => item.slot === member.slot) : undefined;
				return slot?.state === 'streaming' && slot.syncState === 'sync';
			});
			if (held) {
				this.syncLostSince.delete(desired.databaseId);
				continue;
			}
			const since = this.syncLostSince.get(desired.databaseId) ?? this.now();
			if (!this.syncLostSince.has(desired.databaseId)) this.syncLostSince.set(desired.databaseId, since);
			if (this.now() - since < desired.syncTimeoutSeconds * 1_000) continue;
			this.inFlight.add(key);
			try {
				const policy = desired.onSyncLoss === 'block' ? 'block' : 'downgrade';
				if (policy === 'downgrade') await this.helper.syncConfigure(desired.databaseId, []);
				const applied =
					policy === 'downgrade'
						? []
						: desired.members
								.filter((member) => desired.sync.includes(member.nodeId) && member.slot)
								.map((member) => member.slot!);
				this.syncResults.set(key, {
					databaseId: desired.databaseId,
					version: `${desired.leaseEtag ?? ''}:watchdog:${since}`,
					step: 'watchdog',
					status: 'ok',
					lsn: null,
					leaseEtag: desired.leaseEtag,
					targetSyncState: policy,
					applied,
				});
				this.log('warn', `No synchronous standby for ${desired.databaseId}; applied on_sync_loss ${policy} on the primary's node.`);
				this.syncLostSince.delete(desired.databaseId);
			} catch (error) {
				this.syncResults.set(key, {
					databaseId: desired.databaseId,
					version: `${desired.leaseEtag ?? ''}:watchdog:${since}`,
					step: 'watchdog',
					status: 'failed',
					leaseEtag: desired.leaseEtag,
					applied: [],
					error: errorText(error).slice(0, 2_000),
				});
				this.log('error', `Sync-loss watchdog for ${desired.databaseId} failed: ${errorText(error)}`);
			} finally {
				this.inFlight.delete(key);
			}
		}
	}

	async #switchovers(state: DesiredState, signal: AbortSignal): Promise<void> {
		for (const task of state.databaseSwitchovers ?? []) {
			if (signal.aborted) return;
			const key = `${task.switchoverId}:${task.version}`;
			if (this.switchoverResults.has(key) || this.inFlight.has(key)) continue;
			this.inFlight.add(key);
			try {
				if (task.step === 'drain') {
					// The plan's order: checkpoint, then stop writes, which waits for in-flight
					// transactions before the LSN is sampled (W10 review blocker 4).
					await this.helper.checkpoint(task.databaseId);
					await this.helper.writesStop(task.databaseId);
					const status = await this.helper.memberStatus(task.databaseId);
					// A fresh `pg_stat_replication` sample is what proves the target has the primary's
					// final LSN; the replica row's last sample may be up to 30 s old.
					const slots = await this.helper.replicationStatus(task.databaseId).catch(() => []);
					const target = task.replicaSlot ? slots.find((slot) => slot.slot === task.replicaSlot) : undefined;
					this.switchoverResults.set(key, {
						switchoverId: task.switchoverId,
						version: task.version,
						step: 'drain',
						status: 'ok',
						lsn: status.lsn,
						replayLsn: target?.replayLsn ?? null,
					});
					this.log('info', `Drained ${task.databaseId} at ${status.lsn ?? 'unknown LSN'} (replica ${target?.replayLsn ?? 'unknown'})`);
				} else {
					await this.helper.writesResume(task.databaseId);
					this.switchoverResults.set(key, { switchoverId: task.switchoverId, version: task.version, step: 'resume', status: 'ok' });
					this.log('info', `Resumed writes for ${task.databaseId}`);
				}
			} catch (error) {
				this.switchoverResults.set(key, {
					switchoverId: task.switchoverId,
					version: task.version,
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
				// The path is the rewind replica's workload id (`db_dbr_…`); the body names the
				// database whose old data dir is moved into it. Both helper assertions pass.
				const result = await this.helper.replicaRewind(task.workloadId, {
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

/** True when `replay` has reached `barrier` (both `X/Y` hex WAL positions). */
function lsnReached(replay: string | null, barrier: string): boolean {
	const parse = (value: string | null): bigint | null => {
		if (typeof value !== 'string') return null;
		const match = /^([0-9A-F]{1,8})\/([0-9A-F]{1,8})$/i.exec(value);
		return match ? (BigInt(`0x${match[1]}`) << 32n) + BigInt(`0x${match[2]}`) : null;
	};
	const from = parse(replay);
	const to = parse(barrier);
	return from !== null && to !== null && from >= to;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
