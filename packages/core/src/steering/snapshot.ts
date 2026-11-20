import { isIP } from 'node:net';
import { OFFLINE_AFTER_MS } from '../nodes.ts';
import type { SteeringDriverContext, SteeringNode } from './types.ts';

/** The same liveness bound the controller uses to mark a silent node offline. */
export const SILENT_AFTER_MS = OFFLINE_AFTER_MS;

/** The address a driver may use for a node: its overlay endpoint first, then its public address. */
export function nodeAddress(row: { wgEndpoint: string | null; publicAddress: string | null }): string | null {
	for (const candidate of [row.wgEndpoint, row.publicAddress]) {
		const raw = candidate?.trim();
		if (!raw) continue;
		const host = raw.replace(/^\[([^\]]+)\](?::\d+)?$/, '$1').replace(/:\d+$/, '');
		if (isIP(host)) return host;
	}
	return null;
}

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
