import { and, eq, isNull } from 'drizzle-orm';
import {
	databaseAttachments,
	databases,
	nodes,
	serviceEndpoints,
	storageAttachments,
	storageInstances,
	workloads,
} from '@yoal/db';
import { ENDPOINTS_GATEWAY_CAPABILITY, readEndpointPortRange } from '@yoal/contracts';
import { endpointKey, planReadEndpoints, planServiceEndpoints, type ExistingEndpoint, type EndpointService as PlannedService } from './endpoints.ts';
import { nodeHasCapability } from './capability-gate.ts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';

/**
 * Materialises C2/H24 service endpoints from a project's live attachments (docs/CLUSTERING.md
 * §4.3, HA-PLAN H24).
 *
 * Without `ENDPOINTS_GATEWAY` this is exactly C2: only a remote attachment gets a loopback
 * endpoint, and only a process app may leave its provider's node. With the flag on and the node
 * advertising `endpoints-gateway`, every attachment — same node included — gets a stable endpoint,
 * so a promotion never changes an app's environment or restarts it (G10). A database also gets a
 * `pool` endpoint for its PgBouncer and a `read` endpoint that follows its readable replicas
 * (G11). Ports are per consumer and never change on a re-point; only the upstream and `version` do.
 */
export class ServiceEndpointService {
	constructor(private readonly ctx: CoreContext) {}

	/**
	 * Re-plan one consumer node's endpoints. Rows are per node and shared by every project placed
	 * there, so the plan covers all of them plus `projectId` (which may be about to move here):
	 * planning one project alone would delete the endpoints its neighbours use.
	 */
	reconcile(projectId: string | null, consumerNodeId: string): { created: number; updated: number; removed: number } {
		if (!featureEnabled(this.ctx.config, 'SERVICE_ENDPOINTS'))
			return { created: 0, updated: 0, removed: 0 };
		const gateway = this.gatewayAt(consumerNodeId);
		const projectIds = new Set(this.projectsOnNode(consumerNodeId));
		if (projectId) projectIds.add(projectId);
		const services: PlannedService[] = [];
		const readServices: Array<{ serviceId: string; upstreamNodeId: string; upstreamPort: number }> = [];
		for (const id of projectIds) {
			const planned = this.servicesForProject(id, consumerNodeId, gateway);
			services.push(...planned.services);
			readServices.push(...planned.reads);
		}
		const existingRows = this.ctx.db
			.select()
			.from(serviceEndpoints)
			.where(eq(serviceEndpoints.consumerNodeId, consumerNodeId))
			.all();
		const primaryRows = existingRows.filter((row) => row.role !== 'read');
		const readRows = existingRows.filter((row) => row.role === 'read');
		const existing: ExistingEndpoint[] = primaryRows.map((row) => ({
			kind: row.serviceKind,
			serviceId: row.serviceId,
			localPort: row.localPort,
			role: row.role === 'pool' ? 'pool' : 'primary',
		}));
		const range = this.ctx.cluster.get().endpoints;
		const plan = planServiceEndpoints(consumerNodeId, services, existing, { min: range.portMin, max: range.portMax }, { includeSameNode: gateway });
		const readPlan = planReadEndpoints(
			consumerNodeId,
			readServices,
			readRows.map((row) => ({ serviceId: row.serviceId, localPort: row.localPort })),
			readEndpointPortRange,
		);
		const existingByKey = new Map(primaryRows.map((row) => [endpointKey(row.serviceKind, row.serviceId, row.role === 'pool' ? 'pool' : 'primary'), row]));
		const readByService = new Map(readRows.map((row) => [row.serviceId, row]));
		const now = this.ctx.now();
		let created = 0;
		let updated = 0;
		let removed = 0;

		this.ctx.db.transaction(() => {
			for (const key of plan.removed) {
				const row = existingByKey.get(key);
				if (!row) continue;
				this.ctx.db.delete(serviceEndpoints).where(eq(serviceEndpoints.id, row.id)).run();
				removed += 1;
			}
			for (const key of readPlan.removed) {
				const row = readByService.get(key);
				if (!row) continue;
				this.ctx.db.delete(serviceEndpoints).where(eq(serviceEndpoints.id, row.id)).run();
				removed += 1;
			}
			for (const endpoint of plan.endpoints) {
				const role = endpoint.role ?? 'primary';
				const row = existingByKey.get(endpointKey(endpoint.kind, endpoint.serviceId, role));
				const upstreamPort = endpoint.upstream.port;
				if (!row) {
					this.ctx.db
						.insert(serviceEndpoints)
						.values({
							id: endpoint.id,
							consumerNodeId,
							serviceKind: endpoint.kind,
							serviceId: endpoint.serviceId,
							role,
							localPort: endpoint.localPort,
							upstreamNodeId: endpoint.upstream.nodeId,
							upstreamPort,
							version: 0,
							createdAt: now,
							updatedAt: now,
						})
						.run();
					created += 1;
				} else if (
					row.localPort !== endpoint.localPort ||
					row.upstreamNodeId !== endpoint.upstream.nodeId ||
					row.upstreamPort !== upstreamPort
				) {
					this.ctx.db
						.update(serviceEndpoints)
						.set({
							localPort: endpoint.localPort,
							upstreamNodeId: endpoint.upstream.nodeId,
							upstreamPort,
							// A re-point (promotion, replica moved) keeps the port and bumps the version; a
							// port change would change the app's environment, so it bumps it too.
							version: row.version + 1,
							updatedAt: now,
						})
						.where(eq(serviceEndpoints.id, row.id))
						.run();
					updated += 1;
				}
			}
			for (const endpoint of readPlan.endpoints) {
				const row = readByService.get(endpoint.serviceId);
				if (!row) {
					this.ctx.db
						.insert(serviceEndpoints)
						.values({
							id: endpoint.id,
							consumerNodeId,
							serviceKind: 'database',
							serviceId: endpoint.serviceId,
							role: 'read',
							localPort: endpoint.localPort,
							upstreamNodeId: endpoint.upstreamNodeId,
							upstreamPort: endpoint.upstreamPort,
							version: 0,
							createdAt: now,
							updatedAt: now,
						})
						.run();
					created += 1;
				} else if (
					row.localPort !== endpoint.localPort ||
					row.upstreamNodeId !== endpoint.upstreamNodeId ||
					row.upstreamPort !== endpoint.upstreamPort
				) {
					this.ctx.db
						.update(serviceEndpoints)
						.set({
							localPort: endpoint.localPort,
							upstreamNodeId: endpoint.upstreamNodeId,
							upstreamPort: endpoint.upstreamPort,
							version: row.version + 1,
							updatedAt: now,
						})
						.where(eq(serviceEndpoints.id, row.id))
						.run();
					updated += 1;
				}
			}
		});
		if (created || updated || removed) this.ctx.projects.bump();
		return { created, updated, removed };
	}

