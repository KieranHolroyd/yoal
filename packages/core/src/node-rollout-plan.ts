import type { NodeRolloutOptions, NodeRolloutStrategy } from '@yoal/contracts';

/**
 * Wave planning for fleet node updates (docs/CLUSTERING.md §3.11, D217). Pure: the service gathers
 * the facts, this decides the order and the waves, and the same rules answer "may this wave start
 * now?" while the rollout runs.
 *
 * A **group** is a set of nodes that together keep one thing available: every ingress node, every
 * control node, the nodes holding copies of one multi-copy workload, a database's primary and its
 * replicas. A wave is safe when, for every group with two or more members, at least one member
 * outside the wave is online. Single-member groups cannot be protected by ordering (only by a
 * drain), so they are not groups here; the plan counts them as single copies instead.
 */

export interface RolloutFleetNode {
	id: string;
	name: string;
	zone: string | null;
	roles: string[];
	online: boolean;
	agentVersion: string | null;
	/** The agent can install a signed release itself (`node-update`). */
	canUpdate: boolean;
	/** The agent arms the on-node rollback guard (`node-update-guard`). */
	guarded: boolean;
	/** Already on (or past) the target version. */
	current: boolean;
	/** Workloads whose only copy runs here. */
	singleCopies: number;
}

export interface RolloutGroup {
	/** `ingress`, `control`, `workload:<slug>`, `database:<name>`. */
	key: string;
	nodeIds: string[];
}

export interface RolloutFacts {
	nodes: RolloutFleetNode[];
	groups: RolloutGroup[];
}

export interface PlannedWave {
	nodeIds: string[];
	reason: string;
}

export interface RolloutPlan {
	waves: PlannedWave[];
	skipped: Array<{ nodeId: string; name: string; reason: string }>;
	current: number;
	warnings: string[];
}

export type ResolvedRolloutOptions = Required<NodeRolloutOptions>;

/** Fill in the defaults that depend on the strategy (`canary`). */
export function resolveRolloutOptions(options: NodeRolloutOptions): ResolvedRolloutOptions {
	return {
		strategy: options.strategy,
		batchSize: options.batchSize,
		canary: options.canary ?? options.strategy !== 'parallel',
		drain: options.drain,
		soakSeconds: options.soakSeconds,
		maxFailures: options.maxFailures,
	};
}

/** Groups that would have no online member left if `wave` went down together. */
export function exposedGroups(wave: ReadonlySet<string>, facts: RolloutFacts): RolloutGroup[] {
	const online = new Set(facts.nodes.filter((node) => node.online).map((node) => node.id));
	return facts.groups.filter((group) => {
		const members = new Set(group.nodeIds);
		if (members.size < 2) return false;
		if (![...members].some((id) => wave.has(id))) return false;
		return ![...members].some((id) => !wave.has(id) && online.has(id));
	});
}

/** Human text for exposed groups: `ingress, workload:web`. */
export function describeGroups(groups: RolloutGroup[]): string {
	return groups.map((group) => group.key).join(', ');
}

