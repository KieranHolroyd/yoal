import * as z from 'zod';
import { haLevels } from './cluster.ts';
import { sloEvaluationSchema, sloObjectViewSchema } from './slo.ts';

/**
 * W15 read views (HA-PLAN §4 W15): the effective-versus-declared HA level, the failover/drill
 * timeline and the external prober's registration and health.
 *
 * These shapes are additive: no W11 policy contract changes, and every one is read-only except the
 * declared target and prober registration inputs.
 */

export const haLevelSchema = z.enum(haLevels);
export type HaLevelValue = z.infer<typeof haLevelSchema>;

/** Set or clear one project's declared HA target. `null` removes the declaration. */
export const projectHaTargetInputSchema = z.object({ target: haLevelSchema.nullable() });
export type ProjectHaTargetInput = z.infer<typeof projectHaTargetInputSchema>;

/** One project's declared target against the level its placement actually achieves. */
export const projectHaTargetViewSchema = z.object({
	projectId: z.string().min(1).max(100),
	slug: z.string().min(1).max(100),
	name: z.string().min(1).max(200),
	/** The operator's assertion, or null when the project declares none. */
	declared: haLevelSchema.nullable(),
	/** The weakest live resource: a project is only as redundant as its least redundant part. */
	effective: haLevelSchema.nullable(),
	belowTarget: z.boolean(),
	/** Why the weakest resource is not one level up (`ha-level.ts`). */
	blockers: z.array(z.string().max(500)).max(50),
});
export type ProjectHaTargetView = z.infer<typeof projectHaTargetViewSchema>;

export const haTargetsViewSchema = z.object({
	generatedAt: z.string().datetime(),
	targets: z.array(projectHaTargetViewSchema),
	/** Number of projects whose effective level is under a declared target. */
	belowTarget: z.number().int().nonnegative(),
});
export type HaTargetsView = z.infer<typeof haTargetsViewSchema>;

/**
 * One row of the failover/drill timeline. A drill's `lostCommits` is measured; an unplanned
 * failover does not record one, so it stays null rather than inventing zero.
 */
export const haTimelineItemSchema = z.object({
	id: z.string().min(1).max(100),
	source: z.enum(['failover', 'drill']),
	kind: z.enum(['failover', 'switchover', 'drill']),
	databaseId: z.string().min(1).max(100),
	databaseName: z.string().nullable(),
	status: z.string().min(1).max(40),
	/** The current/recorded durability for the database or drill. */
	durability: z.enum(['async', 'sync']).nullable(),
	promotionSource: z.enum(['manual', 'auto', 'drill']).nullable(),
	fromNodeId: z.string().nullable(),
	fromNodeName: z.string().nullable(),
	toNodeId: z.string().nullable(),
	toNodeName: z.string().nullable(),
	generation: z.number().int().nonnegative().nullable(),
	startedAt: z.string().datetime(),
	finishedAt: z.string().datetime().nullable(),
	/** Start to the new primary accepting a write; a running row has null. */
	timeToWritableMs: z.number().int().nonnegative().nullable(),
	lostCommits: z.number().int().nonnegative().nullable(),
	arbiterTested: z.boolean().nullable(),
	message: z.string().nullable(),
});
export type HaTimelineItem = z.infer<typeof haTimelineItemSchema>;

export const haTimelineViewSchema = z.object({
	generatedAt: z.string().datetime(),
	items: z.array(haTimelineItemSchema),
});
export type HaTimelineView = z.infer<typeof haTimelineViewSchema>;

/** Register a prober and receive its token once; the token is not stored in clear. */
export const externalProberRegistrationInputSchema = z.object({
	name: z.string().trim().min(1).max(100),
	installId: z.string().trim().min(1).max(100).nullable().default(null),
	/** How often the prober posts; health expires after max(3×, 120 s) without a report. */
	intervalSeconds: z.number().int().min(10).max(3_600).default(60),
});
export type ExternalProberRegistrationInput = z.infer<typeof externalProberRegistrationInputSchema>;

export const externalProberViewSchema = z.object({
	proberId: z.string().min(1).max(100),
	name: z.string().min(1).max(100),
	installId: z.string().nullable(),
	intervalSeconds: z.number().int().positive(),
	createdBy: z.string().max(100),
	createdAt: z.string().datetime(),
	revokedAt: z.string().datetime().nullable(),
	lastReportAt: z.string().datetime().nullable(),
	lastSequence: z.number().int().nonnegative(),
	/** True while the last report is older than the health window (or none arrived). */
	stale: z.boolean(),
	staleAfterSeconds: z.number().int().positive(),
	/** The last report's targets, newest last; empty before the first report. */
	targets: z.array(
		z.object({
			target: z.string(),
			kind: z.string(),
			status: z.string(),
			statusCode: z.number().int().nullable(),
			latencyMs: z.number().nullable(),
			error: z.string().nullable(),
			checkedAt: z.string().datetime(),
		}),
	),
	counts: z.object({
		up: z.number().int().nonnegative(),
		degraded: z.number().int().nonnegative(),
		down: z.number().int().nonnegative(),
	}),
});
export type ExternalProberView = z.infer<typeof externalProberViewSchema>;

export const externalProberListSchema = z.object({
	enabled: z.boolean(),
	probers: z.array(externalProberViewSchema),
});
export type ExternalProberList = z.infer<typeof externalProberListSchema>;

export const externalProberRegistrationSchema = z.object({
	prober: externalProberViewSchema,
	/** The raw token; returned once, on registration only. */
	token: z.string().min(1),
});
export type ExternalProberRegistration = z.infer<typeof externalProberRegistrationSchema>;

/** One project's SLOs with the latest evaluation (null while telemetry cannot answer). */
export const sloOverviewItemSchema = sloObjectViewSchema.extend({
	projectSlug: z.string().min(1).max(100),
	projectName: z.string().min(1).max(200),
	evaluation: sloEvaluationSchema.nullable(),
});
export type SloOverviewItem = z.infer<typeof sloOverviewItemSchema>;

export const sloOverviewSchema = z.object({
	/** False while `SLO_OBJECTS` is off; `objects` is then always empty. */
	enabled: z.boolean(),
	generatedAt: z.string().datetime(),
	objects: z.array(sloOverviewItemSchema),
});
export type SloOverview = z.infer<typeof sloOverviewSchema>;