	/**
	 * Re-plan every node that consumes a database: after a replica is added, removed or starts or
	 * stops serving reads, and after a promotion moved the primary (C7).
	 */
	reconcileForDatabase(databaseId: string): void {
		if (!featureEnabled(this.ctx.config, 'SERVICE_ENDPOINTS')) return;
		const consumerNodes = new Set<string>();
		for (const row of this.ctx.db
			.select({ nodeId: workloads.nodeId })
			.from(databaseAttachments)
			.innerJoin(workloads, eq(workloads.projectId, databaseAttachments.projectId))
			.where(eq(databaseAttachments.databaseId, databaseId))
			.all())
			if (row.nodeId) consumerNodes.add(row.nodeId);
		const replicaIds = this.ctx.databaseReplicas.rowsFor(databaseId).map((row) => row.id);
		for (const row of this.ctx.db
			.select({ nodeId: serviceEndpoints.consumerNodeId, serviceId: serviceEndpoints.serviceId })
			.from(serviceEndpoints)
			.where(eq(serviceEndpoints.serviceKind, 'database'))
			.all())
			if (row.serviceId === databaseId || replicaIds.includes(row.serviceId)) consumerNodes.add(row.nodeId);
		for (const nodeId of consumerNodes) this.reconcile(null, nodeId);
	}

