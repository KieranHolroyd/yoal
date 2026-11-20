import type { SteeringDriverContext, SteeringNode } from './types.ts';

/** Matches `nodes.OFFLINE_AFTER_MS`, kept local so a driver has no dependency on the node service. */
export const SILENT_AFTER_MS = 30_000;

export function ingressNodes(context: SteeringDriverContext): SteeringNode[] {
	return context.nodes().filter((node) => node.ingress);
}

export function isDraining(node: SteeringNode): boolean {
	return node.status === 'draining';
}

/**
 * What the edge itself has told us: an online node whose last heartbeat is fresh. The dedicated
 * health endpoint (H19) is the stronger signal the balancer probes; the heartbeat is what the
 * control plane can read with no network call, which is why `external-lb.observe()` reports it.
 */
export function isHealthy(node: SteeringNode, now: number): boolean {
	if (node.status !== 'online') return false;
	if (node.lastHeartbeatAt === null) return false;
	return now - node.lastHeartbeatAt <= SILENT_AFTER_MS;
}

export function nodeIds(nodes: readonly SteeringNode[]): string[] {
	return nodes.map((node) => node.id);
}
