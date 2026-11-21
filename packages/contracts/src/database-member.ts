import { z } from 'zod';
import { databaseFailoverModes } from './database-failover-policy.ts';

/**
 * Database members, durability and the synchronous set (HA-PLAN H21–H23, Wave 3 opening). The
 * lease object is the authority for the sync set; these contracts are what the control plane and
 * agents exchange. The member machine is lane A/B after the approved W9 spec.
 */

/** An agent that runs the database member machine (role discovery, keep-alive, fencing). */
export const DB_MEMBER_CAPABILITY = 'db-member';

export const databaseDurabilities = ['async', 'sync'] as const;
export type DatabaseDurability = (typeof databaseDurabilities)[number];

export const syncLossPolicies = ['downgrade', 'block'] as const;
export type SyncLossPolicy = (typeof syncLossPolicies)[number];

export const databaseMemberRoles = [
	'streaming',
	'candidate',
	'promoting',
	'primary',
	'fencing',
	'fenced',
	'rewind',
] as const;

export type DatabaseMemberRole = (typeof databaseMemberRoles)[number];

/** The lease's own transition flag (W9-SPEC Revision 1 §5.5). `changing` is non-promotable. */
export const syncStates = ['steady', 'changing'] as const;
export type SyncState = (typeof syncStates)[number];

/** The primary's progress through a sync-set change; the lease only records `changing`. */
export const syncTransitionPhases = ['opening', 'switching', 'waiting-barrier', 'closing', 'rearming'] as const;
export type SyncTransitionPhase = (typeof syncTransitionPhases)[number];

/** How a database is configured to behave when its synchronous replica is lost. */
export const durabilitySettingsSchema = z.object({
	durability: z.enum(databaseDurabilities),
	/** `downgrade` waits this long before switching to async. */
	syncTimeoutSeconds: z.number().int().min(0).max(300),
	onSyncLoss: z.enum(syncLossPolicies),
});

export type DurabilitySettings = z.infer<typeof durabilitySettingsSchema>;

/** A partial policy change: every field is optional, and the current value fills the rest. */
export const durabilitySettingsUpdateSchema = durabilitySettingsSchema.partial();
export type DurabilitySettingsUpdate = z.infer<typeof durabilitySettingsUpdateSchema>;

/** The sync set as recorded in the lease object (authority) and cached on the row for display. */
export const syncSetSchema = z.object({
	databaseId: z.string().min(1).max(64),
	generation: z.number().int().nonnegative(),
	/** Node ids in the synchronous set; at most one for `sync` today. */
	nodes: z.array(z.string().max(64)).max(3),
	durability: z.enum(databaseDurabilities),
	syncSetAt: z.string().datetime().nullable(),
});

export type SyncSet = z.infer<typeof syncSetSchema>;

/**
 * `yoal/ha/db/<databaseId>.json` (W9-SPEC §5.1). The holder is the only writer; every change is a
 * conditional write at the ETag it read. `durabilityEffective` is what is in force right now, which
 * is `async` after an `on_sync_loss: downgrade` even while the requested policy says `sync`.
 */
export const databaseLeaseSchema = z.object({
	generation: z.number().int().nonnegative(),
	holderNodeId: z.string().min(1).max(64),
	expiresAt: z.string().datetime(),
	sync: z.array(z.string().min(1).max(64)).max(3),
	syncState: z.enum(syncStates),
	durability: z.enum(databaseDurabilities),
	/** Optional on leases written before W9 Revision 1; absent means `durability` is in force. */
	durabilityEffective: z.enum(databaseDurabilities).optional(),
	syncSetAt: z.string().datetime().nullable().optional(),
});

export type DatabaseLease = z.infer<typeof databaseLeaseSchema>;

