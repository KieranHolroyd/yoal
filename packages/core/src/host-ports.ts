import { eq, isNull } from 'drizzle-orm';
import { projects, workloadReplicas, workloads } from '@yoal/db';
import {
	appHostPorts,
	appPortProblem,
	laterPortOwner,
	platformPortOwner,
	workloadSpecSchema,
	type ReservedPortRange,
	type WorkloadSpec,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { parseJson } from './util.ts';

/**
 * The host-port ledger (D225, DESIGN §3.4.2).
 *
 * A process app without socket activation and a container both hold a loopback port on their
 * node, and Caddy routes the project's public host to it. Two apps on one node with the same
 * port, or an app on a port a platform service holds, would send one project's visitors to the
 * other's listener. Every path that puts an app on a node (deploy, spec save, auto placement,
 * copies, moves, rebalancing, failover) asks this ledger first, and the desired-state guard in
 * `nodes.ts` re-checks the result before a route is handed to Caddy.
 */

export interface PortHolder {
	projectId: string;
	slug: string;
}

/** Ports an install's own configuration moved away from the defaults. */
export function installReservedPorts(ctx: Pick<CoreContext, 'config' | 'cluster'>): ReservedPortRange[] {
	const extra: ReservedPortRange[] = [];
	const single = (port: number | undefined, owner: string) => {
		if (port) extra.push({ min: port, max: port, owner });
	};
	single(ctx.config.storageGatewayPort, 'the storage gateway');
	single(ctx.config.databaseGatewayPort, 'the database gateway');
	single(ctx.config.studioPort, 'the database studio');
	single(ctx.config.containerConsolePort, 'the container console');
	const endpoints = ctx.cluster.get().endpoints;
	if (endpoints?.portMin && endpoints?.portMax)
		extra.push({ min: endpoints.portMin, max: endpoints.portMax, owner: 'service endpoints' });
	return extra;
}

/** Who on the platform owns `port` on every node; null when an app may use it. */
export function reservedPortOwner(ctx: Pick<CoreContext, 'config' | 'cluster'>, port: number): string | null {
	return platformPortOwner(port, installReservedPorts(ctx));
}

/** Refusal text for an app port the platform owns; null when the port is the app's to take. */
export function appSpecPortProblem(ctx: Pick<CoreContext, 'config' | 'cluster'>, spec: WorkloadSpec): string | null {
	if (spec.runtime === 'compose') return null; // compose route ports are Yoal's, from their own range
	for (const port of appHostPorts(spec)) {
		const problem = appPortProblem(port, installReservedPorts(ctx));
		if (problem) return problem;
	}
	return null;
}

/**
 * Refusal text when `spec` newly takes a port reserved for a later platform feature (HA-PLAN F2);
 * null when it does not. A port the project's workload already holds is allowed, so an app that
 * was on such a port before the reservation keeps deploying on it.
 */
export function laterPortProblem(ctx: Pick<CoreContext, 'db'>, projectId: string, spec: WorkloadSpec): string | null {
	if (spec.runtime === 'compose') return null;
	const ports = appHostPorts(spec).filter((port) => laterPortOwner(port) !== null);
	if (ports.length === 0) return null;
	const row = ctx.db.select({ specJson: workloads.specJson }).from(workloads).where(eq(workloads.projectId, projectId)).get();
	const current = row ? workloadSpecSchema.safeParse(parseJson<unknown>(row.specJson, null)).data : undefined;
	const held = new Set(current ? appHostPorts(current) : []);
	const port = ports.find((candidate) => !held.has(candidate));
	if (port === undefined) return null;
	return `Port ${port} is reserved for ${laterPortOwner(port)} in a coming release. Pick another port for this app (1024 or higher, outside the platform ranges).`;
}

/**
 * Loopback ports held by apps on `nodeId`: a workload placed there, a copy there, or one still
 * serving there while it moves away. `excludeProjectId` leaves the asking project out, so a
 * redeploy never conflicts with itself. Status does not matter: a failed or stopped app keeps its
 * port, because it is restarted on it.
 */
export function nodeAppPortClaims(
	ctx: Pick<CoreContext, 'db'>,
	nodeId: string,
	excludeProjectId?: string | null,
): Map<number, PortHolder> {
	const live = ctx.db
		.select({ id: workloads.id, projectId: workloads.projectId, nodeId: workloads.nodeId, movingFromNodeId: workloads.movingFromNodeId, specJson: workloads.specJson, slug: projects.slug })
		.from(workloads)
		.innerJoin(projects, eq(projects.id, workloads.projectId))
		.where(isNull(projects.deletedAt))
		.all();
	const copyNodes = new Map<string, Set<string>>();
	for (const row of ctx.db.select({ workloadId: workloadReplicas.workloadId, nodeId: workloadReplicas.nodeId }).from(workloadReplicas).all()) {
		const set = copyNodes.get(row.workloadId) ?? new Set<string>();
		set.add(row.nodeId);
		copyNodes.set(row.workloadId, set);
	}
	const claims = new Map<number, PortHolder>();
	for (const row of live) {
		if (row.projectId === excludeProjectId) continue;
		const here = row.nodeId === nodeId || row.movingFromNodeId === nodeId || (copyNodes.get(row.id)?.has(nodeId) ?? false);
		if (!here) continue;
		const spec = workloadSpecSchema.safeParse(parseJson<unknown>(row.specJson, null)).data;
		if (!spec) continue;
		for (const port of appHostPorts(spec)) if (!claims.has(port)) claims.set(port, { projectId: row.projectId, slug: row.slug });
	}
	return claims;
}

/** A free app port near `wanted` on this node (searching upwards first), for the refusal message. */
export function suggestAppPort(
	ctx: Pick<CoreContext, 'config' | 'cluster'>,
	claims: ReadonlyMap<number, PortHolder>,
	wanted: number,
): number | null {
	const extra = installReservedPorts(ctx);
	const free = (port: number) => port >= 1024 && port <= 65_535 && !claims.has(port) && platformPortOwner(port, extra) === null;
	for (let offset = 1; offset <= 2_000; offset++) {
		if (free(wanted + offset)) return wanted + offset;
		if (free(wanted - offset)) return wanted - offset;
	}
	return null;
}

/**
 * Why `spec` cannot hold its ports on `nodeId`; null when it can. `nodeName` is for the message.
 * Platform ports are checked too, so a stored spec from before D225 is caught at deploy time.
 */
export function nodePortConflict(
	ctx: Pick<CoreContext, 'db' | 'config' | 'cluster'>,
	projectId: string,
	spec: WorkloadSpec,
	nodeId: string,
	nodeName: string = nodeId,
): string | null {
	const ports = spec.runtime === 'compose' ? [] : appHostPorts(spec);
	if (ports.length === 0) return null;
	const platform = appSpecPortProblem(ctx, spec);
	if (platform) return platform;
	const claims = nodeAppPortClaims(ctx, nodeId, projectId);
	for (const port of ports) {
		const holder = claims.get(port);
		if (!holder) continue;
		const suggestion = suggestAppPort(ctx, claims, port);
		return `Port ${port} on node "${nodeName}" is already used by "${holder.slug}". Two apps on one node cannot share a port${
			suggestion ? `; port ${suggestion} is free there` : ''
		}. Change this app's port (and make it listen there), or place it on another node.`;
	}
	return null;
}
