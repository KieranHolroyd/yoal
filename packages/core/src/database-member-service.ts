import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
	databaseFailovers,
	databaseReplicas,
	databaseReplication,
	databases,
	nodeCertificates,
	nodes,
} from '@yoal/db';
import {
	DATABASE_REPLICA_REPORT_STALE_SECONDS,
	DB_MEMBER_CAPABILITY,
	databaseImage,
	databaseReplicaReadable,
	databaseReplicaWorkloadId,
	type DatabaseDurability,
	type DatabaseDurabilityStatus,
	type DatabaseLease,
	type DatabaseMember,
	type DatabaseMemberReport,
	type DatabaseMembersDesired,
	type DatabaseRewindResult,
	type DatabaseRewindTask,
	type DatabaseSwitchoverRequest,
	type DatabaseSwitchoverResult,
	type DatabaseSwitchoverTask,
	type DatabaseSwitchoverView,
	type DatabaseSyncResult,
	type DatabaseSyncTask,
	type DurabilitySettings,
	type DurabilitySettingsUpdate,
	type Principal,
} from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import {
	SYNC_CHANGE_TIMEOUT_MS,
	ObjectStoreDatabaseLeaseStore,
	acquireRefusal,
	barrierHolds,
	closeSyncChange,
	databaseLeaseKey,
	fallbackSyncChange,
	loseSyncSet,
	openSyncChange,
	parseLsn,
	syncLossDecision,
	type DatabaseLeaseStore,
	type SyncMemberView,
} from './database-sync.ts';
import type { SwitchoverStep } from './database-switchover.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { slotName } from './database-replica-service.ts';
import type { DatabaseRow } from './databases.ts';
import { newId, parseJson, sha256Hex } from './util.ts';

/**
 * Database members, durability, the synchronous set and planned switchover (HA-PLAN H21–H23, W10;
 * docs/build-plan/W9-SPEC.md Revision 1).
 *
 * The arbiter's lease object is the authority for the sync set and the transition flag. The row
 * columns are a display cache and the instruction the primary's node renders, so the dashboard,
 * REST and CLI never need a synchronous arbiter read. The engine (`database-sync.ts`) is pure; this
 * service persists its decisions and, while lane A has not merged the node-side member machine,
 * drives the same pure transitions from the control plane through desired state + heartbeat. The
 * seam is `DatabaseSyncTask` / `DatabaseSyncResult`: lane A can host `SyncSetTransition` unchanged.
 */

const DB_LEASE_TTL_MS = 15_000;

type FailoverRow = typeof databaseFailovers.$inferSelect;
type ReplicaRow = typeof databaseReplicas.$inferSelect;

export class DatabaseMemberService {
	constructor(private readonly ctx: CoreContext) {}

	// ---------------------------------------------------------------- surfaces

	/** The primary and its replicas, as every consumer should ask for role and generation. */
	members(databaseId: string): DatabaseMember[] {
		const database = this.ctx.db.select().from(databases).where(eq(databases.id, databaseId)).get();
		if (!database || database.deletedAt) throw new NotFoundError('Database');
		const primary = this.ctx.db
			.select({ id: nodes.id, address: nodes.privateAddress })
			.from(nodes)
			.where(eq(nodes.id, database.nodeId))
			.get();
		const replicas = this.ctx.db
			.select({ nodeId: databaseReplicas.nodeId, address: nodes.privateAddress })
			.from(databaseReplicas)
			.innerJoin(nodes, eq(nodes.id, databaseReplicas.nodeId))
			.where(and(eq(databaseReplicas.databaseId, databaseId), isNull(databaseReplicas.removingAt)))
			.all();
		return [
			...(primary ? [{ nodeId: primary.id, address: primary.address, role: 'primary' as const }] : []),
			...replicas.map((row) => ({ nodeId: row.nodeId, address: row.address, role: 'replica' as const })),
		];
	}

	durability(databaseId: string): DurabilitySettings {
		const row = this.ctx.db
			.select({
				durability: databases.durability,
				syncTimeoutSeconds: databases.syncTimeoutSeconds,
				onSyncLoss: databases.onSyncLoss,
			})
			.from(databases)
			.where(eq(databases.id, databaseId))
			.get();
		if (!row) throw new NotFoundError('Database');
		return row;
	}

	/** The desired-state entry lane B renders; null while the flag is off or there is no replica. */
	membersDesired(databaseId: string): DatabaseMembersDesired | null {
		if (!featureEnabled(this.ctx.config, 'SYNC_REPLICA')) return null;
		const row = this.ctx.db.select().from(databases).where(eq(databases.id, databaseId)).get();
		if (!row) return null;
		const members = this.members(databaseId);
		if (members.length < 2) return null;
		return {
			databaseId,
			generation: row.primaryGeneration,
			members,
			// While a change is open the lease names nobody; the target rides `databaseSyncTasks`.
			sync: row.syncState === 'changing' ? [] : row.syncReplicaNodeId ? [row.syncReplicaNodeId] : [],
			durability: row.durability,
			syncState: row.syncState,
			durabilityEffective: row.durabilityEffective,
		};
	}

