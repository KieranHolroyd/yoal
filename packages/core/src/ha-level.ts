import type { HaLevelAssessment } from '@yoal/contracts';

/**
 * The HA level calculator (HA-PLAN G24, H25; CLUSTERING §8.1). Owned by Wave 1 lane C, which
 * replaces the hard-coded `'L0'` in `topology.ts` with this and shows it everywhere. Pure: the
 * caller gathers the placement facts, so the same function serves topology, preflight and the
 * rollout gate.
 */
export interface HaLevelInput {
	kind: 'workload' | 'database' | 'storage';
	/** Running copies (workload replicas, or database members including the primary). */
	copies: number;
	/** Distinct nodes those copies run on. */
	nodes: number;
	/** Distinct verified zones those copies run on. */
	zones: number;
	/** A verified backup with a passing restore drill exists (L1). */
	verifiedBackup: boolean;
	/** Takes HTTP traffic through the ingress (L3 needs it). */
	http: boolean;
	/** Pinned to one node by an app volume, a singleton run lease or a same-zone share. */
	pinned: boolean;
}

/** Owned by Wave 1 lane C. Unreachable while `RELEASE_PHASE` is off: topology still reports `L0`. */
export function computeHaLevel(_input: HaLevelInput): HaLevelAssessment {
	throw new Error('not implemented (HA Wave 1 lane C): HA level calculator');
}
