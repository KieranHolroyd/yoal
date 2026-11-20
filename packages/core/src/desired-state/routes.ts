import { and, eq, sql } from 'drizzle-orm';
import { deployments, releases, slugRedirects, workloads } from '@yoal/db';
import {
	UNAVAILABLE_UPSTREAM,
	contentUrl,
	workloadReplicaId,
	workloadSpecSchema,
	type ComposeSpec,
	type DesiredState,
	type RouteAccess,
	type RouteSpec,
	type WorkloadSpec,
} from '@yoal/contracts';
import type { ParsedConfig } from '@yoal/site-config';
import type { CoreContext } from '../context.ts';
import { effectiveRuntime } from '../runtime-tier.ts';
import { reservedPortOwner } from '../host-ports.ts';
import { upstreamFor } from '../workloads.ts';
import { routeBlockReason, tcpPortWinners } from '../route-guard.ts';
import { effectiveAccessMode } from '../access.ts';
import { parseJson } from '../util.ts';
import { DesiredStatePart } from './context.ts';
import { IngressState } from './ingress.ts';
import { ReleaseState } from './releases.ts';

/** A route without its host and access, shared by a deployment's preview and environment routes. */
export type RouteBase = Omit<RouteSpec, 'host' | 'access' | 'accessMode'>;
/** The edge-only part of a route's access block, read once per policy per pull. */
export type AccessEdge = (policyId: string | null) => Pick<RouteAccess, 'policyEnabled' | 'serviceTokens' | 'hasPersonRules'>;

export interface DeploymentRoutes {
	routes: RouteSpec[];
	/** Releases this node must hold. */
	releaseShas: Set<string>;
	/** Projects that serve HTTP at all (everything but workers); candidates for a default page. */
	siteProjectIds: Set<string>;
	/** Route body per deployment, reused for that deployment's preview and environment routes. */
	baseByDeployment: Map<string, RouteBase>;
	/** Compose stacks per deployment: extra service hosts are emitted for the production pointer. */
	composeByDeployment: Map<string, ComposeSpec>;
	accessEdge: AccessEdge;
}

/**
 * Where an unauthenticated visitor goes. Yoal Access has its own platform endpoint because it must
 * evaluate a policy and may redirect to an IdP or user pool before handing back a host-bound code.
 */
export function loginUrlFor(platformOrigin: string, mode: string, projectId: string): string {
	return mode === 'access'
		? `${platformOrigin}/api/v1/access/authorize?project=${projectId}`
		: `${platformOrigin}/_yoal/site-login?project=${projectId}`;
}