/** The primary's local progress through a change, for status pages and tests. */
export const databaseSyncTransitionSchema = z.object({
	phase: z.enum(syncTransitionPhases),
	target: z.string().max(64).nullable(),
	previous: z.array(z.string().max(64)).max(3),
	openedAt: z.string().datetime(),
	/** The barrier must be acknowledged by this instant or the transition falls back/downgrades. */
	deadline: z.string().datetime(),
	/** WAL position the target must replay before the transition may close. */
	barrierLsn: z.string().max(64).nullable(),
});

export type DatabaseSyncTransition = z.infer<typeof databaseSyncTransitionSchema>;

/** What the durability surface shows for one database. */
export const databaseDurabilityStatusSchema = z.object({
	databaseId: z.string().min(1).max(64),
	generation: z.number().int().nonnegative(),
	durability: z.enum(databaseDurabilities),
	durabilityEffective: z.enum(databaseDurabilities),
	syncState: z.enum(syncStates),
	sync: z.array(z.string().max(64)).max(3),
	syncSetAt: z.string().datetime().nullable(),
	syncTimeoutSeconds: z.number().int().min(0).max(300),
	onSyncLoss: z.enum(syncLossPolicies),
	transition: databaseSyncTransitionSchema.nullable(),
	lease: databaseLeaseSchema.nullable(),
	/** Why a requested `sync` is not in force (no eligible member, downgraded, changing, …). */
	note: z.string().nullable(),
});

export type DatabaseDurabilityStatus = z.infer<typeof databaseDurabilityStatusSchema>;

/** A planned switchover: drain the primary, verify LSN equality, promote, re-point. */
export const databaseSwitchoverRequestSchema = z.object({
	/** The replica row id (`dbr_…`) to promote. */
	replicaId: z.string().min(1).max(100),
	/** Typed confirmation, as for a promotion. */
	confirm: z.literal(true),
});

export type DatabaseSwitchoverRequest = z.infer<typeof databaseSwitchoverRequestSchema>;

export const databaseSwitchoverSteps = [
	'checkpoint',
	'stop-writes',
	'quiesce',
	'wait-lsn',
	'promote',
	'repoint',
	'done',
] as const;
export type DatabaseSwitchoverStep = (typeof databaseSwitchoverSteps)[number];

/** What the old primary's node does for a planned switchover; promotion reuses C7's task. */
export const databaseSwitchoverTaskSchema = z.object({
	switchoverId: z.string().min(1).max(100),
	databaseId: z.string().min(1).max(100),
	step: z.enum(['drain', 'resume']),
	/** The replica's physical slot, so the drain reports that replica's fresh replay LSN. */
	replicaSlot: z.string().max(100).nullable().default(null),
	/** Bumped when the step is retried; a result at another version is stale. */
	version: z.string().max(128).default(''),
});
export type DatabaseSwitchoverTask = z.infer<typeof databaseSwitchoverTaskSchema>;

export const databaseSwitchoverResultSchema = z.object({
	switchoverId: z.string().min(1).max(100),
	/** Echo of the task version; a mismatch is a stale result and is ignored. */
	version: z.string().max(128).optional(),
	step: z.enum(['drain', 'resume']),
	status: z.enum(['ok', 'failed']),
	/** `pg_current_wal_lsn()` after writes stopped. */
	lsn: z.string().max(64).nullable().optional(),
	/** The target replica's replay LSN from the primary's `pg_stat_replication` at drain time. */
	replayLsn: z.string().max(64).nullable().optional(),
	error: z.string().max(2_000).optional(),
});
export type DatabaseSwitchoverResult = z.infer<typeof databaseSwitchoverResultSchema>;

export interface DatabaseSwitchoverView {
	databaseId: string;
	replicaId: string;
	fromNodeId: string;
	toNodeId: string;
	generation: number;
	step: DatabaseSwitchoverStep;
	/** The primary's LSN when writes stopped; null until then. */
	primaryLsn: string | null;
	/** The replica's replay LSN when it was checked. */
	replayLsn: string | null;
	/** The gap that refused the switchover, if any. */
	gapBytes: number | null;
	/** The promotion succeeded; the old primary must not resume writes. */
	promoted: boolean;
	startedAt: string;
	finishedAt: string | null;
	/** Measured wall time from start to done/refused. */
	durationMs: number | null;
	message: string | null;
}

