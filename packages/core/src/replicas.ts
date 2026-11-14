import type { PackingStrategy, ReplicaPlan, ReplicaRefusal, ReplicaSpread, WorkloadReplica } from '@yoal/contracts';

/**
 * Replica placement across nodes (docs/CLUSTERING.md §8.2, docs/SCALING.md).
 *
 * Pure filter/score. Copies that already run stay where they are, so a deploy or a scale never
 * shuffles a healthy set; only the missing copies are placed. An HTTP copy needs a node of its own
 * (its port or socket is the node's), so node spread is a hard rule there. A worker has no listener:
 * its copies spread first and then stack, so a queue consumer can run more copies than there are
 * nodes.
 */

export interface ReplicaCandidate {
	id: string;
	name: string;
	zone: string;
	status: string;
	/** Free memory **without** this workload's own copies; the planner charges those itself. */
	freeMemoryMb: number;
	/** CPU budget left, in millis; undefined or null when the node has no CPU ceiling. */
	freeCpuMillis?: number | null;
	/** An ingress node takes a copy only after the compute-only nodes (§3.4 score). */
	ingress?: boolean;
}

export interface ReplicaRequest {
	/** Copies wanted in total, existing ones included. */
	count: number;
	memoryMb: number;
	candidates: ReplicaCandidate[];
	spread: ReplicaSpread;
	/** CPU each copy reserves, in millis. */
	cpuMillis?: number;
	/** `pack` fills the fullest node that still fits; unset or `spread` takes the emptiest (D214). */
	strategy?: PackingStrategy;
	/** Copies that already exist. Those on an online candidate keep their node and index. */
	existing?: Array<{ index: number; nodeId: string }>;
	/** Workers: once every eligible node holds a copy, further copies share nodes. */
	stack?: boolean;
	/** Why new copies are placed (`deploy`, `scale`, …), recorded on each. */
	reason?: string;
}

export type ReplicaDecision =
	| { ok: true; plan: ReplicaPlan; kept: number[]; placed: number[] }
	| { ok: false; message: string; refusals: ReplicaRefusal[]; placeable: number };

export function planReplicas(request: ReplicaRequest): ReplicaDecision {
	if (!Number.isInteger(request.count) || request.count < 1)
		return { ok: false, message: 'Replica count must be a positive integer.', refusals: [], placeable: 0 };
	if (!Number.isInteger(request.memoryMb) || request.memoryMb < 0)
		return { ok: false, message: 'Replica memory must be a non-negative integer.', refusals: [], placeable: 0 };

	// Work on copies: a refused plan must leave the caller's candidates untouched.
	const candidates = request.candidates.map((candidate) => ({ ...candidate }));
	const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
	const healthy = candidates.filter((candidate) => candidate.status === 'online');
	const refusals: ReplicaRefusal[] = candidates
		.filter((candidate) => candidate.status !== 'online')
		.map((candidate) => ({ nodeId: candidate.id, name: candidate.name, reason: `node is ${candidate.status}` }));
	const reason = request.reason ?? 'deploy';
	const assignments: WorkloadReplica[] = [];
	const copiesOn = new Map<string, number>();
	const usedZones = new Set<string>();
	const charge = (node: ReplicaCandidate) => {
		node.freeMemoryMb -= request.memoryMb;
		if (node.freeCpuMillis != null && request.cpuMillis) node.freeCpuMillis -= request.cpuMillis;
		copiesOn.set(node.id, (copiesOn.get(node.id) ?? 0) + 1);
		usedZones.add(node.zone);
	};

	// Existing copies first: lowest indices are the ones a scale-down keeps.
	const kept: number[] = [];
	for (const copy of [...(request.existing ?? [])].sort((a, b) => a.index - b.index)) {
		if (kept.length >= request.count) break;
		const node = byId.get(copy.nodeId);
		if (!node || node.status !== 'online') continue;
		// One HTTP copy per node: a second copy that somehow shares a node is re-placed.
		if (!request.stack && (copiesOn.get(node.id) ?? 0) > 0) continue;
		charge(node);
		kept.push(copy.index);
		assignments.push({ index: copy.index, nodeId: node.id, zone: node.zone, reason: 'kept' });
	}

	const taken = new Set(kept);
	const placed: number[] = [];
	const byFree = request.strategy === 'pack' ? -1 : 1;
	let nextIndex = 0;
	while (assignments.length < request.count) {
		while (taken.has(nextIndex)) nextIndex += 1;
		const fits = (candidate: ReplicaCandidate) =>
			candidate.freeMemoryMb >= request.memoryMb && cpuFits(candidate, request.cpuMillis);
		const free = healthy.filter((candidate) => (copiesOn.get(candidate.id) ?? 0) === 0);
		let eligible = free
			.filter((candidate) => request.stack || request.spread !== 'zone' || !usedZones.has(candidate.zone))
			.filter(fits);
		// Stacking only once no empty node can take the copy.
		if (eligible.length === 0 && request.stack) eligible = healthy.filter(fits);
		eligible.sort(
			(a, b) =>
				(copiesOn.get(a.id) ?? 0) - (copiesOn.get(b.id) ?? 0) ||
				Number(a.ingress ?? false) - Number(b.ingress ?? false) ||
				byFree * (b.freeMemoryMb - a.freeMemoryMb) ||
				a.name.localeCompare(b.name),
		);
		const chosen = eligible[0];
		if (!chosen) {
			for (const candidate of healthy) {
				const held = (copiesOn.get(candidate.id) ?? 0) > 0;
				const why =
					held && !request.stack
						? 'already holds a copy'
						: !request.stack && request.spread === 'zone' && usedZones.has(candidate.zone)
							? `zone ${candidate.zone} already holds a copy`
							: candidate.freeMemoryMb < request.memoryMb
								? `only ${Math.max(0, candidate.freeMemoryMb)} MB free`
								: !cpuFits(candidate, request.cpuMillis)
									? `only ${candidate.freeCpuMillis} CPU millis free`
									: 'no eligible slot';
				refusals.push({ nodeId: candidate.id, name: candidate.name, reason: why });
			}
			return {
				ok: false,
				message: `Cannot place ${request.count} ${request.count === 1 ? 'copy' : 'copies'}${
					request.stack ? '' : ` with ${request.spread} spread`
				}: ${refusals.map((row) => `${row.name}: ${row.reason}`).join('; ') || 'no node is online'}.`,
				refusals,
				placeable: assignments.length,
			};
		}
		assignments.push({
			index: nextIndex,
			nodeId: chosen.id,
			zone: chosen.zone,
			reason: `${reason}: ${chosen.freeMemoryMb} MB free`,
		});
		placed.push(nextIndex);
		taken.add(nextIndex);
		charge(chosen);
	}

	assignments.sort((a, b) => a.index - b.index);
	return { ok: true, plan: { assignments }, kept, placed };
}

function cpuFits(candidate: ReplicaCandidate, cpuMillis: number | undefined): boolean {
	return cpuMillis === undefined || candidate.freeCpuMillis == null || candidate.freeCpuMillis >= cpuMillis;
}
