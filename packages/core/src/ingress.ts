import { parseJson } from './util.ts';

/**
 * The ingress set (HA-PLAN H17, CLUSTERING H11). Every "is this the edge?" question in the control
 * plane asks this module; nothing else reads `mode: 'edge'` or `YOAL_EDGE_NODE_ID` to decide what a
 * node serves.
 *
 * This is the W6 opening refactor: the set is still the node the fleet has always treated as the
 * edge, so the desired state is byte-identical. The W6 payload lane expands it to every node with
 * the `ingress` role behind `INGRESS_SET`, which is why `rolesJson` is carried here already.
 */
export interface IngressCandidate {
	id: string;
	mode: string;
	rolesJson?: string | null;
}

/** The node the old code called "the edge": the configured id, else the first `mode: 'edge'`. */
export function firstIngress(allNodes: readonly IngressCandidate[], configEdgeId: string | null): string | null {
	// The configured id wins even when it names no current row: that is what the pre-refactor code
	// did (the id is also what placement and deployment fallbacks still use). A stale id is an
	// operator error shown elsewhere, not a silent move of the first ingress.
	if (configEdgeId) return configEdgeId;
	return allNodes.find((node) => node.mode === 'edge')?.id ?? null;
}

/**
 * The ids whose node serves the edge payload. Today this is exactly the set the old checks used:
 * every `mode: 'edge'` node plus the configured edge id. `IngressCandidate.rolesJson` is not read
 * until the W6 payload lane turns the role into ingress members.
 */
export function ingressNodeIds(allNodes: readonly IngressCandidate[], configEdgeId: string | null): string[] {
	const ids = new Set(allNodes.filter((node) => node.mode === 'edge').map((node) => node.id));
	const first = firstIngress(allNodes, configEdgeId);
	if (first) ids.add(first);
	return [...ids];
}

export function isIngressNode(nodeId: string, ingressIds: readonly string[]): boolean {
	return ingressIds.includes(nodeId);
}

/** The roles a node advertises, for the lanes that need the `ingress` role rather than the set. */
export function nodeRoles(node: IngressCandidate): string[] {
	return parseJson<string[]>(node.rolesJson ?? null, []);
}
