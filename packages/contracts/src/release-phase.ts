import * as z from 'zod';
import { jobCommandSchema, jobLimits, jobTimeoutSchema } from './job.ts';
import { replicaSpreads } from './replica.ts';
import type { FeatureFlags } from './features.ts';

/**
 * Release phase, readiness and drain (HA-PLAN H25, W5; Wave 1 lanes C and D).
 *
 * - A **release command** runs once per release (`releaseId`, the deployment id), on one node,
 *   against the new release with the app's environment, before the first copy rolls. A run lease
 *   on the release id makes it at most once (I16): `release_command_runs` is unique on it. Failure
 *   fails the deployment and nothing rolls.
 * - **Readiness** (`readinessPath`) gates traffic: edge checks and the rollout gate. `healthPath`
 *   stays liveness. One path set means both, as today.
 * - **Drain**: a copy leaves every ingress's upstream list one desired-state version before it is
 *   stopped, then waits `drainSeconds`. `stopTimeoutSeconds` replaces the hard-coded 30.
 * - **Canary**: `rollout.canary` copies roll first and soak `soakSeconds`, judged on the edge's own
 *   error rate and latency, before the rest roll.
 * - **Per-app spread**: `placement.spread` overrides the cluster's `replicas.spread` for one app.
 *
 * Every field is refused while `RELEASE_PHASE` is off (`releasePhaseSpecIssues`) and rendered
 * only to nodes that advertise `release-phase` (`packages/core/src/capability-gate.ts`).
 */

/** The agent capability for H25: release-command tasks, drain, stop timeout and readiness. */
export const RELEASE_PHASE_CAPABILITY = 'release-phase';

/** Seconds a copy keeps serving in-flight requests after it leaves the upstream lists. */
export const DEFAULT_DRAIN_SECONDS = 10;
export const MAX_DRAIN_SECONDS = 600;
/** `TimeoutStopSec` for a copy; 30 is today's hard-coded value (apps/helper/src/units.ts). */
export const DEFAULT_STOP_TIMEOUT_SECONDS = 30;
export const MAX_STOP_TIMEOUT_SECONDS = 3_600;
/** A release command's default time limit, the same as a job's. */
export const DEFAULT_RELEASE_TIMEOUT_SECONDS = 600;

export const releaseCommandSpecSchema = z.strictObject({
	/** Fixed argv run in the new release's directory or image. Never a shell string. */
	command: jobCommandSchema,
	timeoutSeconds: jobTimeoutSchema.default(DEFAULT_RELEASE_TIMEOUT_SECONDS),
});
export type ReleaseCommandSpec = z.infer<typeof releaseCommandSpecSchema>;

export const readinessPathSchema = z.string().startsWith('/').max(512);
export const drainSecondsSchema = z.number().int().min(0).max(MAX_DRAIN_SECONDS);
export const stopTimeoutSecondsSchema = z.number().int().min(1).max(MAX_STOP_TIMEOUT_SECONDS);

export const DEFAULT_ROLLOUT = { canary: 0, soakSeconds: 0, maxUnavailable: 0 } as const;

/**
 * How a deploy rolls. Absent is today's rolling deploy: one copy at a time, surge for one copy, no
 * canary. `canary: 1` rolls one copy first and soaks it. `maxUnavailable` is how many old copies
 * may be stopped before their replacements are ready (0 = surge).
 */
export const rolloutSpecSchema = z.strictObject({
	canary: z.number().int().min(0).max(5).default(DEFAULT_ROLLOUT.canary),
	soakSeconds: z.number().int().min(0).max(3_600).default(DEFAULT_ROLLOUT.soakSeconds),
	maxUnavailable: z.number().int().min(0).max(10).default(DEFAULT_ROLLOUT.maxUnavailable),
});
export type RolloutSpec = z.infer<typeof rolloutSpecSchema>;

/** Per-app placement; `spread` absent means the cluster's `replicas.spread`. */
export const workloadPlacementSpecSchema = z.strictObject({
	spread: z.enum(replicaSpreads).optional(),
});
export type WorkloadPlacementSpec = z.infer<typeof workloadPlacementSpecSchema>;

/** The `WorkloadSpec` fields that need `RELEASE_PHASE`, in the order a refusal names them. */
export const RELEASE_PHASE_SPEC_FIELDS = ['release', 'readinessPath', 'drainSeconds', 'stopTimeoutSeconds', 'rollout', 'placement'] as const;
export type ReleasePhaseSpecField = (typeof RELEASE_PHASE_SPEC_FIELDS)[number];

