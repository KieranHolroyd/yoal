import type { PackingStrategy } from '@yoal/contracts';

/**
 * Rebalance planning (docs/CLUSTERING.md §3.10, D214).
 *
 * Pure: given what each node holds and what may move, it returns the moves that bring the fleet
 * closer to the chosen shape, and writes nothing. `spread` narrows the gap between the fullest and
 * the emptiest node; `pack` empties the lightest nodes onto the others, so a node can be freed.
 * The caller applies the moves through the same admission and move path a drain uses.
 */

export interface BalanceNode {
	id: string;
	name: string;
	zone: string;
	/** May receive work: online, holds the `compute` role, not flapping. A node that is not still donates. */
	eligible: boolean;
	/** Admission ceiling in MB (the slice budget after overcommit) and what is reserved against it. */
	capacityMb: number;
	reservedMb: number;
	/** CPU ceiling in millis, or null when the node has none. */
	cpuCapacityMillis: number | null;
	reservedCpuMillis: number;
}

export interface BalanceUnit {
	/** A workload id for a single copy, or a `workload_replicas` id for a spread copy. */
	id: string;
	label: string;
	nodeId: string;
	memoryMb: number;
	cpuMillis: number;
	/** Why this unit must stay where it is; null when it may move. */
	blocker: string | null;
	/** Nodes and zones that already hold a sibling copy (hard spread, §8.2). */
	avoidNodeIds: string[];
	avoidZones: string[];
	/** A capability or placement filter resolved by the caller: null means any eligible node. */
	allowedNodeIds: string[] | null;
}

export interface BalanceMove {
	unitId: string;
	label: string;
	fromNodeId: string;
	toNodeId: string;
	memoryMb: number;
	cpuMillis: number;
}

export interface BalanceUsage {
	nodeId: string;
	name: string;
	reservedMb: number;
	capacityMb: number;
	/** Reserved memory as a percentage of the ceiling, one decimal. */
	percent: number;
}

export interface BalancePlan {
	strategy: PackingStrategy;
	moves: BalanceMove[];
	before: BalanceUsage[];
	after: BalanceUsage[];
	/** Fullest minus emptiest eligible node, in points, before and after the moves. */
	gapBefore: number;
	gapAfter: number;
	/** Nodes left holding nothing movable or pinned after a `pack`. */
	freedNodeIds: string[];
	/** One sentence for the operator: why these moves, or why none. */
	summary: string;
}

export interface BalanceRequest {
	nodes: BalanceNode[];
	units: BalanceUnit[];
	strategy: PackingStrategy;
	/** `spread`: stop once the gap is at or under this many points. */
	thresholdPercent: number;
	maxMoves: number;
}

const percent = (node: Pick<BalanceNode, 'reservedMb' | 'capacityMb'>): number =>
	node.capacityMb > 0 ? Math.round((node.reservedMb / node.capacityMb) * 1000) / 10 : node.reservedMb > 0 ? 100 : 0;

const usage = (nodes: BalanceNode[]): BalanceUsage[] =>
	nodes.map((node) => ({
		nodeId: node.id,
		name: node.name,
		reservedMb: node.reservedMb,
		capacityMb: node.capacityMb,
		percent: percent(node),
	}));

function gap(nodes: BalanceNode[]): number {
	const eligible = nodes.filter((node) => node.eligible && node.capacityMb > 0);
	if (eligible.length < 2) return 0;
	const values = eligible.map(percent);
	return Math.round((Math.max(...values) - Math.min(...values)) * 10) / 10;
}

function fits(unit: BalanceUnit, target: BalanceNode): boolean {
	if (!target.eligible || target.id === unit.nodeId) return false;
	if (unit.allowedNodeIds && !unit.allowedNodeIds.includes(target.id)) return false;
	if (unit.avoidNodeIds.includes(target.id) || unit.avoidZones.includes(target.zone)) return false;
	if (target.reservedMb + unit.memoryMb > target.capacityMb) return false;
	if (target.cpuCapacityMillis !== null && target.reservedCpuMillis + unit.cpuMillis > target.cpuCapacityMillis)
		return false;
	return true;
}

function apply(unit: BalanceUnit, from: BalanceNode, to: BalanceNode): void {
	from.reservedMb -= unit.memoryMb;
	from.reservedCpuMillis -= unit.cpuMillis;
	to.reservedMb += unit.memoryMb;
	to.reservedCpuMillis += unit.cpuMillis;
	unit.nodeId = to.id;
}

export function planRebalance(request: BalanceRequest): BalancePlan {
	// Work on copies: the caller's snapshot is reused for the preview's `before`.
	const nodes = request.nodes.map((node) => ({ ...node }));
	const units = request.units.map((unit) => ({ ...unit }));
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const before = usage(nodes);
	const gapBefore = gap(nodes);
	const moves: BalanceMove[] = [];
	const moved = new Set<string>();
	const maxMoves = Math.max(0, Math.floor(request.maxMoves));
	const record = (unit: BalanceUnit, to: BalanceNode): void => {
		const from = byId.get(unit.nodeId)!;
		moves.push({
			unitId: unit.id,
			label: unit.label,
			fromNodeId: from.id,
			toNodeId: to.id,
			memoryMb: unit.memoryMb,
			cpuMillis: unit.cpuMillis,
		});
		apply(unit, from, to);
		moved.add(unit.id);
	};

	let summary: string;
	const freed: string[] = [];
	if (request.strategy === 'pack') summary = pack(nodes, units, byId, moved, maxMoves, record, freed);
	else summary = spread(nodes, units, byId, moved, maxMoves, request.thresholdPercent, record, gapBefore);

	return {
		strategy: request.strategy,
		moves,
		before,
		after: usage(nodes),
		gapBefore,
		gapAfter: gap(nodes),
		freedNodeIds: freed,
		summary,
	};
}

