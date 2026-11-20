import type { DesiredState } from '@yoal/contracts';
import { featureEnabled } from '../config.ts';
import { nodeRoles } from '../ingress.ts';
import { DesiredStatePart } from './context.ts';
import type { DeploymentRoutes } from './routes.ts';
import type { EnvironmentRoutes } from './environment-routes.ts';

/**
 * Ingress and edge-only content: the upstream list an ingress balances across, default pages for
 * never-deployed projects, and the internal gateway the studio and console fronts ride. "Ingress"
 * is `isIngress` (one node); the `ingressNodes()` refactor is HA-PLAN W6, not this split.
 */
export class IngressState extends DesiredStatePart {
	/**
	 * The copies an ingress sends one project's traffic to. `local` is how this node reaches its own
	 * copy (its socket or loopback port), or null when that copy is blocked.
	 */
	copyUpstreams(projectId: string, local: string | null): { everyCopyNode: string[]; replicaUpstreams: string[] } {
		const { node, isIngress, proxyAddress, replicaNodesByProject, readyNodesByProject } = this.state;
		// Only an ingress balances across copies. A copy on this node is dialled directly (its
		// socket or loopback port); the others through their node's Caddy over the overlay. A
		// worker never fans out: it serves its own copy and nothing else.
		const everyCopyNode = replicaNodesByProject.get(projectId) ?? [];
		const ready = readyNodesByProject.get(projectId);
		// Before any copy has reported (a first deploy) every node is listed, and the health
		// check decides; after that only copies that are up take traffic.
		const replicaNodes = ready?.size ? everyCopyNode.filter((nodeId) => ready.has(nodeId)) : everyCopyNode;
		const replicaUpstreams =
			isIngress && everyCopyNode.length > 1
				? replicaNodes
						.map((nodeId) =>
							nodeId === node.id
								? local
								: proxyAddress(nodeId)
									? `http://${proxyAddress(nodeId)}`
									: null,
						)
						.filter((address): address is string => Boolean(address))
				: [];
		return { everyCopyNode, replicaUpstreams };
	}

	/** Default pages for never-deployed projects. */
	placeholders(deployment: DeploymentRoutes, environment: EnvironmentRoutes): DesiredState['placeholders'] {
		const { isIngress, projectRows } = this.state;
		const { siteProjectIds } = deployment;
		const { productionProjectIds, environmentsByProject } = environment;
		// A project created in the dashboard and never deployed gets a default page at its production
		// host instead of "No site here". Only the edge answers public traffic, and only while there is
		// no production pointer at all: a pointer whose release is missing is a fault, not a new project.
		return isIngress
			? projectRows
					.filter(
						(project) =>
							siteProjectIds.has(project.id) &&
							!productionProjectIds.has(project.id) &&
							!project.productionDeploymentId &&
							!(environmentsByProject.get(project.id) ?? []).some((row) => row.isProduction && row.deploymentId),
					)
					.map((project) => ({
						host: `${project.slug}.${this.ctx.config.contentDomain}`,
						projectId: project.id,
						dashboardUrl: `${this.ctx.config.platformOrigin.replace(/\/+$/, '')}/projects/${project.slug}`,
					}))
			: [];
	}

	/** The internal gateway for studio and container-console fronts. */
	databaseGateway(): DesiredState['databaseGateway'] {
		const { node, isIngress, proxyAddress } = this.state;
		// The native studio (D96) routes ride one internal gateway on every ingress's loopback.
		const proxyAddressOf = (id: string) => proxyAddress(id);
		return {
			listen: isIngress ? `127.0.0.1:${this.ctx.config.databaseGatewayPort ?? 8082}` : null,
			routes: [
				...this.ctx.databaseStudio.gatewayRoutes(node.id, isIngress, proxyAddressOf),
				// Container console fronts (D127) share the internal gateway with `console.internal` hosts.
				...this.ctx.containerConsole.gatewayRoutes(node.id, isIngress, proxyAddressOf),
			],
		};
	}

