import {
	DATABASE_REPLICATION_SAMPLE_SECONDS,
	databaseReplicaRewindActivationSchema,
	databaseReplicationActivationSchema,
	type DatabaseReplicaPromotionResult,
	type DatabaseReplicaPromotionTask,
	type DatabaseReplicaRewindResult,
	type DatabaseReplicaRewindTask,
	type DatabaseReplicationReport,
	type DatabaseReplicationSlotStatus,
	type DesiredState,
} from '@yoal/contracts';
import type { HelperApi } from './helper-client.ts';

/**
 * Streaming replication on this node (docs/CLUSTERING.md §9.2–9.3, C7).
 *
 * As a primary's node it keeps each `databaseReplication` task applied: the replication password
 * is fetched from the node-authenticated activation endpoint just before the helper's configure
 * verb and never stored. Every 30 s (and right after a configure) it samples the primary's slots;
 * the latest outcome per database rides every heartbeat, and the control plane derives each
 * replica's status and lag from it.
 *
 * As a replica's node it runs `databaseReplicaPromotions`: the replica workload is held (the
 * runtime must not restart it while its data directory is handed over), the helper promotes it,
 * and the result waits for a heartbeat to acknowledge it.
 */

export interface DatabaseReplicationRunnerOptions {
	controlUrl: string;
	nodeToken: string;
	helper: Pick<HelperApi, 'replicationConfigure' | 'replicationStatus' | 'replicaPromote' | 'rewindReplica'>;
	/** The workload runtime: a promoted replica must not be re-applied by the reconcile loop. */
	runtime: { hold(id: string): void; release(id: string): void };
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	now?: () => number;
	/** Retry a failed configure of the same version after this long. */
	retryMs?: number;
	sampleIntervalMs?: number;
	fetch?: typeof fetch;
}

interface DatabaseState {
	appliedVersion: string | null;
	error: string | null;
	failedVersion: string | null;
	failedAt: number;
	slots: DatabaseReplicationSlotStatus[] | null;
	sampledAt: number | null;
}

export class DatabaseReplicationRunner {
	private readonly controlUrl: string;
	private readonly nodeToken: string;
	private readonly helper: DatabaseReplicationRunnerOptions['helper'];
	private readonly runtime: DatabaseReplicationRunnerOptions['runtime'];
	private readonly log: NonNullable<DatabaseReplicationRunnerOptions['log']>;
	private readonly now: () => number;
	private readonly retryMs: number;
	private readonly sampleIntervalMs: number;
	private readonly fetcher: typeof fetch;
	private readonly databases = new Map<string, DatabaseState>();
	private lastSampleAt = Number.NEGATIVE_INFINITY;
	private readonly results = new Map<string, DatabaseReplicaPromotionResult>();
	private readonly rewindResults = new Map<string, DatabaseReplicaRewindResult>();
	private readonly completed = new Set<string>();
	private readonly inFlight = new Set<string>();
	/** Replica workloads held for a promotion, released once they leave desired state. */
	private readonly held = new Map<string, string>();

	constructor(options: DatabaseReplicationRunnerOptions) {
		this.controlUrl = options.controlUrl;
		this.nodeToken = options.nodeToken;
		this.helper = options.helper;
		this.runtime = options.runtime;
		this.log = options.log ?? (() => undefined);
		this.now = options.now ?? Date.now;
		this.retryMs = options.retryMs ?? 30_000;
		this.sampleIntervalMs = options.sampleIntervalMs ?? DATABASE_REPLICATION_SAMPLE_SECONDS * 1000;
		this.fetcher = options.fetch ?? fetch;
	}

	/** The latest configure outcome and slot sample per primary on this node, for the heartbeat. */
	reports(): DatabaseReplicationReport[] {
		return [...this.databases.entries()].slice(0, 100).map(([databaseId, state]) => ({
			databaseId,
			appliedVersion: state.appliedVersion,
			error: state.error,
			slots: state.slots,
			sampledAt: new Date(state.sampledAt ?? this.now()).toISOString(),
		}));
	}

