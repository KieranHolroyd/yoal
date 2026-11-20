import { and, eq, isNull } from 'drizzle-orm';
import { databaseReplicas, databases, nodeCertificates, nodes, serviceEndpoints, storageInstances } from '@yoal/db';
import {
	CONTAINER_GATEWAY_ADDRESS,
	ENDPOINTS_GATEWAY_CAPABILITY,
	endpointTrustMode,
	type EndpointTrustMode,
	type ReadEndpoint,
	type ServiceEndpoint,
	type ServiceProvider,
} from '@yoal/contracts';
import type { CoreContext } from '../context.ts';
import { featureEnabled } from '../config.ts';
import { nodeCapabilityList, nodeHasCapability } from '../capability-gate.ts';

/**
 * Endpoints and attachments (C2, H24): the loopback endpoints a node's apps dial for services on
 * other nodes — or, with the endpoint gateway, on their own — and the overlay listeners a node runs
 * for the services it hosts.
 */
export class EndpointState {
	constructor(private readonly ctx: CoreContext) {}

	/** Whether this node gets H24's same-node and gateway fields. */
	gatewayAt(nodeId: string): boolean {
		if (!featureEnabled(this.ctx.config, 'ENDPOINTS_GATEWAY') || !featureEnabled(this.ctx.config, 'SERVICE_ENDPOINTS')) return false;
		const node = this.ctx.db.select({ capabilitiesJson: nodes.capabilitiesJson }).from(nodes).where(eq(nodes.id, nodeId)).get();
		return node ? nodeHasCapability(node, ENDPOINTS_GATEWAY_CAPABILITY) : false;
	}

