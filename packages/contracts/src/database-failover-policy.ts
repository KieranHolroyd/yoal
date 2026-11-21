import { z } from 'zod';

/**
 * Per-database automatic failover policy (HA-PLAN W11; docs/build-plan/W11-SPEC.md §3/§12).
 *
 * Automatic failover is always per database and defaults to `manual`. `auto` is refused unless the
 * evidence below holds; the refusal is a contract, not a silent fallback, so every surface can show
 * the operator exactly which prerequisite failed. Promotion itself is lane A's; this module is the
 * vocabulary the policy, drill and refusal surfaces share.
 */

export const databaseFailoverModes = ['manual', 'auto'] as const;
export type DatabaseFailoverMode = (typeof databaseFailoverModes)[number];

export const databaseFailoverDrillStatuses = ['running', 'passed', 'failed'] as const;
export type DatabaseFailoverDrillStatus = (typeof databaseFailoverDrillStatuses)[number];

/**
 * The eligibility evidence captured when a policy is armed (W11-SPEC §3). Persisted with the row so
 * an operator can explain an existing `auto` without recomputing it from a fleet that has changed.
 * Every field is additive: an older row parses as the safe defaults.
 */
export const databaseFailoverEvidenceSchema = z.object({
	/** The global `DB_AUTO_PROMOTE` flag at the moment the evidence was captured. */
	autoPromoteEnabled: z.boolean().default(false),
	/** Data nodes that also declare `db-member`; W11 needs at least three. */
	dataNodeCount: z.number().int().nonnegative().default(0),
	/** Distinct zones of those nodes; W11 needs at least two. */
	dataZones: z.array(z.string().max(64)).max(64).default([]),
	/** Every involved member (primary and replicas) declares `db-member`. */
	membersCapable: z.boolean().default(false),
	/** The passed drill this evidence refers to. */
	drillId: z.string().max(100).nullable().default(null),
	drillPassedAt: z.string().datetime().nullable().default(null),
	drillTimeToWritableMs: z.number().int().nonnegative().nullable().default(null),
	/** The drill proved an arbiter compare-and-swap (W11-SPEC §12). */
	arbiterTested: z.boolean().default(false),
	arbiterTestedAt: z.string().datetime().nullable().default(null),
	/** At least one replica is on another online node. */
	crossNodeReplica: z.boolean().default(false),
	/** The active planned-switchover step, if any (`null` means none). */
	switchoverStep: z.string().max(32).nullable().default(null),
	/** The lease's transition flag; `changing` makes the database non-promotable. */
	syncState: z.enum(['steady', 'changing']).default('steady'),
	/** When the evidence was evaluated. */
	observedAt: z.string().datetime().nullable().default(null),
});
export type DatabaseFailoverEvidence = z.infer<typeof databaseFailoverEvidenceSchema>;

/**
 * Why `auto` cannot be armed (W11-SPEC §1/§3). Codes are stable so the CLI, REST and dashboard can
 * localise the message and link the right fix.
 */
export const failoverArmRefusalCodes = [
	/** The global `DB_AUTO_PROMOTE` flag is off. */
	'auto-promote-off',
	/** W11 is Postgres-only; other engines stay on their existing failover path. */
	'engine-unsupported',
	/** An async database did not explicitly accept possible commit loss. */
	'data-loss-not-accepted',
	/** A `sync` database is currently downgraded, so RPO 0 is not in force. */
	'sync-downgraded',
	/** Fewer than three data nodes declare `db-member`. */
	'too-few-data-nodes',
	/** The eligible data nodes span fewer than two zones. */
	'single-zone',
	/** The primary or a replica's agent is too old to run the member machine. */
	'member-capability-missing',
	/** No replica is on another online node. */
	'no-cross-node-replica',
	/** A planned switchover is in progress. */
	'switchover-active',
	/** A sync-set transition is open, so no member may promote automatically. */
	'sync-transition-open',
	/** No failover drill has ever run for this database. */
	'no-drill',
	/** The last drill did not pass. */
	'drill-failed',
	/** The last drill did not prove the arbiter. */
	'arbiter-untested',
	/** The last passed drill is older than 30 days. */
	'drill-stale',
] as const;
export type FailoverArmRefusalCode = (typeof failoverArmRefusalCodes)[number];