	/**
	 * What a node in the ingress set renders for its public role (HA-PLAN H17/G5): extra public
	 * listeners, TLS from ACME, and the platform route. Only while `INGRESS_SET` is on and for a
	 * member, so a single-node install and a worker produce no field at all (golden-identical). This
	 * is the only place `ingress` is rendered: lane C's health/lame-duck settings ride inside it.
	 *
	 * No secret rides here: the ACME email and CA are public, the Cloudflare token arrives through
	 * the node-authenticated activation endpoint (`IngressSetService.activation`).
	 */
	ingress(): DesiredState['ingress'] | undefined {
		if (!featureEnabled(this.ctx.config, 'INGRESS_SET') || !this.state.isIngress) return undefined;
		const { node, nodeById, ingressId } = this.state;
		const email = this.ctx.config.acmeEmail;
		const tls = email ? { email, ...(this.ctx.config.acmeCa ? { ca: this.ctx.config.acmeCa } : {}) } : null;
		const platformHost = platformHostOf(this.ctx.config.platformOrigin);
		// A control node dials its own socket. Any other ingress relays to the compatibility first
		// ingress over HTTPS with the platform host as SNI; W9 replaces this with the control-node
		// upstream list rendered to every ingress.
		const control = node.id === ingressId || node.mode === 'edge' || nodeRoles(node).includes('control');
		const first = ingressId ? nodeById.get(ingressId) : undefined;
		const selfFirst = first?.id === node.id;
		const relay = first ? addressHost(first.privateAddress ?? first.publicAddress) : null;
		// A control node dials its own socket. Any other ingress relays to the first ingress, but
		// never to itself: a worker pinned as the first ingress with no local platform would loop.
		const upstream = control
			? (this.ctx.config.platformUpstream ?? 'unix//run/yoal/control.sock')
			: relay && tls && !selfFirst
				? `https://${relay}`
				: null;
		// Control-plane HA (W9, CLUSTERING §6.4): an ordered upstream list to the control nodes.
		// Caddy health-checks each `/readyz` with `lb_policy first`; the lease holder is first, this
		// node's own socket next when it is a control node, then its peers. A standby may answer
		// `/readyz` 200 for humans but is never preferred while the primary is healthy.
		const controlNodes = featureEnabled(this.ctx.config, 'CONTROL_STANDBY')
			? this.state.allNodes
					.filter((candidate) => nodeRoles(candidate).includes('control'))
					.sort((a, b) => {
						const holder = this.ctx.controlPlane.snapshot()?.lease.holderNodeId ?? null;
						if (a.id === holder) return -1;
						if (b.id === holder) return 1;
						if (a.id === node.id) return -1;
						if (b.id === node.id) return 1;
						return a.id.localeCompare(b.id);
					})
			: [];
		const platformUpstreams = controlNodes
			.map((candidate, index) => {
				if (candidate.id === node.id)
					return {
						nodeId: candidate.id,
						upstream: this.ctx.config.platformUpstream ?? 'unix//run/yoal/control.sock',
						priority: index,
					};
				// A peer control node over the managed overlay's plain ingress listener, so the list
				// is all plain HTTP: Caddy cannot carry a TLS transport per upstream.
				const address = candidate.privateAddress ? `${candidate.privateAddress}:8080` : null;
				return address ? { nodeId: candidate.id, upstream: `http://${address}`, priority: index } : null;
			})
			.filter((entry): entry is { nodeId: string; upstream: string; priority: number } => entry !== null);
		return {
			// H19 (W8 lane C): drain, PROXY protocol, trusted proxies and the health port. Rendered only
			// inside this flag-gated block, so a single-node install gets no health listener, no lame-duck
			// drain on stop and no activation fetch (the single-node gate).
			...this.ctx.cluster.get().ingress,
			// H20 (W7 lane B): the fleet fingerprint this node verifies; null while SHARED_CERTIFICATES is
			// off or before the first issuance.
			certificateFingerprint: this.ctx.certificates.fingerprint(),
			listeners: [...(tls ? [':443'] : []), ...(node.privateAddress ? [`${node.privateAddress}:8080`] : [])],
			tls,
			platform: platformHost && upstream ? { host: platformHost, upstream } : null,
			...(platformUpstreams.length > 0 ? { platformUpstreams } : {}),
		};
	}
}

/** The host part of a node address, without a port; brackets stay on an IPv6 literal. */
function addressHost(address: string | null): string | null {
	const value = address?.trim();
	if (!value) return null;
	if (value.startsWith('[')) {
		const end = value.indexOf(']');
		return end > 0 ? value.slice(0, end + 1) : null;
	}
	const colon = value.indexOf(':');
	return colon > 0 ? value.slice(0, colon) : value;
}

/** The dashboard/API hostname from the platform origin, or null when it has none. */
function platformHostOf(origin: string): string | null {
	try {
		return new URL(origin).hostname || null;
	} catch {
		return null;
	}
}