/**
 * Refusals for a spec that sets release-phase fields while `RELEASE_PHASE` is off: one per field,
 * empty when the flag is on or no field is set. Callers throw a `ValidationError` with the first
 * message, as the other flag-gated refusals in `workloads.ts` do.
 */
export function releasePhaseSpecIssues(
	spec: Partial<Record<ReleasePhaseSpecField, unknown>>,
	features: Pick<FeatureFlags, 'RELEASE_PHASE'>,
): { path: ReleasePhaseSpecField; message: string }[] {
	if (features.RELEASE_PHASE) return [];
	return RELEASE_PHASE_SPEC_FIELDS.filter((field) => spec[field] !== undefined).map((field) => ({
		path: field,
		message: `${field} needs the release phase, which is not enabled on this platform (YOAL_FEATURE_RELEASE_PHASE).`,
	}));
}

/** The drain and stop values a copy runs with: the defaults reproduce today's behaviour. */
export function resolvedStopSettings(spec: { drainSeconds?: number; stopTimeoutSeconds?: number }): {
	drainSeconds: number;
	stopTimeoutSeconds: number;
} {
	return {
		drainSeconds: spec.drainSeconds ?? DEFAULT_DRAIN_SECONDS,
		stopTimeoutSeconds: spec.stopTimeoutSeconds ?? DEFAULT_STOP_TIMEOUT_SECONDS,
	};
}

// -------------------------------------------------------------------- runs

export const releaseCommandRunStatuses = ['queued', 'running', 'succeeded', 'failed', 'timeout', 'cancelled'] as const;
export type ReleaseCommandRunStatus = (typeof releaseCommandRunStatuses)[number];

export const releaseCommandRunIdSchema = z.string().regex(/^rc_[a-f0-9]{32}$/);

/**
 * `releaseCommands` in desired state: a release command this node must run once. Present from
 * the moment the run is leased to this node until its result arrives or the lease expires; the
 * agent records each `runId` it started and never starts one twice, even after a restart, so a
 * replayed desired state cannot run it again (I16). No env or secret values: the agent fetches the
 * new release's activation for `runId`, as it does for jobs.
 */
export const releaseCommandTaskSchema = z.object({
	runId: releaseCommandRunIdSchema,
	/** The release this command prepares: the deployment id. One successful run per release id. */
	releaseId: z.string().min(1).max(100),
	/** The app workload whose environment, identity and volumes the command uses. */
	workloadId: z.string().min(1).max(128),
	/** Content-addressed release (process apps); null for an image-only container. */
	release: z.string().length(64).nullable(),
	/** Container apps: the new image, pinned by digest when the deployment resolved one. */
	image: z.string().min(1).max(512).optional(),
	command: jobCommandSchema,
	timeoutSeconds: jobTimeoutSchema,
	/** 1 for the first attempt. A new attempt is a new `runId` under the same `releaseId`. */
	attempt: z.number().int().min(1).max(jobLimits.maxRetries + 1),
	/** ISO 8601. The node must not start the run after this; the control plane then re-leases it. */
	startBy: z.string().max(40),
});
export type ReleaseCommandTask = z.infer<typeof releaseCommandTaskSchema>;

/** A release command's progress in a heartbeat (`heartbeatSchema.releaseCommandResults`). */
export const releaseCommandResultSchema = z.object({
	runId: releaseCommandRunIdSchema,
	releaseId: z.string().min(1).max(100),
	status: z.enum(['running', 'succeeded', 'failed', 'timeout']),
	exitCode: z.number().int().nullable().default(null),
	/** Epoch ms, as the node saw them. */
	startedAt: z.number().int().nonnegative().nullable().default(null),
	finishedAt: z.number().int().nonnegative().nullable().default(null),
	error: z.string().max(2_000).nullable().default(null),
});
export type ReleaseCommandResult = z.infer<typeof releaseCommandResultSchema>;

// -------------------------------------------------------------------- canary

/** Edge counters for one copy over a soak window (from the edge, not from ClickHouse: H28). */
export interface CanarySample {
	requests: number;
	status5xx: number;
	durationP95Ms: number;
}

export type CanaryVerdict =
	| { verdict: 'wait'; reason: string }
	| { verdict: 'pass'; reason: string }
	| { verdict: 'fail'; reason: string };

export const canaryStates = ['soaking', 'passed', 'failed', 'skipped'] as const;
export type CanaryState = (typeof canaryStates)[number];
