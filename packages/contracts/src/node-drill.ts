import * as z from 'zod';

/**
 * Node offline drills (D235, docs/CLUSTERING.md §12.7): a platform admin, or `yoal ha drill
 * node-offline`, picks a node at random (or names one) and takes it off the control plane for a
 * bounded time, so the real failover path runs on demand rather than only on a real outage.
 *
 * "Offline" is a simulated partition. While a drill runs, the node's agent:
 * - sends no heartbeats, so the control plane marks it offline after `OFFLINE_AFTER_MS` and the
 *   failover controller, alerts and run-lease self-fencing react exactly as for a lost node;
 * - pulls no desired state and keeps serving the copy it has, as a partitioned node would;
 * - answers its ingress health probe `503 desired-state`, so steering withdraws it.
 *
 * Workloads keep running unless their run lease fences them. The agent comes back by itself at
 * `endsAt`, polls `GET /api/agent/drill` (which is not a heartbeat) so a cancel ends it early,
 * and only arms a drill from a fresh pull: restarting the agent ends one.
 */

/** The agent capability that says a build honours `offlineDrill`. */
export const OFFLINE_DRILL_CAPABILITY = 'offline-drill';

export const nodeDrillLimits = {
	minSeconds: 60,
	maxSeconds: 30 * 60,
	defaultSeconds: 5 * 60,
	/** A heartbeat this soon after the start was already in flight; later ones mean the agent did not go dark. */
	startGraceMs: 15_000,
	/** How long after `endsAt` the node has to heartbeat again before the drill fails. */
	returnGraceMs: 3 * 60_000,
	/** How often a dark agent asks whether its drill was cancelled. */
	pollMs: 5_000,
} as const;

/** What desired state and `GET /api/agent/drill` carry for a node in a running drill. */
export const nodeOfflineDrillDesiredSchema = z.object({
	id: z.string().min(1).max(64),
	/** Epoch milliseconds when the node must come back, on the control plane's clock. */
	endsAt: z.number().int().nonnegative(),
});
export type NodeOfflineDrillDesired = z.infer<typeof nodeOfflineDrillDesiredSchema>;

export const nodeDrillPollSchema = z.object({ drill: nodeOfflineDrillDesiredSchema.nullable() });
export type NodeDrillPoll = z.infer<typeof nodeDrillPollSchema>;

export const nodeDrillStartSchema = z.object({
	/** A node id or name; omitted picks one at random among the eligible nodes. */
	node: z.string().min(1).max(128).optional(),
	durationSeconds: z
		.number()
		.int()
		.min(nodeDrillLimits.minSeconds)
		.max(nodeDrillLimits.maxSeconds)
		.default(nodeDrillLimits.defaultSeconds),
	/** Allow the node hosting the control plane (the edge, or a `control` role) to be picked. */
	includeControlNode: z.boolean().default(false),
});
export type NodeDrillStartRequest = z.input<typeof nodeDrillStartSchema>;

export const nodeDrillStatuses = ['running', 'completed', 'cancelled', 'failed'] as const;
export type NodeDrillStatus = (typeof nodeDrillStatuses)[number];

/** One failover event the controller wrote while the drill ran. */
export interface NodeDrillEvent {
	kind: string;
	status: string;
	stage: string;
	subject: string;
	fromNode: string | null;
	toNode: string | null;
	reason: string;
	detectedAt: number;
}

export interface NodeDrillObservations {
	/** Start → the control plane marking the node offline. */
	offlineDetectedAfterMs: number | null;
	/** The drill's end (or cancel) → the first heartbeat after it. */
	backOnlineAfterMs: number | null;
	/** Failover events detected between the start and the node coming back (at most 50). */
	events: NodeDrillEvent[];
	/** Events in the window beyond the 50 listed. */
	moreEvents: number;
}

export interface NodeDrillView {
	id: string;
	nodeId: string;
	nodeName: string;
	status: NodeDrillStatus;
	/** True when the node was picked at random rather than named. */
	random: boolean;
	durationSeconds: number;
	startedAt: number;
	endsAt: number;
	offlineAt: number | null;
	cancelledAt: number | null;
	restoredAt: number | null;
	finishedAt: number | null;
	message: string | null;
	createdBy: string;
	observations: NodeDrillObservations | null;
}

export interface NodeDrillCandidate {
	nodeId: string;
	nodeName: string;
	eligible: boolean;
	/** Why the node cannot be drilled right now, when it cannot. */
	reason: string | null;
	controlNode: boolean;
	/** Ineligible only because it hosts the control plane: `includeControlNode` allows it. */
	needsControlOptIn: boolean;
}

export interface NodeDrillListView {
	running: NodeDrillView | null;
	recent: NodeDrillView[];
	candidates: NodeDrillCandidate[];
	limits: typeof nodeDrillLimits;
}
