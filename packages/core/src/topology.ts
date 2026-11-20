import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { appVolumes, databaseBackups, databaseReplicas, databases, disks, nodes, projects, storageInstances, workloadReplicas, workloads } from '@yoal/db';
import {
	workloadSpecSchema,
	type BlastRadiusItem,
	type HaLevel,
	type BlastRadiusView,
	type Principal,
	type TopologyNodeView,
	type TopologyView,
	type TopologyZoneView,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { CoreError, NotFoundError } from './errors.ts';
import { computeHaLevel, type HaLevelInput } from './ha-level.ts';
import { parseJson } from './util.ts';

/**
 * Topology and blast radius (docs/CLUSTERING.md §3.6 and §12, phase C0).
 *
 * Everything is computed from current placement, not a separate cache: a node's zone, roles,
 * hardware and disks, what runs on it, and what an outage of that node or zone would take down.
 * C0 is read-only; later phases add service endpoints, shares and HA levels.
 */
export class TopologyService {
	constructor(private readonly ctx: CoreContext) {}

	view(principal: Principal): TopologyView {
		this.assertRead(principal);
		const nodeRows = this.ctx.db.select().from(nodes).all();
		const diskRows = this.ctx.db.select().from(disks).all();
		const liveWorkloads = this.liveWorkloads();
		const liveDatabases = this.ctx.db
			.select({ id: databases.id, name: databases.name, nodeId: databases.nodeId, orgId: databases.orgId })
			.from(databases)
			.where(isNull(databases.deletedAt))
			.all();
		const liveStorage = this.ctx.db
			.select({ id: storageInstances.id, name: storageInstances.name, nodeId: storageInstances.nodeId, orgId: storageInstances.orgId })
			.from(storageInstances)
			.where(isNull(storageInstances.deletedAt))
			.all();

		const views: TopologyNodeView[] = nodeRows.map((row) => {
			const facts = this.ctx.nodes.view(row);
			const nodeDisks = diskRows
				.filter((disk) => disk.nodeId === row.id)
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((disk) => ({
					id: disk.id,
					name: disk.name,
					tier: disk.tier,
					mountPath: disk.mountPath,
					sizeBytes: disk.sizeBytes,
					freeBytes: disk.freeBytes,
					remote: disk.remote,
				}));
			return {
				id: row.id,
				name: row.name,
				zone: facts.zone,
				roles: facts.roles,
				labels: facts.labels,
				status: facts.status,
				mode: facts.mode,
				publicAddress: facts.publicAddress,
				privateAddress: facts.privateAddress,
				lanEndpoint: facts.lanEndpoint,
				privateNetwork: facts.privateNetwork,
				hardware: facts.hardware,
				derivedLabels: facts.derivedLabels,
				disks: nodeDisks,
				workloads: liveWorkloads.filter((item) => item.nodeId === row.id).length,
				databases: liveDatabases.filter((item) => item.nodeId === row.id).length,
				storageInstances: liveStorage.filter((item) => item.nodeId === row.id).length,
				cpuBudgetMillis: facts.cpuBudgetMillis,
			};
		});

		const zones = new Map<string, TopologyZoneView>();
		for (const node of views) {
			const zone = zones.get(node.zone) ?? {
				zone: node.zone,
				nodes: [],
				workloads: 0,
				databases: 0,
				storageInstances: 0,
			};
			zone.nodes.push(node.id);
			zone.workloads += node.workloads;
			zone.databases += node.databases;
			zone.storageInstances += node.storageInstances;
			zones.set(node.zone, zone);
		}

		return {
			generatedAt: new Date(this.ctx.now()).toISOString(),
			zones: [...zones.values()].sort((a, b) => a.zone.localeCompare(b.zone)),
			nodes: views.sort((a, b) => a.name.localeCompare(b.name)),
		};
	}

	blastRadius(principal: Principal, target: { kind: 'node' | 'zone'; id: string }): BlastRadiusView {
		this.assertRead(principal);
		const nodeRows = this.ctx.db.select().from(nodes).all();
		let affected: typeof nodeRows;
		let name: string;
		if (target.kind === 'node') {
			const node = nodeRows.find((row) => row.id === target.id);
			if (!node) throw new NotFoundError('Node');
			affected = [node];
			name = node.name;
		} else {
			affected = nodeRows.filter((row) => row.zone === target.id);
			name = target.id;
		}
		const nodeIds = new Set(affected.map((row) => row.id));
		const items: BlastRadiusItem[] = [];
		const levels = this.haLevels(nodeRows);

		for (const item of this.liveWorkloads()) {
			if (!item.nodeId || !nodeIds.has(item.nodeId)) continue;
			items.push({
				kind: 'workload',
				id: item.id,
				name: item.name,
				nodeId: item.nodeId,
				orgId: item.orgId,
				haLevel: levels.workload(item.id),
			});
		}
		for (const item of this.ctx.db
			.select({ id: databases.id, name: databases.name, nodeId: databases.nodeId, orgId: databases.orgId })
			.from(databases)
			.where(isNull(databases.deletedAt))
			.all()) {
			if (!nodeIds.has(item.nodeId)) continue;
			items.push({ kind: 'database', ...item, haLevel: levels.database(item.id, item.nodeId) });
		}
		for (const item of this.ctx.db
			.select({ id: storageInstances.id, name: storageInstances.name, nodeId: storageInstances.nodeId, orgId: storageInstances.orgId })
			.from(storageInstances)
			.where(isNull(storageInstances.deletedAt))
			.all()) {
			if (!nodeIds.has(item.nodeId)) continue;
			items.push({ kind: 'storage', ...item, haLevel: levels.storage(item.nodeId) });
		}
		for (const disk of this.ctx.db.select().from(disks).all()) {
			if (!nodeIds.has(disk.nodeId)) continue;
			items.push({
				kind: 'disk',
				id: disk.id,
				name: disk.name,
				nodeId: disk.nodeId,
				orgId: null,
				haLevel: 'L0',
			});
		}

		return {
			target: { ...target, name },
			affectedNodes: [...nodeIds],
			items: items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
			summary: {
				workloads: items.filter((item) => item.kind === 'workload').length,
				databases: items.filter((item) => item.kind === 'database').length,
				storageInstances: items.filter((item) => item.kind === 'storage').length,
				disks: items.filter((item) => item.kind === 'disk').length,
			},
		};
	}

	/**
	 * HA levels from current placement (HA-PLAN G24, CLUSTERING §8.1), through `computeHaLevel`. Shown
	 * whatever `RELEASE_PHASE` says: it describes where things run and changes no behaviour. A disk
	 * is always `L0`; a storage instance is `L0` until bucket replication counts (C9).
	 */
	private haLevels(nodeRows: Array<typeof nodes.$inferSelect>): {
		workload: (id: string) => HaLevel;
		database: (id: string, nodeId: string) => HaLevel;
		storage: (nodeId: string) => HaLevel;
	} {
		const zoneOf = new Map(nodeRows.map((row) => [row.id, row.zone]));
		const placed = (nodeIds: string[]) => ({ nodes: new Set(nodeIds).size, zones: new Set(nodeIds.map((id) => zoneOf.get(id) ?? 'default')).size });
		const level = (input: HaLevelInput) => computeHaLevel(input).level;
		return {
			workload: (id) => {
				const row = this.ctx.db.select().from(workloads).where(eq(workloads.id, id)).get();
				if (!row?.nodeId) return 'L0';
				const spec = workloadSpecSchema.safeParse(parseJson<unknown>(row.specJson, null)).data;
				const copies = this.ctx.db.select({ nodeId: workloadReplicas.nodeId }).from(workloadReplicas).where(eq(workloadReplicas.workloadId, id)).all();
				const nodeIds = copies.length > 0 ? copies.map((copy) => copy.nodeId) : [row.nodeId];
				const volumes = this.ctx.db.select({ id: appVolumes.id }).from(appVolumes).where(and(eq(appVolumes.projectId, row.projectId), isNull(appVolumes.deletedAt))).all();
				return level({
					kind: 'workload',
					copies: copies.length > 0 ? copies.length : (spec?.replicas ?? 1),
					...placed(nodeIds),
					verifiedBackup: false,
					http: spec?.ingress !== 'none',
					pinned: Boolean(spec?.data) || volumes.length > 0,
				});
			},
			database: (id, nodeId) => {
				const replicas = this.ctx.db
					.select({ nodeId: databaseReplicas.nodeId, status: databaseReplicas.status })
					.from(databaseReplicas)
					.where(eq(databaseReplicas.databaseId, id))
					.all()
					.filter((replica) => replica.status === 'streaming' || replica.status === 'lagging');
				const verified = this.ctx.db
					.select({ id: databaseBackups.id })
					.from(databaseBackups)
					.where(and(eq(databaseBackups.databaseId, id), isNotNull(databaseBackups.verifiedAt)))
					.get();
				return level({
					kind: 'database',
					copies: 1 + replicas.length,
					...placed([nodeId, ...replicas.map((replica) => replica.nodeId)]),
					verifiedBackup: Boolean(verified),
					http: false,
					pinned: false,
				});
			},
			storage: (nodeId) => level({ kind: 'storage', copies: 1, ...placed([nodeId]), verifiedBackup: false, http: false, pinned: false }),
		};
	}

	/** Live workloads joined to their project, so a trashed project is not counted as an impact. */
	private liveWorkloads(): Array<{ id: string; name: string; nodeId: string; orgId: string }> {
		return this.ctx.db
			.select({ id: workloads.id, name: projects.name, nodeId: workloads.nodeId, orgId: workloads.orgId })
			.from(workloads)
			.innerJoin(projects, eq(projects.id, workloads.projectId))
			.where(and(isNotNull(workloads.nodeId), isNull(projects.deletedAt)))
			.all()
			.flatMap((row) => (row.nodeId ? [{ ...row, nodeId: row.nodeId }] : []));
	}

	private assertRead(principal: Principal): void {
		if (!this.ctx.platformIam.canView(principal))
			throw new CoreError('forbidden', 'Platform admin permission required to view the fleet topology.', 403);
	}
}
