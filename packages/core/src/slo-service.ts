import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import {
	databaseAttachments,
	databaseFailoverDrills,
	databaseFailovers,
	databases,
	nodes,
	projects,
	sloObjects,
	storageAttachments,
	workloads,
} from '@yoal/db';
import {
	haLevels,
	projectHaTargetInputSchema,
	sloBurnAlertSchema,
	sloObjectInputSchema,
	type HaLevel,
	type HaTimelineItem,
	type HaTimelineView,
	type HaTargetsView,
	type Permission,
	type Principal,
	type ProjectHaTargetInput,
	type ProjectHaTargetView,
	type SloErrorBudget,
	type SloEvaluation,
	type SloObjectInput,
	type SloObjectView,
	type SloOverview,
	type SloOverviewItem,
} from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { CoreError, NotFoundError, ValidationError } from './errors.ts';
import {
	computeErrorBudget,
	evaluateBurnAlert,
	TelemetrySloSignalSource,
	type SloSignalCounts,
	type SloSignalSource,
} from './slo-evaluation.ts';
import { newId, parseJson } from './util.ts';

type SloRow = typeof sloObjects.$inferSelect;

/** This many minutes below the declared target before `ha.effective_below_target` fires. */
export const EFFECTIVE_BELOW_TARGET_GRACE_MS = 5 * 60_000;

/** `ha_target:<projectId>` in `settings`; no migration because the declaration is one small value. */
const HA_TARGET_PREFIX = 'ha_target:';

const LEVEL_RANK: Record<HaLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

/**
 * W15 SLO objects, the effective-versus-declared HA check and the failover/drill timeline
 * (HA-PLAN §4 W15).
 *
 * SLO reads and writes are gated by `SLO_OBJECTS`; with it off `list` is empty and every write
 * refuses, so no object exists. The effective-level check and the timeline describe placement and
 * history that already exist, so they are always readable and their metrics always render.
 *
 * Evaluation reads the same telemetry the dashboard and `/metrics` read; a blind window is a note,
 * not a healthy ratio. Burn alerts are raised by `sweep()` (the 60 s maintenance sweep), never by a
 * GET, so reading a view has no side effects.
 */
export class SloService {
	/** First time a project was seen below its declared target, for the 5 min grace. */
	readonly #belowSince = new Map<string, number>();

	constructor(
		private readonly ctx: CoreContext,
		private readonly signals: SloSignalSource = new TelemetrySloSignalSource(ctx),
	) {}

	// ------------------------------------------------------------------ SLO objects

	/** Stored SLOs for one project; empty while `SLO_OBJECTS` is off. */
	list(principal: Principal, projectSlug: string): SloObjectView[] {
		const project = this.#project(principal, projectSlug, 'project:read');
		if (!featureEnabled(this.ctx.config, 'SLO_OBJECTS')) return [];
		return this.#rows(project.id).map((row) => this.#view(row));
	}