/** Narrow the gap: each step takes the single move that leaves the smallest gap. */
function spread(
	nodes: BalanceNode[],
	units: BalanceUnit[],
	byId: Map<string, BalanceNode>,
	moved: Set<string>,
	maxMoves: number,
	thresholdPercent: number,
	record: (unit: BalanceUnit, to: BalanceNode) => void,
	gapBefore: number,
): string {
	if (nodes.filter((node) => node.eligible).length < 2) return 'Only one node can take workloads, so there is nothing to balance.';
	if (gapBefore <= thresholdPercent)
		return `The fleet is balanced: the fullest and emptiest nodes are ${gapBefore} points apart (threshold ${thresholdPercent}).`;
	let pinned = 0;
	while (moved.size < maxMoves) {
		const current = gap(nodes);
		if (current <= thresholdPercent) break;
		let best: { unit: BalanceUnit; to: BalanceNode; gap: number } | null = null;
		// Donors are the nodes above the fleet's mean; a draining or offline node donates too.
		const mean = nodes.reduce((sum, node) => sum + percent(node), 0) / nodes.length;
		for (const unit of units) {
			if (moved.has(unit.id)) continue;
			const from = byId.get(unit.nodeId);
			if (!from || percent(from) <= mean) continue;
			if (unit.blocker) {
				pinned += 1;
				continue;
			}
			for (const to of nodes) {
				if (!fits(unit, to)) continue;
				// Try the move, measure, undo. Moving must not just swap which node is the full one.
				apply(unit, from, to);
				const after = gap(nodes);
				const overshoot = percent(to) > percent(from) + 0.05;
				apply(unit, to, from);
				if (overshoot || after >= current - 0.5) continue;
				if (!best || after < best.gap || (after === best.gap && unit.memoryMb < best.unit.memoryMb))
					best = { unit, to, gap: after };
			}
		}
		if (!best) break;
		record(best.unit, best.to);
	}
	const after = gap(nodes);
	if (moved.size === 0)
		return pinned > 0
			? `The fleet is ${gapBefore} points apart, but nothing that may move would narrow it: the workloads on the full nodes are pinned or fit nowhere else.`
			: `The fleet is ${gapBefore} points apart, but no single move would narrow it.`;
	return `${moved.size} move${moved.size === 1 ? '' : 's'} narrow the gap from ${gapBefore} to ${after} points.`;
}

/** Empty the lightest nodes onto the fullest that still fit; a node is emptied whole or not at all. */
function pack(
	nodes: BalanceNode[],
	units: BalanceUnit[],
	byId: Map<string, BalanceNode>,
	moved: Set<string>,
	maxMoves: number,
	record: (unit: BalanceUnit, to: BalanceNode) => void,
	freed: string[],
): string {
	const donors = nodes
		.filter((node) => units.some((unit) => unit.nodeId === node.id))
		.sort((a, b) => a.reservedMb - b.reservedMb || a.name.localeCompare(b.name));
	const receivers = new Set<string>();
	for (const donor of donors) {
		// A node that already took work in this plan stays; emptying it would undo the plan.
		if (receivers.has(donor.id)) continue;
		const mine = units.filter((unit) => unit.nodeId === donor.id).sort((a, b) => b.memoryMb - a.memoryMb);
		if (mine.some((unit) => unit.blocker) || moved.size + mine.length > maxMoves) continue;
		// Dry-run the whole node first: half-emptied is worse than untouched.
		const trial: Array<{ unit: BalanceUnit; to: BalanceNode }> = [];
		let ok = true;
		for (const unit of mine) {
			const target = nodes
				.filter((node) => node.id !== donor.id && fits(unit, node))
				// Never pour into another lighter node that we might empty next.
				.filter((node) => node.reservedMb > 0 || receivers.has(node.id))
				.sort((a, b) => percent(b) - percent(a) || a.name.localeCompare(b.name))[0];
			if (!target) {
				ok = false;
				break;
			}
			apply(unit, donor, target);
			trial.push({ unit, to: target });
		}
		for (const step of [...trial].reverse()) apply(step.unit, step.to, donor);
		if (!ok) continue;
		for (const step of trial) {
			record(step.unit, step.to);
			receivers.add(step.to.id);
		}
		freed.push(donor.id);
	}
	if (moved.size === 0) return 'No node can be emptied onto the others: its workloads are pinned or do not fit elsewhere.';
	const names = freed.map((id) => byId.get(id)?.name ?? id).join(', ');
	return `${moved.size} move${moved.size === 1 ? '' : 's'} free ${names}.`;
}