/** One member, as desired state tells every consumer to ask "role and generation?". */
export const databaseMemberSchema = z.object({
	nodeId: z.string().min(1).max(64),
	address: z.string().max(253).nullable(),
	role: z.enum(['primary', 'replica']),
	/** The physical slot a replica streams under; the sync setting names it. */
	slot: z.string().max(100).nullable().default(null),
});

export type DatabaseMember = z.infer<typeof databaseMemberSchema>;

/** What a member reports in its heartbeat. */
export const databaseMemberReportSchema = z.object({
	databaseId: z.string().min(1).max(64),
	role: z.enum(databaseMemberRoles),
	generation: z.number().int().nonnegative(),
	epoch: z.number().int().nonnegative(),
	/** WAL receiver state where the engine exposes one. */
	streaming: z.boolean(),
	/** `pg_is_in_recovery()`; the authoritative "am I a primary?" on the node. */
	inRecovery: z.boolean().default(false),
	/** `pg_last_wal_replay_lsn()` on a replica, `pg_current_wal_lsn()` on a primary. */
	lsn: z.string().max(64).nullable().default(null),
	/** `default_transaction_read_only` on the member, so a drained/fenced primary is visible. */
	readOnly: z.boolean().default(false),
	/** This member is the old primary of a promotion and is read-only/stopped. */
	fenced: z.boolean().default(false),
	/** The database lease generation this member last saw (0 when it has none). */
	leaseGeneration: z.number().int().nonnegative().default(0),
	/** The control-plane epoch this member last saw (0 when unknown). */
	leaseEpoch: z.number().int().nonnegative().default(0),
	/** The lease's effective durability, as this member last read it. */
	durabilityEffective: z.enum(databaseDurabilities).default('async'),
	syncState: z.enum(syncStates).default('steady'),
	/**
	 * W11 detection evidence: whether this member can reach the arbiter, the arbiter lease expiry it
	 * last read, and when it last saw the primary's keep-alive. Optional so a report from a Wave 3
	 * agent parses unchanged; W11-SPEC §4 treats an absent value as "not reported", never as true.
	 */
	arbiterReachable: z.boolean().optional(),
	leaseExpiresAt: z.string().datetime().nullable().optional(),
	primaryKeepAliveAt: z.string().datetime().nullable().optional(),
	observedAt: z.string().datetime(),
});

export type DatabaseMemberReport = z.infer<typeof databaseMemberReportSchema>;

/** What a member probe answers (helper `GET …/member`, consumed over mTLS). */
export const databaseMemberProbeSchema = z.object({
	databaseId: z.string().min(1).max(64),
	nodeId: z.string().min(1).max(64),
	role: z.enum(databaseMemberRoles),
	generation: z.number().int().nonnegative(),
	epoch: z.number().int().nonnegative(),
	streaming: z.boolean(),
	inRecovery: z.boolean(),
	lsn: z.string().max(64).nullable(),
	/** The member's `default_transaction_read_only`; a drained primary answers true. */
	readOnly: z.boolean().default(false),
	observedAt: z.string().datetime(),
});

export type DatabaseMemberProbe = z.infer<typeof databaseMemberProbeSchema>;

/** W11's policy for one database, as desired state tells its members (W11-SPEC §3). */
export const databaseFailoverDesiredSchema = z.object({
	mode: z.enum(databaseFailoverModes).default('manual'),
	/** Async only: the operator accepted that an automatic promotion may lose commits. */
	acceptDataLoss: z.boolean().default(false),
	autoArmedAt: z.string().datetime().nullable().default(null),
});
export type DatabaseFailoverDesired = z.infer<typeof databaseFailoverDesiredSchema>;

