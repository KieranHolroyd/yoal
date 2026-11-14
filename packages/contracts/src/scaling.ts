import * as z from 'zod';
import { MAX_WORKLOAD_REPLICAS } from './workload.ts';

/**
 * Horizontal scaling for one app (docs/SCALING.md, D218–D220).
 *
 * The number of copies is operational state, not part of a release: it changes without a deploy,
 * a rollback keeps it, and a deploy updates the copies one at a time. An autoscaling policy moves
 * the number between two bounds to hold one measured signal near a target.
 */

/** What an autoscaling policy watches. `requests` needs telemetry (ClickHouse). */
export const autoscaleMetrics = ['cpu', 'memory', 'requests'] as const;
export type AutoscaleMetric = (typeof autoscaleMetrics)[number];

export const scalingPolicySchema = z
	.object({
		enabled: z.boolean().default(false),
		min: z.number().int().min(1).max(MAX_WORKLOAD_REPLICAS).default(1),
		max: z.number().int().min(1).max(MAX_WORKLOAD_REPLICAS).default(3),
		metric: z.enum(autoscaleMetrics).default('cpu'),
		/**
		 * `cpu` and `memory`: percent of each copy's limit, averaged over the copies (10–95).
		 * `requests`: requests per second per copy (1–100000).
		 */
		target: z.number().positive().max(100_000).default(70),
		/** How long the load must stay low before a copy is removed. Scaling up never waits. */
		scaleDownMinutes: z.number().int().min(1).max(120).default(5),
	})
	.superRefine((policy, ctx) => {
		if (policy.min > policy.max) ctx.addIssue({ code: 'custom', path: ['min'], message: 'The minimum cannot be above the maximum.' });
		if (policy.metric !== 'requests' && (policy.target < 10 || policy.target > 95))
			ctx.addIssue({ code: 'custom', path: ['target'], message: 'A CPU or memory target is a percentage from 10 to 95.' });
	});
export type ScalingPolicy = z.infer<typeof scalingPolicySchema>;
export type ScalingPolicyInput = z.input<typeof scalingPolicySchema>;

export const scaleRequestSchema = z
	.object({
		replicas: z.number().int().min(1).max(MAX_WORKLOAD_REPLICAS),
	})
	.strict();
export type ScaleRequest = z.infer<typeof scaleRequestSchema>;

/**
 * How an app's copies may be placed:
 * - `spread`: one copy per node (an HTTP app; each copy owns its node's port or socket);
 * - `stack`: copies spread across nodes first, then share them (a worker);
 * - `node`: every copy on the app's one node (a function, a runner pool, or a pinned worker);
 * - `single`: one copy only, with `blocker` saying why.
 */
export const scalingModes = ['spread', 'stack', 'node', 'single'] as const;
export type ScalingMode = (typeof scalingModes)[number];

export interface ScalingCopyView {
	/** The id the node runs it under: `<workload>` or `<workload>-r<n>`. */
	id: string;
	index: number;
	nodeId: string;
	nodeName: string;
	zone: string;
	status: string;
	/** `previous` while a rollout has not reached this copy yet. */
	release: 'current' | 'previous';
	memoryBytes: number | null;
	/** CPU in use, in millis (1000 is one core); null before two samples exist. */
	cpuMillis: number | null;
	sampledAt: string | null;
}

export interface ScalingRolloutView {
	status: 'rolling' | 'paused';
	message: string | null;
	startedAt: string | null;
	/** Copies already on the new release, and the total. */
	updated: number;
	total: number;
}

export interface ScalingEventView {
	id: string;
	from: number;
	to: number;
	reason: 'manual' | 'autoscale' | 'deploy' | string;
	detail: string | null;
	actor: string | null;
	at: string;
}

export interface ScalingView {
	project: string;
	deployed: boolean;
	replicas: number;
	mode: ScalingMode;
	/** Why the app cannot run a copy per node (or more than one copy); null when it can. */
	blocker: string | null;
	/** The most copies this fleet could run right now: nodes with room, capped by the install limit. */
	capacity: number;
	limit: number;
	/** Each copy's limits, so usage reads as a share of them. */
	memoryMb: number;
	cpuMillis: number;
	copies: ScalingCopyView[];
	rollout: ScalingRolloutView | null;
	policy: ScalingPolicy;
	autoscale: {
		/** The last measured value of the policy's metric, in the unit of its target. */
		observed: number | null;
		desired: number | null;
		reason: string | null;
		evaluatedAt: string | null;
		scaledAt: string | null;
		/** False when the policy's metric cannot be measured here (no telemetry, an old agent). */
		available: boolean;
	};
	events: ScalingEventView[];
}

export interface ScaleResult {
	project: string;
	from: number;
	to: number;
	/** Nodes that gained or lost a copy. */
	added: Array<{ index: number; nodeId: string; nodeName: string }>;
	removed: Array<{ index: number; nodeId: string; nodeName: string }>;
}
