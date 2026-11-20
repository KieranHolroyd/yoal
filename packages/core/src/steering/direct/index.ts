import type { SteeringCapabilities, SteeringDriver } from '@yoal/contracts';
import { ingressNodes, isHealthy, nodeIds } from '../snapshot.ts';
import type { SteeringDriverContext } from '../types.ts';

/**
 * `direct` (HA-PLAN H18, CLUSTERING §7.2): today's behaviour. Yoal writes nothing, probes nothing
 * and expects a person to repoint the record when the ingress changes. One node.
 */
const capabilities: SteeringCapabilities = { probes: 'none', writes: false, preservesClientIp: 'native' };

class DirectDriver implements SteeringDriver {
	readonly kind = 'direct' as const;
	readonly capabilities = capabilities;

	constructor(private readonly context: SteeringDriverContext) {}

	/** Nothing to refuse: a single node without a balancer is a supported install (D105). */
	preflight(): Array<{ nodeId: string | null; reason: string }> {
		return [];
	}

	/** Idempotent and write-free, like every `direct` tick. */
	async desired(): Promise<void> {}

	async observe(): Promise<Record<string, unknown>> {
		const now = this.context.now();
		const nodes = ingressNodes(this.context);
		const healthy = nodes.filter((node) => isHealthy(node, now)).map((node) => node.id);
		return {
			kind: this.kind,
			observedAt: now,
			provider: 'none',
			healthy,
			serving: healthy,
			nodes: nodes.map((node) => ({ id: node.id, name: node.name, zone: node.zone, status: node.status })),
			total: nodeIds(nodes).length,
		};
	}
}

export function createDirectDriver(context: SteeringDriverContext): SteeringDriver {
	return new DirectDriver(context);
}