	/** Create or replace an SLO by name within the project. */
	async upsert(principal: Principal, projectSlug: string, input: SloObjectInput): Promise<SloObjectView> {
		const project = this.#project(principal, projectSlug, 'project:update');
		this.#requireFlag();
		const parsed = sloObjectInputSchema.parse(input);
		const now = this.ctx.now();
		const existing = this.ctx.db
			.select()
			.from(sloObjects)
			.where(and(eq(sloObjects.projectId, project.id), eq(sloObjects.name, parsed.name)))
			.get();
		if (existing) {
			this.ctx.db
				.update(sloObjects)
				.set({
					description: parsed.description,
					indicator: parsed.indicator,
					target: parsed.target,
					windowSeconds: parsed.windowSeconds,
					burnAlertsJson: JSON.stringify(parsed.burnAlerts),
					enabled: parsed.enabled,
					updatedAt: now,
				})
				.where(eq(sloObjects.id, existing.id))
				.run();
			this.#audit(principal, 'slo.update', existing.id, { project: project.slug, name: parsed.name });
			return this.#view(this.#row(existing.id)!);
		}
		const id = newId('slo_');
		this.ctx.db
			.insert(sloObjects)
			.values({
				id,
				orgId: project.orgId,
				projectId: project.id,
				name: parsed.name,
				description: parsed.description,
				indicator: parsed.indicator,
				target: parsed.target,
				windowSeconds: parsed.windowSeconds,
				burnAlertsJson: JSON.stringify(parsed.burnAlerts),
				enabled: parsed.enabled,
				createdBy: principal.userId,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		this.#audit(principal, 'slo.create', id, { project: project.slug, name: parsed.name });
		return this.#view(this.#row(id)!);
	}

	/** Remove one SLO. Missing ids are a 404 so a retried delete is honest. */
	remove(principal: Principal, projectSlug: string, sloId: string): void {
		const project = this.#project(principal, projectSlug, 'project:update');
		this.#requireFlag();
		const row = this.#row(sloId);
		if (!row || row.projectId !== project.id) throw new NotFoundError('SLO');
		this.ctx.db.delete(sloObjects).where(eq(sloObjects.id, sloId)).run();
		this.#audit(principal, 'slo.delete', sloId, { project: project.slug, name: row.name });
	}

	/** Evaluate the SLO over its window and return the error budget and burn-alert state. */
	async evaluate(principal: Principal, projectSlug: string, sloId?: string): Promise<SloEvaluation[]> {
		const project = this.#project(principal, projectSlug, 'project:read');
		this.#requireFlag();
		const rows = sloId
			? [this.#row(sloId)].filter((row): row is SloRow => row !== undefined && row.projectId === project.id)
			: this.#rows(project.id);
		if (sloId && rows.length === 0) throw new NotFoundError('SLO');
		const cache = new Map<string, Promise<SloSignalCounts>>();
		const out: SloEvaluation[] = [];
		for (const row of rows) out.push(await this.#evaluateRow(row, cache));
		return out;
	}

	/** Platform-wide read view for Settings → SLOs; empty while the flag is off. */
	async overview(principal: Principal): Promise<SloOverview> {
		if (!this.ctx.platformIam.canView(principal))
			throw new CoreError('forbidden', 'SLOs are platform-wide here; only platform admins can see every project.', 403);
		const generatedAt = new Date(this.ctx.now()).toISOString();
		if (!featureEnabled(this.ctx.config, 'SLO_OBJECTS')) return { enabled: false, generatedAt, objects: [] };
		const projectRows = this.ctx.db.select().from(projects).where(isNull(projects.deletedAt)).all();
		const byId = new Map(projectRows.map((row) => [row.id, row]));
		const cache = new Map<string, Promise<SloSignalCounts>>();
		const objects: SloOverviewItem[] = [];
		for (const row of this.ctx.db.select().from(sloObjects).orderBy(asc(sloObjects.name)).all()) {
			const project = byId.get(row.projectId);
			if (!project) continue;
			let evaluation: SloEvaluation | null = null;
			try {
				evaluation = await this.#evaluateRow(row, cache);
			} catch {
				// A view never fails because a signal source did; the row stays visible without a budget.
			}
			objects.push({
				...this.#view(row, evaluation?.errorBudget ?? null),
				projectSlug: project.slug,
				projectName: project.name,
				evaluation,
			});
		}
		return { enabled: true, generatedAt, objects };
	}

	// ------------------------------------------------------------------ declared HA target

	/** Every project's declared target and its effective level. Platform-wide read. */
	targets(principal: Principal): HaTargetsView {
		if (!this.ctx.platformIam.canView(principal))
			throw new CoreError('forbidden', 'Effective HA levels are platform-wide; only platform admins can see them.', 403);
		const targets = this.targetsInternal();
		return {
			generatedAt: new Date(this.ctx.now()).toISOString(),
			targets,
			belowTarget: targets.filter((target) => target.belowTarget).length,
		};
	}

	/** One project's declaration, for the project-facing REST surface. */
	haTarget(principal: Principal, projectSlug: string): ProjectHaTargetView {
		const project = this.#project(principal, projectSlug, 'project:read');
		const view = this.targetsInternal().find((target) => target.projectId === project.id);
		if (!view) throw new NotFoundError('Project');
		return view;
	}

	/** Declare (or clear, with null) the level a project says it needs. */
	setHaTarget(principal: Principal, projectSlug: string, input: ProjectHaTargetInput): ProjectHaTargetView {
		const project = this.#project(principal, projectSlug, 'project:update');
		const parsed = projectHaTargetInputSchema.parse(input);
		const key = `${HA_TARGET_PREFIX}${project.id}`;
		if (parsed.target === null) this.ctx.sqlite.run('DELETE FROM settings WHERE key = ?', [key]);
		else
			this.ctx.sqlite.run(
				'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
				[key, parsed.target, this.ctx.now()],
			);
		this.#audit(principal, 'ha.target', project.id, { project: project.slug, target: parsed.target });
		const view = this.targetsInternal().find((target) => target.projectId === project.id);
		if (!view) throw new NotFoundError('Project');
		return view;
	}

	/**
	 * The declaration check without a principal, for `/metrics`. Returns every live project; a
	 * project with no declaration has `belowTarget: false` and `declared: null`.
	 */
	targetsInternal(): ProjectHaTargetView[] {
		const projectRows = this.ctx.db.select().from(projects).where(isNull(projects.deletedAt)).all();
		if (projectRows.length === 0) return [];
		const levels = this.ctx.topology.resourceLevels();
		const workloadRows = this.ctx.db.select({ id: workloads.id, projectId: workloads.projectId }).from(workloads).all();
		const databaseRows = this.ctx.db
			.select({ id: databaseAttachments.databaseId, projectId: databaseAttachments.projectId })
			.from(databaseAttachments)
			.all();
		const storageRows = this.ctx.db
			.select({ id: storageAttachments.storageId, projectId: storageAttachments.projectId })
			.from(storageAttachments)
			.all();
		const declarations = new Map(
			this.ctx.sqlite
				.query<{ key: string; value: string }, []>(`SELECT key, value FROM settings WHERE key LIKE '${HA_TARGET_PREFIX}%'`)
				.all()
				.map((row) => [row.key.slice(HA_TARGET_PREFIX.length), row.value]),
		);

		return projectRows.map((project) => {
			const assessments = [
				...workloadRows.filter((row) => row.projectId === project.id).flatMap((row) => levels.workloads.get(row.id) ?? []),
				...databaseRows.filter((row) => row.projectId === project.id).flatMap((row) => levels.databases.get(row.id) ?? []),
				...storageRows.filter((row) => row.projectId === project.id).flatMap((row) => levels.storage.get(row.id) ?? []),
			];
			const weakest = assessments.reduce<{ level: HaLevel; blockers: string[] } | null>((lowest, assessment) => {
				if (!lowest) return assessment;
				if (LEVEL_RANK[assessment.level] < LEVEL_RANK[lowest.level]) return assessment;
				if (LEVEL_RANK[assessment.level] === LEVEL_RANK[lowest.level])
					return { level: lowest.level, blockers: [...new Set([...lowest.blockers, ...assessment.blockers])] };
				return lowest;
			}, null);
			const declaredRaw = declarations.get(project.id);
			const declared = (haLevels as readonly string[]).includes(declaredRaw ?? '') ? (declaredRaw as HaLevel) : null;
			const effective = weakest?.level ?? null;
			return {
				projectId: project.id,
				slug: project.slug,
				name: project.name,
				declared,
				effective,
				belowTarget:
					declared !== null && effective !== null && LEVEL_RANK[effective] < LEVEL_RANK[declared],
				blockers: weakest?.blockers.slice(0, 10) ?? [],
			};
		});
	}

	// ------------------------------------------------------------------ timeline

	/** Failovers, switchovers and drills in one newest-first timeline. */
	timeline(principal: Principal, options: { limit?: number } = {}): HaTimelineView {
		if (!this.ctx.platformIam.canView(principal))
			throw new CoreError('forbidden', 'The failover timeline is platform-wide; only platform admins can see it.', 403);
		const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 100)));
		const databaseRows = this.ctx.db.select().from(databases).all();
		const databaseById = new Map(databaseRows.map((row) => [row.id, row]));
		const nodeNames = new Map(this.ctx.db.select({ id: nodes.id, name: nodes.name }).from(nodes).all().map((row) => [row.id, row.name]));
		const iso = (value: number | null | undefined): string | null => (value == null ? null : new Date(value).toISOString());
		const items: HaTimelineItem[] = [];

		for (const row of this.ctx.db
			.select()
			.from(databaseFailovers)
			.orderBy(desc(databaseFailovers.startedAt))
			.limit(limit)
			.all()) {
			const database = databaseById.get(row.databaseId);
			const end = row.promotionSucceededAt ?? (row.status === 'completed' ? row.finishedAt : null);
			items.push({
				id: row.id,
				source: 'failover',
				kind: row.kind === 'switchover' ? 'switchover' : 'failover',
				databaseId: row.databaseId,
				databaseName: database?.name ?? null,
				status: row.status,
				durability: database?.durabilityEffective ?? null,
				promotionSource: row.promotionSource,
				fromNodeId: row.fromNodeId,
				fromNodeName: row.fromNodeId ? (nodeNames.get(row.fromNodeId) ?? null) : null,
				toNodeId: row.toNodeId,
				toNodeName: nodeNames.get(row.toNodeId) ?? null,
				generation: row.generation,
				startedAt: new Date(row.startedAt).toISOString(),
				finishedAt: iso(row.finishedAt),
				timeToWritableMs: end === null ? null : Math.max(0, end - row.startedAt),
				// A failover does not measure lost commits; only a drill does.
				lostCommits: null,
				arbiterTested: null,
				message: row.message,
			});
		}
		for (const row of this.ctx.db
			.select()
			.from(databaseFailoverDrills)
			.orderBy(desc(databaseFailoverDrills.startedAt))
			.limit(limit)
			.all()) {
			const database = databaseById.get(row.databaseId);
			items.push({
				id: row.id,
				source: 'drill',
				kind: 'drill',
				databaseId: row.databaseId,
				databaseName: database?.name ?? null,
				status: row.status,
				durability: row.durability,
				promotionSource: 'drill',
				fromNodeId: row.fromNodeId,
				fromNodeName: row.fromNodeId ? (nodeNames.get(row.fromNodeId) ?? null) : null,
				toNodeId: row.toNodeId,
				toNodeName: row.toNodeId ? (nodeNames.get(row.toNodeId) ?? null) : null,
				generation: row.generation,
				startedAt: new Date(row.startedAt).toISOString(),
				finishedAt: iso(row.finishedAt),
				timeToWritableMs: row.timeToWritableMs,
				lostCommits: row.lostCommits,
				arbiterTested: row.arbiterTested ? true : false,
				message: row.message,
			});
		}
		items.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || a.id.localeCompare(b.id));
		return { generatedAt: new Date(this.ctx.now()).toISOString(), items: items.slice(0, limit) };
	}