	pendingPromotionResults(): DatabaseReplicaPromotionResult[] {
		return [...this.results.values()].slice(0, 20);
	}

	pendingRewindResults(): DatabaseReplicaRewindResult[] {
		return [...this.rewindResults.values()].slice(0, 20);
	}

	acknowledgeRewinds(replicaIds: readonly string[]): void {
		for (const id of replicaIds) this.rewindResults.delete(id);
	}

	acknowledgePromotions(failoverIds: readonly string[]): void {
		for (const id of failoverIds) {
			this.results.delete(id);
			this.completed.add(id);
		}
	}

	async runOnce(state: DesiredState, signal: AbortSignal): Promise<void> {
		const tasks = state.databaseReplication ?? [];
		const present = new Set(tasks.map((task) => task.databaseId));
		for (const id of [...this.databases.keys()]) if (!present.has(id)) this.databases.delete(id);
		let configured = false;
		for (const task of tasks) {
			if (signal.aborted) return;
			const current = this.databases.get(task.databaseId) ?? emptyState();
			this.databases.set(task.databaseId, current);
			if (current.appliedVersion === task.version) continue;
			if (current.failedVersion === task.version && this.now() - current.failedAt < this.retryMs) continue;
			configured = (await this.configure(task, current, signal)) || configured;
		}
		if (configured || this.now() - this.lastSampleAt >= this.sampleIntervalMs) {
			this.lastSampleAt = this.now();
			for (const task of tasks) {
				if (signal.aborted) return;
				await this.sample(task.databaseId);
			}
		}
		await this.promote(state, signal);
		await this.rewind(state, signal);
	}