	/** The requested policy and what the lease says is in force. */
	async status(principal: Principal, databaseName: string): Promise<DatabaseDurabilityStatus> {
		const database = this.ctx.databases.requireRow(principal, databaseName);
		this.ctx.iam.require(principal, 'database:read', { type: 'database', id: database.id });
		let lease: DatabaseLease | null = null;
		let note: string | null = null;
		try {
			lease = (await this.#store()?.read(database.id))?.lease ?? null;
		} catch (error) {
			note = `The arbiter could not be read: ${errorText(error)}`;
		}
		const startedAt = database.syncChangeStartedAt;
		return {
			databaseId: database.id,
			generation: database.primaryGeneration,
			durability: database.durability,
			durabilityEffective: database.durabilityEffective,
			syncState: database.syncState,
			sync: lease?.sync ?? (database.syncReplicaNodeId ? [database.syncReplicaNodeId] : []),
			syncSetAt: database.syncSetAt ? new Date(database.syncSetAt).toISOString() : null,
			syncTimeoutSeconds: database.syncTimeoutSeconds,
			onSyncLoss: database.onSyncLoss,
			transition:
				database.syncState === 'changing' && startedAt !== null
					? {
							phase: 'switching',
							target: database.syncReplicaNodeId,
							previous: database.syncPreviousNodeId ? [database.syncPreviousNodeId] : [],
							openedAt: new Date(startedAt).toISOString(),
							deadline: new Date(startedAt + SYNC_CHANGE_TIMEOUT_MS).toISOString(),
							barrierLsn: null,
						}
					: null,
			lease,
			note: note ?? this.#note(database),
		};
	}

	/**
	 * Set the durability policy (H23). `sync` is refused unless the prerequisites hold, and is
	 * always entered through the non-promotable three-step change: the lease opens `changing`, the
	 * primary's node sets the setting and writes the barrier, and only the acknowledged barrier
	 * closes it. `async` closes at once (it is the weaker mode, so there is no RPO window).
	 */
	async setDurability(
		principal: Principal,
		databaseName: string,
		raw: DurabilitySettingsUpdate,
	): Promise<DatabaseDurabilityStatus> {
		const database = this.ctx.databases.requireRow(principal, databaseName);
		this.ctx.iam.require(principal, 'database:update', { type: 'database', id: database.id });
		if (!featureEnabled(this.ctx.config, 'SYNC_REPLICA'))
			throw new CoreError('unavailable', 'Synchronous replicas are off: enable SYNC_REPLICA first (HA-PLAN H23).', 409);
		if (database.engine !== 'postgres')
			throw new ValidationError('Durability settings are only available for Postgres.');
		if (!this.#nodeHasDbMember(database.nodeId))
			throw new ConflictError(`The agent on the primary's node is too old to apply a sync set; update it first (needs "${DB_MEMBER_CAPABILITY}").`);
		this.ctx.moves.assertNotMoving(database);
		if (this.ctx.databaseReplicas.rowsFor(database.id).some((row) => row.removingAt))
			throw new ConflictError('A replica is being removed; wait for it to finish before changing durability.');
		const current = this.durability(database.id);
		const next: DurabilitySettings = {
			durability: raw.durability ?? current.durability,
			syncTimeoutSeconds: raw.syncTimeoutSeconds ?? current.syncTimeoutSeconds,
			onSyncLoss: raw.onSyncLoss ?? current.onSyncLoss,
		};
		const unchangedSet =
			next.durability === 'sync' &&
			database.durability === 'sync' &&
			database.syncState === 'steady' &&
			database.syncReplicaNodeId !== null &&
			(() => {
				const replica = this.#replicaOn(database.id, database.syncReplicaNodeId);
				return Boolean(replica && this.#memberHealthy(database, replica));
			})();
		if (database.syncState === 'changing' && !unchangedSet)
			throw new ConflictError(
				`"${database.name}" has a sync-set change open (non-promotable, W9-SPEC §5.5). Wait for it to close or fall back before starting another.`,
			);
		if (unchangedSet)
			this.ctx.db
				.update(databases)
				.set({ syncTimeoutSeconds: next.syncTimeoutSeconds, onSyncLoss: next.onSyncLoss, updatedAt: this.ctx.now() })
				.where(eq(databases.id, database.id))
				.run();
		else if (next.durability === 'sync') await this.#armSync(database, next, principal);
		else await this.#setAsync(database, next);
		this.ctx.audit.record({
			principal: principal,
			action: 'database.durability.update',
			resource: 'database',
			resourceId: database.id,
			args: { name: database.name, from: current, to: next },
			result: 'ok',
		});
		this.ctx.projects.bump(database.orgId);
		return this.status(principal, database.name);
	}

	/** Planned switchover: checkpoint, stop writes, LSN equality, promote, re-point (refuse on a gap). */
	async switchover(
		principal: Principal,
		databaseName: string,
		raw: DatabaseSwitchoverRequest,
	): Promise<DatabaseSwitchoverView> {
		const database = this.ctx.databases.requireRow(principal, databaseName);
		this.ctx.iam.require(principal, 'database:update', { type: 'database', id: database.id });
		if (!featureEnabled(this.ctx.config, 'SYNC_REPLICA'))
			throw new CoreError('unavailable', 'Planned switchover is off: enable SYNC_REPLICA first (HA-PLAN W10).', 409);
		if (database.engine !== 'postgres') throw new ValidationError('Only Postgres supports switchover.');
		if (!this.#nodeHasDbMember(database.nodeId))
			throw new ConflictError(`The agent on the primary's node is too old for a planned drain; update it first (needs "${DB_MEMBER_CAPABILITY}").`);
		this.ctx.moves.assertNotMoving(database);
		if (this.#activeFailover(database.id)) throw new ConflictError(`"${database.name}" is already failing over.`);
		if (database.syncState === 'changing')
			throw new ConflictError(
				`"${database.name}" has a sync-set change open, which is non-promotable (W9-SPEC §5.5). Wait for it to close, or choose manually.`,
			);
		const replica = this.ctx.db
			.select()
			.from(databaseReplicas)
			.where(and(eq(databaseReplicas.id, raw.replicaId), eq(databaseReplicas.databaseId, database.id)))
			.get();
		if (!replica || replica.removingAt) throw new NotFoundError('Database replica');
		if (replica.nodeId === database.nodeId)
			throw new ValidationError('A replica on the primary\'s own node cannot take over; add one on another node.');
		if (!this.#nodeHasDbMember(replica.nodeId))
			throw new ConflictError(`The agent on "${this.#node(replica.nodeId)?.name ?? replica.nodeId}" is too old to promote for a switchover; update it first.`);
		if (replica.primaryGeneration !== database.primaryGeneration)
			throw new ConflictError('This replica follows an older primary; it is being rebuilt.');
		if (!databaseReplicaReadable(replica.status))
			throw new ConflictError(`This replica is ${replica.status}; it cannot take over.`);
		if (database.durability === 'sync' && !this.#memberHealthy(database, replica))
			throw new ConflictError('This replica has not reported a fresh replay position; refusing a switchover to it.');
		const now = this.ctx.now();
		const id = newId('dfo_');
		this.ctx.db
			.insert(databaseFailovers)
			.values({
				id,
				databaseId: database.id,
				fromNodeId: database.nodeId,
				toNodeId: replica.nodeId,
				generation: database.primaryGeneration + 1,
				status: 'pending',
				kind: 'switchover',
				switchoverStep: 'drain',
				switchoverStartedAt: now,
				reason: `Planned switchover by ${principal.userId ?? principal.kind ?? 'operator'}.`,
				startedAt: now,
				replicaId: replica.id,
			})
			.run();
		this.ctx.audit.record({
			principal: principal,
			action: 'database.switchover.start',
			resource: 'database',
			resourceId: database.id,
			args: { name: database.name, replicaId: replica.id, from: database.nodeId, to: replica.nodeId, generation: database.primaryGeneration + 1 },
			result: 'ok',
		});
		this.ctx.projects.bump(database.orgId);
		return this.#switchoverView(this.#failover(id)!, database);
	}

	/** Recent switchovers and failures for one database, newest first. */
	switchovers(principal: Principal, databaseName: string): DatabaseSwitchoverView[] {
		const database = this.ctx.databases.requireRow(principal, databaseName, { includeDeleted: true });
		this.ctx.iam.require(principal, 'database:read', { type: 'database', id: database.id });
		return this.ctx.db
			.select()
			.from(databaseFailovers)
			.where(and(eq(databaseFailovers.databaseId, database.id), eq(databaseFailovers.kind, 'switchover')))
			.orderBy(desc(databaseFailovers.startedAt))
			.limit(20)
			.all()
			.map((row) => this.#switchoverView(row, database));
	}

	/** Role discovery: what a consumer's 1–2 s poll receives from one member. */
	memberRole(databaseId: string, nodeId: string): DatabaseMemberReport | null {
		const database = this.ctx.db.select().from(databases).where(eq(databases.id, databaseId)).get();
		if (!database) return null;
		const report = this.#lastMemberReport(databaseId, nodeId);
		if (report) return report;
		const role = database.nodeId === nodeId ? 'primary' : 'streaming';
		return {
			databaseId,
			role,
			generation: database.primaryGeneration,
			epoch: 0,
			streaming: database.nodeId === nodeId ? true : false,
			inRecovery: database.nodeId !== nodeId,
			lsn: null,
			durabilityEffective: database.durabilityEffective,
			syncState: database.syncState,
			observedAt: new Date(this.ctx.now()).toISOString(),
		};
	}

	// ---------------------------------------------------------------- desired state

	/** Requested durable members: the primary and its replicas, by node. */
	membersDesiredForNode(nodeId: string): DatabaseMembersDesired[] {
		if (!featureEnabled(this.ctx.config, 'SYNC_REPLICA')) return [];
		const rows = this.ctx.db
			.select({ databaseId: databases.id })
			.from(databases)
			.where(and(eq(databases.nodeId, nodeId), isNull(databases.deletedAt)))
			.all();
		const replicaRows = this.ctx.db
			.select({ databaseId: databaseReplicas.databaseId })
			.from(databaseReplicas)
			.where(and(eq(databaseReplicas.nodeId, nodeId), isNull(databaseReplicas.removingAt)))
			.all();
		const ids = new Set([...rows.map((row) => row.databaseId), ...replicaRows.map((row) => row.databaseId)]);
		return [...ids].flatMap((id) => {
			const desired = this.membersDesired(id);
			return desired ? [desired] : [];
		});
	}

	/** Every database with a replica, for every node's desired state, so any consumer can poll. */
	membersDesiredAll(limit = 500): DatabaseMembersDesired[] {
		if (!featureEnabled(this.ctx.config, 'SYNC_REPLICA')) return [];
		const ids = this.ctx.db
			.selectDistinct({ databaseId: databaseReplicas.databaseId })
			.from(databaseReplicas)
			.innerJoin(databases, eq(databases.id, databaseReplicas.databaseId))
			.where(and(isNull(databaseReplicas.removingAt), isNull(databases.deletedAt)))
			.all()
			.slice(0, limit)
			.map((row) => row.databaseId);
		return ids.flatMap((id) => {
			const desired = this.membersDesired(id);
			return desired ? [desired] : [];
		});
	}

	/** Sync-set steps the primary's node must apply (step 1's open already happened). */
	syncTasksForNode(nodeId: string): DatabaseSyncTask[] {
		if (!featureEnabled(this.ctx.config, 'SYNC_REPLICA') || !this.#nodeHasDbMember(nodeId)) return [];
		const rows = this.ctx.db
			.select()
			.from(databases)
			.where(and(eq(databases.nodeId, nodeId), isNull(databases.deletedAt)))
			.all();
		const tasks: DatabaseSyncTask[] = [];
		for (const row of rows) {
			if (row.durability === 'sync' && row.syncState === 'changing' && row.syncReplicaNodeId) {
				const replica = this.#replicaOn(row.id, row.syncReplicaNodeId);
				if (!replica?.slot) continue;
				tasks.push({
					databaseId: row.id,
					version: sha256Hex(JSON.stringify({ v: 1, step: 'set-sync', target: row.syncReplicaNodeId, slot: replica.slot, gen: row.primaryGeneration })),
					step: 'set-sync',
					sync: [replica.slot],
				});
				continue;
			}
			// Only a downgrade (or an explicit async) clears the setting. A `block` leaves the
			// unavailable member named so writes keep waiting.
			if (row.syncState === 'steady' && row.syncReplicaNodeId === null && row.syncSetAt !== null && row.durabilityEffective === 'async')
				tasks.push({
					databaseId: row.id,
					version: sha256Hex(JSON.stringify({ v: 1, step: 'clear-sync', gen: row.primaryGeneration, effective: row.durabilityEffective })),
					step: 'clear-sync',
					sync: [],
				});
		}
		return tasks;
	}

	/** Drain/resume steps for a planned switchover on the old primary's node. */
	switchoverTasksForNode(nodeId: string): DatabaseSwitchoverTask[] {
		if (!featureEnabled(this.ctx.config, 'SYNC_REPLICA') || !this.#nodeHasDbMember(nodeId)) return [];
		const rows = this.ctx.db
			.select()
			.from(databaseFailovers)
			.where(
				and(
					eq(databaseFailovers.fromNodeId, nodeId),
					eq(databaseFailovers.kind, 'switchover'),
					inArray(databaseFailovers.status, ['pending', 'failed']),
				),
			)
			.all();
		return rows.flatMap((row) => {
			const step = row.switchoverStep;
			if (step !== 'drain' && step !== 'resume') return [];
			const replica = row.replicaId
				? this.ctx.db.select({ slot: databaseReplicas.slot }).from(databaseReplicas).where(eq(databaseReplicas.id, row.replicaId)).get()
				: undefined;
			return [{ switchoverId: row.id, databaseId: row.databaseId, step, replicaSlot: replica?.slot ?? null }];
		});
	}

	/** The old primary of a completed switchover, to rewind against the new primary. */
	rewindTasksForNode(nodeId: string): DatabaseRewindTask[] {
		if (!featureEnabled(this.ctx.config, 'SYNC_REPLICA') || !this.#nodeHasDbMember(nodeId)) return [];
		const rows = this.ctx.db
			.select({ failover: databaseFailovers, database: databases })
			.from(databaseFailovers)
			.innerJoin(databases, eq(databases.id, databaseFailovers.databaseId))
			.where(
				and(
					eq(databaseFailovers.fromNodeId, nodeId),
					eq(databaseFailovers.kind, 'switchover'),
					eq(databaseFailovers.status, 'completed'),
					isNull(databaseFailovers.rewoundAt),
				),
			)
			.all();
		return rows.flatMap(({ failover, database }) => {
			if (database.nodeId === nodeId || !failover.rewindReplicaId) return [];
			const source = this.ctx.db.select().from(nodes).where(eq(nodes.id, database.nodeId)).get();
			return [
				{
					databaseId: database.id,
					workloadId: databaseReplicaWorkloadId(failover.rewindReplicaId),
					generation: database.primaryGeneration,
					source: {
						nodeId: database.nodeId,
						address: source?.privateAddress ?? null,
						port: database.hostPort,
						tlsFingerprint: this.#fingerprint(database.nodeId),
					},
				},
			];
		});
	}

	/** The `yoal_repl` password for a rewind, for the old primary's node only. */
	rewindActivation(nodeId: string, databaseId: string): {
		databaseId: string;
		version: string;
		source: DatabaseRewindTask['source'];
		image: string;
		password: string;
	} {
		const database = this.ctx.db.select().from(databases).where(eq(databases.id, databaseId)).get();
		if (!database || database.deletedAt) throw new NotFoundError('Database');
		const task = this.rewindTasksForNode(nodeId).find((item) => item.databaseId === databaseId);
		if (!task) throw new ConflictError('This database has no rewind waiting on this node.');
		const replication = this.ctx.db.select().from(databaseReplication).where(eq(databaseReplication.databaseId, databaseId)).get();
		if (!replication) throw new ConflictError('The new primary has no replication role yet.');
		return {
			databaseId,
			version: sha256Hex(JSON.stringify({ v: 1, source: task.source, secret: sha256Hex(replication.secretSealed) })),
			source: task.source,
			image: databaseImage(database.engine, database.version, database.variant),
			password: this.ctx.secrets.open(database.orgId, replication.secretSealed),
		};
	}

	// ---------------------------------------------------------------- heartbeat

	/** Member reports (role, generation, replay position) from every node. */
	applyMemberReports(nodeId: string, reports: readonly DatabaseMemberReport[]): void {
		const now = this.ctx.now();
		let changed = false;
		for (const report of reports.slice(0, 50)) {
			if (this.#lastMemberReport(report.databaseId, nodeId)?.observedAt === report.observedAt) continue;
			this.ctx.sqlite.run(
				`INSERT INTO database_member_status (database_id, node_id, role, generation, epoch, streaming, in_recovery, lsn, durability_effective, sync_state, observed_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(database_id, node_id) DO UPDATE SET role = excluded.role, generation = excluded.generation,
				 epoch = excluded.epoch, streaming = excluded.streaming, in_recovery = excluded.in_recovery,
				 lsn = excluded.lsn, durability_effective = excluded.durability_effective, sync_state = excluded.sync_state,
				 observed_at = excluded.observed_at`,
				[
					report.databaseId,
					nodeId,
					report.role,
					report.generation,
					report.epoch,
					report.streaming ? 1 : 0,
					report.inRecovery ? 1 : 0,
					report.lsn,
					report.durabilityEffective,
					report.syncState,
					now,
				],
			);
			changed = true;
		}
		if (changed) this.ctx.projects.bump();
	}

	/** The primary's node applied a sync step: close the lease on a barrier, else fall back/lose. */
	async applySyncResults(nodeId: string, results: readonly DatabaseSyncResult[]): Promise<void> {
		for (const result of results) {
			const database = this.ctx.db.select().from(databases).where(eq(databases.id, result.databaseId)).get();
			if (!database || database.nodeId !== nodeId) continue;
			if (database.syncState !== 'changing') continue;
			if (result.status === 'ok' && result.step === 'set-sync' && result.lsn && barrierHolds(result.replayLsn ?? result.lsn, result.lsn)) {
				await this.#closeChange(database, result.lsn);
				continue;
			}
			await this.#switchFailed(database, result.error ?? 'the primary\'s node could not apply the sync setting');
		}
	}

	/** Planned switchover drain/resume outcomes. */
	applySwitchoverResults(nodeId: string, results: readonly DatabaseSwitchoverResult[]): void {
		for (const result of results) {
			const failover = this.#failover(result.switchoverId);
			if (!failover || failover.fromNodeId !== nodeId || failover.kind !== 'switchover') continue;
			const database = this.ctx.db.select().from(databases).where(eq(databases.id, failover.databaseId)).get();
			if (!database) continue;
			if (result.step === 'resume') {
				this.ctx.db
					.update(databaseFailovers)
					.set({ switchoverStep: null, finishedAt: this.ctx.now() })
					.where(eq(databaseFailovers.id, failover.id))
					.run();
				continue;
			}
			if (result.status === 'failed') {
				this.#refuseSwitchover(failover, `Drain failed: ${result.error ?? 'unknown error'}`);
				continue;
			}
			const replica = failover.replicaId
				? this.ctx.db.select().from(databaseReplicas).where(eq(databaseReplicas.id, failover.replicaId)).get()
				: undefined;
			if (!replica || !result.lsn || !this.#memberHealthy(database, replica)) {
				this.#refuseSwitchover(
					failover,
					'The replica has no fresh replay position; refusing to promote without proving LSN equality.',
				);
				continue;
			}
			const gap = gapBytes(result.lsn, result.replayLsn ?? replica.replayLsn);
			if (gap === null || gap > 0) {
				this.#refuseSwitchover(
					failover,
					`The replica is ${gap ?? 'an unknown number of'} byte(s) behind the primary's ${result.lsn}; refusing the switchover.`,
					gap,
					result.lsn,
				);
				continue;
			}
			this.ctx.db
				.update(databaseFailovers)
				.set({
					drainLsn: result.lsn,
					status: 'promoting',
					switchoverStep: 'promote',
					message: `Writes stopped at ${result.lsn}; the replica has replayed it.`,
				})
				.where(eq(databaseFailovers.id, failover.id))
				.run();
			this.ctx.audit.record({
				orgId: database.orgId,
				action: 'database.switchover.drained',
				resource: 'database',
				resourceId: database.id,
				args: { name: database.name, lsn: result.lsn, replayLsn: result.replayLsn ?? replica.replayLsn },
				result: 'ok',
			});
			this.ctx.projects.bump(database.orgId);
		}
	}

	/** Rewind outcomes: `rewound` re-attaches; `rebuild` adds a fresh replica on the same node. */
	applyRewindResults(nodeId: string, results: readonly DatabaseRewindResult[]): void {
		for (const result of results) {
			const failover = this.ctx.db
				.select()
				.from(databaseFailovers)
				.where(
					and(
						eq(databaseFailovers.databaseId, result.databaseId),
						eq(databaseFailovers.fromNodeId, nodeId),
						eq(databaseFailovers.kind, 'switchover'),
					),
				)
				.orderBy(desc(databaseFailovers.startedAt))
				.get();
			if (!failover || failover.rewoundAt) continue;
			this.ctx.db
				.update(databaseFailovers)
				.set({
					rewoundAt: this.ctx.now(),
					rewindStatus: result.status,
					message: result.status === 'rewound' ? 'The old primary was rewound and follows the new primary.' : (result.error ?? 'The rewind failed; rebuilding.'),
				})
				.where(eq(databaseFailovers.id, failover.id))
				.run();
			// The copy is in place (rewound, or deleted for a rebuild): start the replica workload.
			if (failover.rewindReplicaId) this.ctx.databaseReplicas.activateRewindReplica(failover.rewindReplicaId);
			const database = this.ctx.db.select().from(databases).where(eq(databases.id, result.databaseId)).get();
			if (database)
				this.ctx.audit.record({
					orgId: database.orgId,
					action: `database.rewind.${result.status}`,
					resource: 'database',
					resourceId: database.id,
					args: { name: database.name, nodeId, error: result.error ?? null },
					result: 'ok',
				});
			this.ctx.projects.bump();
		}
	}

	// ---------------------------------------------------------------- the timer

	/**
	 * The steady-state watchdog and the change timeout (W9-SPEC §5.5). Called from maintenance.
	 * - A sync database whose named standby is not streaming starts a transition to another
	 *   replica, or after `sync_timeout` applies `on_sync_loss`.
	 * - A change older than `SYNC_CHANGE_TIMEOUT` whose barrier never came back falls back to the
	 *   previous member when it is healthy, else applies `on_sync_loss`.
	 */
	async tick(now = this.ctx.now()): Promise<number> {
		if (!featureEnabled(this.ctx.config, 'SYNC_REPLICA')) return 0;
		await this.#replicaAlerts(now);
		let changed = 0;
		const rows = this.ctx.db
			.select()
			.from(databases)
			.where(and(isNull(databases.deletedAt), eq(databases.durability, 'sync')))
			.all();
		for (const database of rows) {
			if (database.syncState === 'changing') {
				if (database.syncChangeStartedAt === null || now - database.syncChangeStartedAt < SYNC_CHANGE_TIMEOUT_MS) continue;
				await this.#changeTimedOut(database, now);
				changed += 1;
				continue;
			}
			// Already blocked: the member is named (writes wait) and there is nothing to decide until
			// an operator repairs it or chooses async.
			if (database.durabilityEffective === 'sync' && database.syncReplicaNodeId === null && database.syncLostAt !== null)
				continue;
			const members = this.#memberViews(database.id);
			const decision = syncLossDecision({
				lease: {
					generation: database.primaryGeneration,
					holderNodeId: database.nodeId,
					expiresAt: new Date(now + DB_LEASE_TTL_MS).toISOString(),
					sync: database.syncReplicaNodeId ? [database.syncReplicaNodeId] : [],
					syncState: database.syncState,
					durability: database.durability,
					durabilityEffective: database.durabilityEffective,
					syncSetAt: database.syncSetAt ? new Date(database.syncSetAt).toISOString() : null,
				},
				members,
				syncTimeoutSeconds: database.syncTimeoutSeconds,
				onSyncLoss: database.onSyncLoss,
				lostSince: database.syncLostAt,
				now,
			});
			if (decision.action === 'transition' && decision.target) {
				await this.#openChange(database, decision.target, now);
				changed += 1;
			} else if (decision.action === 'none' && database.syncLostAt === null && !this.#syncHeld(database, members)) {
				this.ctx.db.update(databases).set({ syncLostAt: now, updatedAt: now }).where(eq(databases.id, database.id)).run();
				changed += 1;
			} else if (decision.action === 'downgrade' || decision.action === 'block') {
				await this.#loseSync(database, decision.action === 'downgrade' ? 'downgrade' : 'block', decision.reason, now);
				changed += 1;
			} else if (decision.action === 'none' && database.syncLostAt !== null && this.#syncHeld(database, members)) {
				this.ctx.db.update(databases).set({ syncLostAt: null, updatedAt: now }).where(eq(databases.id, database.id)).run();
				changed += 1;
			}
		}
		return changed;
	}

	// ---------------------------------------------------------------- internals

	/** Lag, replica-down and slot-lost alerts (docs/CLUSTERING.md §9.2, §12.5). */
	async #replicaAlerts(now: number): Promise<void> {
		const rows = this.ctx.db
			.select({ replica: databaseReplicas, database: databases })
			.from(databaseReplicas)
			.innerJoin(databases, eq(databases.id, databaseReplicas.databaseId))
			.where(and(isNull(databaseReplicas.removingAt), isNull(databases.deletedAt)))
			.all();
		for (const { replica, database } of rows) {
			if (replica.status === 'lost') {
				await this.#notify(
					database,
					`slot_lost:${replica.id}`,
					'critical',
					'Replica slot lost',
					`The primary removed WAL replica ${replica.id} still needed (max_slot_wal_keep_size). It must be rebuilt; a lost slot cannot resume.`,
				);
				continue;
			}
			if (!databaseReplicaReadable(replica.status)) {
				await this.#notify(
					database,
					`replica_down:${replica.id}`,
					'critical',
					'Replica down',
					`Replica ${replica.id} on ${this.#node(replica.nodeId)?.name ?? replica.nodeId} is ${replica.status}. Re-add it, or check its node and disk.`,
				);
				continue;
			}
			const lagSeconds = replica.lagSeconds ?? 0;
			const lagBytes = replica.lagBytes ?? 0;
			if (lagSeconds > 30 || lagBytes > 256 * 1024 * 1024) {
				await this.#notify(
					database,
					`replica_lag:${replica.id}`,
					'warning',
					'Replica lag',
					`Replica ${replica.id} is ${lagSeconds} s / ${lagBytes} bytes behind. Reads from it may be stale; check the overlay and disk.`,
				);
			}
		}
	}

	#store(): DatabaseLeaseStore | null {
		return this.ctx.arbiter ? new ObjectStoreDatabaseLeaseStore(this.ctx.arbiter) : null;
	}

	#note(database: DatabaseRow): string | null {
		if (database.durability !== 'sync') return null;
		if (database.syncState === 'changing') return 'A sync-set change is open; no member may promote automatically.';
		if (database.durabilityEffective === 'async') return 'Downgraded: the synchronous standby was lost. Writes are async.';
		if (!database.syncReplicaNodeId) return 'Blocked: no member is named synchronous, so writes block rather than lose a commit.';
		return null;
	}

	async #armSync(
		database: DatabaseRow,
		settings: DurabilitySettings,
		principal: Principal,
	): Promise<void> {
		const replicas = this.ctx.databaseReplicas.rowsFor(database.id).filter((row) => !row.removingAt && row.primaryGeneration === database.primaryGeneration);
		const crossNode = replicas.filter((row) => row.nodeId !== database.nodeId);
		const zones = new Set(crossNode.map((row) => this.#node(row.nodeId)?.zone ?? row.nodeId));
		// CLUSTERING §9.2: one sync replica has no slack, so `sync` needs two replicas in different
		// zones unless the operator explicitly chooses to block instead.
		if (settings.onSyncLoss !== 'block' && (crossNode.length < 2 || zones.size < 2))
			throw new ValidationError(
				'`sync` needs two replicas in different zones, or `on_sync_loss: block`. With one synchronous replica, losing it either blocks every write or leaves you async without warning.',
			);
		const target = crossNode
			.filter((row) => databaseReplicaReadable(row.status) && this.#memberHealthy(database, row))
			.sort((a, b) => a.nodeId.localeCompare(b.nodeId))[0];
		if (!target)
			throw new ConflictError(
				'No replica has a fresh replay position, so there is nothing to make synchronous. Wait for a replica to stream, then try again.',
			);
		const store = this.#store();
		if (!store)
			throw new CoreError(
				'unavailable',
				'No arbiter with conditional writes is configured, so a sync set cannot be recorded. `sync` fails closed.',
				409,
			);
		await this.#openChange(database, target.nodeId, this.ctx.now(), settings, principal);
	}

	/**
	 * Step 1. The lease goes to `sync: []`, `changing` (non-promotable); the row records the target
	 * so the primary's node is told which setting to apply. A failed CAS is a conflict, never a blind
	 * retry.
	 */
	async #openChange(
		database: DatabaseRow,
		target: string,
		now: number,
		settings: DurabilitySettings = this.durability(database.id),
		principal?: { userId?: string | null; kind?: string },
	): Promise<void> {
		const store = this.#store();
		if (!store) throw new CoreError('unavailable', 'No arbiter is configured; a sync change cannot be recorded.', 409);
		const current = await store.read(database.id);
		if (current && current.lease.holderNodeId !== database.nodeId)
			throw new ConflictError(`The database lease is held by ${current.lease.holderNodeId}, not its primary's node.`);
		if (current && current.lease.syncState !== 'steady')
			throw new ConflictError('A sync-set change is already open on the lease; close or recover it before starting another.');
		const opening: DatabaseLease = current
			? openSyncChange(current.lease)
			: {
					generation: database.primaryGeneration,
					holderNodeId: database.nodeId,
					expiresAt: new Date(now + DB_LEASE_TTL_MS).toISOString(),
					sync: [],
					syncState: 'changing',
					durability: settings.durability,
					durabilityEffective: database.durabilityEffective,
					syncSetAt: null,
				};
		if (!(await store.compareAndSwap(database.id, current?.etag ?? null, opening)))
			throw new ConflictError('The sync change lost the compare-and-swap; re-read the lease and try again.');
		this.ctx.db
			.update(databases)
			.set({
				durability: settings.durability,
				syncTimeoutSeconds: settings.syncTimeoutSeconds,
				onSyncLoss: settings.onSyncLoss,
				syncState: 'changing',
				syncReplicaNodeId: target,
				syncPreviousNodeId: current?.lease.sync[0] ?? database.syncReplicaNodeId,
				syncChangeStartedAt: now,
				updatedAt: now,
			})
			.where(eq(databases.id, database.id))
			.run();
		this.ctx.audit.record({
			...principal,
			orgId: database.orgId,
			action: 'database.sync.open',
			resource: 'database',
			resourceId: database.id,
			args: { name: database.name, target, previous: current?.lease.sync ?? [], generation: database.primaryGeneration },
			result: 'ok',
		});
	}

	/** Step 3 (success). Only a barrier-acknowledged target may close. */
	async #closeChange(database: DatabaseRow, barrierLsn: string | null): Promise<void> {
		const target = database.syncReplicaNodeId;
		if (!target) return;
		const store = this.#store();
		if (store) {
			const current = await store.read(database.id);
			if (current && current.lease.syncState === 'changing' && current.lease.holderNodeId === database.nodeId) {
				const closed = closeSyncChange(current.lease, target, this.ctx.now(), database.durability);
				if (!(await store.compareAndSwap(database.id, current.etag, closed)))
					throw new ConflictError('The sync close lost the compare-and-swap; the lease needs a re-read.');
			}
		}
		this.ctx.db
			.update(databases)
			.set({
				syncState: 'steady',
				durabilityEffective: database.durability,
				syncSetAt: this.ctx.now(),
				syncChangeStartedAt: null,
				syncPreviousNodeId: null,
				syncLostAt: null,
				updatedAt: this.ctx.now(),
			})
			.where(eq(databases.id, database.id))
			.run();
		this.ctx.audit.record({
			orgId: database.orgId,
			action: 'database.sync.close',
			resource: 'database',
			resourceId: database.id,
			args: { name: database.name, target, barrierLsn },
			result: 'ok',
		});
	}

	/** Step 2 failed: fall back to the previous member if healthy, else apply `on_sync_loss`. */
	async #switchFailed(database: DatabaseRow, reason: string): Promise<void> {
		const previous = database.syncPreviousNodeId;
		if (previous && previous !== database.syncReplicaNodeId) {
			const replica = this.#replicaOn(database.id, previous);
			if (replica && this.#memberHealthy(database, replica)) {
				const store = this.#store();
				if (store) {
					const current = await store.read(database.id);
					if (current && current.lease.syncState === 'changing' && current.lease.holderNodeId === database.nodeId) {
						const fallback = fallbackSyncChange(current.lease, previous, this.ctx.now(), database.durability);
						if (await store.compareAndSwap(database.id, current.etag, fallback)) {
							this.ctx.db
								.update(databases)
								.set({
									syncState: 'steady',
									syncReplicaNodeId: previous,
									syncPreviousNodeId: null,
									syncChangeStartedAt: null,
									syncSetAt: this.ctx.now(),
									durabilityEffective: database.durability,
									updatedAt: this.ctx.now(),
								})
								.where(eq(databases.id, database.id))
								.run();
							await this.#notify(database, 'sync_fallback', 'warning', `Sync change fell back to ${previous}`, reason);
										return;
						}
					}
				}
			}
		}
		await this.#loseSync(database, database.onSyncLoss, reason, this.ctx.now());
	}

	async #loseSync(
		database: DatabaseRow,
		policy: 'downgrade' | 'block',
		reason: string,
		now: number,
	): Promise<void> {
		const store = this.#store();
		if (store) {
			const current = await store.read(database.id);
			if (current && current.lease.holderNodeId === database.nodeId) {
				const lease = loseSyncSet(current.lease, policy, { durability: database.durability }, now);
				if (!(await store.compareAndSwap(database.id, current.etag, lease)))
					throw new ConflictError('The downgrade lost the compare-and-swap; the lease needs a re-read.');
			}
		}
		this.ctx.db
			.update(databases)
			.set({
				syncState: 'steady',
				syncReplicaNodeId: null,
				syncPreviousNodeId: null,
				syncChangeStartedAt: null,
				syncSetAt: now,
				// The requested policy stays `sync`; the alert rides `durability_effective = async`.
				durability: database.durability,
				durabilityEffective: policy === 'downgrade' ? 'async' : 'sync',
				// Keep the loss timestamp for `block`, so the watchdog does not re-apply it forever.
				syncLostAt: policy === 'block' ? (database.syncLostAt ?? now) : null,
				updatedAt: now,
			})
			.where(eq(databases.id, database.id))
			.run();
		await this.#notify(
			database,
			policy === 'downgrade' ? 'sync_downgraded' : 'sync_blocked',
			'critical',
			policy === 'downgrade' ? 'Synchronous database downgraded to async' : 'Synchronous database blocked',
			reason,
		);
		this.ctx.audit.record({
			orgId: database.orgId,
			action: `database.sync.${policy}`,
			resource: 'database',
			resourceId: database.id,
			args: { name: database.name, reason },
			result: 'ok',
		});
		this.ctx.projects.bump(database.orgId);
	}

	async #changeTimedOut(database: DatabaseRow, now: number): Promise<void> {
		const previous = database.syncPreviousNodeId;
		if (previous) {
			const replica = this.#replicaOn(database.id, previous);
			if (replica && this.#memberHealthy(database, replica)) {
				await this.#switchFailed(database, `The barrier was not acknowledged within ${SYNC_CHANGE_TIMEOUT_MS / 1000} s; falling back to ${previous}.`);
				return;
			}
		}
		await this.#loseSync(
			database,
			database.onSyncLoss,
			`The barrier was not acknowledged within ${SYNC_CHANGE_TIMEOUT_MS / 1000} s and the previous member is not healthy.`,
			now,
		);
	}

	async #setAsync(database: DatabaseRow, settings: DurabilitySettings): Promise<void> {
		const store = this.#store();
		if (store) {
			const current = await store.read(database.id);
			if (current && current.lease.holderNodeId === database.nodeId) {
				const clear: DatabaseLease = {
					...current.lease,
					sync: [],
					syncState: 'steady',
					durability: 'async',
					durabilityEffective: 'async',
					syncSetAt: new Date(this.ctx.now()).toISOString(),
				};
				await store.compareAndSwap(database.id, current.etag, clear);
			}
		}
		this.ctx.db
			.update(databases)
			.set({
				durability: 'async',
				syncTimeoutSeconds: settings.syncTimeoutSeconds,
				onSyncLoss: settings.onSyncLoss,
				syncState: 'steady',
				syncReplicaNodeId: null,
				syncPreviousNodeId: null,
				syncChangeStartedAt: null,
				syncLostAt: null,
				durabilityEffective: 'async',
				updatedAt: this.ctx.now(),
			})
			.where(eq(databases.id, database.id))
			.run();
	}

	#memberViews(databaseId: string): SyncMemberView[] {
		return this.ctx.databaseReplicas
			.rowsFor(databaseId)
			.filter((row) => !row.removingAt)
			.map((row) => ({
				nodeId: row.nodeId,
				streaming: databaseReplicaReadable(row.status) && this.#memberHealthy(this.#database(row.databaseId), row),
				replayLsn: row.replayLsn,
			}));
	}

	#syncHeld(database: DatabaseRow, members: readonly SyncMemberView[]): boolean {
		if (!database.syncReplicaNodeId) return false;
		const member = members.find((item) => item.nodeId === database.syncReplicaNodeId);
		return member?.streaming === true;
	}

	#memberHealthy(database: DatabaseRow, replica: ReplicaRow): boolean {
		return (
			replica.primaryGeneration === database.primaryGeneration &&
			replica.reportedAt !== null &&
			this.ctx.now() - replica.reportedAt <= DATABASE_REPLICA_REPORT_STALE_SECONDS * 1000 &&
			replica.replayLsn !== null
		);
	}

	#replicaOn(databaseId: string, nodeId: string): ReplicaRow | undefined {
		return this.ctx.db
			.select()
			.from(databaseReplicas)
			.where(and(eq(databaseReplicas.databaseId, databaseId), eq(databaseReplicas.nodeId, nodeId), isNull(databaseReplicas.removingAt)))
			.get();
	}

	#database(databaseId: string): DatabaseRow {
		const row = this.ctx.db.select().from(databases).where(eq(databases.id, databaseId)).get();
		if (!row) throw new NotFoundError('Database');
		return row;
	}

	#nodeHasDbMember(nodeId: string): boolean {
		const node = this.#node(nodeId);
		return Boolean(node && parseJson<string[]>(node.capabilitiesJson, []).includes(DB_MEMBER_CAPABILITY));
	}

	#node(nodeId: string): typeof nodes.$inferSelect | undefined {
		return this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
	}

	#fingerprint(nodeId: string): string | null {
		return this.ctx.db.select({ serial: nodeCertificates.serial }).from(nodeCertificates).where(eq(nodeCertificates.nodeId, nodeId)).get()?.serial ?? null;
	}

	#activeFailover(databaseId: string): FailoverRow | undefined {
		return this.ctx.db
			.select()
			.from(databaseFailovers)
			.where(and(eq(databaseFailovers.databaseId, databaseId), inArray(databaseFailovers.status, ['pending', 'promoting'])))
			.get();
	}

	#failover(id: string): FailoverRow | undefined {
		return this.ctx.db.select().from(databaseFailovers).where(eq(databaseFailovers.id, id)).get();
	}

	#refuseSwitchover(failover: FailoverRow, message: string, gap: number | null = null, lsn: string | null = null): void {
		const now = this.ctx.now();
		this.ctx.db
			.update(databaseFailovers)
			.set({
				status: 'failed',
				switchoverStep: 'resume',
				...(lsn ? { drainLsn: lsn } : {}),
				message: message.slice(0, 2_000),
				finishedAt: now,
			})
			.where(eq(databaseFailovers.id, failover.id))
			.run();
		const database = this.ctx.db.select().from(databases).where(eq(databases.id, failover.databaseId)).get();
		if (database) {
			this.ctx.audit.record({
				orgId: database.orgId,
				action: 'database.switchover.refused',
				resource: 'database',
				resourceId: database.id,
				args: { name: database.name, gapBytes: gap, message },
				result: 'error',
				error: message.slice(0, 500),
			});
			void this.#notify(database, 'switchover_refused', 'critical', 'Switchover refused', message);
		}
		this.ctx.projects.bump();
	}

	#switchoverView(row: FailoverRow, database: DatabaseRow): DatabaseSwitchoverView {
		const step: SwitchoverStep =
			row.status === 'completed'
				? 'done'
				: row.status === 'failed'
					? 'stop-writes'
					: row.switchoverStep === 'drain'
						? 'checkpoint'
						: row.switchoverStep === 'promote'
							? 'promote'
							: 'checkpoint';
		const startedAt = row.switchoverStartedAt ?? row.startedAt;
		return {
			databaseId: row.databaseId,
			replicaId: row.replicaId ?? '',
			fromNodeId: row.fromNodeId ?? database.nodeId,
			toNodeId: row.toNodeId,
			generation: row.generation,
			step,
			primaryLsn: row.drainLsn,
			replayLsn: row.replicaId
				? (this.ctx.db.select({ replayLsn: databaseReplicas.replayLsn }).from(databaseReplicas).where(eq(databaseReplicas.id, row.replicaId)).get()?.replayLsn ?? null)
				: null,
			gapBytes: null,
			startedAt: new Date(startedAt).toISOString(),
			finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
			durationMs: row.finishedAt ? row.finishedAt - startedAt : null,
			message: row.message,
		};
	}

	#lastMemberReport(databaseId: string, nodeId: string): DatabaseMemberReport | null {
		const row = this.ctx.sqlite
			.query<
				{
					role: string;
					generation: number;
					epoch: number;
					streaming: number;
					in_recovery: number;
					lsn: string | null;
					durability_effective: string;
					sync_state: string;
					observed_at: number;
				},
				[string, string]
			>('SELECT role, generation, epoch, streaming, in_recovery, lsn, durability_effective, sync_state, observed_at FROM database_member_status WHERE database_id = ? AND node_id = ?')
			.get(databaseId, nodeId);
		if (!row) return null;
		return {
			databaseId,
			role: row.role as DatabaseMemberReport['role'],
			generation: row.generation,
			epoch: row.epoch,
			streaming: row.streaming === 1,
			inRecovery: row.in_recovery === 1,
			lsn: row.lsn,
			durabilityEffective: row.durability_effective as DatabaseDurability,
			syncState: row.sync_state as DatabaseMemberReport['syncState'],
			observedAt: new Date(row.observed_at).toISOString(),
		};
	}

	async #notify(database: DatabaseRow, kind: string, severity: 'info' | 'warning' | 'critical', title: string, detail: string): Promise<void> {
		const key = `database_replica:${kind}:${database.id}`;
		if (!this.ctx.alerts.systemRoute(key)) return;
		const now = this.ctx.now();
		const last = this.ctx.sqlite
			.query<{ last_fired_at: number | null; last_value: string | null }, [string]>(
				'SELECT last_fired_at, last_value FROM alert_state WHERE key = ?',
			)
			.get(key);
		const cooldown = this.ctx.policies.get().systemAlertRepeatMinutes * 60_000;
		if (last?.last_fired_at && now - last.last_fired_at < cooldown && last.last_value === detail) return;
		this.ctx.sqlite.run(
			'INSERT INTO alert_state (key, last_fired_at, last_value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET last_fired_at = excluded.last_fired_at, last_value = excluded.last_value',
			[key, now, detail],
		);
		await this.ctx.alerts.deliverSystem({
			key,
			title: `${title}: ${database.name}`,
			detail,
			severity,
			labels: { database_id: database.id },
		});
	}

	/** Debug helper: the lease key for a database (tests and operators). */
	static leaseKey(databaseId: string): string {
		return databaseLeaseKey(databaseId);
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Bytes `primary - replay`; null when either position is unparseable. */
export function gapBytes(primary: string | null, replay: string | null): number | null {
	const from = parseLsn(primary);
	const to = parseLsn(replay);
	if (from === null || to === null) return null;
	const difference = from - to;
	if (difference <= 0n) return 0;
	return difference > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(difference);
}

/** The application name (physical slot) a replica uses; kept here for the sync task. */
export function syncSlotName(replicaId: string): string {
	return slotName(replicaId);
}