	// ------------------------------------------------------------------ sweep (alerts)

	/**
	 * The maintenance sweep: raise `ha.effective_below_target` after its grace, and SLO burn alerts
	 * for every firing multi-window alert. Returns the alert keys it delivered, like the other
	 * maintenance alert passes. Flag-off SLOs are a no-op; the target check always runs.
	 */
	async sweep(): Promise<string[]> {
		const fired: string[] = [];
		const now = this.ctx.now();
		const below = new Set<string>();
		for (const target of this.targetsInternal()) {
			if (!target.belowTarget) continue;
			below.add(target.projectId);
			const since = this.#belowSince.get(target.projectId) ?? now;
			this.#belowSince.set(target.projectId, since);
			if (now - since < EFFECTIVE_BELOW_TARGET_GRACE_MS) continue;
			const key = `ha.effective_below_target:${target.projectId}`;
			const raised = await this.#alert(
				key,
				`HA level below target: ${target.name}`,
				`Project "${target.name}" declares ${target.declared} but its weakest resource is ${target.effective}.` +
					(target.blockers.length > 0 ? ` ${target.blockers.join('; ')}` : ''),
				'warning',
			);
			if (raised) fired.push(key);
		}
		for (const projectId of this.#belowSince.keys()) if (!below.has(projectId)) this.#belowSince.delete(projectId);
		if (!featureEnabled(this.ctx.config, 'SLO_OBJECTS')) return fired;

		const cache = new Map<string, Promise<SloSignalCounts>>();
		const projectNames = new Map(this.ctx.db.select({ id: projects.id, name: projects.name }).from(projects).all().map((row) => [row.id, row.name]));
		for (const row of this.ctx.db.select().from(sloObjects).where(eq(sloObjects.enabled, true)).all()) {
			let evaluation: SloEvaluation;
			try {
				evaluation = await this.#evaluateRow(row, cache);
			} catch (error) {
				console.error(`[slo] evaluation for ${row.id} failed:`, error);
				continue;
			}
			for (const [index, alert] of evaluation.burnAlerts.entries()) {
				if (!alert.firing) continue;
				const key = `ha.slo_burn:${row.id}:${alert.severity}:${row.windowSeconds}:${index}`;
				const raised = await this.#alert(
					key,
					`SLO burning: ${row.name}`,
					`SLO "${row.name}" in project "${projectNames.get(row.projectId) ?? row.projectId}" ` +
						`observed a burn rate of ${alert.observedBurnRate.toFixed(2)}× against a ` +
						`${alert.burnRate}× threshold (target ${(row.target * 100).toFixed(3)}%).`,
					alert.severity,
				);
				if (raised) fired.push(key);
			}
		}
		return fired;
	}

	// ------------------------------------------------------------------ internals

	async #evaluateRow(row: SloRow, cache: Map<string, Promise<SloSignalCounts>>): Promise<SloEvaluation> {
		const now = this.ctx.now();
		const startsAt = new Date(now - row.windowSeconds * 1_000).toISOString();
		const endsAt = new Date(now).toISOString();
		const alerts = this.#burnAlerts(row);
		if (!row.enabled) {
			return {
				sloId: row.id,
				evaluatedAt: endsAt,
				window: { startsAt, endsAt },
				errorBudget: { total: Math.max(0, 1 - row.target), consumed: 0, remaining: 1, burnRate: 0 },
				burnAlerts: alerts.map((alert) => ({ severity: alert.severity, burnRate: alert.burnRate, observedBurnRate: 0, firing: false })),
				note: 'SLO is disabled.',
			};
		}
		const count = (fromMs: number, toMs: number) => {
			const key = `${row.indicator}\u0000${row.projectId}\u0000${fromMs}\u0000${toMs}`;
			let pending = cache.get(key);
			if (!pending) {
				pending = this.signals.counts(row.indicator, row.projectId, fromMs, toMs);
				cache.set(key, pending);
			}
			return pending;
		};
		const notes = new Set<string>();
		const full = await count(now - row.windowSeconds * 1_000, now);
		if (full.note) notes.add(full.note);
		const errorBudget: SloErrorBudget = computeErrorBudget({ target: row.target, good: full.good, total: full.total });
		const burnAlerts = [];
		for (const alert of alerts) {
			const long = await count(now - alert.windowSeconds * 1_000, now);
			const short =
				alert.shortWindowSeconds === null ? null : await count(now - alert.shortWindowSeconds * 1_000, now);
			if (long.note) notes.add(long.note);
			burnAlerts.push(evaluateBurnAlert(alert, row.target, long, short));
		}
		return {
			sloId: row.id,
			evaluatedAt: endsAt,
			window: { startsAt, endsAt },
			errorBudget,
			burnAlerts,
			note: notes.size > 0 ? [...notes].join('; ').slice(0, 1_000) : null,
		};
	}

	#burnAlerts(row: SloRow) {
		const parsed = sloBurnAlertSchema.array().safeParse(parseJson<unknown>(row.burnAlertsJson, []));
		return parsed.success ? parsed.data : [];
	}

	#rows(projectId: string): SloRow[] {
		return this.ctx.db.select().from(sloObjects).where(eq(sloObjects.projectId, projectId)).orderBy(asc(sloObjects.name)).all();
	}

	#row(id: string): SloRow | undefined {
		return this.ctx.db.select().from(sloObjects).where(eq(sloObjects.id, id)).get();
	}

	#view(row: SloRow, errorBudget: SloErrorBudget | null = null): SloObjectView {
		return {
			id: row.id,
			orgId: row.orgId,
			projectId: row.projectId,
			name: row.name,
			description: row.description,
			indicator: row.indicator,
			target: row.target,
			windowSeconds: row.windowSeconds,
			burnAlerts: this.#burnAlerts(row),
			enabled: row.enabled,
			createdBy: row.createdBy,
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
			errorBudget,
		};
	}

	#requireFlag(): void {
		if (!featureEnabled(this.ctx.config, 'SLO_OBJECTS'))
			throw new CoreError('unavailable', 'SLO objects are off: enable SLO_OBJECTS first (HA-PLAN W15).', 409);
	}

	#audit(principal: Principal, action: string, resourceId: string, args: Record<string, unknown>): void {
		this.ctx.audit.record({ principal, action, resource: 'slo', resourceId, args, result: 'ok' });
	}

	#project(principal: Principal, projectSlug: string, permission: Permission) {
		const project = this.ctx.projects.requireRow(principal, projectSlug);
		this.ctx.iam.require(principal, permission, { type: 'project', id: project.id });
		return project;
	}

	/**
	 * Deliver one system alert through its kind's routing, with the platform's repeat cooldown.
	 * Returns false when the kind is off or the alert is inside its cooldown.
	 */
	async #alert(key: string, title: string, detail: string, severity: 'info' | 'warning' | 'critical'): Promise<boolean> {
		if (!this.ctx.alerts.systemRoute(key)) return false;
		const now = this.ctx.now();
		const last = this.ctx.sqlite
			.query<{ last_fired_at: number | null }, [string]>('SELECT last_fired_at FROM alert_state WHERE key = ?')
			.get(key);
		const cooldown = this.ctx.policies.get().systemAlertRepeatMinutes * 60_000;
		if (last?.last_fired_at && now - last.last_fired_at < cooldown) return false;
		this.ctx.sqlite.run(
			'INSERT INTO alert_state (key, last_fired_at, last_value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET last_fired_at = excluded.last_fired_at, last_value = excluded.last_value',
			[key, now, detail],
		);
		await this.ctx.alerts.deliverSystem({ key, title, detail, severity });
		return true;
	}
}

/** Validate a declared target; exported so a CLI/REST caller fails with the same words. */
export function parseHaTarget(input: unknown): ProjectHaTargetInput {
	const parsed = projectHaTargetInputSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError('Use one of L0, L1, L2, L3, or null to clear.', parsed.error.issues);
	return parsed.data;
}