	private async configure(
		task: DesiredState['databaseReplication'][number],
		current: DatabaseState,
		signal: AbortSignal,
	): Promise<boolean> {
		try {
			const response = await this.fetcher(
				`${this.controlUrl}/api/agent/database-replication/${encodeURIComponent(task.databaseId)}`,
				{ headers: { authorization: `Bearer ${this.nodeToken}`, accept: 'application/json' }, signal },
			);
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				throw new Error(`replication activation -> ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
			}
			const activation = databaseReplicationActivationSchema.parse(await response.json());
			// Desired state moved on while we fetched: the next pass picks up the newer task.
			if (activation.databaseId !== task.databaseId || activation.version !== task.version) return false;
			await this.helper.replicationConfigure(task.databaseId, { slots: activation.slots, password: activation.password });
			current.appliedVersion = task.version;
			current.error = null;
			current.failedVersion = null;
			this.log('info', `Replication for ${task.databaseId} applied (${activation.slots.length} slot(s))`);
			return true;
		} catch (error) {
			current.error = errorText(error).slice(0, 2_000);
			current.failedVersion = task.version;
			current.failedAt = this.now();
			this.log('warn', `Could not configure replication for ${task.databaseId}: ${current.error}`);
			return false;
		}
	}

	private async sample(databaseId: string): Promise<void> {
		const current = this.databases.get(databaseId);
		if (!current) return;
		try {
			current.slots = await this.helper.replicationStatus(databaseId);
		} catch (error) {
			// The primary is not answering (stopped, restarting): report no sample, not stale data.
			current.slots = null;
			this.log('warn', `Could not sample replication for ${databaseId}: ${errorText(error)}`);
		}
		current.sampledAt = this.now();
	}

	private async promote(state: DesiredState, signal: AbortSignal): Promise<void> {
		const desiredIds = new Set(state.workloads.map((workload) => workload.id));
		for (const [failoverId, workloadId] of [...this.held]) {
			if (desiredIds.has(workloadId)) continue;
			this.runtime.release(workloadId);
			this.held.delete(failoverId);
		}
		const tasks = state.databaseReplicaPromotions ?? [];
		const present = new Set(tasks.map((task) => task.failoverId));
		for (const id of [...this.completed]) if (!present.has(id)) this.completed.delete(id);
		for (const task of tasks) {
			if (signal.aborted) return;
			if (this.completed.has(task.failoverId) || this.inFlight.has(task.failoverId) || this.results.has(task.failoverId))
				continue;
			await this.execute(task);
		}
	}

	/**
	 * Rewind old primaries onto the new primary (HA-PLAN W10). The workload is not in desired state
	 * until this finishes (the control plane holds it back), so nothing races the adopted data dir.
	 * The credential is fetched per task and never stored; the result rides a heartbeat.
	 */
	private async rewind(state: DesiredState, signal: AbortSignal): Promise<void> {
		const tasks = state.databaseReplicaRewinds ?? [];
		for (const task of tasks) {
			if (signal.aborted) return;
			if (this.completed.has(`rewind:${task.replicaId}`) || this.inFlight.has(`rewind:${task.replicaId}`))
				continue;
			if (this.rewindResults.has(task.replicaId)) continue;
			await this.executeRewind(task, signal);
		}
	}

	private async executeRewind(task: DatabaseReplicaRewindTask, signal: AbortSignal): Promise<void> {
		this.inFlight.add(`rewind:${task.replicaId}`);
		try {
			const response = await this.fetcher(
				`${this.controlUrl}/api/agent/database-rewind/${encodeURIComponent(task.replicaId)}`,
				{
					headers: { authorization: `Bearer ${this.nodeToken}`, accept: 'application/json' },
					signal,
				},
			);
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				throw new Error(`rewind activation -> ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
			}
			const activation = databaseReplicaRewindActivationSchema.parse(await response.json());
			if (activation.replicaId !== task.replicaId || activation.databaseId !== task.databaseId)
				throw new Error('The rewind activation does not match the desired task');
			const result = await this.helper.rewindReplica(task.replicaWorkloadId, {
				databaseId: task.databaseId,
				walLogHints: task.walLogHints,
				user: activation.user,
				password: activation.password,
			});
			this.rewindResults.set(task.replicaId, {
				replicaId: task.replicaId,
				status: result.rewound ? 'ok' : result.fallback ? 'fallback' : 'failed',
				rewound: result.rewound,
				...(result.reason ? { reason: result.reason } : {}),
			});
			this.log(
				'info',
				result.rewound
					? `Rewound ${task.databaseId} onto ${task.replicaWorkloadId}`
					: `Rebuilding ${task.replicaWorkloadId} instead of rewinding${result.reason ? `: ${result.reason}` : ''}`,
			);
		} catch (error) {
			this.rewindResults.set(task.replicaId, {
				replicaId: task.replicaId,
				status: 'failed',
				rewound: false,
				error: errorText(error).slice(0, 2_000),
			});
			this.log('error', `Could not rewind ${task.databaseId} onto ${task.replicaWorkloadId}: ${errorText(error)}`);
		} finally {
			this.inFlight.delete(`rewind:${task.replicaId}`);
		}
	}

	private async execute(task: DatabaseReplicaPromotionTask): Promise<void> {		this.inFlight.add(task.failoverId);
		this.runtime.hold(task.replicaWorkloadId);
		this.held.set(task.failoverId, task.replicaWorkloadId);
		try {
			const { lsn } = await this.helper.replicaPromote(task.replicaWorkloadId, task.databaseId);
			this.results.set(task.failoverId, { failoverId: task.failoverId, status: 'ok', lsn });
			this.log('info', `Promoted ${task.replicaWorkloadId} to primary of ${task.databaseId}${lsn ? ` at ${lsn}` : ''}`);
		} catch (error) {
			// Not handed over: the replica goes back to normal reconcile; the control plane decides.
			this.runtime.release(task.replicaWorkloadId);
			this.held.delete(task.failoverId);
			this.results.set(task.failoverId, {
				failoverId: task.failoverId,
				status: 'failed',
				error: errorText(error).slice(0, 2_000),
			});
			this.log('error', `Could not promote ${task.replicaWorkloadId}: ${errorText(error)}`);
		} finally {
			this.inFlight.delete(task.failoverId);
		}
	}
}

function emptyState(): DatabaseState {
	return { appliedVersion: null, error: null, failedVersion: null, failedAt: 0, slots: null, sampledAt: null };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