	/**
	 * Provider-side overlay listeners for services this node hosts (C2), plus the listeners read
	 * replicas on other nodes stream through (C7). The agent keeps one listener per port, so every
	 * consumer of a port is merged into that listener's allowlist: emitting one provider per
	 * consumer used to leave all but the last consumer node refused.
	 */
	serviceProvidersForNode(nodeId: string): ServiceProvider[] {
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node?.privateAddress) return [];
		const gateway = this.gatewayAt(nodeId);
		const rows = this.ctx.db
			.select()
			.from(serviceEndpoints)
			.where(eq(serviceEndpoints.upstreamNodeId, nodeId))
			.all()
			// A same-node consumer dials the service's loopback port directly; no overlay listener.
			.filter((row) => row.role !== 'read' && row.consumerNodeId !== nodeId);
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
			for (const client of provider.allowedClientNodeIds ?? [])
				if (!current.allowedClientNodeIds?.includes(client)) current.allowedClientNodeIds?.push(client);
		};
		for (const row of rows) {
			const targetPort =
				row.serviceKind === 'database'
					? row.role === 'pool'
						? this.ctx.db
								.select({ port: databases.poolerPort })
								.from(databases)
								.where(eq(databases.id, row.serviceId))
								.get()?.port
						: (this.ctx.databaseReplicas.servicePort(row.serviceId) ??
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
			const trust = this.trustForProvider(nodeId);
			// The primary's listener is also the replication listener: a replica on another node is
			// a client of the same port and must be in the install-ca allowlist (H24, C7).
			const replicaClients = row.serviceKind === 'database' ? this.replicaClientIds(row.serviceId, nodeId) : [];
			add({
				id: `svp_${row.id}`.slice(0, 100),
				listenAddress: node.privateAddress,
				listenPort: row.upstreamPort,
				targetPort,
				allowedClientFingerprints: consumerCert ? [consumerCert.serial] : [],
				...(gateway
					? { clientAuth: trust, allowedClientNodeIds: [...new Set([row.consumerNodeId, ...replicaClients])] }
					: {}),
			});
		}
		for (const provider of this.ctx.databaseReplicas.providersForNode(nodeId, node.privateAddress)) add(provider);
		return [...byPort.values()]
			.map((provider) => ({
				...provider,
				allowedClientFingerprints: [...provider.allowedClientFingerprints].sort(),
				...(provider.allowedClientNodeIds ? { allowedClientNodeIds: [...provider.allowedClientNodeIds].sort() } : {}),
			}))
			.sort((a, b) => a.listenPort - b.listenPort);
	}

	/** Consumer-side loopback endpoints for this node's attachments (C2, H24). */
	serviceEndpointsForNode(nodeId: string): ServiceEndpoint[] {
		const gateway = this.gatewayAt(nodeId);
		const rows = this.ctx.db
			.select()
			.from(serviceEndpoints)
			.where(eq(serviceEndpoints.consumerNodeId, nodeId))
			.all()
			// `read` endpoints are a separate desired-state list, so an older agent never sees one.
			.filter((row) => row.role !== 'read' && (gateway || row.role === 'primary'));
		if (rows.length === 0) return [];
		const nodesById = new Map(this.ctx.db.select().from(nodes).all().map((node) => [node.id, node]));
		return rows
			.map((row) => {
				const upstream = nodesById.get(row.upstreamNodeId);
				const sameNode = row.consumerNodeId === row.upstreamNodeId;
				return {
					id: row.id,
					kind: row.serviceKind,
					serviceId: row.serviceId,
					localPort: row.localPort,
					upstream: {
						nodeId: row.upstreamNodeId,
						// A same-node endpoint dials the service's loopback directly, so it also works
						// before the overlay exists (a single node with the flag on).
						address: row.consumerNodeId === row.upstreamNodeId ? '127.0.0.1' : (upstream?.privateAddress ?? null),
						port: row.upstreamPort,
					},
					// A same-node endpoint dials the service's own loopback port: that listener
					// presents the service's certificate, not the node identity, so the forwarder
					// passes the connection through with no node TLS (and no client certificate).
					tlsFingerprint: sameNode
						? null
						: (this.ctx.db
								.select({ serial: nodeCertificates.serial })
								.from(nodeCertificates)
								.where(eq(nodeCertificates.nodeId, row.upstreamNodeId))
								.get()?.serial ?? null),
					...(gateway
						? {
								role: row.role === 'pool' ? ('pool' as const) : ('primary' as const),
								gatewayAddress: CONTAINER_GATEWAY_ADDRESS,
								...(sameNode ? {} : { trust: this.trustForProvider(row.upstreamNodeId) }),
								version: row.version,
							}
						: {}),
				};
			})
			.sort((a, b) => a.localPort - b.localPort);
	}

	/** Stable read endpoints (23000–23999) that follow a database's readable replicas (H24, G11). */
	readEndpointsForNode(nodeId: string): ReadEndpoint[] | undefined {
		if (!this.gatewayAt(nodeId)) return undefined;
		const rows = this.ctx.db
			.select()
			.from(serviceEndpoints)
			.where(eq(serviceEndpoints.consumerNodeId, nodeId))
			.all()
			.filter((row) => row.role === 'read');
		if (rows.length === 0) return undefined;
		const nodesById = new Map(this.ctx.db.select().from(nodes).all().map((node) => [node.id, node]));
		const endpoints: ReadEndpoint[] = [];
		for (const row of rows) {
			const database = this.ctx.db.select().from(databases).where(eq(databases.id, row.serviceId)).get();
			if (!database || database.deletedAt) continue;
			const seen = new Set<string>();
			const upstreams: ReadEndpoint['upstreams'] = [];
			const push = (upstreamNodeId: string, port: number): void => {
				const key = `${upstreamNodeId}:${port}`;
				if (seen.has(key)) return;
				seen.add(key);
				upstreams.push({
					nodeId: upstreamNodeId,
					address: upstreamNodeId === nodeId ? '127.0.0.1' : (nodesById.get(upstreamNodeId)?.privateAddress ?? null),
					port,
					trust: this.trustForProvider(upstreamNodeId),
					tlsFingerprint:
						this.ctx.db
							.select({ serial: nodeCertificates.serial })
							.from(nodeCertificates)
							.where(eq(nodeCertificates.nodeId, upstreamNodeId))
							.get()?.serial ?? null,
				});
			};
			for (const replica of this.ctx.databaseReplicas.readableUpstreamsFor(database.id))
				push(replica.nodeId, replica.port);
			// The primary is the fallback when every replica stops serving between reconciles.
			push(database.nodeId, database.hostPort);
			if (upstreams.length === 0) continue;
			endpoints.push({
				id: row.id,
				kind: 'database',
				serviceId: row.serviceId,
				role: 'read',
				localPort: row.localPort,
				upstreams: upstreams.slice(0, 8),
				gatewayAddress: CONTAINER_GATEWAY_ADDRESS,
				version: row.version,
			});
		}
		return endpoints.sort((a, b) => a.localPort - b.localPort);
	}

	/** Public CA material for one node; absent until the flag is on and the node is capable. */
	nodeTrustForNode(nodeId: string) {
		if (!this.gatewayAt(nodeId)) return undefined;
		return this.ctx.nodeCa.trustFor(nodeId) ?? undefined;
	}

	/**
	 * One provider listener has one client-auth mode. `install-ca` only when the provider and every
	 * remote consumer advertise `endpoints-gateway`; otherwise the listeners stay pinned (C2).
	 */
	/** Replica nodes on other hosts that stream from this primary and thus use its listener. */
	private replicaClientIds(databaseId: string, providerNodeId: string): string[] {
		return this.ctx.db
			.select({ nodeId: databaseReplicas.nodeId, replicaGeneration: databaseReplicas.primaryGeneration, generation: databases.primaryGeneration })
			.from(databaseReplicas)
			.innerJoin(databases, eq(databases.id, databaseReplicas.databaseId))
			.where(and(eq(databaseReplicas.databaseId, databaseId), isNull(databaseReplicas.removingAt), isNull(databases.deletedAt)))
			.all()
			.filter((row) => row.nodeId !== providerNodeId && row.replicaGeneration === row.generation)
			.map((row) => row.nodeId);
	}

	private trustForProvider(providerNodeId: string): EndpointTrustMode {
		const provider = this.ctx.db.select().from(nodes).where(eq(nodes.id, providerNodeId)).get();
		if (!provider) return 'pinned';
		const consumers = this.ctx.db
			.select({ consumerNodeId: serviceEndpoints.consumerNodeId })
			.from(serviceEndpoints)
			.where(eq(serviceEndpoints.upstreamNodeId, providerNodeId))
			.all()
			.map((row) => row.consumerNodeId)
			.filter((nodeId) => nodeId !== providerNodeId);
		const replicaConsumers = this.ctx.db
			.select({ nodeId: databaseReplicas.nodeId })
			.from(databaseReplicas)
			.innerJoin(databases, eq(databases.id, databaseReplicas.databaseId))
			.where(and(eq(databases.nodeId, providerNodeId), isNull(databaseReplicas.removingAt), isNull(databases.deletedAt)))
			.all()
			.map((row) => row.nodeId);
		const consumerNodes = [...new Set([...consumers, ...replicaConsumers])]
			.map((nodeId) => this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get())
			.filter((node) => node !== undefined);
		return endpointTrustMode(
			{ capabilities: nodeCapabilityList(provider.capabilitiesJson) },
			consumerNodes.map((node) => ({ capabilities: nodeCapabilityList(node.capabilitiesJson) })),
		);
	}
}
