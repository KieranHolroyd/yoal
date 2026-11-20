import type { IngressSettings, SteeringCapabilities, SteeringDriver } from '@yoal/contracts';
import { ingressNodes, isDraining, isHealthy } from '../snapshot.ts';
import type { SteeringDriverContext, SteeringFinding } from '../types.ts';

/**
 * The health endpoint lane C renders on every ingress (HA-PLAN H19; S9 prototype). A balancer
 * probes the plain listener without SNI or PROXY, so the recipe and the driver agree on the path.
 */
export const INGRESS_HEALTH_PATH = '/.well-known/yoal/health';
/** The S9 rig's plain-HTTP port. Lane C reserves the production number in the port registry. */
export const DEFAULT_INGRESS_HEALTH_PORT = 8099;

type ClientIpMode = SteeringCapabilities['preservesClientIp'];

/**
 * `external-lb` (HA-PLAN H18, CLUSTERING §7.2): the operator's balancer decides which ingress gets
 * traffic. Yoal serves the health endpoint and the lame-duck drain, and **writes nothing** to the
 * provider. That is what lets one driver serve Azure LB, AWS NLB, GCP LB, Hetzner LB, HAProxy, F5
 * and Cloudflare LB: all any of them needs is an HTTP probe.
 */
class ExternalLbDriver implements SteeringDriver {
	readonly kind = 'external-lb' as const;

	/** The intended serving set. Advisory only: the balancer owns the real one (never provider state). */
	#serving: string[] | null = null;

	constructor(private readonly context: SteeringDriverContext) {}

	get capabilities(): SteeringCapabilities {
		return {
			probes: 'external',
			writes: false,
			preservesClientIp: clientIpMode(this.context.settings()),
		};
	}

	/**
	 * Refuses to enable with a reason per node (H18). A node that cannot answer the health endpoint
	 * would be offered traffic it cannot serve (I14); a PROXY header from an unlisted source would
	 * make every Access rule read the balancer's address instead of the client's.
	 */
	preflight(): SteeringFinding[] {
		const nodes = ingressNodes(this.context);
		const findings: SteeringFinding[] = [];
		if (nodes.length === 0)
			findings.push({
				nodeId: null,
				reason:
					'external-lb needs at least one ingress node: give a node the ingress role and an agent with the ingress-set capability first.',
			});
		for (const node of nodes) {
			if (!node.capable)
				findings.push({
					nodeId: node.id,
					reason: `${node.name} cannot serve /.well-known/yoal/health: its agent does not advertise ingress-set, so a balancer would probe a route it does not have.`,
				});
			if (node.status === 'pending')
				findings.push({
					nodeId: node.id,
					reason: `${node.name} has never sent a heartbeat, so there is nothing for a balancer to probe yet.`,
				});
		}
		const settings = this.context.settings();
		if (settings.proxyProtocol !== 'off' && settings.trustedProxies.length === 0)
			findings.push({
				nodeId: null,
				reason:
					`ingress.proxyProtocol is ${settings.proxyProtocol} but ingress.trustedProxies is empty: ` +
					'Caddy would not accept the header from the balancer (or would trust any sender), so client addresses in Access rules would be wrong.',
			});
		// HA-PLAN §1.2: a balancer probing every 5 s with 2 failures takes up to ~14 s to remove a
		// draining node. A shorter drain would stop Caddy while the balancer still sends requests.
		if (settings.drainSeconds < 15)
			findings.push({
				nodeId: null,
				reason:
					`ingress.drainSeconds is ${settings.drainSeconds}s: a balancer meeting the 15 s removal bound can still be sending to a draining node. ` +
					'Use at least 15 (the default is 20).',
			});
		return findings;
	}

	/**
	 * Idempotent and write-free: it computes the set Yoal believes should be serving and remembers
	 * it for `observe()`/status. It never calls a provider API and never removes the last healthy
	 * ingress: an empty healthy set keeps the previous intent (H18).
	 */
	async desired(): Promise<void> {
		const now = this.context.now();
		const wanted = ingressNodes(this.context)
			.filter((node) => isHealthy(node, now) && !isDraining(node))
			.map((node) => node.id);
		if (wanted.length > 0 || this.#serving === null) this.#serving = wanted;
	}

	/** What the provider has, read from the edge's own heartbeat and health state; no network call. */
	async observe(): Promise<Record<string, unknown>> {
		const now = this.context.now();
		const settings = this.context.settings();
		const nodes = ingressNodes(this.context);
		const healthy = nodes.filter((node) => isHealthy(node, now)).map((node) => node.id);
		const draining = nodes.filter((node) => isDraining(node)).map((node) => node.id);
		const serving = this.#serving ?? healthy.filter((id) => !draining.includes(id));
		return {
			kind: this.kind,
			observedAt: now,
			provider: 'external',
			probes: 'external',
			writes: false,
			clientIp: clientIpMode(settings),
			health: {
				path: INGRESS_HEALTH_PATH,
				port: settings.healthPort ?? DEFAULT_INGRESS_HEALTH_PORT,
				// A balancer reaches the endpoint on 443 and 80 too; the plain port avoids SNI and PROXY.
				https: true,
				http: true,
			},
			healthy,
			serving,
			draining,
			nodes: nodes.map((node) => ({
				id: node.id,
				name: node.name,
				zone: node.zone,
				status: node.status,
				healthy: isHealthy(node, now),
				draining: isDraining(node),
				capable: node.capable,
			})),
			total: nodes.length,
		};
	}
}

/**
 * Which client-address mechanism the configured ingress gives the driver. `native` is honest when
 * the operator asks for neither; the balancer's address is then the client address.
 */
export function clientIpMode(settings: IngressSettings): ClientIpMode {
	if (settings.proxyProtocol !== 'off') return 'proxy-protocol';
	if (settings.trustedProxies.length > 0) return 'header';
	return 'native';
}

export function createExternalLbDriver(context: SteeringDriverContext): SteeringDriver {
	return new ExternalLbDriver(context);
}
