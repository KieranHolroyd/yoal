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
	/**
	 * Every data node advertises `db-member-self-fencing`: a real arbiter transport and peer
	 * channel, so a primary can fence itself. Arming `auto` without it re-opens F1.
	 */
	selfFencing: z.boolean().default(false),
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
	/** `acceptDataLoss` is set on a `sync` database, where it means nothing and hides a mistake. */
	'data-loss-not-needed',
	/** A `sync` database is currently downgraded, so RPO 0 is not in force. */
	'sync-downgraded',
	/** Fewer than three data nodes declare `db-member`. */
	'too-few-data-nodes',
	/** The eligible data nodes span fewer than two zones. */
	'single-zone',
	/** The primary or a replica's agent is too old to run the member machine. */
	'member-capability-missing',
	/**
	 * No data node advertises `db-member-self-fencing`, so a primary cannot fence itself and an
	 * automatic promotion could produce two primaries (HA-PLAN F1).
	 */
	'no-self-fencing-path',
	/** No replica is on another online node. */
	'no-cross-node-replica',
	/** A planned switchover is in progress. */
	'switchover-active',
	/** A sync-set transition is open, so no member may promote automatically. */
	'sync-transition-open',
	/** No failover drill has ever run for this database. */
	'no-drill',
	/** The latest drill attempt is still running; do not arm on a half-finished result. */
	'drill-running',
	/** The latest passed drill has no finished time or no measured time to writable. */
	'drill-unmeasured',
	/** The latest passed drill took longer than the W11 worst-case bound (30 s). */
	'drill-too-slow',
	/** A `sync` drill lost acknowledged commits; RPO 0 is not proven. */
	'drill-lost-commits',
	/** The latest drill attempt did not pass. */
	'drill-failed',
	/** The latest passed drill did not prove the arbiter. */
	'arbiter-untested',
	/** The latest passed drill is older than 30 days. */
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
export const databaseFailoverDrillSchema = z
	.object({
		id: z.string().min(1).max(100),
		/**
		 * The database whose policy this drill proves. A drill may promote a disposable copy;
		 * `drillDatabaseId` records that copy and `databaseId` remains the armed database.
		 */
		databaseId: z.string().min(1).max(100),
		/** The database actually promoted, when it is a disposable copy; null when it is `databaseId`. */
		drillDatabaseId: z.string().min(1).max(100).nullable().default(null),
		status: z.enum(databaseFailoverDrillStatuses),
		/** The durability in force for the drill; a `sync` drill must prove RPO 0. */
		durability: z.enum(['async', 'sync']).default('async'),
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
	})
	.superRefine((drill, ctx) => {
		if (drill.arbiterTested && drill.arbiterTestedAt === null)
			ctx.addIssue({
				code: 'custom',
				path: ['arbiterTestedAt'],
				message: 'a drill that tested the arbiter must record when it did so',
			});
		if (drill.status !== 'passed') return;
		if (drill.finishedAt === null)
			ctx.addIssue({ code: 'custom', path: ['finishedAt'], message: 'a passed drill needs a finished time' });
		if (drill.timeToWritableMs === null)
			ctx.addIssue({
				code: 'custom',
				path: ['timeToWritableMs'],
				message: 'a passed drill needs a measured time to writable',
			});
		else if (drill.timeToWritableMs > 30_000)
			ctx.addIssue({
				code: 'custom',
				path: ['timeToWritableMs'],
				message: 'a passed drill must be writable within 30 s (W11-SPEC §9)',
			});
		if (drill.durability === 'sync' && drill.lostCommits !== 0)
			ctx.addIssue({
				code: 'custom',
				path: ['lostCommits'],
				message: 'a passed sync drill must record exactly 0 lost commits (I13)',
			});
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
	/**
	 * The disposable database to promote. A drill never promotes the production database; when this
	 * is absent or names the policy database itself, the drill is refused (review blocker 11).
	 */
	drillDatabaseId: z.string().min(1).max(100).optional(),
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
	/**
	 * Derived from the latest PASSED drill's `finishedAt` (the drills table is the authority); the
	 * database's `last_failover_drill_at` column is only a cache for reads that do not join it.
	 */
	lastFailoverDrillAt: z.string().datetime().nullable(),
	/** The latest drill attempt, whatever its status, so a running/failed attempt is visible. */
	lastDrill: databaseFailoverDrillSchema.nullable(),
	/** Current eligibility evidence, recomputed from the fleet. */
	evidence: databaseFailoverEvidenceSchema,
	/** `config.failover.enabled`: the controller may act at all. */
	controllerEnabled: z.boolean().default(false),
	/** An automatic database promotion handler is installed in this process. */
	controllerInstalled: z.boolean().default(false),
	/** Every involved member advertises `db-member-self-fencing` right now. */
	selfFencing: z.boolean().default(false),
	/** The evidence persisted when the policy was last armed; null for a manual database. */
	armedEvidence: databaseFailoverEvidenceSchema.nullable(),
	/** `failoverMode === 'auto'` and the live predicate the controller uses (flag, steady, durability). */
	active: z.boolean(),
	/** Every arming gate that currently fails; `active` is the controller's live predicate, so a
	 * lapsed gate such as a stale drill is visible here without silently disabling a live `auto`. */
	refusals: z.array(failoverArmRefusalSchema),
});
export type DatabaseFailoverPolicyView = z.infer<typeof databaseFailoverPolicyViewSchema>;