export const failoverArmRefusalSchema = z.object({
	code: z.enum(failoverArmRefusalCodes),
	/** One sentence for the operator; never a secret. */
	message: z.string().min(1).max(1_000),
	/** Structured values behind the message (counts, zones, drill id). */
	detail: z.record(z.string(), z.unknown()).default({}),
});
export type FailoverArmRefusal = z.infer<typeof failoverArmRefusalSchema>;

/** One failover drill: a real promotion on a disposable database (W11-SPEC §12). */
export const databaseFailoverDrillSchema = z.object({
	id: z.string().min(1).max(100),
	databaseId: z.string().min(1).max(100),
	status: z.enum(databaseFailoverDrillStatuses),
	startedAt: z.string().datetime(),
	finishedAt: z.string().datetime().nullable(),
	/**
	 * From the primary's last successful lease renew to the promoted member accepting its first
	 * write. The W11 bound is median ≤ 25 s, worst ≤ 30 s (W11-SPEC §9).
	 */
	timeToWritableMs: z.number().int().nonnegative().nullable(),
	/** Acknowledged commits lost; a `sync` drill must record 0 (I13). */
	lostCommits: z.number().int().nonnegative().nullable(),
	generation: z.number().int().nonnegative(),
	fromNodeId: z.string().max(64).nullable(),
	toNodeId: z.string().max(64).nullable(),
	/** The drill took the lease compare-and-swap, so the arbiter is tested. */
	arbiterTested: z.boolean().default(false),
	arbiterTestedAt: z.string().datetime().nullable(),
	/** Measured stages and any evidence the lane records; opaque to the foundation. */
	evidence: z.record(z.string(), z.unknown()).default({}),
	message: z.string().max(2_000).nullable(),
});
export type DatabaseFailoverDrill = z.infer<typeof databaseFailoverDrillSchema>;

/** What `yoal ha db arm <database>` sends. */
export const databaseFailoverArmRequestSchema = z.object({
	/** Typed confirmation, as for every destructive policy change. */
	confirm: z.literal(true),
	/**
	 * Async only: accept that an automatic promotion may lose recent commits. A `sync` database
	 * needs no acknowledgement, and setting this on one is refused by the policy check.
	 */
	acceptDataLoss: z.boolean().default(false),
	/** The passed drill that proves eligibility; defaults to the latest recorded drill. */
	drillId: z.string().min(1).max(100).optional(),
});
export type DatabaseFailoverArmRequest = z.infer<typeof databaseFailoverArmRequestSchema>;

/** What `yoal ha db drill <database>` sends (W11-SPEC §12: the same path, disposable database). */
export const databaseFailoverDrillRequestSchema = z.object({
	confirm: z.literal(true),
	/** Optional note recorded with the drill, e.g. the lab scenario name. */
	note: z.string().max(500).optional(),
});
export type DatabaseFailoverDrillRequest = z.infer<typeof databaseFailoverDrillRequestSchema>;

/**
 * The policy surface for one database: what is configured, the evidence behind it, and why `auto`
 * is currently refused. `active` is false when `failoverMode` is `auto` but a prerequisite lapsed,
 * so a drifted policy is visible rather than silently trusted.
 */
export const databaseFailoverPolicyViewSchema = z.object({
	databaseId: z.string().min(1).max(100),
	failoverMode: z.enum(databaseFailoverModes),
	acceptDataLoss: z.boolean(),
	/** When an operator last armed `auto`; null for a database that has never been armed. */
	autoArmedAt: z.string().datetime().nullable(),
	/** The start/last-success marker the W11 arming check reads; null when no drill passed. */
	lastFailoverDrillAt: z.string().datetime().nullable(),
	lastDrill: databaseFailoverDrillSchema.nullable(),
	/** Current eligibility evidence, recomputed from the fleet. */
	evidence: databaseFailoverEvidenceSchema,
	/** The evidence persisted when the policy was last armed; null for a manual database. */
	armedEvidence: databaseFailoverEvidenceSchema.nullable(),
	/** `failoverMode === 'auto'` with no current refusals. */
	active: z.boolean(),
	refusals: z.array(failoverArmRefusalSchema),
});
export type DatabaseFailoverPolicyView = z.infer<typeof databaseFailoverPolicyViewSchema>;