export function planRollout(
	facts: RolloutFacts,
	options: ResolvedRolloutOptions,
	filter: ReadonlySet<string> | null = null,
): RolloutPlan {
	const skipped: RolloutPlan['skipped'] = [];
	const warnings: string[] = [];
	let current = 0;
	const candidates: RolloutFleetNode[] = [];
	for (const node of facts.nodes) {
		if (filter && !filter.has(node.id)) continue;
		if (node.current) {
			current += 1;
			continue;
		}
		if (!node.canUpdate) {
			skipped.push({
				nodeId: node.id,
				name: node.name,
				reason: `Its agent (${node.agentVersion ?? 'unknown version'}) predates dashboard updates; update it by hand once.`,
			});
			continue;
		}
		if (!node.online) {
			skipped.push({ nodeId: node.id, name: node.name, reason: 'It is offline.' });
			continue;
		}
		candidates.push(node);
	}

	const groupsOf = new Map<string, string[]>();
	for (const group of facts.groups) {
		if (new Set(group.nodeIds).size < 2) continue;
		for (const id of group.nodeIds) groupsOf.set(id, [...(groupsOf.get(id) ?? []), group.key]);
	}
	// Least responsibility first: the canary should be the node whose trouble costs least, and
	// ingress nodes go last so most of the fleet has proven the release before traffic depends on it.
	const weight = (node: RolloutFleetNode) =>
		(node.roles.includes('ingress') ? 1_000 : 0) +
		(node.roles.includes('control') ? 500 : 0) +
		(groupsOf.get(node.id)?.length ?? 0) * 10 +
		node.singleCopies;
	const ordered = [...candidates].sort((a, b) => weight(a) - weight(b) || a.name.localeCompare(b.name));

	const waves: PlannedWave[] = [];
	if (ordered.length === 0) return { waves, skipped, current, warnings };

	let rest = ordered;
	if (options.canary && ordered.length > 1 && !(options.strategy === 'rolling' && options.batchSize === 1)) {
		waves.push({ nodeIds: [ordered[0]!.id], reason: 'canary' });
		rest = ordered.slice(1);
	}

	waves.push(...wavesFor(options.strategy, rest, facts, options.batchSize));

	if (options.strategy === 'parallel') {
		for (const wave of waves) {
			const exposed = exposedGroups(new Set(wave.nodeIds), facts);
			if (exposed.length > 0)
				warnings.push(
					`Every node of ${describeGroups(exposed)} restarts its agent at the same time. Their workloads keep running, but cross-node endpoints and replication links drop together for a few seconds.`,
				);
		}
	}
	const singles = candidates.reduce((sum, node) => sum + node.singleCopies, 0);
	if (singles > 0 && !options.drain)
		warnings.push(
			`${singles} workload${singles === 1 ? ' has' : 's have'} a single copy on a node being updated. They keep running while the agent restarts; turn on "drain first" to move the movable ones away beforehand.`,
		);
	const unguarded = candidates.filter((node) => !node.guarded);
	if (unguarded.length > 0)
		warnings.push(
			`${unguarded.map((node) => node.name).join(', ')} ${unguarded.length === 1 ? 'runs an agent' : 'run agents'} without the rollback guard: if the new release fails to start there, it stays down until fixed by hand. Nodes updated by this rollout get the guard.`,
		);
	return { waves, skipped, current, warnings };
}

function wavesFor(
	strategy: NodeRolloutStrategy,
	nodes: RolloutFleetNode[],
	facts: RolloutFacts,
	batchSize: number,
): PlannedWave[] {
	if (nodes.length === 0) return [];
	if (strategy === 'parallel') return [{ nodeIds: nodes.map((node) => node.id), reason: 'all at once' }];
	if (strategy === 'rolling') {
		const waves: PlannedWave[] = [];
		for (let index = 0; index < nodes.length; index += batchSize)
			waves.push({
				nodeIds: nodes.slice(index, index + batchSize).map((node) => node.id),
				reason: batchSize === 1 ? 'one at a time' : `batches of ${batchSize}`,
			});
		return waves;
	}
	// availability: first fit into the earliest wave that stays safe and under half the fleet.
	const fleetOnline = facts.nodes.filter((node) => node.online).length;
	const cap = Math.max(1, Math.floor(fleetOnline / 2));
	const waves: Array<{ ids: Set<string>; reason: string }> = [];
	for (const node of nodes) {
		let placed = false;
		for (const wave of waves) {
			if (wave.ids.size >= cap) continue;
			const next = new Set([...wave.ids, node.id]);
			if (exposedGroups(next, facts).length > 0) continue;
			wave.ids.add(node.id);
			placed = true;
			break;
		}
		if (!placed) {
			const full = waves.length > 0 && waves.every((wave) => wave.ids.size >= cap);
			waves.push({ ids: new Set([node.id]), reason: waves.length === 0 ? 'first wave' : full ? 'half the fleet' : 'group limit' });
		}
	}
	return waves.map((wave) => ({ nodeIds: [...wave.ids], reason: wave.reason }));
}
