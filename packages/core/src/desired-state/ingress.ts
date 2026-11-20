import type { DesiredState } from '@yoal/contracts';
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
		const { node, isIngress, nodeById, replicaNodesByProject, readyNodesByProject } = this.state;
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
								: nodeById.get(nodeId)?.publicAddress
									? `http://${nodeById.get(nodeId)!.publicAddress}`
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
		const { node, isIngress, nodeById } = this.state;
		// The native studio (D96) routes ride one internal gateway listener on the edge's loopback.
		const publicAddressOf = (id: string) => nodeById.get(id)?.publicAddress ?? null;
		return {
			listen: isIngress ? `127.0.0.1:${this.ctx.config.databaseGatewayPort ?? 8082}` : null,
			routes: [
				...this.ctx.databaseStudio.gatewayRoutes(node.id, isIngress, publicAddressOf),
				// Container console fronts (D127) share the internal gateway with `console.internal` hosts.
				...this.ctx.containerConsole.gatewayRoutes(node.id, isIngress, publicAddressOf),
			],
		};
	}
}
