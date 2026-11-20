import { eq } from 'drizzle-orm';
import { databases, nodeCertificates, nodes, serviceEndpoints, storageInstances } from '@yoal/db';
import type { ServiceEndpoint, ServiceProvider } from '@yoal/contracts';
import type { CoreContext } from '../context.ts';

/**
 * Endpoints and attachments (C2): the loopback endpoints a node's apps dial for services on other
 * nodes, and the overlay listeners a node runs for the services it hosts.
 */
export class EndpointState {
	constructor(private readonly ctx: CoreContext) {}

	/**
	 * Provider-side overlay listeners for services this node hosts (C2), plus the listeners read
	 * replicas on other nodes stream through (C7). The agent keeps one listener per port, so every
	 * consumer of a port is merged into that listener's allowlist: emitting one provider per
	 * consumer used to leave all but the last consumer node refused.
	 */
	serviceProvidersForNode(nodeId: string): ServiceProvider[] {
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node?.privateAddress) return [];
		const rows = this.ctx.db
			.select()
			.from(serviceEndpoints)
			.where(eq(serviceEndpoints.upstreamNodeId, nodeId))
			.all();
		const byPort = new Map<number, ServiceProvider>();
		const add = (provider: ServiceProvider): void => {
			const current = byPort.get(provider.listenPort);
			if (!current) {
				byPort.set(provider.listenPort, { ...provider, allowedClientFingerprints: [...provider.allowedClientFingerprints] });
				return;
			}
			// Two services can never share a host port on one node, so the target agrees.
			for (const fingerprint of provider.allowedClientFingerprints)
				if (!current.allowedClientFingerprints.includes(fingerprint)) current.allowedClientFingerprints.push(fingerprint);
		};
		for (const row of rows) {
			const targetPort =
				row.serviceKind === 'database'
					? (this.ctx.databaseReplicas.servicePort(row.serviceId) ??
						this.ctx.db
							.select({ port: databases.hostPort })
							.from(databases)
							.where(eq(databases.id, row.serviceId))
							.get()?.port)
					: this.ctx.db
							.select({ port: storageInstances.hostPort })
							.from(storageInstances)
							.where(eq(storageInstances.id, row.serviceId))
							.get()?.port;
			if (!targetPort) continue;
			const consumerCert = this.ctx.db
				.select({ serial: nodeCertificates.serial })
				.from(nodeCertificates)
				.where(eq(nodeCertificates.nodeId, row.consumerNodeId))
				.get();
			add({
				id: `svp_${row.id}`.slice(0, 100),
				listenAddress: node.privateAddress,
				listenPort: row.upstreamPort,
				targetPort,
				allowedClientFingerprints: consumerCert ? [consumerCert.serial] : [],
			});
		}
		for (const provider of this.ctx.databaseReplicas.providersForNode(nodeId, node.privateAddress)) add(provider);
		return [...byPort.values()]
			.map((provider) => ({ ...provider, allowedClientFingerprints: [...provider.allowedClientFingerprints].sort() }))
			.sort((a, b) => a.listenPort - b.listenPort);
	}

	/** Consumer-side loopback endpoints for this node's remote attachments (C2). */
	serviceEndpointsForNode(nodeId: string): ServiceEndpoint[] {
		const rows = this.ctx.db
			.select()
			.from(serviceEndpoints)
			.where(eq(serviceEndpoints.consumerNodeId, nodeId))
			.all();
		if (rows.length === 0) return [];
		const nodesById = new Map(this.ctx.db.select().from(nodes).all().map((node) => [node.id, node]));
		return rows
			.map((row) => {
				const upstream = nodesById.get(row.upstreamNodeId);
				return {
					id: row.id,
					kind: row.serviceKind,
					serviceId: row.serviceId,
					localPort: row.localPort,
					upstream: {
						nodeId: row.upstreamNodeId,
						address: upstream?.privateAddress ?? null,
						port: row.upstreamPort,
					},
					tlsFingerprint:
						this.ctx.db
							.select({ serial: nodeCertificates.serial })
							.from(nodeCertificates)
							.where(eq(nodeCertificates.nodeId, row.upstreamNodeId))
							.get()?.serial ?? null,
				};
			})
			.sort((a, b) => a.localPort - b.localPort);
	}
}
