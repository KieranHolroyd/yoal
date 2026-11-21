import * as z from 'zod';

/**
 * Multi-node workload replicas (docs/CLUSTERING.md §8.2, C4). `region` (HA-PLAN H26) is
 * control-plane placement only: no desired-state schema carries a spread, so no agent sees the
 * value. It is refused on every write while `REGIONS` is off (`regionWriteIssues`).
 */
export const replicaSpreads = ['node', 'zone', 'region'] as const;
export type ReplicaSpread = (typeof replicaSpreads)[number];

export const workloadReplicaSchema = z.object({
	index: z.number().int().nonnegative(),
	nodeId: z.string().min(1).max(100),
	zone: z.string().min(1).max(32),
	reason: z.string().max(200).default(''),
});
export type WorkloadReplica = z.infer<typeof workloadReplicaSchema>;

export interface ReplicaPlan {
	assignments: WorkloadReplica[];
}

export interface ReplicaRefusal {
	nodeId: string;
	name: string;
	reason: string;
}