/** Routes and site config: every active deployment's preview route and the route body it shares. */
export class RouteState extends DesiredStatePart {
	/** Every deployment of every project this node serves gets its immutable preview URL. */
	deploymentRoutes(): DeploymentRoutes {
		const { node, nodeById, arrivingHere, targetOf, projectRows, holdsCopy } = this.state;
		const routes: RouteSpec[] = [];
		/**
		 * The edge-only part of each policy (service tokens, whether a person could still match and
		 * whether the policy is enabled), read once per pull and shared by every route using it.
		 */
		const edgeSettings = new Map<string, ReturnType<CoreContext['accessPolicies']['edgeSettings']>>();
		const accessEdge = (policyId: string | null) => {
			if (!policyId) return {};
			let settings = edgeSettings.get(policyId);
			if (!settings) {
				settings = this.ctx.accessPolicies.edgeSettings(policyId);
				edgeSettings.set(policyId, settings);
			}
			return {
				policyEnabled: settings.enabled,
				serviceTokens: settings.serviceTokens,
				hasPersonRules: settings.hasPersonRules,
			};
		};
		const releaseShas = new Set<string>();
		/** Route body per deployment, reused for that deployment's preview and environment routes. */
		const baseByDeployment = new Map<string, Omit<RouteSpec, 'host' | 'access' | 'accessMode'>>();
		/** Compose stacks per deployment: extra service hosts are emitted for the production pointer. */
		const composeByDeployment = new Map<string, import('@yoal/contracts').ComposeSpec>();
		const workloadByProject = new Map(
			this.ctx.db
				.select()
				.from(workloads)
				.all()
				.filter((row) => row.nodeId === node.id || row.movingFromNodeId === node.id || holdsCopy(row.projectId))
				.map((row) => [row.projectId, row]),
		);
		const ingress = new IngressState(this.state);
		const releaseState = new ReleaseState(this.state);

		// Which app owns each loopback port on this node; any other claimant is not routed (D225).
		const portWinners = tcpPortWinners([...workloadByProject.values()]);
		/** Projects that serve HTTP at all (everything but workers); candidates for a default page. */
		const siteProjectIds = new Set<string>();
		for (const project of projectRows) {
			const target = targetOf(project) ?? node.id;
			const local = target === node.id;
			const workload = workloadByProject.get(project.id);
			// Parse the project's saved spec once: the worker test and a function route both need it.
			const spec = workloadSpecOf(project);
			// Workers (plan 21) have no route at all: no preview URL, no environment host. Their
			// release is app code or a template manifest and must never be served as a static site;
			// a process worker on this node still needs the release itself.
			if (isWorkerProject(project, spec)) {
				if (local && effectiveRuntime(project) === 'process') {
					releaseState.addWorkerReleases(project.id, releaseShas);
				}
				continue;
			}
			siteProjectIds.add(project.id);
			// The last check before Caddy (D225): a local app route proxies only to its own running
			// listener. Never to a port another app or the platform holds, and never by serving the
			// app's release (its source) as static files while it has no upstream.
			const block = local
				? routeBlockReason({
						runtime: effectiveRuntime(project),
						workload: workload ?? null,
						portWinners,
						reserved: (port) => reservedPortOwner(this.ctx, port),
					})
				: null;
			// Apps proxy to the workload on their node; the edge reaches a worker's Caddy over WireGuard.
			const upstream = block
				? UNAVAILABLE_UPSTREAM
				: effectiveRuntime(project) !== 'static' && local
					? (workload?.upstream ?? null)
					: local
						? null
						: `http://${this.state.proxyAddress(target) ?? '127.0.0.1:1'}`;
			const rows = this.ctx.db
				.select()
				.from(deployments)
				.where(and(eq(deployments.projectId, project.id), eq(deployments.status, 'active')))
				.all();
			for (const deployment of rows) {
				const release = this.ctx.db.select().from(releases).where(eq(releases.id, deployment.releaseId)).get();
				if (!release) continue;
				if (local || arrivingHere.has(project.id)) releaseShas.add(release.sha256);
				const config = this.configFor(deployment.configSnapshotId);
				// A function's assets are part of *this deployment's* snapshot (rollback restores it),
				// and they live in the release, so only the node holding the release serves them. The
				// edge has no release and proxies here like any other worker-placed site (D110).
				const deploymentSpec = workloadSpecOf({ workloadJson: deployment.workloadJson });
				// A function dials its own socket (phase 4). Replica 0 keeps the workload id, so a
				// single-host function uses `<workload-id>.sock`, matching the helper's socket unit.
				// Read from this deployment's snapshot, so a rollback restores its own upstream.
				const functionUpstream =
					local && workload && deploymentSpec?.runtime === 'function'
						? upstreamFor(workload.id, deploymentSpec)
						: null;
				const functionRoute =
					local && deploymentSpec?.runtime === 'function'
						? {
								function: {
									assetsDirectory: deploymentSpec.function?.assets?.directory ?? null,
									runWorkerFirst: deploymentSpec.function?.assets?.runWorkerFirst ?? [],
									// Phase 4: a stateless function with `replicas > 1` gets one socket per
									// replica, in order, and the node's Caddy balances across them. Omitted
									// for a single host, so that route is byte-identical to phase 1.
									...(workload && deploymentSpec.replicas > 1
										? {
												upstreams: Array.from({ length: deploymentSpec.replicas }, (_, index) =>
													upstreamFor(workloadReplicaId(workload.id, index), deploymentSpec),
												),
											}
										: {}),
								},
							}
						: {};
				const { everyCopyNode, replicaUpstreams } = ingress.copyUpstreams(project.id, block ? null : (functionUpstream ?? upstream));
				const base = {
					projectId: project.id,
					slug: project.slug,
					deploymentId: deployment.id,
					release: release.sha256,
					spa: config.config.spa,
					cleanUrls: config.config.cleanUrls,
					trailingSlash: config.config.trailingSlash,
					notFound: config.config.notFound,
					redirects: config.redirects,
					headers: config.headers,
					upstream: functionUpstream ?? upstream,
					...(block && !(replicaUpstreams.length > 0 && everyCopyNode.length > 1) ? { unavailable: block } : {}),
					// HA-PLAN H25: the edge's active check uses readiness when the app sets one;
					// `healthPath` stays the liveness path. Omitted when unset, so flag-off desired
					// state is byte-for-byte unchanged.
					...(deploymentSpec?.readinessPath ? { readinessPath: deploymentSpec.readinessPath } : {}),
					...(replicaUpstreams.length > 0 && everyCopyNode.length > 1
						? {
							upstreams: replicaUpstreams,
							...(deploymentSpec?.healthPath
								? {
										healthPath: deploymentSpec.healthPath,
										healthIntervalSeconds: this.ctx.cluster.get().replicas.healthIntervalSeconds,
									}
								: {}),
						}
						: everyCopyNode.length > 1 && everyCopyNode.includes(node.id) && deploymentSpec?.healthPath
							? // A node holding one copy of a spread app: ingresses probe this path through its
								// Caddy with no session, so a protected route must know it (F7).
								{ healthPath: deploymentSpec.healthPath }
							: {}),
					...functionRoute,
				} satisfies Omit<RouteSpec, 'host' | 'access' | 'accessMode'>;
				baseByDeployment.set(deployment.id, base);
				if (deploymentSpec?.compose) composeByDeployment.set(deployment.id, deploymentSpec.compose);

				// Every deployment always gets its immutable preview URL, whatever its environment.
				const previewPolicyId = project.previewAccessPolicyId ?? null;
				const previewAccessMode = effectiveAccessMode(project.previewAccess, previewPolicyId);
				routes.push({
					...base,
					host: deployment.previewHost,
					production: false,
					accessMode: previewAccessMode,
					access: {
						mode: previewAccessMode,
						siteKey: this.ctx.access.siteKeyFor(project, previewPolicyId),
						loginUrl: loginUrlFor(this.ctx.config.platformOrigin, previewAccessMode, project.id),
						policyId: previewPolicyId,
						...accessEdge(previewPolicyId),
					},
				});
			}
		}
		return { routes, releaseShas, siteProjectIds, baseByDeployment, composeByDeployment, accessEdge };
	}

