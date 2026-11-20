import type { HaLevel, HaLevelAssessment } from '@yoal/contracts';

/**
 * The HA level calculator (HA-PLAN G24, H25; CLUSTERING §8.1). Owned by Wave 1 lane C. Pure: the
 * caller gathers the placement facts, so the same function serves topology, preflight and the
 * rollout gate. The level is computed from where things run now, never stored as intent.
 *
 * - `L0` single: one copy on one node.
 * - `L1` recoverable: `L0` plus a verified backup.
 * - `L2` failover: a second copy on another node: a workload copy, or a database replica.
 * - `L3` active: two or more copies in two or more zones, not pinned to one node. Stateless only:
 *   a database with replicas is `L2` (§8.1, "Stateful engines are not in this table"). For a
 *   worker `L3` means active capacity, not traffic failover (copies have no route).
 *
 * `blockers` names what the next level needs, in the words §8.1's "gap to the next level" uses.
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

/** Owned by Wave 1 lane C. */
export function computeHaLevel(input: HaLevelInput): HaLevelAssessment {
	const spread = input.copies >= 2 && input.nodes >= 2;
	const stateless = input.kind === 'workload';
	if (stateless && spread && input.zones >= 2 && !input.pinned) return { level: 'L3', blockers: [] };
	if (spread && !input.pinned) {
		if (!stateless) return { level: 'L2', blockers: [`a ${input.kind} with replicas is L2; L3 is for stateless copies`] };
		return { level: 'L2', blockers: ['add a copy in another zone'] };
	}
	const level: HaLevel = input.verifiedBackup ? 'L1' : 'L0';
	const blockers: string[] = [];
	if (level === 'L0' && !stateless) blockers.push('no verified backup');
	if (input.pinned) blockers.push('pinned to one node');
	else if (stateless) blockers.push(input.copies >= 2 ? 'every copy is on one node' : 'add a second copy on another node');
	else blockers.push('add a replica on another node');
	return { level, blockers };
}
