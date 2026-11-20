import { isNull } from 'drizzle-orm';
import { nodes, projects, workloadReplicas, workloads, type nodes as nodesTable } from '@yoal/db';
import type { CoreContext } from '../context.ts';
import { effectiveRuntime } from '../runtime-tier.ts';

export type NodeRow = typeof nodesTable.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
/** The node columns every part of desired state reads about the rest of the fleet. */
export type FleetNode = Pick<NodeRow, 'id' | 'mode' | 'publicAddress' | 'status' | 'capabilitiesJson'>;

/**
 * What one node's desired state is built from: the node, the fleet around it, where each project's
 * copies run and which projects this node serves. Read once per pull and shared by every part
 * (`routes.ts`, `releases.ts`, `endpoints.ts`, `databases.ts`, `ingress.ts`); `NodeService.desiredState()`
 * composes them.
 */
export class DesiredStateContext {
	readonly now: number;
	readonly allNodes: FleetNode[];
	readonly edgeId: string | null;
	readonly isEdge: boolean;
	readonly nodeById: Map<string, FleetNode>;
	readonly workloadNodeByProject: Map<string, string>;
	readonly arrivingHere: Set<string>;
	readonly replicaNodesByProject: Map<string, string[]>;
	readonly readyNodesByProject: Map<string, Set<string>>;
	readonly holdsCopy: (projectId: string) => boolean;
	readonly targetOf: (project: { id: string; runtime: string; runtimeName?: string | null; placement: string }) => string | null;
	/** The projects this node serves (every project on the edge). */
	readonly projectRows: ProjectRow[];

	constructor(
		readonly ctx: CoreContext,
		readonly node: NodeRow,
	) {
		const now = this.ctx.now();
		const allNodes = this.ctx.db
			.select({
				id: nodes.id,
				mode: nodes.mode,
				publicAddress: nodes.publicAddress,
				status: nodes.status,
				capabilitiesJson: nodes.capabilitiesJson,
			})
			.from(nodes)
			.all();
		const edgeId = this.ctx.config.edgeNodeId ?? allNodes.find((row) => row.mode === 'edge')?.id ?? null;
		const isEdge = node.id === edgeId || node.mode === 'edge';
		const nodeById = new Map(allNodes.map((row) => [row.id, row]));

		// Apps are served from the node their workload was admitted to (`auto` and database pinning
		// resolve at deploy time); the placement request is only the fallback before a deploy.
		const workloadPlacements = this.ctx.db
			.select({ projectId: workloads.projectId, nodeId: workloads.nodeId, movingFromNodeId: workloads.movingFromNodeId })
			.from(workloads)
			.all();
		// During a surge move the old node still serves: the route follows only once the new copy
		// has reported running and `moving_from_node_id` is cleared.
		const workloadNodeByProject = new Map(
			workloadPlacements.flatMap((row) =>
				(row.movingFromNodeId ?? row.nodeId) ? [[row.projectId, (row.movingFromNodeId ?? row.nodeId)!] as const] : [],
			),
		);
		/** Projects whose copy is starting here mid-move: this node needs the release before the route. */
		const arrivingHere = new Set(
			workloadPlacements.filter((row) => row.movingFromNodeId && row.nodeId === node.id).map((row) => row.projectId),
		);
		// Spread copies (C4), in index order so the upstream list is stable between pulls. A node
		// appears once however many copies it holds: its own Caddy balances nothing locally.
		const replicaNodesByProject = new Map<string, string[]>();
		/** Nodes whose copy is up: the only ones an ingress should send traffic to. */
		const readyNodesByProject = new Map<string, Set<string>>();
		for (const replica of this.ctx.db
			.select({
				projectId: workloadReplicas.projectId,
				nodeId: workloadReplicas.nodeId,
				status: workloadReplicas.status,
				appliedVersion: workloadReplicas.appliedVersion,
			})
			.from(workloadReplicas)
			.orderBy(workloadReplicas.replicaIndex)
			.all()) {
			const list = replicaNodesByProject.get(replica.projectId) ?? [];
			if (!list.includes(replica.nodeId)) list.push(replica.nodeId);
			replicaNodesByProject.set(replica.projectId, list);
			// A copy being restarted by a rollout leaves the upstreams before its node stops it.
			if (replica.status === 'running' && replica.appliedVersion === null) {
				const ready = readyNodesByProject.get(replica.projectId) ?? new Set<string>();
				ready.add(replica.nodeId);
				readyNodesByProject.set(replica.projectId, ready);
			}
		}
		/** This node holds a copy of the project's workload, whichever index it is. */
		const holdsCopy = (projectId: string): boolean => replicaNodesByProject.get(projectId)?.includes(node.id) ?? false;

		const targetOf = (project: { id: string; runtime: string; runtimeName?: string | null; placement: string }): string | null =>
			// Every node holding a copy serves the project itself: it needs the route and the release,
			// not only the node `workloads.node_id` names (copy 0).
			(effectiveRuntime(project) !== 'static' && holdsCopy(project.id) ? node.id : undefined) ??
			(effectiveRuntime(project) !== 'static' ? workloadNodeByProject.get(project.id) : undefined) ??
			(project.placement === 'edge' || project.placement === 'auto' ? edgeId : project.placement);

		const projectRows = this.ctx.db
			.select()
			.from(projects)
			.where(isNull(projects.deletedAt))
			.all()
			.filter((project) => {
				const target = targetOf(project);
				// Edge serves edge-placed projects locally and proxies worker-placed ones; a worker
				// only serves the projects placed on it, or arriving on it.
				return isEdge || target === node.id || arrivingHere.has(project.id);
			});

		this.now = now;
		this.allNodes = allNodes;
		this.edgeId = edgeId;
		this.isEdge = isEdge;
		this.nodeById = nodeById;
		this.workloadNodeByProject = workloadNodeByProject;
		this.arrivingHere = arrivingHere;
		this.replicaNodesByProject = replicaNodesByProject;
		this.readyNodesByProject = readyNodesByProject;
		this.holdsCopy = holdsCopy;
		this.targetOf = targetOf;
		this.projectRows = projectRows;
	}
}

/** One part of a node's desired state: the shared lookups plus the core services through `ctx`. */
export abstract class DesiredStatePart {
	protected readonly ctx: CoreContext;

	constructor(protected readonly state: DesiredStateContext) {
		this.ctx = state.ctx;
	}
}
