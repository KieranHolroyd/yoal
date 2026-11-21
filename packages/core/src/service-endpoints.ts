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
import {
	ENDPOINTS_GATEWAY_CAPABILITY,
	databaseAlias,
	databaseEngineRegistry,
	readEndpointPortRange,
	type Principal,
} from '@yoal/contracts';
import { endpointKey, planReadEndpoints, planServiceEndpoints, type ExistingEndpoint, type EndpointService as PlannedService } from './endpoints.ts';
import { nodeHasCapability } from './capability-gate.ts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { CoreError, ValidationError } from './errors.ts';

export interface AttachmentMigrationItem {
	projectId: string;
	slug: string;
	runtime: string;
	/** Nodes holding a copy, by name. */
	nodes: string[];
	databases: string[];
	/** `will-move` in a dry run, `moved` once applied, `blocked` when a node or flag stops it. */
	status: 'will-move' | 'moved' | 'blocked';
	reason: string;
}

export interface AttachmentMigrationView {
	apply: boolean;
	/** Both ENDPOINTS_GATEWAY and SERVICE_ENDPOINTS are on. */
	gateway: boolean;
	/** Apps with attachments already on their endpoints. */
	alreadyMoved: number;
	/** Apps with attachments not on their endpoints yet. */
	projects: AttachmentMigrationItem[];
}

export interface AttachmentConsumerView {
	nodeId: string;
	node: string;
	/** `gateway`: the stable endpoint (H24); `endpoint`: a C2 loopback endpoint to another node; `direct`: on the database's node; `none`: no URL. */
	mode: 'gateway' | 'endpoint' | 'direct' | 'none';
	host: string | null;
	port: number | null;
	poolPort: number | null;
	readPort: number | null;
	/** Where the connection lands: the primary's node for a gateway or C2 endpoint. */
	upstreamNode: string | null;
	version: number | null;
	databaseNode?: string;
}