	/** Old slugs redirect to the project's production URL until they expire. */
	hostRedirects(): DesiredState['hostRedirects'] {
		const { now, projectRows } = this.state;
		const productionUrl = (slug: string) =>
			contentUrl(this.ctx.config.platformOrigin, `${slug}.${this.ctx.config.contentDomain}`);

		return this.ctx.db
			.select({ fromSlug: slugRedirects.fromSlug, projectId: slugRedirects.projectId })
			.from(slugRedirects)
			.where(sql`${slugRedirects.expiresAt} > ${now}`)
			.all()
			.flatMap((row) => {
				const target = projectRows.find((project) => project.id === row.projectId);
				return target
					? [
							{
								host: `${row.fromSlug}.${this.ctx.config.contentDomain}`,
								to: productionUrl(target.slug),
							},
						]
					: [];
			});
	}

	private configFor(snapshotId: string): ParsedConfig {
		const row = this.ctx.sqlite
			.query<{ site_config_json: string }, [string]>('SELECT site_config_json FROM config_snapshots WHERE id = ?')
			.get(snapshotId);
		return parseJson<ParsedConfig>(row?.site_config_json, {
			config: { spa: false, cleanUrls: false, trailingSlash: 'ignore', notFound: null },
			redirects: [],
			headers: [],
		});
	}
}

/** The project's saved workload spec, or null when it has none (or it does not parse). */
function workloadSpecOf(project: { workloadJson: string | null }): WorkloadSpec | null {
	if (!project.workloadJson) return null;
	const spec = workloadSpecSchema.safeParse(parseJson<unknown>(project.workloadJson, null));
	return spec.success ? spec.data : null;
}

/** A project whose current spec is a worker (`ingress: "none"`, plan 21): it gets no route. */
function isWorkerProject(
	project: { runtime: string; runtimeName?: string | null },
	spec: WorkloadSpec | null,
): boolean {
	if (effectiveRuntime(project) === 'static') return false;
	return spec?.ingress === 'none';
}
