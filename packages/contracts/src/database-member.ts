import { z } from 'zod';

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
export const syncTransitionPhases = ['opening', 'switching', 'waiting-barrier', 'closing'] as const;
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
	sync: z.array(z.string().max(64)).max(3),
	syncState: z.enum(syncStates),
	durability: z.enum(databaseDurabilities),
	durabilityEffective: z.enum(databaseDurabilities),
	syncSetAt: z.string().datetime().nullable(),
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
});
export type DatabaseSwitchoverTask = z.infer<typeof databaseSwitchoverTaskSchema>;

export const databaseSwitchoverResultSchema = z.object({
	switchoverId: z.string().min(1).max(100),
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
	/** The lease's effective durability, as this member last read it. */
	durabilityEffective: z.enum(databaseDurabilities).default('async'),
	syncState: z.enum(syncStates).default('steady'),
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
	observedAt: z.string().datetime(),
});

export type DatabaseMemberProbe = z.infer<typeof databaseMemberProbeSchema>;

/** The desired-state entry per database that has replicas (lane B renders it). */
export const databaseMembersDesiredSchema = z.object({
	databaseId: z.string().min(1).max(64),
	generation: z.number().int().nonnegative(),
	members: z.array(databaseMemberSchema).min(1).max(4),
	sync: z.array(z.string().max(64)).max(3),
	durability: z.enum(databaseDurabilities),
	syncState: z.enum(syncStates).default('steady'),
	durabilityEffective: z.enum(databaseDurabilities).default('async'),
});

export type DatabaseMembersDesired = z.infer<typeof databaseMembersDesiredSchema>;

/** A sync-set step the primary's node must apply (fixed verbs, no SQL from the control plane). */
export const databaseSyncStep = [
	'set-sync',
	'clear-sync',
	'barrier',
	'downgrade',
] as const;
export type DatabaseSyncStep = (typeof databaseSyncStep)[number];

export const databaseSyncTaskSchema = z.object({
	databaseId: z.string().min(1).max(64),
	/** Bumped when the instruction changes, so a node applies it once. */
	version: z.string().min(1).max(128),
	step: z.enum(databaseSyncStep),
	/** Application names (physical slot names) the setting must name. */
	sync: z.array(z.string().max(100)).max(3),
});
export type DatabaseSyncTask = z.infer<typeof databaseSyncTaskSchema>;

export const databaseSyncResultSchema = z.object({
	databaseId: z.string().min(1).max(64),
	step: z.enum(databaseSyncStep),
	status: z.enum(['ok', 'failed']),
	/** `pg_current_wal_lsn()` after a barrier write, and the target's replay position. */
	lsn: z.string().max(64).nullable().optional(),
	replayLsn: z.string().max(64).nullable().optional(),
	error: z.string().max(2_000).optional(),
});
export type DatabaseSyncResult = z.infer<typeof databaseSyncResultSchema>;

/**
 * Re-attach the old primary after a switchover (W9-SPEC §5.4, W10): `pg_rewind` against the new
 * primary, then start as a standby. A failed rewind falls back to a rebuild (the control plane
 * removes the copy and adds a fresh replica on the same node).
 */
export const databaseRewindTaskSchema = z.object({
	databaseId: z.string().min(1).max(64),
	/** The old primary's workload id on its node (`db_<databaseId>`). */
	workloadId: z.string().min(1).max(100),
	generation: z.number().int().nonnegative(),
	source: z.object({
		nodeId: z.string().min(1).max(64),
		address: z.string().max(253).nullable(),
		port: z.number().int().min(1).max(65_535),
		tlsFingerprint: z.string().max(128).nullable(),
	}),
});
export type DatabaseRewindTask = z.infer<typeof databaseRewindTaskSchema>;

/** The `yoal_repl` password for a rewind; fetched by the old primary's node only. */
export const databaseRewindActivationSchema = z.object({
	databaseId: z.string().min(1).max(64),
	version: z.string().min(1).max(128),
	source: databaseRewindTaskSchema.shape.source,
	/** The Postgres image for the one-shot `pg_rewind`; the old unit may already be removed. */
	image: z.string().regex(/^[a-z0-9][a-z0-9._/:@-]{0,199}$/),
	password: z.string().regex(/^[A-Za-z0-9_-]{16,200}$/),
});
export type DatabaseRewindActivation = z.infer<typeof databaseRewindActivationSchema>;

export const databaseRewindResultSchema = z.object({
	databaseId: z.string().min(1).max(64),
	status: z.enum(['rewound', 'rebuild']),
	error: z.string().max(2_000).optional(),
});
export type DatabaseRewindResult = z.infer<typeof databaseRewindResultSchema>;