export interface AttachmentsView {
	attachments: Array<{
		projectId: string;
		project: string;
		runtime: string;
		databaseId: string;
		database: string;
		databaseNode: string;
		envPrefix: string;
		/** The project chose the gateway on its own deploy, attach or migration. */
		gateway: boolean;
		consumers: AttachmentConsumerView[];
	}>;
}

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
		const readServices: Array<{ serviceId: string; upstreamNodeId: string; upstreamPort: number; upstreamsKey: string }> = [];
		for (const id of projectIds) {
			// Same-node, pooled and read endpoints only for a project whose own deploy (or attach, or
			// `ha migrate attachments`) chose the gateway: a neighbour's deploy or a replica coming
			// and going must never move another app to its endpoint and restart it (HA-PLAN §9).
			const planned = this.servicesForProject(id, consumerNodeId, gateway && this.marked(id));
			services.push(...planned.services);
			readServices.push(...planned.reads);
		}
		const readKeys = new Map(readServices.map((service) => [service.serviceId, service.upstreamsKey]));
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
		// Each project's services are already filtered for the same-node case (`servicesForProject`).
		const plan = planServiceEndpoints(consumerNodeId, services, existing, { min: range.portMin, max: range.portMax }, { includeSameNode: true });
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
							upstreamsKey: readKeys.get(endpoint.serviceId) ?? null,
							createdAt: now,
							updatedAt: now,
						})
						.run();
					created += 1;
				} else {
					const key = readKeys.get(endpoint.serviceId) ?? null;
					const repointed =
						row.localPort !== endpoint.localPort ||
						row.upstreamNodeId !== endpoint.upstreamNodeId ||
						row.upstreamPort !== endpoint.upstreamPort;
					// A replica joining or leaving the set is a re-point too: the forwarder cuts the
					// sessions still on a replica that left. A row from before 0133 learns its set
					// without a bump.
					const setChanged = row.upstreamsKey !== null && key !== null && row.upstreamsKey !== key;
					if (repointed || setChanged || row.upstreamsKey !== key) {
						this.ctx.db
							.update(serviceEndpoints)
							.set({
								localPort: endpoint.localPort,
								upstreamNodeId: endpoint.upstreamNodeId,
								upstreamPort: endpoint.upstreamPort,
								upstreamsKey: key,
								version: repointed || setChanged ? row.version + 1 : row.version,
								updatedAt: now,
							})
							.where(eq(serviceEndpoints.id, row.id))
							.run();
						if (repointed || setChanged) updated += 1;
					}
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

	/** The project's own last deploy, attach or migration chose the gateway (0133). */
	marked(projectId: string): boolean {
		return (
			this.ctx.db.select({ on: workloads.endpointsGateway }).from(workloads).where(eq(workloads.projectId, projectId)).get()?.on ===
			true
		);
	}

	/**
	 * Whether this project's copy on this node goes through H24's endpoints: the flags are on, the
	 * node runs the gateway, and the project chose it on its own deploy, attach or migration.
	 */
	projectGateway(projectId: string, nodeId: string): boolean {
		return featureEnabled(this.ctx.config, 'SERVICE_ENDPOINTS') && this.gatewayAt(nodeId) && this.marked(projectId);
	}

	/**
	 * Why this project's copies cannot all use the gateway right now, or null when they can: both
	 * flags on and every node holding a copy advertising `endpoints-gateway`.
	 */
	gatewayBlocker(projectId: string): string | null {
		if (!featureEnabled(this.ctx.config, 'ENDPOINTS_GATEWAY') || !featureEnabled(this.ctx.config, 'SERVICE_ENDPOINTS'))
			return 'ENDPOINTS_GATEWAY and SERVICE_ENDPOINTS are not both on';
		const nodeIds = this.copyNodes(projectId);
		if (nodeIds.length === 0) return 'it has no running copy';
		const missing = nodeIds.filter((nodeId) => !this.gatewayAt(nodeId));
		if (missing.length === 0) return null;
		return `${missing.map((nodeId) => this.nodeName(nodeId)).join(', ')} ${missing.length === 1 ? 'runs an agent' : 'run agents'} without the endpoint gateway; update ${missing.length === 1 ? 'it' : 'them'} first`;
	}

	/**
	 * A deploy (or promote, or rollback) of this project was just recorded: it uses the gateway from
	 * now on exactly when every copy's node can (HA-PLAN §9: existing attachments move on the
	 * project's own next deploy). Called before the endpoints are re-planned.
	 */
	recordGatewayMarker(projectId: string): void {
		const on = this.gatewayBlocker(projectId) === null;
		if (this.marked(projectId) !== on)
			this.ctx.db.update(workloads).set({ endpointsGateway: on }).where(eq(workloads.projectId, projectId)).run();
		// Its own deploy is also when it gains (or drops) its read URLs; an app the upgrade backfill put
		// on the gateway gets them here, never on a neighbour's deploy.
		this.setReadEndpoints(projectId, on);
	}

	/** `<P>_READ_*` through the read endpoint for every attachment of the project, or none. */
	private setReadEndpoints(projectId: string, on: boolean): void {
		this.ctx.db
			.update(databaseAttachments)
			.set({ readEndpoint: on })
			.where(and(eq(databaseAttachments.projectId, projectId), eq(databaseAttachments.readEndpoint, !on)))
			.run();
	}

	/**
	 * An attachment was just added to a project. Its running copies get their endpoints now, not on
	 * the next deploy, so a container on another node has its URL at once. The attach restarts the
	 * app anyway (its environment changes), so it also moves to the gateway if it can.
	 */
	attached(projectId: string): void {
		if (!featureEnabled(this.ctx.config, 'SERVICE_ENDPOINTS')) return;
		if (!this.marked(projectId) && this.gatewayBlocker(projectId) === null)
			this.ctx.db.update(workloads).set({ endpointsGateway: true }).where(eq(workloads.projectId, projectId)).run();
		if (this.marked(projectId)) this.setReadEndpoints(projectId, true);
		for (const nodeId of this.copyNodes(projectId)) this.reconcile(projectId, nodeId);
	}

	/**
	 * `yoal ha migrate attachments` (HA-PLAN §9): every app with a database attachment that still
	 * connects directly, and whether moving it to its stable endpoint is possible now. A dry run
	 * changes nothing; `apply` moves each listed app at once, which restarts it.
	 */
	migrationPlan(principal: Principal, options: { projects?: string[] } = {}): AttachmentMigrationView {
		this.requireHa(principal);
		const gateway = featureEnabled(this.ctx.config, 'ENDPOINTS_GATEWAY') && featureEnabled(this.ctx.config, 'SERVICE_ENDPOINTS');
		const rows = this.ctx.sqlite
			.query<{ projectId: string; slug: string; runtime: string; marked: number }, []>(
				`SELECT DISTINCT w.project_id AS projectId, p.slug AS slug, w.runtime AS runtime, w.endpoints_gateway AS marked
				 FROM workloads w
				 JOIN projects p ON p.id = w.project_id AND p.deleted_at IS NULL
				 JOIN database_attachments a ON a.project_id = w.project_id
				 JOIN databases d ON d.id = a.database_id AND d.deleted_at IS NULL
				 ORDER BY p.slug`,
			)
			.all();
		const wanted = options.projects?.length ? new Set(options.projects) : null;
		if (wanted) {
			const known = new Set(rows.flatMap((row) => [row.slug, row.projectId]));
			const unknown = [...wanted].filter((name) => !known.has(name));
			if (unknown.length) throw new ValidationError(`No app with a database attachment named ${unknown.map((name) => `"${name}"`).join(', ')}.`);
		}
		const projects: AttachmentMigrationItem[] = rows
			.filter((row) => !row.marked && (!wanted || wanted.has(row.slug) || wanted.has(row.projectId)))
			.map((row) => {
				const blocker = this.gatewayBlocker(row.projectId);
				return {
					projectId: row.projectId,
					slug: row.slug,
					runtime: row.runtime,
					nodes: this.copyNodes(row.projectId).map((nodeId) => this.nodeName(nodeId)),
					databases: this.attachedDatabases(row.projectId).map((database) => database.name),
					status: blocker ? 'blocked' : 'will-move',
					reason: blocker ? `Cannot move: ${blocker}.` : 'Moves to its stable endpoint; the app restarts once.',
				};
			});
		return {
			apply: false,
			gateway,
			alreadyMoved: rows.filter((row) => row.marked && (!wanted || wanted.has(row.slug) || wanted.has(row.projectId))).length,
			projects,
		};
	}

	/** The dry run under `platform:ha`; `apply` restarts apps, so it is for a platform admin only. */
	migrateAttachments(principal: Principal, input: { apply?: boolean; projects?: string[] } = {}): AttachmentMigrationView {
		const plan = this.migrationPlan(principal, { projects: input.projects });
		if (!input.apply) return plan;
		// An empty list is never "every app": a caller that filtered down to nothing must not move everything.
		if (input.projects && input.projects.length === 0)
			throw new ValidationError('Name at least one app to move, or leave the list out to move every app.');
		if (!this.ctx.platformIam.canAdminister(principal))
			throw new CoreError('forbidden', 'Only a platform admin role can move apps to their endpoints; a platform operator can run the dry run.', 403);
		const projects = plan.projects.map((item): AttachmentMigrationItem => {
			if (item.status !== 'will-move') return item;
			this.ctx.db.update(workloads).set({ endpointsGateway: true }).where(eq(workloads.projectId, item.projectId)).run();
			this.setReadEndpoints(item.projectId, true);
			for (const nodeId of this.copyNodes(item.projectId)) this.reconcile(item.projectId, nodeId);
			this.ctx.audit.record({
				principal,
				action: 'ha.migrate-attachments',
				resource: 'project',
				resourceId: item.projectId,
				args: { project: item.slug, databases: item.databases },
				result: 'ok',
			});
			return { ...item, status: 'moved', reason: 'Moved to its stable endpoint; the app restarts on its next heartbeat.' };
		});
		this.ctx.projects.bump();
		return { ...plan, apply: true, projects };
	}

	/**
	 * Every database attachment and, per node holding a copy, how that copy reaches it: through its
	 * gateway endpoint, a C2 endpoint, directly on the database's node, or not at all. No secrets.
	 */
	attachmentsView(principal: Principal): AttachmentsView {
		this.requireHa(principal);
		const rows = this.ctx.sqlite
			.query<
				{ projectId: string; slug: string; runtime: string; databaseId: string; database: string; engine: string; databaseNodeId: string; hostPort: number; envPrefix: string; readEndpoint: number },
				[]
			>(
				`SELECT w.project_id AS projectId, p.slug AS slug, w.runtime AS runtime, d.id AS databaseId, d.name AS database,
				        d.engine_name AS engine, d.node_id AS databaseNodeId, d.host_port AS hostPort, a.env_prefix AS envPrefix,
				        a.read_endpoint AS readEndpoint
				 FROM workloads w
				 JOIN projects p ON p.id = w.project_id AND p.deleted_at IS NULL
				 JOIN database_attachments a ON a.project_id = w.project_id
				 JOIN databases d ON d.id = a.database_id AND d.deleted_at IS NULL
				 ORDER BY p.slug, d.name`,
			)
			.all();
		const endpointsByKey = new Map(
			this.ctx.db
				.select()
				.from(serviceEndpoints)
				.where(eq(serviceEndpoints.serviceKind, 'database'))
				.all()
				.map((row) => [`${row.consumerNodeId}:${row.serviceId}:${row.role}`, row]),
		);
		const attachments = rows.map((row) => {
			const container = row.runtime === 'container';
			const info = databaseEngineRegistry[row.engine as keyof typeof databaseEngineRegistry];
			const consumers = this.copyNodes(row.projectId).map((nodeId): AttachmentConsumerView => {
				const primary = endpointsByKey.get(`${nodeId}:${row.databaseId}:primary`);
				const sameNode = nodeId === row.databaseNodeId;
				const base = { nodeId, node: this.nodeName(nodeId) };
				if (this.projectGateway(row.projectId, nodeId) && primary)
					return {
						...base,
						mode: 'gateway',
						host: container ? databaseAlias(row.databaseId) : '127.0.0.1',
						port: primary.localPort,
						poolPort: endpointsByKey.get(`${nodeId}:${row.databaseId}:pool`)?.localPort ?? null,
						readPort: row.readEndpoint ? (endpointsByKey.get(`${nodeId}:${row.databaseId}:read`)?.localPort ?? null) : null,
						upstreamNode: this.nodeName(primary.upstreamNodeId),
						version: primary.version,
					};
				if (sameNode)
					return {
						...base,
						mode: 'direct',
						host: container ? databaseAlias(row.databaseId) : '127.0.0.1',
						port: container ? (info?.containerPort ?? row.hostPort) : row.hostPort,
						poolPort: null,
						readPort: null,
						upstreamNode: this.nodeName(row.databaseNodeId),
						version: null,
					};
				if (primary && !container)
					return {
						...base,
						mode: 'endpoint',
						host: '127.0.0.1',
						port: primary.localPort,
						poolPort: null,
						readPort: null,
						upstreamNode: this.nodeName(primary.upstreamNodeId),
						version: primary.version,
					};
				return { ...base, mode: 'none', host: null, port: null, poolPort: null, readPort: null, upstreamNode: null, version: null };
			});
			return {
				projectId: row.projectId,
				project: row.slug,
				runtime: row.runtime,
				databaseId: row.databaseId,
				database: row.database,
				databaseNode: this.nodeName(row.databaseNodeId),
				envPrefix: row.envPrefix,
				gateway: this.marked(row.projectId),
				consumers: consumers.map((consumer) => ({ ...consumer, databaseNode: this.nodeName(row.databaseNodeId) })),
			};
		});
		return { attachments };
	}

	/** Whether a node gets H24's same-node, pooled and read endpoints. */
	gatewayAt(nodeId: string): boolean {
		if (!featureEnabled(this.ctx.config, 'ENDPOINTS_GATEWAY')) return false;
		const node = this.ctx.db.select({ capabilitiesJson: nodes.capabilitiesJson }).from(nodes).where(eq(nodes.id, nodeId)).get();
		return node ? nodeHasCapability(node, ENDPOINTS_GATEWAY_CAPABILITY) : false;
	}

	/** Nodes that hold a copy of the project: its workload's node, spread copies and a copy mid-move. */
	private copyNodes(projectId: string): string[] {
		const rows = this.ctx.sqlite
			.query<{ nodeId: string | null }, [string, string, string]>(
				`SELECT w.node_id AS nodeId FROM workloads w WHERE w.project_id = ?
				 UNION SELECT w.moving_from_node_id FROM workloads w WHERE w.project_id = ?
				 UNION SELECT r.node_id FROM workload_replicas r JOIN workloads w ON w.id = r.workload_id WHERE w.project_id = ?`,
			)
			.all(projectId, projectId, projectId);
		return [...new Set(rows.map((row) => row.nodeId).filter((nodeId): nodeId is string => Boolean(nodeId)))].sort();
	}

	private attachedDatabases(projectId: string): Array<{ id: string; name: string }> {
		return this.ctx.db
			.select({ id: databases.id, name: databases.name })
			.from(databaseAttachments)
			.innerJoin(databases, eq(databases.id, databaseAttachments.databaseId))
			.where(and(eq(databaseAttachments.projectId, projectId), isNull(databases.deletedAt)))
			.all();
	}

	private nodeName(nodeId: string): string {
		return this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).get()?.name ?? nodeId;
	}

	private requireHa(principal: Principal): void {
		if (!this.ctx.platformIam.allows(principal, 'platform:ha'))
			throw new CoreError('forbidden', 'High availability is for platform operators and admins.', 403);
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
		reads: Array<{ serviceId: string; upstreamNodeId: string; upstreamPort: number; upstreamsKey: string }>;
	} {
		const services: PlannedService[] = [];
		const reads: Array<{ serviceId: string; upstreamNodeId: string; upstreamPort: number; upstreamsKey: string }> = [];
		const databasesOnProject = this.ctx.db
			.select({
				id: databases.id,
				nodeId: databases.nodeId,
				port: databases.hostPort,
				engine: databases.engine,
				poolerEnabled: databases.poolerEnabled,
				poolerPort: databases.poolerPort,
				readEndpoint: databaseAttachments.readEndpoint,
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
			// A read endpoint exists from the project's own deploy (or attach, or migration) on, pointing
			// at the primary until a replica serves reads, so adding, removing or promoting a replica
			// changes no app's environment. Only an attachment that asked for it plans one: a
			// neighbour's deploy re-plans this node and must not add read URLs to an app the upgrade
			// backfill put on the gateway. It follows every readable replica; one representative
			// upstream allocates it, and the set's key bumps its version when the set changes.
			if (row.engine === 'postgres' && row.readEndpoint) {
				const upstreams = this.ctx.databaseReplicas.readableUpstreamsFor(row.id);
				const first = upstreams[0];
				reads.push({
					serviceId: row.id,
					upstreamNodeId: first?.nodeId ?? row.nodeId,
					upstreamPort: first?.port ?? row.port,
					upstreamsKey: [...upstreams.map((item) => `${item.nodeId}:${item.port}`), `${row.nodeId}:${row.port}`].join(','),
				});
			}
		}
		// Without the gateway a same-node attachment connects directly (C2): no endpoint for it.
		if (!gateway) {
			const remote = services.filter((service) => service.upstreamNodeId !== consumerNodeId);
			services.length = 0;
			services.push(...remote);
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
