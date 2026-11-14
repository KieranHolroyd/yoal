import * as z from 'zod';
import { packingStrategies, type PackingStrategy } from './cluster-config.ts';

/**
 * Fleet scheduling (docs/CLUSTERING.md §3.10, D214): how full each node is, what could move and
 * the moves a rebalance would make. Views only; the planner lives in `@yoal/core`.
 */

export interface SchedulingNodeView {
	id: string;
	name: string;
	zone: string;
	status: string;
	/** May receive workloads: online and holding the `compute` role. */
	eligible: boolean;
	/** The node's workload memory budget, and the admission ceiling after overcommit. */
	sliceMemoryMb: number;
	capacityMb: number;
	reservedMb: number;
	/** Reserved memory as a percentage of the ceiling. */
	reservedPercent: number;
	/** Memory the host reports in use right now, from the last heartbeat; null before one. */
	usedMemoryMb: number | null;
	totalMemoryMb: number | null;
	cpuPercent: number | null;
	cpuCapacityMillis: number | null;
	reservedCpuMillis: number;
	/** Copies placed here, and how many of them may move. */
	copies: number;
	movable: number;
}

export interface SchedulingUnitView {
	id: string;
	label: string;
	nodeId: string;
	memoryMb: number;
	cpuMillis: number;
	/** Why it must stay on its node; null when it may move. */
	blocker: string | null;
}

export interface SchedulingMoveView {
	unitId: string;
	label: string;
	fromNodeId: string;
	fromNodeName: string;
	toNodeId: string;
	toNodeName: string;
	memoryMb: number;
}

export interface SchedulingPlanView {
	strategy: PackingStrategy;
	moves: SchedulingMoveView[];
	gapBefore: number;
	gapAfter: number;
	/** Reserved percent per node after the moves, for the before/after bars. */
	after: Array<{ nodeId: string; reservedMb: number; percent: number }>;
	freedNodeIds: string[];
	summary: string;
}

export interface SchedulingView {
	generatedAt: string;
	strategy: PackingStrategy;
	memoryOvercommitPercent: number;
	cpuOvercommitPercent: number;
	autoRebalance: boolean;
	rebalanceThresholdPercent: number;
	nodes: SchedulingNodeView[];
	units: SchedulingUnitView[];
	plan: SchedulingPlanView;
}

export const rebalanceRequestSchema = z
	.object({
		/** False (the default) only previews. */
		apply: z.boolean().default(false),
		/** Override the configured strategy for this run. */
		strategy: z.enum(packingStrategies).optional(),
	})
	.strict();
export type RebalanceRequest = z.infer<typeof rebalanceRequestSchema>;

export interface RebalanceResult {
	applied: boolean;
	plan: SchedulingPlanView;
	/** Moves the control plane started; fewer than planned when one was refused at admission. */
	moved: SchedulingMoveView[];
	skipped: Array<{ label: string; reason: string }>;
}

export const workloadMoveRequestSchema = z
	.object({
		/** A node id or name; omitted lets the scheduler choose. */
		node: z.string().trim().min(1).max(100).optional(),
	})
	.strict();
export type WorkloadMoveRequest = z.infer<typeof workloadMoveRequestSchema>;

export interface WorkloadMoveResult {
	project: string;
	from: { id: string; name: string };
	to: { id: string; name: string };
	/** `surge` keeps the old copy serving until the new one is up; `restart` stops it first. */
	mode: 'surge' | 'restart';
}
