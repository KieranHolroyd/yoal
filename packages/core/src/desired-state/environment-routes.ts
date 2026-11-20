import { inArray } from 'drizzle-orm';
import { environments } from '@yoal/db';
import { effectiveAccessMode } from '../access.ts';
import { DesiredStatePart } from './context.ts';
import { loginUrlFor, type DeploymentRoutes } from './routes.ts';

export type EnvironmentRow = typeof environments.$inferSelect;

export interface EnvironmentRoutes {
	/** Projects with a production pointer: the only candidates for custom domains. */
	productionProjectIds: Set<string>;
	environmentsByProject: Map<string, EnvironmentRow[]>;
}

/** Routes and site config: each environment's host, and a compose stack's extra service hosts. */
export class EnvironmentRouteState extends DesiredStatePart {
	/** Appends every environment route to `deployment.routes`. */
	environmentRoutes(deployment: DeploymentRoutes): EnvironmentRoutes {
		const { node, nodeById, targetOf, projectRows } = this.state;
		const { routes, baseByDeployment, composeByDeployment, accessEdge } = deployment;

		// Every environment with a pointer gets its own production route at the environment host
		// (`<slug>.<domain>` for production, `<slug>--<env>.<domain>` otherwise, D13/D14). The v1
		// flow is the production-only case of this, so behaviour there is unchanged.
		const environmentRows =
			projectRows.length > 0
				? this.ctx.db
						.select()
						.from(environments)
						.where(inArray(environments.projectId, projectRows.map((project) => project.id)))
						.all()
				: [];
		const environmentsByProject = new Map<string, typeof environmentRows>();
		for (const row of environmentRows) {
			const list = environmentsByProject.get(row.projectId) ?? [];
			list.push(row);
			environmentsByProject.set(row.projectId, list);
		}
		const productionProjectIds = new Set<string>();
		for (const project of projectRows) {
			const rows = environmentsByProject.get(project.id) ?? [];
			const seen = new Set(rows.map((row) => row.slug));
			const candidates = [...rows];
			// A project predating the environments table (or one whose production row was never
			// materialised) still serves from the project pointer.
			if (!seen.has('production') && project.productionDeploymentId)
				candidates.push({
					id: `implicit_${project.id}`,
					orgId: project.orgId,
					projectId: project.id,
					name: 'Production',
					slug: 'production',
					isProduction: true,
					access: project.productionAccess,
					accessPolicyId: project.productionAccessPolicyId ?? null,
					passwordHash: null,
					deploymentId: project.productionDeploymentId,
					createdAt: project.createdAt,
					updatedAt: project.updatedAt,
				});
			for (const environment of candidates) {
				const deploymentId =
					environment.isProduction && !environment.deploymentId
						? project.productionDeploymentId
						: environment.deploymentId;
				if (!deploymentId) continue;
				const base = baseByDeployment.get(deploymentId);
				if (!base) continue;
				const environmentPolicyId = environment.isProduction
					? (project.productionAccessPolicyId ?? null)
					: (environment.accessPolicyId ?? null);
				const accessMode = effectiveAccessMode(
					environment.isProduction ? project.productionAccess : environment.access,
					environmentPolicyId,
				);
				routes.push({
					...base,
					host: this.ctx.environments.hostFor(project, environment),
					production: true,
					accessMode,
					access: {
						mode: accessMode,
						siteKey: this.ctx.access.siteKeyFor(project, environmentPolicyId),
						loginUrl: loginUrlFor(this.ctx.config.platformOrigin, accessMode, project.id),
						policyId: environmentPolicyId,
						...accessEdge(environmentPolicyId),
					},
				});
				// Compose: every other exposed service gets its own host on the production pointer.
				// The project's own host always serves the primary route; a service's declared host
				// must be a single label under the content domain so the wildcard certificate covers
				// it. Per-service custom domains are a later, verified surface.
				const compose = environment.isProduction ? composeByDeployment.get(deploymentId) : undefined;
				if (compose) {
					const target = targetOf(project) ?? node.id;
					const local = target === node.id;
					const nodeUpstream = `http://${nodeById.get(target)?.publicAddress ?? '127.0.0.1:1'}`;
					const primary = compose.routes.find((route) => route.primary) ?? compose.routes[0];
					const projectHost = this.ctx.environments.hostFor(project, environment);
					for (const route of compose.routes) {
						const declared = route.host?.toLowerCase().replace(/\.$/, '');
						const underContent = declared?.endsWith(`.${this.ctx.config.contentDomain.toLowerCase()}`);
						const host =
							declared && underContent && !declared.slice(0, -(this.ctx.config.contentDomain.length + 1)).includes('.')
								? declared
								: `${project.slug}--${route.service}.${this.ctx.config.contentDomain}`;
						if (route === primary && (!declared || host === projectHost)) continue;
						routes.push({
							...base,
							host,
							production: true,
							accessMode,
							upstream: local && route.hostPort ? `127.0.0.1:${route.hostPort}` : nodeUpstream,
							healthPath: route.healthPath,
							access: {
								mode: accessMode,
								siteKey: this.ctx.access.siteKeyFor(project, environmentPolicyId),
								loginUrl: loginUrlFor(this.ctx.config.platformOrigin, accessMode, project.id),
								policyId: environmentPolicyId,
								...accessEdge(environmentPolicyId),
							},
						});
					}
				}
				if (environment.isProduction) productionProjectIds.add(project.id);
			}
		}
		return { productionProjectIds, environmentsByProject };
	}
}