	/** Whether a node gets H24's same-node, pooled and read endpoints. */
	gatewayAt(nodeId: string): boolean {
		if (!featureEnabled(this.ctx.config, 'ENDPOINTS_GATEWAY')) return false;
		const node = this.ctx.db.select({ capabilitiesJson: nodes.capabilitiesJson }).from(nodes).where(eq(nodes.id, nodeId)).get();
		return node ? nodeHasCapability(node, ENDPOINTS_GATEWAY_CAPABILITY) : false;
	}

	/** Live projects with a copy on a node: the workload's own node, a spread copy, or a copy mid-move. */
	private projectsOnNode(nodeId: string): string[] {
		const rows = this.ctx.sqlite
			.query<{ projectId: string }, [string, string, string]>(
				`SELECT DISTINCT w.project_id AS projectId FROM workloads w
				 JOIN projects p ON p.id = w.project_id AND p.deleted_at IS NULL
				 WHERE w.node_id = ? OR w.moving_from_node_id = ?
				    OR EXISTS (SELECT 1 FROM workload_replicas r WHERE r.workload_id = w.id AND r.node_id = ?)`,
			)
			.all(nodeId, nodeId, nodeId);
		return rows.map((row) => row.projectId);
	}

	/** Attachments that need an endpoint on this consumer, and the read ports they want. */
	private servicesForProject(
		projectId: string,
		consumerNodeId: string,
		gateway: boolean,
	): {
		services: PlannedService[];
		reads: Array<{ serviceId: string; upstreamNodeId: string; upstreamPort: number }>;
	} {
		const services: PlannedService[] = [];
		const reads: Array<{ serviceId: string; upstreamNodeId: string; upstreamPort: number }> = [];
		const databasesOnProject = this.ctx.db
			.select({
				id: databases.id,
				nodeId: databases.nodeId,
				port: databases.hostPort,
				engine: databases.engine,
				poolerEnabled: databases.poolerEnabled,
				poolerPort: databases.poolerPort,
			})
			.from(databaseAttachments)
			.innerJoin(databases, eq(databases.id, databaseAttachments.databaseId))
			.where(and(eq(databaseAttachments.projectId, projectId), isNull(databases.deletedAt)))
			.all();
		for (const row of databasesOnProject) {
			services.push({
				kind: 'database',
				serviceId: row.id,
				upstreamNodeId: row.nodeId,
				upstreamPort: row.port,
			});
			// Each read replica keeps its own primary endpoint for a process app on another node (C7).
			for (const replica of this.ctx.databaseReplicas.endpointServicesFor(row.id))
				services.push({
					kind: 'database',
					serviceId: replica.serviceId,
					upstreamNodeId: replica.nodeId,
					upstreamPort: replica.port,
				});
			if (!gateway) continue;
			// The pooler stays on the database's node (D85): one endpoint to its loopback port.
			if (row.poolerEnabled && row.poolerPort !== null)
				services.push({
					kind: 'database',
					serviceId: row.id,
					role: 'pool',
					upstreamNodeId: row.nodeId,
					upstreamPort: row.poolerPort,
				});
			// A read endpoint follows every readable replica; one representative upstream allocates it.
			if (row.engine === 'postgres') {
				const upstreams = this.ctx.databaseReplicas.readableUpstreamsFor(row.id);
				if (upstreams.length > 0)
					reads.push({
						serviceId: row.id,
						upstreamNodeId: upstreams[0]!.nodeId,
						upstreamPort: upstreams[0]!.port,
					});
			}
		}
		const storageOnProject = this.ctx.db
			.select({
				id: storageInstances.id,
				nodeId: storageInstances.nodeId,
				port: storageInstances.hostPort,
				public: storageInstances.public,
			})
			.from(storageAttachments)
			.innerJoin(storageInstances, eq(storageInstances.id, storageAttachments.storageId))
			.where(and(eq(storageAttachments.projectId, projectId), isNull(storageInstances.deletedAt)))
			.all()
			// A private instance is only remote-consumed; a public one uses its edge route.
			.filter((row) => !row.public && row.nodeId !== consumerNodeId)
			.map((row) => ({
				kind: 'storage' as const,
				serviceId: row.id,
				upstreamNodeId: row.nodeId,
				upstreamPort: row.port,
			}));
		services.push(...storageOnProject);
		return { services, reads };
	}
}
