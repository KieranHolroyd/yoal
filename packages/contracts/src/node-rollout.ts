import * as z from 'zod';

/**
 * Fleet node updates (docs/CLUSTERING.md §3.11, D217).
 *
 * A rollout installs the control plane's own signed release (D99) on many worker nodes, in waves,
 * and checks each wave before the next starts. The strategy decides the waves:
 *
 * - `parallel`: every node at once. Fastest; each node still rolls itself back if its new agent
 *   never reports a healthy heartbeat.
 * - `rolling`: `batchSize` nodes at a time (one by default).
 * - `availability`: the largest waves that never take every node of a redundant group at once
 *   (every ingress node, every control node, every node holding a copy of one multi-copy workload,
 *   or a database's primary and all its replicas), capped at half the fleet.
 *
 * The control-plane host itself is updated by `yoal-update-self` (Settings → Updates), which is
 * why the target is always the control plane's version: update the control plane first, then roll
 * the fleet, or turn on `updates.autoRollout` so the fleet follows on its own.
 */
export const nodeRolloutStrategies = ['availability', 'rolling', 'parallel'] as const;
export type NodeRolloutStrategy = (typeof nodeRolloutStrategies)[number];

export const nodeRolloutStatuses = ['running', 'paused', 'succeeded', 'failed', 'cancelled'] as const;
export type NodeRolloutStatus = (typeof nodeRolloutStatuses)[number];

/** Where a running rollout is within its current wave. */
export const nodeRolloutPhases = ['starting', 'blocked', 'draining', 'updating', 'soaking', 'paused', 'done'] as const;
export type NodeRolloutPhase = (typeof nodeRolloutPhases)[number];

export const nodeRolloutNodeStates = [
	'pending',
	'draining',
	'updating',
	'verifying',
	'done',
	'failed',
	'skipped',
] as const;
export type NodeRolloutNodeState = (typeof nodeRolloutNodeStates)[number];

/** Limits shared by the planner, the service and the dashboard. */
export const nodeRolloutLimits = {
	maxBatchSize: 50,
	maxSoakSeconds: 3_600,
	maxFailures: 50,
	/** A node that has not reported the new version (or a failure) by then has failed. */
	nodeTimeoutMs: 20 * 60_000,
	/** Longest a drain may run before the wave updates anyway (an agent update stops no workload). */
	drainTimeoutMs: 15 * 60_000,
	/** Longest a wave waits for a redundant group's other members to come back before pausing. */
	blockedTimeoutMs: 10 * 60_000,
	/** A paused rollout that nobody resumes or cancels fails after this long. */
	pausedTimeoutMs: 7 * 24 * 60 * 60_000,
} as const;

const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** Options shared by a manual rollout and `updates` in the cluster configuration. */
export const nodeRolloutOptionsSchema = z.object({
	strategy: z.enum(nodeRolloutStrategies).default('availability'),
	/** Nodes per wave for `rolling`. Ignored by the other strategies. */
	batchSize: int(1, nodeRolloutLimits.maxBatchSize).default(1),
	/**
	 * Update one node on its own first, then the rest. Defaults on for `availability` and `rolling`
	 * and off for `parallel`.
	 */
	canary: z.boolean().optional(),
	/**
	 * Cordon each wave and let the scheduler move what can move before updating it, then lift the
	 * cordon. Off by default: an agent update stops no workload, but it does restart the node's
	 * endpoint forwarders, replication links, mail and any build in progress.
	 */
	drain: z.boolean().default(false),
	/** Seconds every node of a wave must stay healthy on the new version before the next wave. */
	soakSeconds: int(0, nodeRolloutLimits.maxSoakSeconds).default(60),
	/** Nodes that may fail before the rollout pauses. 0 pauses on the first failure. */
	maxFailures: int(0, nodeRolloutLimits.maxFailures).default(0),
});
export type NodeRolloutOptions = z.infer<typeof nodeRolloutOptionsSchema>;

/** `POST /nodes/rollouts` and `POST /nodes/rollouts/plan`. */
export const nodeRolloutCreateSchema = nodeRolloutOptionsSchema
	.extend({
		/** Only these nodes; by default every node behind the control plane's version. */
		nodeIds: z.array(z.string().trim().min(1).max(64)).min(1).max(500).optional(),
	})
	.strict();
export type NodeRolloutCreate = z.infer<typeof nodeRolloutCreateSchema>;

/** `POST /nodes/rollouts/:id/resume`: retry the failed nodes (default) or leave them and go on. */
export const nodeRolloutResumeSchema = z
	.object({
		retryFailed: z.boolean().default(true),
	})
	.strict();
export type NodeRolloutResume = z.infer<typeof nodeRolloutResumeSchema>;

export interface NodeRolloutPlanNode {
	id: string;
	name: string;
	zone: string | null;
	roles: string[];
	agentVersion: string | null;
	/** True when the agent arms the on-node rollback guard (`node-update-guard`). */
	guarded: boolean;
	/** Redundant groups this node belongs to, e.g. `ingress`, `workload:web`. */
	groups: string[];
	/** Workloads whose only copy runs here (they keep running; their endpoints blip). */
	singleCopies: number;
}

export interface NodeRolloutPlanWave {
	index: number;
	nodes: NodeRolloutPlanNode[];
	/** Why this wave is its own: `canary`, `batch`, `group limit`, `half the fleet`. */
	reason: string;
}

export interface NodeRolloutPlanView {
	targetVersion: string;
	strategy: NodeRolloutStrategy;
	options: Required<NodeRolloutOptions>;
	waves: NodeRolloutPlanWave[];
	/** Nodes that will not be updated, and why. */
	skipped: Array<{ nodeId: string; name: string; reason: string }>;
	/** Nodes already on the target version. */
	current: number;
	warnings: string[];
}

export interface NodeRolloutNodeView {
	nodeId: string;
	name: string;
	wave: number;
	state: NodeRolloutNodeState;
	fromVersion: string | null;
	/** The version the node reports now (from its heartbeat). */
	version: string | null;
	guarded: boolean;
	attempts: number;
	error: string | null;
	startedAt: string | null;
	finishedAt: string | null;
}

export interface NodeRolloutView {
	id: string;
	/** The flow run that drives it (`/operations/flw_…`). */
	flowId: string | null;
	status: NodeRolloutStatus;
	phase: NodeRolloutPhase | null;
	/** What the rollout is doing or waiting for, in a sentence. */
	detail: string | null;
	targetVersion: string;
	options: Required<NodeRolloutOptions>;
	/** Zero-based index of the wave in progress (equal to `waves` once finished). */
	currentWave: number;
	waves: number;
	nodes: NodeRolloutNodeView[];
	counts: Record<NodeRolloutNodeState, number>;
	failures: number;
	error: string | null;
	/** `auto` for a rollout the control plane started after its own update (`updates.autoRollout`). */
	trigger: 'manual' | 'auto';
	createdBy: string | null;
	createdAt: string;
	updatedAt: string;
	finishedAt: string | null;
}

export function isActiveRollout(status: NodeRolloutStatus): boolean {
	return status === 'running' || status === 'paused';
}