/** The desired-state entry per database that has replicas (lane B renders it). */
export const databaseMembersDesiredSchema = z.object({
	databaseId: z.string().min(1).max(64),
	generation: z.number().int().nonnegative(),
	members: z.array(databaseMemberSchema).min(1).max(4),
	sync: z.array(z.string().max(64)).max(3),
	durability: z.enum(databaseDurabilities),
	syncState: z.enum(syncStates).default('steady'),
	durabilityEffective: z.enum(databaseDurabilities).default('async'),
	/** The node the database lease names; the node-hosted watchdog acts only when it is this one. */
	holderNodeId: z.string().max(64).nullable().default(null),
	/** The lease ETag as the control plane last read it: the ownership token for node-side results. */
	leaseEtag: z.string().max(256).nullable().default(null),
	leaseExpiresAt: z.string().datetime().nullable().default(null),
	leaseGeneration: z.number().int().nonnegative().default(0),
	leaseEpoch: z.number().int().nonnegative().default(0),
	/** `on_sync_loss` policy, so the primary's node can act within `sync_timeout` while I11 holds. */
	syncTimeoutSeconds: z.number().int().min(0).max(300).default(30),
	onSyncLoss: z.enum(syncLossPolicies).default('downgrade'),
	/**
	 * W11 policy. Optional and omitted while `DB_AUTO_PROMOTE` is off (and always for a manual
	 * database), so a flag-off payload stays byte-identical.
	 */
	failover: databaseFailoverDesiredSchema.optional(),
});

export type DatabaseMembersDesired = z.infer<typeof databaseMembersDesiredSchema>;

/** A sync-set step the primary's node must apply (fixed verbs, no SQL from the control plane). */
export const databaseSyncStep = [
	'set-sync',
	'clear-sync',
	'barrier',
	'downgrade',
	/** A node-hosted on_sync_loss decision; not a task the control plane queues. */
	'watchdog',
] as const;
export type DatabaseSyncStep = (typeof databaseSyncStep)[number];

export const databaseSyncTaskSchema = z.object({
	databaseId: z.string().min(1).max(64),
	/** Bumped when the instruction changes, so a node applies it once. Includes the attempt. */
	version: z.string().min(1).max(128),
	step: z.enum(databaseSyncStep),
	/** Application names (physical slot names) the setting must name. */
	sync: z.array(z.string().max(100)).max(3),
	/** The lease ETag this instruction belongs to; a result at another ETag is stale. */
	leaseEtag: z.string().max(256).nullable().default(null),
});
export type DatabaseSyncTask = z.infer<typeof databaseSyncTaskSchema>;

export const databaseSyncResultSchema = z.object({
	databaseId: z.string().min(1).max(64),
	/** Echo of the task version; a mismatch is a stale result and is ignored. */
	version: z.string().max(128).optional(),
	step: z.enum(databaseSyncStep),
	status: z.enum(['ok', 'failed']),
	/** `pg_current_wal_lsn()` after a barrier write, and the target's replay position. */
	lsn: z.string().max(64).nullable().optional(),
	/** The TARGET slot's `pg_stat_replication.replay_lsn`; never the primary's own position. */
	replayLsn: z.string().max(64).nullable().optional(),
	/** The TARGET slot's `pg_stat_replication.sync_state`; `sync` proves the setting took effect. */
	targetSyncState: z.string().max(32).nullable().optional(),
	/** The lease ETag the node acted at (its ownership token). */
	leaseEtag: z.string().max(256).nullable().optional(),
	/** The application names the node actually left in `synchronous_standby_names`. */
	applied: z.array(z.string().max(100)).max(3).optional(),
	error: z.string().max(2_000).optional(),
});
export type DatabaseSyncResult = z.infer<typeof databaseSyncResultSchema>;
