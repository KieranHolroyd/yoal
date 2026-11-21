import { asc, eq } from 'drizzle-orm';
import { sloObjects } from '@yoal/db';
import {
	sloBurnAlertSchema,
	type Permission,
	type Principal,
	type SloEvaluation,
	type SloObjectInput,
	type SloObjectView,
} from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { CoreError } from './errors.ts';
import { parseJson } from './util.ts';

type SloRow = typeof sloObjects.$inferSelect;

/**
 * W15 SLO objects: target, rolling window, derived error budget and burn alerts (HA-PLAN W15).
 *
 * `list` is a real read so the dashboard can show an empty or stored policy while the flag is off.
 * `upsert` and `evaluate` are lane B's; they refuse loudly until the evaluator exists, so no surface
 * records an SLO that nothing measures.
 */
export class SloService {
	constructor(private readonly ctx: CoreContext) {}

	/** Stored SLOs for one project; empty while `SLO_OBJECTS` is off. */
	list(principal: Principal, projectSlug: string): SloObjectView[] {
		const project = this.#project(principal, projectSlug, 'project:read');
		if (!featureEnabled(this.ctx.config, 'SLO_OBJECTS')) return [];
		return this.ctx.db
			.select()
			.from(sloObjects)
			.where(eq(sloObjects.projectId, project.id))
			.orderBy(asc(sloObjects.name))
			.all()
			.map((row) => this.#view(row));
	}

	/** Create or replace an SLO object. Lane B owns the write and the burn-alert validation. */
	async upsert(principal: Principal, projectSlug: string, _input: SloObjectInput): Promise<SloObjectView> {
		const project = this.#project(principal, projectSlug, 'project:update');
		if (!featureEnabled(this.ctx.config, 'SLO_OBJECTS'))
			throw new CoreError('unavailable', 'SLO objects are off: enable SLO_OBJECTS first (HA-PLAN W15).', 409);
		throw new CoreError(
			'conflict',
			`not implemented (HA Wave 4 lane B): SLO upsert for project "${project.slug}"`,
			409,
		);
	}

	/** Evaluate the SLO over its window and return the error budget and burn-alert state. */
	async evaluate(principal: Principal, projectSlug: string, sloId?: string): Promise<SloEvaluation[]> {
		const project = this.#project(principal, projectSlug, 'project:read');
		if (!featureEnabled(this.ctx.config, 'SLO_OBJECTS'))
			throw new CoreError('unavailable', 'SLO objects are off: enable SLO_OBJECTS first (HA-PLAN W15).', 409);
		throw new CoreError(
			'conflict',
			`not implemented (HA Wave 4 lane B): SLO evaluation for project "${project.slug}"${sloId ? ` (${sloId})` : ''}`,
			409,
		);
	}

	#view(row: SloRow): SloObjectView {
		const parsed = sloBurnAlertSchema.array().safeParse(parseJson<unknown>(row.burnAlertsJson, []));
		return {
			id: row.id,
			orgId: row.orgId,
			projectId: row.projectId,
			name: row.name,
			description: row.description,
			indicator: row.indicator,
			target: row.target,
			windowSeconds: row.windowSeconds,
			burnAlerts: parsed.success ? parsed.data : [],
			enabled: row.enabled,
			createdBy: row.createdBy,
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
			errorBudget: null,
		};
	}

	#project(principal: Principal, projectSlug: string, permission: Permission) {
		const project = this.ctx.projects.requireRow(principal, projectSlug);
		this.ctx.iam.require(principal, permission, { type: 'project', id: project.id });
		return project;
	}
}
