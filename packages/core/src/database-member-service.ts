import { and, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import {
	databaseFailovers,
	databaseReplicas,
	databaseReplication,
	databases,
	controlState,
	nodes,
} from '@yoal/db';
import {
	regionOf,
	DATABASE_REPLICA_REPORT_STALE_SECONDS,
	DB_MEMBER_CAPABILITY,
	DB_MEMBER_SELF_FENCING_CAPABILITY,
	databaseReplicaReadable,
	effectiveDurability,
	reconcilePromotionReport,
	selectConsumerTarget,
	type ConsumerMemberAnswer,
	type DatabaseDurability,
	type DatabaseDurabilityStatus,
	type DatabaseLease,
	type DatabaseMember,
	type DatabaseMemberEvent,
	type DatabaseMemberReport,
	type DatabaseMembersDesired,
	type DatabaseSwitchoverRequest,
	type DatabaseSwitchoverResult,
	type DatabaseSwitchoverTask,
	type DatabaseSwitchoverView,
	type DatabaseSyncResult,
	type DatabaseSyncTask,
	type DurabilitySettings,
	type DurabilitySettingsUpdate,
	type Principal,
	type ReaderAlert,
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
	loseSyncSet,
	openSyncChange,
	parseLsn,
	renewedLease,
	syncLossDecision,
	type DatabaseLeaseRecord,
	type DatabaseLeaseStore,
	type SyncMemberView,
} from './database-sync.ts';
import type { SwitchoverStep } from './database-switchover.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { slotName } from './database-replica-service.ts';
import type { DatabaseRow } from './databases.ts';
import { newId, parseJson, sha256Hex } from './util.ts';
import { crossRegionPromotionRefusal, syncTargetRefusal } from './regions.ts';

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
	private readonly twoPrimaryAudited = new Set<string>();
	private readonly readerTwoPrimaryAudited = new Set<string>();

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
			.select({ id: databaseReplicas.id, nodeId: databaseReplicas.nodeId, address: nodes.privateAddress, slot: databaseReplicas.slot })
			.from(databaseReplicas)
			.innerJoin(nodes, eq(nodes.id, databaseReplicas.nodeId))
			.where(and(eq(databaseReplicas.databaseId, databaseId), isNull(databaseReplicas.removingAt)))
			.all();
		return [
			...(primary ? [{ nodeId: primary.id, address: primary.address, role: 'primary' as const, slot: null, workloadId: database.id }] : []),
			...replicas.map((row) => ({
				nodeId: row.nodeId,
				address: row.address,
				role: 'replica' as const,
				slot: row.slot,
				workloadId: `db_${row.id}`,
			})),
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

	/**
	 * The desired-state entry lane B renders; null while the flag is off or there is no replica.
	 * `forNodeId` renders it for one node: a node outside the primary's region never carries the
	 * W11 policy, so its member machine is never armed and never a candidate (HA-PLAN H26: a standby
	 * region's replica never auto-promotes). With every node in one region it is byte-identical.
	 */
	membersDesired(databaseId: string, forNodeId?: string): DatabaseMembersDesired | null {
		if (!featureEnabled(this.ctx.config, 'SYNC_REPLICA')) return null;
		const row = this.ctx.db.select().from(databases).where(eq(databases.id, databaseId)).get();
		if (!row) return null;
		const members = this.members(databaseId);
		if (members.length < 2) return null;
		const auto =
			featureEnabled(this.ctx.config, 'DB_AUTO_PROMOTE') &&
			row.failoverMode === 'auto' &&
			(forNodeId === undefined || this.#sameRegionAsPrimary(row, forNodeId));
		return {
			databaseId,
			generation: row.primaryGeneration,
			members,
			// While a change is open the lease names nobody; the target rides `databaseSyncTasks`.
			sync: row.syncState === 'changing' ? [] : row.syncReplicaNodeId ? [row.syncReplicaNodeId] : [],
			durability: row.durability,
			syncState: row.syncState,
			durabilityEffective: row.durabilityEffective,
			// The lease snapshot is the primary's node ownership token: it may only act on this
			// generation/ETag, and the control plane only applies a result that still matches it.
			holderNodeId: row.nodeId,
			leaseEtag: row.syncLeaseEtag,
			leaseExpiresAt: row.syncLeaseExpiresAt === null ? null : new Date(row.syncLeaseExpiresAt).toISOString(),
			leaseGeneration: row.primaryGeneration,
			leaseEpoch: this.#controlEpoch(),
			syncTimeoutSeconds: row.syncTimeoutSeconds,
			onSyncLoss: row.onSyncLoss,
			// W11: only an armed database carries the policy, so a manual (the default) or flag-off
			// payload is byte-identical to before.
			...(auto
				? {
						failover: {
							mode: 'auto' as const,
							acceptDataLoss: row.acceptDataLoss,
							autoArmedAt: row.autoArmedAt === null ? null : new Date(row.autoArmedAt).toISOString(),
						},
					}
				: {}),
		};
	}

	/** The control-plane epoch this process last recorded, for role discovery (0 when unknown). */
	#controlEpoch(): number {
		return (
			this.ctx.db
				.select({ epoch: controlState.epoch })
				.from(controlState)
				.orderBy(desc(controlState.epoch))
				.limit(1)
				.get()?.epoch ?? 0
		);
	}

	/** The requested policy and what the lease says is in force. */
	async status(principal: Principal, databaseName: string): Promise<DatabaseDurabilityStatus> {
		const database = this.ctx.databases.requireRow(principal, databaseName);
		this.ctx.iam.require(principal, 'database:read', { type: 'database', id: database.id });
		let lease: DatabaseLease | null = null;
		let note: string | null = null;
		try {
			const record = (await this.#store()?.read(database.id)) ?? null;
			lease = record?.lease ?? null;
			if (record) {
				this.ctx.db
					.update(databases)
					.set({ syncLeaseEtag: record.etag, syncLeaseExpiresAt: Date.parse(record.lease.expiresAt) })
					.where(eq(databases.id, database.id))
					.run();
			}
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
							// Report the phase the primary's node last reported, not a fabricated one.
							phase: database.syncPhase ?? 'opening',
							target: database.syncReplicaNodeId,
							previous: database.syncPreviousNodeId ? [database.syncPreviousNodeId] : [],
							openedAt: new Date(startedAt).toISOString(),
							deadline: new Date(startedAt + SYNC_CHANGE_TIMEOUT_MS).toISOString(),
							barrierLsn: database.syncBarrierLsn,
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
		const { current, next, unchangedSet } = this.#durabilityPreconditions(database, raw);
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

	/**
	 * The refusal `setDurability` would throw for this change, or null, without writing anything.
	 * Blueprint plans (HA-PLAN W14) call it so a plan shows the same refusal the apply would meet;
	 * it runs the very checks `setDurability` runs (`#durabilityPreconditions`, `#syncTarget`).
	 */
	durabilityRefusal(principal: Principal, databaseName: string, raw: DurabilitySettingsUpdate): string | null {
		const database = this.ctx.databases.requireRow(principal, databaseName);
		this.ctx.iam.require(principal, 'database:read', { type: 'database', id: database.id });
		try {
			const { next, unchangedSet } = this.#durabilityPreconditions(database, raw);
			if (!unchangedSet && next.durability === 'sync') this.#syncTarget(database, next);
			return null;
		} catch (error) {
			if (error instanceof CoreError) return error.message;
			throw error;
		}
	}

	/** Every check `setDurability` makes before it writes; throws the refusal. */
	#durabilityPreconditions(
		database: DatabaseRow,
		raw: DurabilitySettingsUpdate,
	): { current: DurabilitySettings; next: DurabilitySettings; unchangedSet: boolean } {
		if (!featureEnabled(this.ctx.config, 'SYNC_REPLICA'))
			throw new CoreError('unavailable', 'Synchronous replicas are off: enable SYNC_REPLICA first (HA-PLAN H23).', 409);
		if (database.engine !== 'postgres')
			throw new ValidationError('Durability settings are only available for Postgres.');
		if (!this.#nodeHasDbMember(database.nodeId))
			throw new ConflictError(`The agent on the primary's node is too old to apply a sync set; update it first (needs "${DB_MEMBER_CAPABILITY}").`);
		this.ctx.moves.assertNotMoving(database);
		// A sync-set change and a failover are mutually exclusive: opening one while the other is
		// active makes promotion/durability decisions race (W10 review).
		if (this.#activeFailover(database.id))
			throw new ConflictError(`"${database.name}" is failing over; wait for it to finish before changing durability.`);
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
		return { current, next, unchangedSet };
	}

	/** Planned switchover: checkpoint, stop writes, LSN equality, promote, re-point (refuse on a gap). */
	async switchover(
		principal: Principal,
		databaseName: string,
		raw: DatabaseSwitchoverRequest,
		options: { ifMatch?: number | null } = {},
	): Promise<DatabaseSwitchoverView> {
		const database = this.ctx.databases.requireRow(principal, databaseName);
		this.ctx.iam.require(principal, 'database:update', { type: 'database', id: database.id });
		if (options.ifMatch !== undefined && options.ifMatch !== null && options.ifMatch !== database.primaryGeneration)
			throw new CoreError(
				'precondition_failed',
				`"${database.name}" is at primary generation ${database.primaryGeneration}, not ${options.ifMatch}. Re-read its replicas and try again.`,
				412,
			);
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
				switchoverAttempt: 1,
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

	/**
	 * Role discovery: what a consumer's 1–2 s poll receives from one member (W9-SPEC §5.6).
	 *
	 * There is no synthesis: a member that has not reported has no role. The generation is the
	 * member's own report, and the lease generation/epoch it last saw is carried alongside, so a
	 * consumer can tell a stale primary from a current one. A member that is read-only outside
	 * recovery is fenced (`role: 'fenced'`), never reported as a primary.
	 */
	async memberRole(databaseId: string, nodeId: string): Promise<DatabaseMemberReport | null> {
		const database = this.ctx.db.select().from(databases).where(eq(databases.id, databaseId)).get();
		if (!database) return null;
		const report = this.#lastMemberReport(databaseId, nodeId);
		if (!report) return null;
		let leaseGeneration = report.leaseGeneration;
		let leaseEpoch = report.leaseEpoch;
		try {
			const record = await this.#store()?.read(databaseId);
			if (record) {
				leaseGeneration = record.lease.generation;
				if (record.lease.holderNodeId !== nodeId && report.role === 'primary') {
					// The lease names another node; this member's primary claim is stale, and a primary
					// that cannot prove the lease is fenced (W9-SPEC §5.2).
					return {
						...report,
						role: 'fenced',
						fenced: true,
						leaseGeneration,
						leaseEpoch,
					};
				}
			}
			const epoch = this.ctx.db
				.select({ epoch: controlState.epoch })
				.from(controlState)
				.orderBy(desc(controlState.epoch))
				.limit(1)
				.get();
			if (epoch && epoch.epoch > leaseEpoch) leaseEpoch = epoch.epoch;
		} catch {
			// The arbiter is unreadable: report only what the member last said, never a guess.
		}
		return { ...report, leaseGeneration, leaseEpoch };
	}

	/**
	 * W11 consumer discovery, from the control plane's cache: the node a consumer should forward to
	 * (the `primary` at the highest generation), or `null` when none answers or two claim one
	 * generation (W11-SPEC §6). A consumer on the same node normally polls the members directly; this
	 * is the same selection over the heartbeat cache for status and for the read surface.
	 */
	async consumerTarget(databaseId: string): Promise<ReturnType<typeof selectConsumerTarget>> {
		const database = this.ctx.db.select().from(databases).where(eq(databases.id, databaseId)).get();
		if (!database) return selectConsumerTarget([]);
		const now = this.ctx.now();
		const fresh = now - DATABASE_REPLICA_REPORT_STALE_SECONDS * 1000;
		const answers: ConsumerMemberAnswer[] = this.#memberReports(databaseId)
			.filter((report) => Date.parse(report.observedAt) >= fresh)
			.map((report) => ({
				nodeId: report.nodeId,
				role: report.role,
				generation: report.generation,
				reachable: this.#node(report.nodeId)?.status === 'online',
			}));
		const selection = selectConsumerTarget(answers);
		if (selection.twoPrimaries) {
			const key = `${databaseId}:${selection.generation}`;
			if (!this.twoPrimaryAudited.has(key)) {
				this.twoPrimaryAudited.add(key);
				this.ctx.audit.record({
					orgId: database.orgId,
					action: 'database.failover.two_primaries',
					resource: 'database',
					resourceId: database.id,
					args: { name: database.name, generation: selection.generation, source: 'consumer-discovery' },
					result: 'error',
					error: `Two reachable primaries at generation ${selection.generation}; consumers fail closed.`,
				});
			}
		}
		return selection;
	}
	/**
	 * W11-SPEC §7: the control-plane reader. It never decides or writes a lease; it reconciles a
	 * promotion a node performed while the control plane was down, moves the row/endpoints/PITR
	 * stanza, never lowers a generation, and alerts on an invalid promotion or two primaries.
	 */
	async reconcilePromotions(now = this.ctx.now()): Promise<number> {
		let changed = 0;
		const rows = this.ctx.sqlite
			.query<{ database_id: string; node_id: string; generation: number; role: string; lsn: string | null; observed_at: number }, []>(
				`SELECT database_id, node_id, generation, role, lsn, observed_at FROM database_member_status
				 WHERE role = 'primary' ORDER BY database_id, generation DESC`,
			)
			.all();
		const fresh = now - DATABASE_REPLICA_REPORT_STALE_SECONDS * 1000;
		const byDatabase = new Map<string, typeof rows>();
		for (const row of rows) {
			if (row.observed_at < fresh) continue;
			byDatabase.set(row.database_id, [...(byDatabase.get(row.database_id) ?? []), row]);
		}
		for (const [databaseId, reports] of byDatabase) {
			const database = this.ctx.db.select().from(databases).where(eq(databases.id, databaseId)).get();
			if (!database || database.deletedAt) continue;
			// Two primaries at one generation is an I3 violation even when the row already names one.
			const top = Math.max(...reports.map((report) => report.generation));
			const atTop = reports.filter((report) => report.generation === top);
			if (atTop.length > 1) {
				await this.#notify(
					database,
					`two_primaries:${top}`,
					'critical',
					'Two primaries at one generation (I3)',
					`${atTop.map((report) => `${report.node_id}@${report.generation}`).join(' and ')} both report primary. Consumers must fail closed; fence both and page.`,
				);
				const key = `${database.id}:${top}`;
				if (!this.readerTwoPrimaryAudited.has(key)) {
					this.readerTwoPrimaryAudited.add(key);
					this.ctx.audit.record({
						orgId: database.orgId,
						action: 'database.failover.two_primaries',
						resource: 'database',
						resourceId: database.id,
						args: { name: database.name, generation: top, nodes: atTop.map((report) => report.node_id) },
						result: 'error',
						error: `Two primaries at generation ${top}.`,
					});
				}
				continue;
			}
			const report = atTop[0]!;
			if (report.generation < database.primaryGeneration) continue;
			const leaseRecord = await this.#readLease(databaseId);
			const evidence =
				leaseRecord && leaseRecord.lease.generation === report.generation
					? {
							durabilityEffective: effectiveDurability(leaseRecord.lease),
							sync: leaseRecord.lease.sync,
							syncState: leaseRecord.lease.syncState,
							acceptDataLoss: database.acceptDataLoss,
						}
					: null;
			const decision = reconcilePromotionReport(
				{ generation: database.primaryGeneration, primaryNodeId: database.nodeId },
				{
					nodeId: report.node_id,
					generation: report.generation,
					fromGeneration: report.generation - 1,
					lsn: report.lsn,
					status: 'promoted',
					reportedAt: report.observed_at,
				},
				evidence,
			);
			if (decision.action !== 'apply') {
				for (const alert of decision.alerts) await this.#deliverReaderAlert(database, alert);
				if (decision.action === 'refuse' || decision.alerts.some((alert) => alert.severity === 'critical'))
					this.ctx.audit.record({
						orgId: database.orgId,
						action:
							decision.alerts.some((alert) => alert.code === 'two-primaries')
								? 'database.failover.two_primaries'
								: 'database.failover.invalid',
						resource: 'database',
						resourceId: database.id,
						args: {
							name: database.name,
							nodeId: report.node_id,
							generation: report.generation,
							fence: decision.action === 'refuse' ? decision.fence : false,
						},
						result: 'error',
						error: decision.alerts[0]?.message ?? 'invalid promotion',
					});
				continue;
			}
			for (const alert of decision.alerts) await this.#deliverReaderAlert(database, alert);
			if (decision.generation === database.primaryGeneration) {
				// The row already names this primary; nothing to move.
				if (decision.primaryNodeId === database.nodeId) continue;
			}
			const replica = this.ctx.db
				.select()
				.from(databaseReplicas)
				.where(and(eq(databaseReplicas.databaseId, databaseId), eq(databaseReplicas.nodeId, decision.primaryNodeId), isNull(databaseReplicas.removingAt)))
				.get();
			if (!replica || replica.hostPort === null) {
				// The node says it promoted, but there is no row to move the database onto. Never
				// lower the row; page so a person can finish the re-point.
				await this.#notify(
					database,
					`promotion_unreconciled:${report.node_id}`,
					'critical',
					'Promotion could not be reconciled',
					`${report.node_id} reports primary at generation ${report.generation}, but no replica row with a host port exists for it. The row is unchanged.`,
				);
				continue;
			}
			const fromNodeId = database.nodeId;
			const fromDiskId = database.diskId;
			const others = this.ctx.db
				.select()
				.from(databaseReplicas)
				.where(and(eq(databaseReplicas.databaseId, databaseId), isNull(databaseReplicas.removingAt)))
				.all()
				.filter((row) => row.id !== replica.id);
			const poolerPort = database.poolerEnabled ? this.ctx.databases.allocatePoolerPort(replica.nodeId) : null;
			this.ctx.sqlite.transaction(() => {
				this.ctx.db.delete(databaseReplicas).where(eq(databaseReplicas.id, replica.id)).run();
				this.ctx.db
					.update(databases)
					.set({
						nodeId: replica.nodeId,
						hostPort: replica.hostPort!,
						diskId: replica.diskId,
						poolerPort,
						primaryGeneration: decision.generation,
						status: 'pending',
						message: null,
						updatedAt: now,
					})
					.where(eq(databases.id, databaseId))
					.run();
				for (const other of others)
					this.ctx.db
						.update(databaseReplicas)
						.set({ removingAt: now, slot: null, rebuildOnPurge: true, updatedAt: now })
						.where(eq(databaseReplicas.id, other.id))
						.run();
				this.ctx.db
					.update(databaseReplication)
					.set({ appliedVersion: null, appliedAt: null, error: null, updatedAt: now })
					.where(eq(databaseReplication.databaseId, databaseId))
					.run();
				this.ctx.db
					.insert(databaseFailovers)
					.values({
						id: newId('dfo_'),
						databaseId,
						fromNodeId,
						toNodeId: decision.primaryNodeId,
						generation: decision.generation,
						status: 'completed',
						startedAt: report.observed_at,
						finishedAt: now,
						promotedAt: report.observed_at,
						promotionSucceededAt: report.observed_at,
						promotionSource: 'auto',
						evidenceJson: JSON.stringify({ reconciled: true, lsn: decision.lsn, nodeReported: true }),
						message: `Reconciled from ${decision.primaryNodeId}'s report at generation ${decision.generation}.`,
					})
					.run();
			})();
			this.ctx.endpoints.reconcileForDatabase(databaseId);
			this.ctx.databases.queuePitrStatusFor(databaseId);
			// The old primary comes back only as a replica: rewind when the capabilities allow it,
			// otherwise its data dir is purged; it is never served as a primary (W11-SPEC §8).
			this.ctx.databaseReplicas.reattachForReader(databaseId, fromNodeId, fromDiskId);
			this.ctx.audit.record({
				orgId: database.orgId,
				action: 'database.failover.reconciled',
				resource: 'database',
				resourceId: database.id,
				args: { name: database.name, from: fromNodeId, to: decision.primaryNodeId, generation: decision.generation, lsn: decision.lsn },
				result: 'ok',
			});
			this.ctx.projects.bump(database.orgId);
			changed += 1;
		}
		return changed;
	}

	async #deliverReaderAlert(database: DatabaseRow, alert: ReaderAlert): Promise<void> {
		await this.#notify(
			database,
			`reader:${alert.code}:${alert.message.slice(0, 40)}`,
			alert.severity,
			alert.code === 'two-primaries' ? 'Two primaries at one generation (I3)' : 'Database promotion needs attention',
			alert.message,
		);
	}

	#memberReports(databaseId: string): Array<DatabaseMemberReport & { nodeId: string }> {
		const rows = this.ctx.sqlite
			.query<
				{
					node_id: string;
					role: string;
					generation: number;
					epoch: number;
					streaming: number;
					in_recovery: number;
					lsn: string | null;
					durability_effective: string;
					sync_state: string;
					read_only: number;
					fenced: number;
					lease_generation: number;
					lease_epoch: number;
					observed_at: number;
				},
				[string]
			>('SELECT node_id, role, generation, epoch, streaming, in_recovery, lsn, durability_effective, sync_state, read_only, fenced, lease_generation, lease_epoch, observed_at FROM database_member_status WHERE database_id = ?')
			.all(databaseId);
		return rows.map((row) => ({
			databaseId,
			nodeId: row.node_id,
			role: row.role as DatabaseMemberReport['role'],
			generation: row.generation,
			epoch: row.epoch,
			streaming: row.streaming === 1,
			inRecovery: row.in_recovery === 1,
			lsn: row.lsn,
			readOnly: row.read_only === 1,
			fenced: row.fenced === 1,
			leaseGeneration: row.lease_generation,
			leaseEpoch: row.lease_epoch,
			durabilityEffective: row.durability_effective as DatabaseDurability,
			syncState: row.sync_state as DatabaseMemberReport['syncState'],
			observedAt: new Date(row.observed_at).toISOString(),
		}));
	}

	/**
	 * The arbiter's answer to "may this node promote?" (I12). The row cache is for display; this
	 * reads the lease. `acceptDataLoss` overrides a membership/expiry refusal (a manual choice), but
	 * never an open change: that is non-promotable for everyone until it closes.
	 */
	async promotionRefusal(
		database: Pick<DatabaseRow, 'id' | 'durability'>,
		nodeId: string,
		acceptDataLoss = false,
	): Promise<string | null> {
		const store = this.#store();
		// No arbiter configured means this deployment predates the sync lease; the row remains the
		// only gate (an explicit `sync` already fails closed without an arbiter).
		if (!store) return null;
		let record;
		try {
			record = await store.read(database.id);
		} catch (error) {
			return `the database lease could not be read: ${errorText(error)}`;
		}
		if (!record) {
			return database.durability === 'sync'
				? 'there is no database lease, so this node cannot prove it may promote.'
				: null;
		}
		const refusal = acquireRefusal(record.lease, nodeId, this.ctx.now());
		if (!refusal) return null;
		if (acceptDataLoss && !refusal.startsWith('a sync-set change is open')) return null;
		return refusal;
	}

	/**
	 * The W11 controller gate (review blocker 2): the control-plane promotion path may only start
	 * when the lease is steady, at the database's generation, names the candidate for `sync` (or the
	 * database accepted async data loss), and appears expired. The store does not expose the
	 * arbiter's clock, so expiry is necessarily this process's clock; the node member machine, which
	 * does read the arbiter clock, is the W11 path (review F5).
	 */
	async automaticPromotionRefusal(
		database: Pick<
			DatabaseRow,
			'id' | 'nodeId' | 'primaryGeneration' | 'acceptDataLoss' | 'failoverMode' | 'durabilityEffective' | 'syncState'
		>,
		candidateNodeId: string,
	): Promise<string | null> {
		// F1: a post-boot capability downgrade (or a controller installed without the flag/handler)
		// must refuse before the lease is even read.
		// HA-PLAN H26: a replica outside the primary's region is never promoted automatically,
		// whatever the policy says, so this is checked first.
		const candidateNode = this.#node(candidateNodeId);
		const crossRegion = crossRegionPromotionRefusal(this.#node(database.nodeId) ?? {}, {
			name: candidateNode?.name ?? candidateNodeId,
			region: candidateNode?.region,
		});
		if (crossRegion) return crossRegion;
		if (!this.ctx.failoverPolicies.autoActiveForRow(database))
			return 'automatic failover is no longer eligible (policy, controller or node self-fencing changed)';
		const store = this.#store();
		if (!store) return 'no arbiter with conditional writes is configured';
		let record;
		try {
			record = await store.read(database.id);
		} catch (error) {
			return `the database lease could not be read: ${errorText(error)}`;
		}
		if (!record) return 'there is no database lease';
		const lease = record.lease;
		if (lease.generation !== database.primaryGeneration)
			return `the lease is at generation ${lease.generation}, not ${database.primaryGeneration}`;
		if (lease.syncState !== 'steady') return 'a sync-set change is open, so the database is non-promotable';
		if (lease.holderNodeId === candidateNodeId) return 'the candidate already holds the lease';
		if (effectiveDurability(lease) === 'sync' && !lease.sync.includes(candidateNodeId))
			return 'the candidate is not named in the lease’s synchronous set (I12)';
		if (effectiveDurability(lease) === 'async' && !database.acceptDataLoss)
			return 'the database is async and has not accepted data loss';
		const expiresAt = Date.parse(lease.expiresAt);
		if (Number.isFinite(expiresAt) && expiresAt > this.ctx.now())
			return 'the lease has not expired by this process’s clock (the store does not expose the arbiter clock), so the primary may still be serving';
		return null;
	}

	/**
	 * A promotion is now authoritative: take the lease at the new generation, name nobody, and
	 * re-open the Revision 1 transition so the new primary clears its inherited setting and arms a
	 * healthy replica through `set-sync` (W10 review major 9). The old primary is never a candidate.
	 */
	async onPromotion(databaseId: string, toNodeId: string, generation: number, failoverId?: string): Promise<void> {
		const database = this.ctx.db.select().from(databases).where(eq(databases.id, databaseId)).get();
		if (!database || database.deletedAt) return;
		const now = this.ctx.now();
		const durability = database.durability;
		const sync = durability === 'sync';
		const store = this.#store();
		let etag: string | null = null;
		let expiresAt: number | null = null;
		if (store) {
			const current = await store.read(databaseId);
			// A retry (or a stale result) must never move the lease backwards. Taking the same
			// generation again is idempotent; a lower one is a bug or a historical failover.
			if (current && current.lease.generation > generation)
				throw new ConflictError(
					`The database lease is at generation ${current.lease.generation}; refusing to lower it to ${generation}.`,
				);
			const next = renewedLease(
				{
					generation,
					holderNodeId: toNodeId,
					expiresAt: new Date(now).toISOString(),
					sync: [],
					syncState: sync ? 'changing' : 'steady',
					durability,
					durabilityEffective: 'async',
					syncSetAt: null,
				},
				now,
			);
			// The promotion is authoritative even though the old holder wrote the previous lease:
			// the old primary is fenced/stopped before `pg_ctl promote` returns. A lost CAS here is a
			// real conflict; do not pretend the lease was taken.
			if (!(await store.compareAndSwap(databaseId, current?.etag ?? null, next)))
				throw new ConflictError('The promotion could not take the database lease; it is still held by another writer.');
			const written = await store.read(databaseId);
			etag = written?.etag ?? null;
			expiresAt = written ? Date.parse(written.lease.expiresAt) : null;
		}
		this.ctx.db
			.update(databases)
			.set({
				syncState: sync ? 'changing' : 'steady',
				syncReplicaNodeId: null,
				syncPreviousNodeId: null,
				syncChangeStartedAt: sync ? now : null,
				syncAttempt: database.syncAttempt + 1,
				syncPhase: sync ? 'opening' : null,
				syncBarrierLsn: null,
				syncLostAt: null,
				syncSetAt: null,
				durability,
				durabilityEffective: 'async',
				...(etag ? { syncLeaseEtag: etag, syncLeaseExpiresAt: expiresAt } : {}),
				updatedAt: now,
			})
			.where(eq(databases.id, databaseId))
			.run();
		if (failoverId)
			this.ctx.db
				.update(databaseFailovers)
				.set({ leaseTakenAt: now, message: `Promoted at generation ${generation}; lease taken by ${toNodeId}.` })
				.where(eq(databaseFailovers.id, failoverId))
				.run();
		this.ctx.audit.record({
			orgId: database.orgId,
			action: 'database.sync.promotion',
			resource: 'database',
			resourceId: databaseId,
			args: { name: database.name, holder: toNodeId, generation },
			result: 'ok',
		});
	}

	/**
	 * A promotion succeeded but its re-point is refused (an open sync change): the new primary is
	 * live, so there is no safe resume and no automatic re-point. Alert and leave it for a person.
	 */
	async onPromotionBlocked(failover: { id: string; databaseId: string }, message: string): Promise<void> {
		const database = this.ctx.db.select().from(databases).where(eq(databases.id, failover.databaseId)).get();
		if (!database) return;
		this.ctx.db
			.update(databaseFailovers)
			.set({ message: message.slice(0, 2_000) })
			.where(eq(databaseFailovers.id, failover.id))
			.run();
		await this.#notify(
			database,
			'switchover_promoted_not_repointed',
			'critical',
			'Promotion succeeded but the database was not re-pointed',
			`${message} The new primary is live; the old primary stays stopped/read-only. Nothing resumed writes. Repair by hand.`,
		);
	}

	/** The promotion succeeded but its data-dir hand-over failed: alert and keep the task. */
	async onHandoverFailed(failover: { id: string; databaseId: string }, message: string): Promise<void> {
		const database = this.ctx.db.select().from(databases).where(eq(databases.id, failover.databaseId)).get();
		if (!database) return;
		this.ctx.db
			.update(databaseFailovers)
			.set({ message: `${message}. Retrying the hand-over; the old primary stays stopped.`.slice(0, 2_000) })
			.where(eq(databaseFailovers.id, failover.id))
			.run();
		await this.#notify(
			database,
			'promotion_handover_failed',
			'critical',
			'Promoted but the hand-over failed',
			`${message}. The new primary is live; the old primary is never resumed. The node retries the hand-over.`,
		);
	}

	/** The re-point succeeded but the lease CAS failed: alert and let the tick retry it. */
	async onLeaseTakeFailed(failover: { id: string; databaseId: string }, message: string): Promise<void> {		const database = this.ctx.db.select().from(databases).where(eq(databases.id, failover.databaseId)).get();
		if (!database) return;
		this.ctx.db
			.update(databaseFailovers)
			.set({ message: `The promoted database has no lease yet: ${message}`.slice(0, 2_000) })
			.where(eq(databaseFailovers.id, failover.id))
			.run();
		await this.#notify(
			database,
			'promotion_lease_failed',
			'critical',
			'Promoted database has no lease',
			`${message} The database serves from its new primary, but no member can prove the lease. Retrying every tick; promote nothing else until it clears.`,
		);
	}

	/** A promotion result could not be processed at all: alert with the failover when we know it. */
	async onPromotionResultFailure(failoverId: string | undefined, error: unknown): Promise<void> {
		const failover = failoverId ? this.#failover(failoverId) : undefined;
		const database = failover
			? this.ctx.db.select().from(databases).where(eq(databases.id, failover.databaseId)).get()
			: undefined;
		if (!database) {
			console.error(`[database-replicas] promotion result: ${errorText(error)}`);
			return;
		}
		await this.#notify(
			database,
			'promotion_result_failed',
			'critical',
			'A promotion result could not be applied',
			`${errorText(error)}. The node's promotion state is unknown; check the replica and the lease.`,
		);
	}

	/** A switchover's promotion failed on the replica's node: resume writes and alert. */
	async onPromotionFailed(failover: { id: string; databaseId: string }, message: string): Promise<void> {
		const database = this.ctx.db.select().from(databases).where(eq(databases.id, failover.databaseId)).get();
		if (!database) return;
		const row = this.#failover(failover.id);
		this.ctx.db
			.update(databaseFailovers)
			.set({
				switchoverStep: 'resume',
				switchoverStartedAt: this.ctx.now(),
				switchoverAttempt: (row?.switchoverAttempt ?? 0) + 1,
				message: message.slice(0, 2_000),
			})
			.where(eq(databaseFailovers.id, failover.id))
			.run();
		await this.#notify(
			database,
			'switchover_promote_failed',
			'critical',
			'Switchover promotion failed',
			`${message} The old primary is being asked to resume writes; nothing was promoted.`,
		);
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
			const desired = this.membersDesired(id, nodeId);
			return desired ? [desired] : [];
		});
	}

	/**
	 * Every database with a replica, for every node's desired state, so any consumer can poll.
	 * `forNodeId` strips the W11 policy for a node outside a database's primary region (see
	 * `membersDesired`).
	 */
	membersDesiredAll(limit = 500, forNodeId?: string): DatabaseMembersDesired[] {
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
			const desired = this.membersDesired(id, forNodeId);
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
					version: this.#syncVersion(row, 'set-sync', replica.slot),
					step: 'set-sync',
					sync: [replica.slot],
					leaseEtag: row.syncLeaseEtag,
				});
				continue;
			}
			// A change opened by a promotion starts with nobody named: the new primary must clear any
			// inherited setting before a target is chosen. The attempt counter keeps this distinct
			// from the previous steady instruction.
			if (row.durability === 'sync' && row.syncState === 'changing' && row.syncReplicaNodeId === null) {
				tasks.push({
					databaseId: row.id,
					version: this.#syncVersion(row, 'clear-sync', 'rearming'),
					step: 'clear-sync',
					sync: [],
					leaseEtag: row.syncLeaseEtag,
				});
				continue;
			}
			// Only a downgrade (or an explicit async) clears the setting. A `block` leaves the
			// unavailable member named so writes keep waiting.
			if (row.syncState === 'steady' && row.syncReplicaNodeId === null && row.syncSetAt !== null && row.durabilityEffective === 'async')
				tasks.push({
					databaseId: row.id,
					version: this.#syncVersion(row, 'clear-sync', 'downgraded'),
					step: 'clear-sync',
					sync: [],
					leaseEtag: row.syncLeaseEtag,
				});
		}
		return tasks;
	}

	/** The task version includes the attempt, so re-opening the same target is a new instruction. */
	#syncVersion(row: DatabaseRow, step: string, detail: string): string {
		return sha256Hex(JSON.stringify({ v: 2, step, detail, attempt: row.syncAttempt, gen: row.primaryGeneration }));
	}

	/** Drain/resume steps for a planned switchover on the old primary's node. */
	switchoverTasksForNode(nodeId: string): DatabaseSwitchoverTask[] {
		const enabled = featureEnabled(this.ctx.config, 'SYNC_REPLICA') && this.#nodeHasDbMember(nodeId);
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
			// A resume is a recovery path: emit it even if the flag was turned off or the node stopped
			// advertising db-member mid-flight, or writes stay stopped forever (W10 review).
			if (step === 'drain' && !enabled) return [];
			const replica = row.replicaId
				? this.ctx.db.select({ slot: databaseReplicas.slot }).from(databaseReplicas).where(eq(databaseReplicas.id, row.replicaId)).get()
				: undefined;
			return [{
				switchoverId: row.id,
				databaseId: row.databaseId,
				step,
				replicaSlot: replica?.slot ?? null,
				version: sha256Hex(JSON.stringify({ v: 1, id: row.id, step, attempt: row.switchoverAttempt })),
			}];
		});
	}

	/** Member-machine events: audit every one, alert the fence/promotion failures (review blocker 14). */
	async applyMemberEvents(nodeId: string, events: readonly DatabaseMemberEvent[]): Promise<void> {
		for (const event of events.slice(0, 50)) {
			const database = this.ctx.db.select().from(databases).where(eq(databases.id, event.databaseId)).get();
			if (!database) continue;
			this.ctx.audit.record({
				orgId: database.orgId,
				action: 'database.member.event',
				resource: 'database',
				resourceId: database.id,
				args: {
					name: database.name,
					nodeId,
					memberNodeId: event.nodeId,
					kind: event.kind,
					generation: event.generation,
					at: event.at,
					detail: event.detail ?? null,
					notice: event.notice ?? null,
				},
				result: event.kind === 'fence-failed' || event.kind === 'promotion-failed' ? 'error' : 'ok',
				...(event.detail ? { error: event.detail.slice(0, 500) } : {}),
			});
			if (event.kind === 'fence-failed' || event.kind === 'fence-notice-missed' || event.kind === 'promotion-failed') {
				await this.#notify(
					database,
					`member:${event.kind}:${event.nodeId}:${event.generation}`,
					event.kind === 'fence-notice-missed' ? 'warning' : 'critical',
					event.kind === 'fence-failed'
						? 'A database primary could not confirm its fence'
						: event.kind === 'fence-notice-missed'
							? 'A fence notice was not delivered'
							: 'A database promotion did not complete',
					`${event.nodeId} at generation ${event.generation}: ${event.detail ?? event.kind}.`,
				);
			}
		}
	}

	// ---------------------------------------------------------------- heartbeat

	/** Member reports (role, generation, replay position) from every node. */
	applyMemberReports(nodeId: string, reports: readonly DatabaseMemberReport[]): void {
		let changed = false;
		for (const report of reports.slice(0, 50)) {
			const observedAt = Date.parse(report.observedAt);
			if (!Number.isFinite(observedAt)) continue;
			const previous = this.#lastMemberReport(report.databaseId, nodeId);
			// Persist the member's own observation time and never let a reordered/older report
			// overwrite a newer one (review blocker 8).
			if (previous && Date.parse(previous.observedAt) >= observedAt) continue;
			this.ctx.sqlite.run(
				`INSERT INTO database_member_status (database_id, node_id, role, generation, epoch, streaming, in_recovery, lsn, durability_effective, sync_state, read_only, fenced, lease_generation, lease_epoch, observed_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(database_id, node_id) DO UPDATE SET role = excluded.role, generation = excluded.generation,
				 epoch = excluded.epoch, streaming = excluded.streaming, in_recovery = excluded.in_recovery,
				 lsn = excluded.lsn, durability_effective = excluded.durability_effective, sync_state = excluded.sync_state,
				 read_only = excluded.read_only, fenced = excluded.fenced, lease_generation = excluded.lease_generation,
				 lease_epoch = excluded.lease_epoch, observed_at = excluded.observed_at`,
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
					report.readOnly ? 1 : 0,
					report.fenced ? 1 : 0,
					report.leaseGeneration,
					report.leaseEpoch,
					observedAt,
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
			// A node-hosted on_sync_loss decision (major 12). Apply it only at the exact lease ETag
			// the node acted on: a stale snapshot can never clear a newer set (major 13).
			if (result.step === 'watchdog') {
				if (result.status !== 'ok' || database.durability !== 'sync' || database.syncState !== 'steady') continue;
				const policy = result.targetSyncState === 'block' ? 'block' : 'downgrade';
				const current = await this.#readLease(database.id);
				if (current && result.leaseEtag && current.etag !== result.leaseEtag) {
					await this.#reconcileStaleSyncAction(database, result, current);
					continue;
				}
				await this.#loseSync(
					database,
					policy,
					'The primary node observed no synchronous standby for its sync timeout and applied on_sync_loss.',
					this.ctx.now(),
					result.leaseEtag ?? null,
				).catch(async (error: unknown) => {
					const latest = await this.#readLease(database.id);
					if (latest) await this.#reconcileStaleSyncAction(database, result, latest);
					else
						await this.#notify(
							database,
							'sync_watchdog_failed',
							'critical',
							'The node watchdog result could not be recorded',
							`${errorText(error)}. The setting may already have changed on the primary; reconcile by hand.`,
						);
				});
				continue;
			}
			// The node applies the setting at the lease ETag it last saw; if the lease moved under it
			// the result is stale. Never record the applied setting as a steady sync set: reconcile
			// from the current lease and alert (W9-SPEC §5.5 clarification, W10 review).
			const leaseRecord = await this.#readLease(database.id);
			if (leaseRecord && result.leaseEtag && leaseRecord.etag !== result.leaseEtag) {
				await this.#reconcileStaleSyncAction(database, result, leaseRecord);
				continue;
			}
			if (database.syncState !== 'changing') continue;
			// Echoed version: a result for an earlier attempt must not close this change (major 10).
			if (result.version !== undefined && result.version !== this.#expectedSyncVersion(database)) {
				await this.#notify(
					database,
					'sync_stale_result',
					'warning',
					'A stale sync-set result was ignored',
					`The node reported ${result.step} at version ${result.version}, but the current instruction is ${this.#expectedSyncVersion(database) ?? 'none'}. Nothing was recorded.`,
				);
				continue;
			}
			if (result.status === 'ok' && result.step === 'clear-sync') {
				// A change opened by a promotion has no target yet; clearing the inherited setting is
				// step 2's first half. The next tick arms a target through the same transition.
				this.ctx.db
					.update(databases)
					.set({ syncPhase: 'rearming', syncChangeStartedAt: this.ctx.now(), updatedAt: this.ctx.now() })
					.where(eq(databases.id, database.id))
					.run();
				continue;
			}
			if (result.status === 'ok' && result.step === 'set-sync') {
				// The barrier only closes the change when the TARGET (not the primary) reported a
				// replay position at or beyond the barrier, and its slot was actually `sync`.
				const barrierLsn = result.lsn ?? null;
				const replayLsn = result.replayLsn ?? null;
				if (!barrierLsn || !replayLsn || !barrierHolds(replayLsn, barrierLsn) || result.targetSyncState !== 'sync') {
					try {
						await this.#switchFailed(
							database,
							`The target did not prove the barrier (barrier ${barrierLsn ?? 'unknown'}, target replay ${replayLsn ?? 'missing'}, sync_state ${result.targetSyncState ?? 'missing'}).`,
							barrierLsn,
						);
					} catch (error) {
						const latest = await this.#readLease(database.id);
						if (latest) await this.#reconcileStaleSyncAction(database, result, latest);
						else
							await this.#notify(
								database,
								'sync_failure_unrecorded',
								'critical',
								'A sync failure could not be recorded',
								`${errorText(error)}. Nothing was recorded as sync.`,
							);
					}
					continue;
				}
				this.ctx.db
					.update(databases)
					.set({ syncPhase: 'closing', syncBarrierLsn: barrierLsn, updatedAt: this.ctx.now() })
					.where(eq(databases.id, database.id))
					.run();
				try {
					await this.#closeChange(database, barrierLsn);
				} catch (error) {
					// The lease moved under the node (or another writer won). Never record the setting
					// as steady sync; reconcile from the current lease and alert.
					const latest = await this.#readLease(database.id);
					if (latest) await this.#reconcileStaleSyncAction(database, result, latest);
					else
						await this.#notify(
							database,
							'sync_close_failed',
							'critical',
							'Sync-set close failed',
							`The target proved the barrier, but the lease could not be closed: ${errorText(error)}. Nothing was recorded as sync.`,
						);
				}
				continue;
			}
			await this.#switchFailed(
				database,
				result.error ?? "the primary's node could not apply the sync setting",
				result.lsn ?? null,
			).catch(async (error: unknown) => {
				const latest = await this.#readLease(database.id);
				if (latest) await this.#reconcileStaleSyncAction(database, result, latest);
				else
					await this.#notify(
						database,
						'sync_failure_unrecorded',
						'critical',
						'A sync failure could not be recorded',
						`${errorText(error)}. Nothing was recorded as sync.`,
					);
			});
		}
	}

	async #readLease(databaseId: string) {
		const store = this.#store();
		if (!store) return null;
		try {
			return await store.read(databaseId);
		} catch {
			return null;
		}
	}

	/**
	 * A node applied `synchronous_standby_names` at a lease ETag that has since moved. The node did
	 * its job; the control plane must not record its setting as a steady sync set. Reconcile from
	 * the current lease: if it still names a healthy member, re-open the Revision 1 transition to
	 * re-prove the setting; if not (or the node left the setting empty), apply `on_sync_loss`. Every
	 * path alerts with the setting the node actually left.
	 */
	async #reconcileStaleSyncAction(
		database: DatabaseRow,
		result: DatabaseSyncResult,
		current: { lease: DatabaseLease; etag: string },
	): Promise<void> {
		const now = this.ctx.now();
		const applied = result.applied ?? [];
		const detail = `The node applied [${applied.length > 0 ? applied.join(', ') : 'no members'}] at lease ETag ${result.leaseEtag ?? 'unknown'}, but the lease moved to ${current.etag}.`;
		const lease = current.lease;
		if (lease.syncState !== 'steady') {
			await this.#notify(
				database,
				'sync_stale_change',
				'critical',
				'A sync result raced an open change',
				`${detail} The lease is changing, so the node's setting is not recorded as sync. Recover the open change deliberately.`,
			);
			return;
		}
		if (lease.durability === 'async' || lease.durabilityEffective === 'async') {
			// The current authority already says async: make the row agree, never record sync.
			this.ctx.db
				.update(databases)
				.set({
					syncState: 'steady',
					syncReplicaNodeId: null,
					syncPreviousNodeId: null,
					syncChangeStartedAt: null,
					syncPhase: null,
					durabilityEffective: 'async',
					syncLeaseEtag: current.etag,
					syncLeaseExpiresAt: Date.parse(lease.expiresAt),
					updatedAt: now,
				})
				.where(eq(databases.id, database.id))
				.run();
			await this.#notify(database, 'sync_stale_async', 'warning', 'A stale sync result matched an async lease', `${detail} The database is recorded async, as the lease says.`);
			return;
		}
		const members = this.#memberViews(database.id);
		const healthy = lease.sync.find((nodeId) => members.find((member) => member.nodeId === nodeId)?.streaming === true) ?? null;
		if (applied.length > 0 && healthy) {
			// The node's setting names a healthy member; re-apply it through a real transition so a
			// barrier proves it again, rather than trusting a stale result.
			try {
				await this.#openChange(database, healthy, now);
				await this.#notify(
					database,
					'sync_stale_reapplied',
					'warning',
					'A sync setting is being re-applied after a stale result',
					`${detail} The lease still names ${healthy}; a fresh transition will require its barrier before anything is recorded.`,
				);
			} catch (error) {
				await this.#notify(
					database,
					'sync_stale_reapply_failed',
					'critical',
					'A stale sync setting could not be re-applied',
					`${detail} Re-opening the transition failed: ${errorText(error)}.`,
				);
			}
			return;
		}
		const policy = database.onSyncLoss;
		const next = renewedLease(loseSyncSet(lease, policy, { durability: database.durability }, now), now);
		const store = this.#store();
		if (store && (await store.compareAndSwap(database.id, current.etag, next))) {
			this.ctx.db
				.update(databases)
				.set({
					syncState: 'steady',
					syncReplicaNodeId: null,
					syncPreviousNodeId: null,
					syncChangeStartedAt: null,
					syncPhase: null,
					syncSetAt: now,
					durability: database.durability,
					durabilityEffective: policy === 'downgrade' ? 'async' : 'sync',
					syncLostAt: policy === 'block' ? (database.syncLostAt ?? now) : null,
					syncLeaseEtag: null,
					syncLeaseExpiresAt: null,
					updatedAt: now,
				})
				.where(eq(databases.id, database.id))
				.run();
			await this.#notify(
				database,
				'sync_stale_reconciled',
				'critical',
				'A stale sync action was reconciled to on_sync_loss',
				`${detail} No healthy member is named, so ${policy} is now recorded. Nothing was recorded as sync.`,
			);
		} else {
			await this.#notify(
				database,
				'sync_stale_reconcile_failed',
				'critical',
				'A stale sync action could not be reconciled',
				`${detail} The arbitration write lost; nothing was recorded. The next tick re-reads the lease.`,
			);
		}
	}

	/** The version `syncTasksForNode` would emit now; a result at another version is stale. */
	#expectedSyncVersion(row: DatabaseRow): string | null {
		if (row.syncState === 'changing' && row.syncReplicaNodeId) {
			const replica = this.#replicaOn(row.id, row.syncReplicaNodeId);
			return replica?.slot ? this.#syncVersion(row, 'set-sync', replica.slot) : null;
		}
		if (row.syncState === 'changing') return this.#syncVersion(row, 'clear-sync', 'rearming');
		if (row.syncReplicaNodeId === null && row.syncSetAt !== null) return this.#syncVersion(row, 'clear-sync', 'downgraded');
		return null;
	}

	/** Planned switchover drain/resume outcomes. */
	async applySwitchoverResults(nodeId: string, results: readonly DatabaseSwitchoverResult[]): Promise<void> {
		for (const result of results) {
			const failover = this.#failover(result.switchoverId);
			if (!failover || failover.fromNodeId !== nodeId || failover.kind !== 'switchover') continue;
			const database = this.ctx.db.select().from(databases).where(eq(databases.id, failover.databaseId)).get();
			if (!database) continue;
			const expected = sha256Hex(
				JSON.stringify({ v: 1, id: failover.id, step: result.step, attempt: failover.switchoverAttempt }),
			);
			if (result.version !== undefined && result.version !== expected) continue;
			if (result.step === 'resume') {
				if (result.status !== 'ok') {
					// A failed resume is not success: keep the task, bump its version so the node retries
					// it (a stable version would be de-duplicated forever), and alert.
					this.ctx.db
						.update(databaseFailovers)
						.set({
							switchoverStep: 'resume',
							switchoverStartedAt: this.ctx.now(),
							switchoverAttempt: failover.switchoverAttempt + 1,
							message: `Resuming writes failed: ${result.error ?? 'unknown error'}. Retrying.`,
						})
						.where(eq(databaseFailovers.id, failover.id))
						.run();
					void this.#notify(
						database,
						'resume_failed',
						'critical',
						'Writes are still stopped after a refused switchover',
						`The drain was refused and the old primary did not resume writes: ${result.error ?? 'unknown error'}. Retrying; writes remain read-only until it succeeds.`,
					);
					continue;
				}
				this.ctx.db
					.update(databaseFailovers)
					.set({ switchoverStep: null, finishedAt: this.ctx.now(), message: 'Writes resumed; the switchover was refused.' })
					.where(eq(databaseFailovers.id, failover.id))
					.run();
				continue;
			}
			if (result.status === 'failed') {
				this.#refuseSwitchover(failover, `Drain failed: ${result.error ?? 'unknown error'}`, null, result.lsn ?? null);
				continue;
			}
			const replica = failover.replicaId
				? this.ctx.db.select().from(databaseReplicas).where(eq(databaseReplicas.id, failover.replicaId)).get()
				: undefined;
			// The drain must report both the primary's final LSN and the target's fresh replay LSN.
			// Falling back to the replica's cached row would accept a sample up to 30 s old.
			if (!replica || !result.lsn || !result.replayLsn) {
				this.#refuseSwitchover(
					failover,
					'The drain did not report both the primary and target WAL positions; refusing to promote without proving LSN equality.',
					null,
					result.lsn ?? null,
				);
				continue;
			}
			const gap = gapBytes(result.lsn, result.replayLsn);
			if (gap === null || gap > 0) {
				this.#refuseSwitchover(
					failover,
					`The replica is ${gap ?? 'an unknown number of'} byte(s) behind the primary's ${result.lsn}; refusing the switchover.`,
					gap,
					result.lsn,
				);
				continue;
			}
			// The non-promotable gate is moved before the promotion is handed out: read the lease,
			// not just the row cache, so an open change or an expired lease refuses here while writes
			// can still be resumed.
			const refusal =
				database.syncState === 'changing'
					? 'a sync-set change is open; the database is non-promotable'
					: await this.promotionRefusal(database, replica.nodeId, false);
			if (refusal) {
				this.#refuseSwitchover(failover, `Promotion refused: ${refusal}.`, 0, result.lsn);
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

	// ---------------------------------------------------------------- the timer

	/**
	 * The steady-state watchdog and the change timeout (W9-SPEC §5.5). Called from maintenance.
	 * - A sync database whose named standby is not streaming starts a transition to another
	 *   replica, or after `sync_timeout` applies `on_sync_loss`.
	 * - A change older than `SYNC_CHANGE_TIMEOUT` whose barrier never came back falls back to the
	 *   previous member when it is healthy, else applies `on_sync_loss`.
	 */
	async tick(now = this.ctx.now()): Promise<number> {
		// Lease retries and switchover stalls are recovery paths, not SYNC_REPLICA features: a
		// promotion or a stopped-writes switchover must still finish after the flag is turned off.
		let changed = await this.#retryPromotionLeases();
		changed += await this.#switchoverStalls(now);
		// The W11 reader reconciles a promotion a node performed while this control plane was down,
		// whatever the flags are now: it never decides, never lowers and never needs the lease to be
		// writable by this process (W11-SPEC §7, I11).
		changed += await this.reconcilePromotions(now);
		if (!featureEnabled(this.ctx.config, 'SYNC_REPLICA')) return changed;
		await this.#replicaAlerts(now);
		const rows = this.ctx.db
			.select()
			.from(databases)
			.where(and(isNull(databases.deletedAt), or(eq(databases.durability, 'sync'), isNotNull(databases.syncLeaseEtag))))
			.all();
		for (const database of rows) {
			// CAS writes renew the lease, but a steady set otherwise never writes again: without this
			// the holder's lease is permanently expired one TTL after arming (W10 review blocker 3).
			// Async databases have a lease too (a promotion creates one); renew it as well.
			if (await this.#renewLeaseIfDue(database, now)) changed += 1;
			// Only a `sync` row has a set/watchdog decision; an async lease is renewed and left alone.
			if (database.durability !== 'sync') continue;
			if (database.syncState === 'changing') {
				// A change opened by a promotion starts with nobody named: arm the first healthy
				// replica through the same non-promotable transition (major 9), or lose sync once the
				// change timeout expires.
				if (!database.syncReplicaNodeId) {
					const candidate = this.#armCandidate(database);
					if (candidate) {
						this.ctx.db
							.update(databases)
							.set({
								syncReplicaNodeId: candidate,
								syncChangeStartedAt: now,
								syncAttempt: database.syncAttempt + 1,
								syncPhase: 'opening',
								updatedAt: now,
							})
							.where(eq(databases.id, database.id))
							.run();
						changed += 1;
						continue;
					}
				}
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
				try {
					await this.#openChange(database, decision.target, now);
					changed += 1;
				} catch {
					// A failover is active or the CAS was lost; the next tick re-evaluates.
				}
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

	/**
	 * A switchover parked at `promote` that never had a promotion task handed out leaves writes
	 * stopped with no timer. After `SYNC_CHANGE_TIMEOUT` alert and queue the resume; a task that
	 * was handed out is not touched because the node may be promoting right now.
	 */
	async #switchoverStalls(now: number): Promise<number> {
		let changed = 0;
		const rows = this.ctx.db
			.select({ failover: databaseFailovers, database: databases })
			.from(databaseFailovers)
			.innerJoin(databases, eq(databases.id, databaseFailovers.databaseId))
			.where(
				and(
					eq(databaseFailovers.kind, 'switchover'),
					eq(databaseFailovers.status, 'promoting'),
					eq(databaseFailovers.switchoverStep, 'promote'),
					isNull(databaseFailovers.promotedAt),
					isNull(databaseFailovers.promotionIssuedAt),
				),
			)
			.all();
		for (const { failover, database } of rows) {
			const since = failover.switchoverStartedAt ?? failover.startedAt;
			if (now - since < SYNC_CHANGE_TIMEOUT_MS) continue;
			const message = `The switchover drained writes but no promotion was issued within ${SYNC_CHANGE_TIMEOUT_MS / 1000} s; resuming writes and refusing the switchover.`;
			this.ctx.db
				.update(databaseFailovers)
				.set({
					status: 'failed',
					switchoverStep: 'resume',
					switchoverAttempt: failover.switchoverAttempt + 1,
					switchoverStartedAt: now,
					message,
				})
				.where(eq(databaseFailovers.id, failover.id))
				.run();
			await this.#notify(
				database,
				'switchover_parked',
				'critical',
				'Writes were stopped with no promotion',
				message,
			);
			changed += 1;
		}
		return changed;
	}

	/** Lag, replica-down and slot-lost alerts (docs/CLUSTERING.md §9.2, §12.5). */
	async #replicaAlerts(now: number): Promise<void> {		const rows = this.ctx.db
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
				// HA-PLAN H26: a standby region's replica lag is the data a region promotion would lose.
				const standby = database.standbyRegion !== null && regionOf(this.#node(replica.nodeId) ?? {}) === database.standbyRegion;
				await this.#notify(
					database,
					`replica_lag:${replica.id}`,
					'warning',
					standby ? 'Standby region replica lag' : 'Replica lag',
					standby
						? `The standby replica ${replica.id} in region ${database.standbyRegion} is ${lagSeconds} s / ${lagBytes} bytes behind. A region promotion now would lose about that much; check the link between the regions.`
						: `Replica ${replica.id} is ${lagSeconds} s / ${lagBytes} bytes behind. Reads from it may be stale; check the overlay and disk.`,
				);
			}
		}
	}

	/** True when every involved node really renews from the arbiter, so this process must not. */
	#nodeRenewalAvailable(database: DatabaseRow): boolean {
		const replicaIds = this.ctx.db
			.select({ nodeId: databaseReplicas.nodeId })
			.from(databaseReplicas)
			.where(and(eq(databaseReplicas.databaseId, database.id), isNull(databaseReplicas.removingAt)))
			.all()
			.map((row) => row.nodeId);
		const ids = [...new Set([database.nodeId, ...replicaIds])];
		if (ids.length === 0) return false;
		return ids.every((id: string) => {
			const node = this.#node(id);
			return Boolean(node && parseJson<string[]>(node.capabilitiesJson, []).includes(DB_MEMBER_SELF_FENCING_CAPABILITY));
		});
	}

	/**
	 * The database lease as the arbiter holds it now, with the arbiter's clock, for the region
	 * promotion's live-lease gate (HA-PLAN H26). `record` is null when there is no arbiter or no
	 * lease; `error` says the arbiter could not be read.
	 */
	async readLease(databaseId: string): Promise<{ record: DatabaseLeaseRecord | null; error: string | null }> {
		const store = this.#store();
		if (!store) return { record: null, error: null };
		try {
			return { record: await store.read(databaseId), error: null };
		} catch (error) {
			return { record: null, error: errorText(error) };
		}
	}

	#store(): DatabaseLeaseStore | null {
		return this.ctx.arbiter ? new ObjectStoreDatabaseLeaseStore(this.ctx.arbiter) : null;
	}

	/** Renew a lease the primary holds when it is inside half a TTL of expiry; CAS at its ETag. */
	async #renewLeaseIfDue(database: DatabaseRow, now: number): Promise<boolean> {
		// Review blocker 9: once every data node advertises the real member machine, the primary's
		// node renews its own lease; the control plane must not race it.
		if (this.#nodeRenewalAvailable(database)) return false;
		// HA-PLAN H26 (W13 review): with regions on, an offline holder's lease must lapse, and so must
		// the lease of a database an open region promotion is moving, or the promotion's live-lease
		// gate would refuse for ever. A draining or pending node still runs its primary, and with
		// regions off nothing gates on the lease lapsing, so both keep the W10 renewal.
		if (featureEnabled(this.ctx.config, 'REGIONS') && this.#node(database.nodeId)?.status === 'offline') return false;
		if (this.#regionPromotionMoving(database.id)) return false;
		const store = this.#store();
		if (!store) return false;
		try {
			const current = await store.read(database.id);
			if (!current || current.lease.holderNodeId !== database.nodeId) return false;
			const expiresAt = Date.parse(current.lease.expiresAt);
			// Never resurrect an expired lease: the holder could not prove it before the TTL, so a
			// control-plane write would make a fenced primary live again (review blocker 9).
			if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
			if (expiresAt - now >= DB_LEASE_TTL_MS / 2) return false;
			const renewed = renewedLease(current.lease, now);
			if (!(await store.compareAndSwap(database.id, current.etag, renewed))) return false;
			const written = await store.read(database.id);
			this.ctx.db
				.update(databases)
				.set({
					syncLeaseEtag: written?.etag ?? current.etag,
					syncLeaseExpiresAt: written ? Date.parse(written.lease.expiresAt) : expiresAt,
					updatedAt: now,
				})
				.where(eq(databases.id, database.id))
				.run();
			return true;
		} catch {
			// The arbiter is unreachable: the holder cannot prove the lease, and the next tick retries.
			return false;
		}
	}

	/** True while an open region promotion has an unfinished step for this database. */
	#regionPromotionMoving(databaseId: string): boolean {
		return Boolean(
			this.ctx.sqlite
				.query(
					`SELECT 1 FROM region_promotion_steps s JOIN region_promotions p ON p.id = s.promotion_id
					  WHERE p.finished_at IS NULL AND s.kind = 'database' AND s.resource_id = ? AND s.status IN ('pending', 'running') LIMIT 1`,
				)
				.get(databaseId),
		);
	}

	/** Retry a promotion's lease take that failed after the database was already re-pointed. */
	async #retryPromotionLeases(): Promise<number> {
		let changed = 0;
		const rows = this.ctx.db
			.select({ failover: databaseFailovers, database: databases })
			.from(databaseFailovers)
			.innerJoin(databases, eq(databases.id, databaseFailovers.databaseId))
			.where(and(isNotNull(databaseFailovers.promotedAt), isNull(databaseFailovers.leaseTakenAt)))
			.orderBy(desc(databaseFailovers.startedAt))
			.all();
		// Newest first: `onPromotion` refuses to lower a generation, so an older blocked row can
		// never move the lease backwards. Process at most one (the newest) per database.
		const seen = new Set<string>();
		for (const { failover, database } of rows) {
			if (seen.has(database.id) || database.deletedAt) continue;
			seen.add(database.id);
			try {
				await this.onPromotion(database.id, failover.toNodeId, failover.generation, failover.id);
				changed += 1;
			} catch (error) {
				await this.onLeaseTakeFailed(failover, errorText(error));
			}
		}
		return changed;
	}

	#note(database: DatabaseRow): string | null {
		if (database.durability !== 'sync') return null;
		if (database.syncState === 'changing') return 'A sync-set change is open; no member may promote automatically.';
		if (database.durabilityEffective === 'async') return 'Downgraded: the synchronous standby was lost. Writes are async.';
		if (!database.syncReplicaNodeId) return 'Blocked: no member is named synchronous, so writes block rather than lose a commit.';
		return null;
	}

	/** The replica `#armSync` would make synchronous; throws the refusal when there is none. */
	#syncTarget(database: DatabaseRow, settings: DurabilitySettings): { nodeId: string } {
		const replicas = this.ctx.databaseReplicas.rowsFor(database.id).filter((row) => !row.removingAt && row.primaryGeneration === database.primaryGeneration);
		// HA-PLAN H26: `sync` is only offered inside one region; a replica in another region (a
		// standby region's in particular) stays async and is never a sync target.
		const crossNode = replicas.filter((row) => row.nodeId !== database.nodeId && this.#sameRegionAsPrimary(database, row.nodeId));
		const elsewhere = replicas.filter((row) => row.nodeId !== database.nodeId && !this.#sameRegionAsPrimary(database, row.nodeId));
		if (crossNode.length === 0 && elsewhere.length > 0)
			throw new ValidationError(
				syncTargetRefusal(this.#node(database.nodeId) ?? { name: database.nodeId }, this.#node(elsewhere[0]!.nodeId) ?? { name: elsewhere[0]!.nodeId }) ??
					'A synchronous replica must be in the primary\'s region.',
			);
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
		return target;
	}

	async #armSync(
		database: DatabaseRow,
		settings: DurabilitySettings,
		principal: Principal,
	): Promise<void> {
		const target = this.#syncTarget(database, settings);
		await this.#openChange(database, target.nodeId, this.ctx.now(), settings, principal);
	}

	/**
	 * Step 1. The lease goes to `sync: []`, `changing` (non-promotable); the row records the target
	 * so the primary's node is told which setting to apply. A failed CAS is a conflict, never a blind
	 * retry.
	 */
	async #openChange(
		database: DatabaseRow,
		target: string | null,
		now: number,
		settings: DurabilitySettings = this.durability(database.id),
		principal?: { userId?: string | null; kind?: string },
	): Promise<void> {
		if (this.#activeFailover(database.id))
			throw new ConflictError('A failover is active; a sync-set change cannot be opened until it finishes.');
		// HA-PLAN H26: the one choke point every sync set passes through. A target outside the
		// primary's region is refused, whichever picker chose it.
		if (target !== null && !this.#sameRegionAsPrimary(database, target))
			throw new ValidationError(
				syncTargetRefusal(this.#node(database.nodeId) ?? { name: database.nodeId }, this.#node(target) ?? { name: target }) ??
					'A synchronous replica must be in the primary\'s region.',
			);
		const store = this.#store();
		if (!store) throw new CoreError('unavailable', 'No arbiter is configured; a sync change cannot be recorded.', 409);
		const current = await store.read(database.id);
		if (current && current.lease.holderNodeId !== database.nodeId)
			throw new ConflictError(`The database lease is held by ${current.lease.holderNodeId}, not its primary's node.`);
		if (current && current.lease.syncState !== 'steady')
			throw new ConflictError('A sync-set change is already open on the lease; close or recover it before starting another.');
		const opening: DatabaseLease = current
			? renewedLease(openSyncChange(current.lease), now)
			: renewedLease(
					{
						generation: database.primaryGeneration,
						holderNodeId: database.nodeId,
						expiresAt: new Date(now).toISOString(),
						sync: [],
						syncState: 'changing',
						durability: settings.durability,
						durabilityEffective: database.durabilityEffective,
						syncSetAt: null,
					},
					now,
				);
		if (!(await store.compareAndSwap(database.id, current?.etag ?? null, opening)))
			throw new ConflictError('The sync change lost the compare-and-swap; re-read the lease and try again.');
		const written = await store.read(database.id);
		const attempt = database.syncAttempt + 1;
		this.ctx.db
			.update(databases)
			.set({
				durability: settings.durability,
				syncTimeoutSeconds: settings.syncTimeoutSeconds,
				onSyncLoss: settings.onSyncLoss,
				syncState: 'changing',
				syncReplicaNodeId: target,
				syncPreviousNodeId: target ? (current?.lease.sync[0] ?? database.syncReplicaNodeId) : null,
				syncChangeStartedAt: now,
				syncAttempt: attempt,
				syncPhase: 'opening',
				syncBarrierLsn: null,
				syncLeaseEtag: written?.etag ?? null,
				syncLeaseExpiresAt: written ? Date.parse(written.lease.expiresAt) : null,
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
			args: { name: database.name, target, previous: current?.lease.sync ?? [], generation: database.primaryGeneration, attempt },
			result: 'ok',
		});
	}

	/** Step 3 (success). Only a barrier-acknowledged target may close. */
	async #closeChange(database: DatabaseRow, barrierLsn: string | null): Promise<void> {
		const target = database.syncReplicaNodeId;
		if (!target) return;
		const store = this.#store();
		let etag: string | null = null;
		let expiresAt: number | null = null;
		if (store) {
			const current = await store.read(database.id);
			if (!current) throw new ConflictError('The database lease disappeared before the sync close.');
			if (current.lease.holderNodeId !== database.nodeId)
				throw new ConflictError(`The database lease is held by ${current.lease.holderNodeId}, not its primary's node.`);
			if (current.lease.syncState === 'changing') {
				const closed = renewedLease(closeSyncChange(current.lease, target, this.ctx.now(), database.durability), this.ctx.now());
				if (!(await store.compareAndSwap(database.id, current.etag, closed)))
					throw new ConflictError('The sync close lost the compare-and-swap; the lease needs a re-read.');
				const written = await store.read(database.id);
				etag = written?.etag ?? null;
				expiresAt = written ? Date.parse(written.lease.expiresAt) : null;
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
				syncPhase: null,
				syncBarrierLsn: barrierLsn,
				...(etag ? { syncLeaseEtag: etag, syncLeaseExpiresAt: expiresAt } : {}),
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

	/**
	 * Step 2 failed. The previous member may be restored only after its setting is in force and it
	 * has proven the failed barrier's position; the close then happens through the normal barrier
	 * task, never by CASing a steady set the Postgres setting does not name (blockers 3 and 18).
	 * If it cannot be restored, `on_sync_loss` applies.
	 */
	async #switchFailed(database: DatabaseRow, reason: string, barrierLsn: string | null): Promise<void> {
		const previous = database.syncPreviousNodeId;
		if (previous && previous !== database.syncReplicaNodeId) {
			const replica = this.#replicaOn(database.id, previous);
			if (replica && replica.slot && this.#memberHealthy(database, replica)) {
				if (barrierLsn && replica.replayLsn && !barrierHolds(replica.replayLsn, barrierLsn)) {
					await this.#loseSync(
						database,
						database.onSyncLoss,
						`${reason} The previous member ${previous} is behind the failed barrier (${replica.replayLsn} < ${barrierLsn}).`,
						this.ctx.now(),
					);
					return;
				}
				const now = this.ctx.now();
				// Re-arm the same open transition at the previous member. The lease stays
				// `changing` (non-promotable) until a fresh barrier at that member closes it.
				this.ctx.db
					.update(databases)
					.set({
						syncReplicaNodeId: previous,
						syncPreviousNodeId: null,
						syncChangeStartedAt: now,
						syncAttempt: database.syncAttempt + 1,
						syncPhase: 'opening',
						syncBarrierLsn: null,
						updatedAt: now,
					})
					.where(eq(databases.id, database.id))
					.run();
				await this.#notify(
					database,
					'sync_fallback',
					'warning',
					`Sync change falling back to ${previous}`,
					`${reason} The previous member is being restored through a fresh setting and barrier; the database stays non-promotable until it acknowledges.`,
				);
				return;
			}
		}
		await this.#loseSync(database, database.onSyncLoss, reason, this.ctx.now());
	}

	async #loseSync(
		database: DatabaseRow,
		policy: 'downgrade' | 'block',
		reason: string,
		now: number,
		expectedEtag: string | null = null,
	): Promise<void> {
		const store = this.#store();
		let etag: string | null = null;
		let expiresAt: number | null = null;
		if (store) {
			const current = await store.read(database.id);
			// A node-hosted result carries the ETag it acted on; a newer lease makes it stale.
			if (current && expectedEtag !== null && current.etag !== expectedEtag) return;
			if (current && current.lease.holderNodeId !== database.nodeId && expectedEtag === null)
				throw new ConflictError(`The database lease is held by ${current.lease.holderNodeId}, not its primary's node.`);
			if (current && current.lease.holderNodeId === database.nodeId) {
				const lease = renewedLease(loseSyncSet(current.lease, policy, { durability: database.durability }, now), now);
				if (!(await store.compareAndSwap(database.id, current.etag, lease)))
					throw new ConflictError('The downgrade lost the compare-and-swap; the lease needs a re-read.');
				const written = await store.read(database.id);
				etag = written?.etag ?? null;
				expiresAt = written ? Date.parse(written.lease.expiresAt) : null;
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
				syncPhase: null,
				// The requested policy stays `sync`; the alert rides `durability_effective = async`.
				durability: database.durability,
				durabilityEffective: policy === 'downgrade' ? 'async' : 'sync',
				// Keep the loss timestamp for `block`, so the watchdog does not re-apply it forever.
				syncLostAt: policy === 'block' ? (database.syncLostAt ?? now) : null,
				...(etag ? { syncLeaseEtag: etag, syncLeaseExpiresAt: expiresAt } : {}),
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
				await this.#switchFailed(
					database,
					`The barrier was not acknowledged within ${SYNC_CHANGE_TIMEOUT_MS / 1000} s; falling back to ${previous}.`,
					database.syncBarrierLsn,
				);
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
		let etag: string | null = null;
		let expiresAt: number | null = null;
		if (store) {
			const current = await store.read(database.id);
			if (current && current.lease.holderNodeId !== database.nodeId)
				throw new ConflictError(`The database lease is held by ${current.lease.holderNodeId}, not its primary's node.`);
			if (current) {
				const clear = renewedLease(
					{
						...current.lease,
						sync: [],
						syncState: 'steady',
						durability: 'async',
						durabilityEffective: 'async',
						syncSetAt: new Date(this.ctx.now()).toISOString(),
					},
					this.ctx.now(),
				);
				if (!(await store.compareAndSwap(database.id, current.etag, clear)))
					throw new ConflictError('The durability change lost the compare-and-swap; re-read the lease and try again.');
				const written = await store.read(database.id);
				etag = written?.etag ?? null;
				expiresAt = written ? Date.parse(written.lease.expiresAt) : null;
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
				syncPhase: null,
				durabilityEffective: 'async',
				...(etag ? { syncLeaseEtag: etag, syncLeaseExpiresAt: expiresAt } : {}),
				updatedAt: this.ctx.now(),
			})
			.where(eq(databases.id, database.id))
			.run();
	}

	/** Members a sync decision may name: never one outside the primary's region (HA-PLAN H26). */
	#memberViews(databaseId: string): SyncMemberView[] {
		const database = this.#database(databaseId);
		return this.ctx.databaseReplicas
			.rowsFor(databaseId)
			.filter((row) => !row.removingAt && this.#sameRegionAsPrimary(database, row.nodeId))
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

	/** The first healthy cross-node replica to arm after a promotion; null when none can serve. */
	#armCandidate(database: DatabaseRow): string | null {
		const candidates = this.ctx.databaseReplicas
			.rowsFor(database.id)
			.filter(
				(row) =>
					!row.removingAt &&
					row.nodeId !== database.nodeId &&
					row.slot !== null &&
					row.primaryGeneration === database.primaryGeneration &&
					this.#sameRegionAsPrimary(database, row.nodeId) &&
					databaseReplicaReadable(row.status) &&
					this.#memberHealthy(database, row),
			)
			.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
		return candidates[0]?.nodeId ?? null;
	}

	/** True when `nodeId` is in the database primary's region (stored regions; `default` when unset). */
	#sameRegionAsPrimary(database: Pick<DatabaseRow, 'nodeId'>, nodeId: string): boolean {
		return regionOf(this.#node(database.nodeId) ?? {}) === regionOf(this.#node(nodeId) ?? {});
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
				// Bump the attempt so the resume task has a new version and the node retries it.
				switchoverStartedAt: now,
				switchoverAttempt: failover.switchoverAttempt + 1,
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
				: row.switchoverStep === 'promote'
					? 'promote'
					: row.switchoverStep === 'resume' || row.status === 'failed'
						? 'stop-writes'
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
			promoted: row.promotedAt !== null,
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
					read_only: number;
					fenced: number;
					lease_generation: number;
					lease_epoch: number;
					observed_at: number;
				},
				[string, string]
			>('SELECT role, generation, epoch, streaming, in_recovery, lsn, durability_effective, sync_state, read_only, fenced, lease_generation, lease_epoch, observed_at FROM database_member_status WHERE database_id = ? AND node_id = ?')
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
			readOnly: row.read_only === 1,
			fenced: row.fenced === 1,
			leaseGeneration: row.lease_generation,
			leaseEpoch: row.lease_epoch,
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
