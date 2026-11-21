import {
	HA_DRILL_CATALOGUE,
	featureEnvKey,
	haDrillAllRequestSchema,
	haDrillConfirmationIssue,
	haDrillLevelIssue,
	haDrillRunRequestSchema,
	haDrillScenario,
	planHaDrillAll,
	type FeatureFlags,
	type HaDrillAllRequest,
	type HaDrillAllView,
	type HaDrillCatalogueView,
	type HaDrillMeasured,
	type HaDrillResourceKind,
	type HaDrillRunRequest,
	type HaDrillRunStatus,
	type HaDrillRunView,
	type HaDrillScenario,
	type HaDrillScenarioId,
	type HaLevel,
	type NodeDrillStartRequest,
	type NodeDrillView,
	type Principal,
} from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { newId } from './util.ts';

interface HaDrillRow {
	id: string;
	scenario: string;
	resource_kind: string;
	resource_id: string;
	resource_name: string;
	status: HaDrillRunStatus;
	record_id: string | null;
	batch_id: string | null;
	started_at: number | null;
	finished_at: number | null;
	rto_ms: number | null;
	lost_commits: number | null;
	lag_bytes: number | null;
	failed_requests: number | null;
	refused: number | null;
	message: string | null;
	created_by: string;
	created_at: number;
}

interface Resource {
	kind: HaDrillResourceKind;
	id: string;
	name: string;
}

const LEVEL_RANK: Readonly<Record<HaLevel, number>> = { L0: 0, L1: 1, L2: 2, L3: 3 };
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const emptyMeasured = (): HaDrillMeasured => ({ rtoMs: null, lostCommits: null, lagBytes: null, failedRequests: null, refused: null });

/** Why the two `release-*` scenarios have no fleet path yet (said, never faked). */
const RELEASE_DRILL_GAP =
	'The runner has no fleet path for this drill yet: it needs a deploy of a release built to fail, and the runner does not create one on a live project. The lab runs it (tests/lab, the W5 release-phase scenarios).';

/**
 * `yoal ha drill <scenario> --resource <id>` and `yoal ha drill --all` (HA-PLAN H27, §7.2, §10,
 * W14; Wave 5 lane B).
 *
 * `run` checks `platform:ha` (the rule the D235 drill already uses; the platform-operator role holds
 * it too), refuses a lab-only scenario on a fleet with its reason, then the scenario's flags, its
 * confirmation (`haDrillConfirmationIssue`: the resource is always named and the name is typed back
 * for a destructive one) and its HA level (`haDrillLevelIssue`, §10), and only then acts:
 * - `node-offline` and `ingress-offline` hand the named node to `NodeDrillService.start` (D235);
 *   the typed name is the control-node opt-in;
 * - `database-failover` hands the database and its disposable copy to
 *   `DatabaseFailoverPolicyService.drill` (W11), unchanged;
 * - `stale-generation-promote` asks for a promotion at a generation that is not the database's
 *   (`If-Match`) and passes only when the platform refuses it with `precondition_failed`;
 * - `release-readiness-fail` and `release-command-fail` are recorded `skipped` with the reason.
 * Every run gets an `ha_drills` row; a handed-off one names the D235 or W11 row in `record_id`, and
 * its view reads the measurements from there, so the two histories never disagree.
 *
 * `runAll` runs exactly `planHaDrillAll(request, flags).runs`, one at a time, and returns the skipped
 * scenarios with their reasons; a run the level check refuses is moved to `skipped` with its reason.
 */
export class HaDrillRunner {
	constructor(private readonly ctx: CoreContext) {}

	catalogue(principal: Principal): HaDrillCatalogueView {
		this.#assert(principal);
		return { scenarios: HA_DRILL_CATALOGUE };
	}

	async run(principal: Principal, input: HaDrillRunRequest, batchId: string | null = null): Promise<HaDrillRunView> {
		this.#assert(principal);
		const parsed = haDrillRunRequestSchema.safeParse(input);
		if (!parsed.success) throw new ValidationError('Invalid drill request.', parsed.error.issues);
		const request = parsed.data;
		const entry = haDrillScenario(request.scenario);
		// HA-PLAN §10: a scenario that takes something down needs a platform admin, not an operator.
		if (entry.destructive) this.#assertAdmin(principal, entry.id);
		if (entry.availability === 'lab')
			throw new ConflictError(`The ${entry.id} drill runs in the lab only: ${entry.fleetUnavailableReason}`);
		const missing = entry.flags.filter((name) => !featureEnabled(this.ctx.config, name));
		if (missing.length > 0)
			throw new ConflictError(`The ${entry.id} drill needs ${missing.map((name) => `${featureEnvKey(name)}=1`).join(', ')}.`);
		const resource = this.#resolve(principal, entry.resourceKind, request.resource);
		const confirmation = haDrillConfirmationIssue(entry, resource.name, request.confirm);
		if (confirmation) throw new ValidationError(confirmation);
		const level = this.#levelIssue(entry, resource);
		if (level) throw new ConflictError(level);

		switch (entry.id) {
			case 'node-offline':
			case 'ingress-offline':
				return this.#nodeOffline(principal, entry, resource, request.durationSeconds, request.includeControlNode, batchId);
			case 'database-failover': {
				if (!request.drillDatabase)
					throw new ValidationError(`Name a disposable copy of ${resource.name} (--drill-database); a drill never promotes the database itself.`);
				const drill = await this.ctx.failoverPolicies.drill(principal, resource.name, { confirm: true, drillDatabaseId: request.drillDatabase });
				return this.#record(principal, entry, resource, batchId, { status: 'running', recordId: drill.id, startedAt: Date.parse(drill.startedAt) });
			}
			case 'stale-generation-promote':
				return this.#staleGeneration(principal, entry, resource, batchId);
			case 'release-readiness-fail':
			case 'release-command-fail':
				return this.#record(principal, entry, resource, batchId, { status: 'skipped', message: RELEASE_DRILL_GAP });
			default:
				throw new ConflictError(`The ${entry.id} drill has no fleet path.`);
		}
	}

	async runAll(principal: Principal, input: HaDrillAllRequest): Promise<HaDrillAllView> {
		this.#assert(principal);
		const parsed = haDrillAllRequestSchema.safeParse(input);
		if (!parsed.success) throw new ValidationError('Invalid drill request.', parsed.error.issues);
		const flags = Object.fromEntries(HA_DRILL_CATALOGUE.flatMap((entry) => entry.flags).map((name) => [name, featureEnabled(this.ctx.config, name)])) as Partial<FeatureFlags>;
		const plan = planHaDrillAll(parsed.data, flags);
		const batchId = newId('hdb_');
		const runs: HaDrillRunView[] = [];
		const skipped = [...plan.skipped];
		for (const item of plan.runs) {
			const entry = haDrillScenario(item.scenario);
			try {
				runs.push(
					await this.run(
						principal,
						{
							scenario: item.scenario,
							resource: item.resource,
							...(entry.confirmation === 'confirm' ? { confirm: true as const } : {}),
							...(item.drillDatabase ? { drillDatabase: item.drillDatabase } : {}),
						},
						batchId,
					),
				);
			} catch (error) {
				// A refusal (level, flag, resource) is a skip with its reason; anything else is a failure.
				if (error instanceof CoreError && error.status < 500 && error.status !== 403) {
					skipped.push({ scenario: item.scenario, reason: `${item.resource}: ${error.message}` });
					continue;
				}
				throw error;
			}
		}
		return { runs, skipped, passed: runs.length > 0 && runs.every((run) => run.status === 'passed') };
	}

	/**
	 * The D235 node offline drill as `POST /api/v1/ha/drills` and the dashboard start it (HA-PLAN
	 * §10): a platform admin, and the node's name typed back in `confirm` (or `random` when the
	 * drill picks the node). Checked here so neither surface relies on its UI for it.
	 */
	startNodeDrill(principal: Principal, input: NodeDrillStartRequest & { confirm?: string }): NodeDrillView {
		this.#assertAdmin(principal, 'node-offline');
		const { confirm, ...request } = input;
		if (request.node) {
			const name =
				this.ctx.sqlite
					.query<{ name: string }, [string, string]>('SELECT name FROM nodes WHERE id = ? OR name = ? LIMIT 1')
					.get(request.node, request.node)?.name ?? request.node;
			if (confirm?.trim() !== name) throw new ValidationError(`The node-offline drill is destructive: type the name "${name}" to confirm.`);
		} else if (confirm?.trim() !== 'random')
			throw new ValidationError('The node-offline drill is destructive: type "random" to confirm a drill on a node picked at random.');
		return this.ctx.nodeDrills.start(principal, request);
	}

	/** Recent catalogue runs, newest first. */
	list(principal: Principal, limit = 50): HaDrillRunView[] {
		this.#assert(principal);
		return this.ctx.sqlite
			.query<HaDrillRow, [number]>('SELECT * FROM ha_drills ORDER BY created_at DESC, rowid DESC LIMIT ?')
			.all(Math.min(Math.max(limit, 1), 200))
			.map((row) => this.#view(principal, row));
	}

	get(principal: Principal, id: string): HaDrillRunView {
		this.#assert(principal);
		const row = this.ctx.sqlite.query<HaDrillRow, [string]>('SELECT * FROM ha_drills WHERE id = ?').get(id);
		if (!row) throw new NotFoundError('Drill');
		return this.#view(principal, row);
	}

	// ---------------------------------------------------------------- scenarios

	#nodeOffline(
		principal: Principal,
		entry: HaDrillScenario,
		resource: Resource,
		durationSeconds: number | undefined,
		includeControlNode: boolean,
		batchId: string | null,
	): HaDrillRunView {
		// The typed name is not the control-plane opt-in: that stays explicit, as on the D235 path.
		const candidate = this.ctx.nodeDrills.view(principal).candidates.find((item) => item.nodeId === resource.id);
		if (candidate?.controlNode && !includeControlNode)
			throw new ConflictError(
				`${resource.name} hosts the control plane: drilling it withdraws the ingress through it. Pass includeControlNode (yoal ha drill … --include-control) to drill it anyway.`,
			);
		const drill = this.ctx.nodeDrills.start(principal, {
			node: resource.id,
			...(durationSeconds ? { durationSeconds } : {}),
			includeControlNode,
		});
		return this.#record(principal, entry, resource, batchId, { status: 'running', recordId: drill.id, startedAt: drill.startedAt });
	}

	async #staleGeneration(principal: Principal, entry: HaDrillScenario, resource: Resource, batchId: string | null): Promise<HaDrillRunView> {
		const database = this.ctx.sqlite
			.query<{ generation: number }, [string]>('SELECT primary_generation AS generation FROM databases WHERE id = ?')
			.get(resource.id);
		const replica = this.ctx.sqlite
			.query<{ id: string }, [string]>('SELECT id FROM database_replicas WHERE database_id = ? AND removing_at IS NULL ORDER BY id LIMIT 1')
			.get(resource.id);
		if (!database || !replica)
			return this.#record(principal, entry, resource, batchId, {
				status: 'skipped',
				message: `${resource.name} has no replica, so there is no promotion to refuse.`,
			});
		const started = this.ctx.now();
		// A generation no database ever had: the fence must refuse it before anything moves.
		const stale = -1;
		try {
			await this.ctx.databaseReplicas.promote(
				principal,
				resource.name,
				replica.id,
				{ confirm: true, acceptDataLoss: false } as never,
				{ ifMatch: stale, source: 'drill' },
			);
		} catch (error) {
			const code = error instanceof CoreError ? error.code : null;
			const refused = code === 'precondition_failed';
			return this.#record(principal, entry, resource, batchId, {
				status: refused ? 'passed' : 'failed',
				startedAt: started,
				finishedAt: this.ctx.now(),
				measured: { refused },
				message: refused
					? `A promotion at generation ${stale} was refused; ${resource.name} is at ${database.generation}.`
					: `The promotion was refused for another reason, so the fence was not tested: ${(error as Error).message}`,
			});
		}
		return this.#record(principal, entry, resource, batchId, {
			status: 'failed',
			startedAt: started,
			finishedAt: this.ctx.now(),
			measured: { refused: false },
			message: `The platform accepted a promotion at the stale generation ${stale}. Check ${resource.name} now: yoal db replicas ${resource.name}.`,
		});
	}

	// ---------------------------------------------------------------- facts

	#assert(principal: Principal): void {
		if (!this.ctx.platformIam.allows(principal, 'platform:ha'))
			throw new CoreError('forbidden', 'Drills need a platform admin or operator.', 403);
	}

	#assertAdmin(principal: Principal, what: string): void {
		if (!this.ctx.platformIam.canAdminister(principal))
			throw new CoreError('forbidden', `The ${what} drill takes something down: it needs a platform admin signed in to the dashboard.`, 403);
	}

	#resolve(principal: Principal, kind: HaDrillResourceKind, ref: string): Resource {
		if (kind === 'node' || kind === 'ingress-node') {
			const row = this.ctx.sqlite
				.query<{ id: string; name: string; mode: string; roles_json: string | null }, [string, string]>(
					'SELECT id, name, mode, roles_json FROM nodes WHERE id = ? OR name = ? ORDER BY id = ?1 DESC LIMIT 1',
				)
				.get(ref, ref);
			if (!row) throw new NotFoundError('Node');
			if (kind === 'ingress-node' && !this.ctx.ingressSet.isIngress(row.id))
				throw new ValidationError(`${row.name} is not in the ingress set; name an ingress node.`);
			return { kind, id: row.id, name: row.name };
		}
		if (kind === 'database') {
			// The drill and promotion services look a database up by name in the caller's org, so the
			// level check must use that same row: never a same-named database in another org.
			const row = this.ctx.sqlite
				.query<{ id: string; name: string }, [string, string, string]>(
					'SELECT id, name FROM databases WHERE deleted_at IS NULL AND org_id = ? AND (id = ? OR name = ?) LIMIT 1',
				)
				.get(principal.orgId, ref, ref);
			if (!row) throw new NotFoundError('Database');
			return { kind, id: row.id, name: row.name };
		}
		if (kind === 'project') {
			const row = this.ctx.sqlite
				.query<{ id: string; slug: string }, [string, string]>('SELECT id, slug FROM projects WHERE deleted_at IS NULL AND (id = ? OR slug = ?) LIMIT 1')
				.get(ref, ref);
			if (!row) throw new NotFoundError('Project');
			return { kind, id: row.id, name: row.slug };
		}
		// Zones, regions, the control plane and the arbiter are drilled in the lab only.
		throw new ConflictError(`A ${kind} drill runs in the lab only.`);
	}

	/** §10: the scenario's minimum against the resource's declared level, and the resource against its own. */
	#levelIssue(entry: HaDrillScenario, resource: Resource): string | null {
		const levels = this.ctx.topology.resourceLevels();
		const targets = this.ctx.slos.targetsInternal(levels);
		if (resource.kind === 'project') {
			const target = targets.find((item) => item.projectId === resource.id);
			return haDrillLevelIssue(entry, { declared: target?.declared ?? null, effective: target?.effective ?? 'L0' });
		}
		if (resource.kind === 'database') {
			const effective = (levels.databases.get(resource.id) as { level: HaLevel } | undefined)?.level ?? 'L0';
			const projects = new Set(
				this.ctx.sqlite
					.query<{ project_id: string }, [string]>('SELECT project_id FROM database_attachments WHERE database_id = ?')
					.all(resource.id)
					.map((row) => row.project_id),
			);
			const declared = targets
				.filter((item) => projects.has(item.projectId) && item.declared !== null)
				.map((item) => item.declared as HaLevel)
				.sort((a, b) => LEVEL_RANK[b] - LEVEL_RANK[a])[0];
			return haDrillLevelIssue(entry, { declared: declared ?? null, effective });
		}
		// A node: refuse while any project with a copy on it is already below its declared level.
		const onNode = new Set(
			this.ctx.sqlite
				.query<{ project_id: string }, [string, string]>(
					'SELECT project_id FROM workloads WHERE node_id = ? UNION SELECT project_id FROM workload_replicas WHERE node_id = ?',
				)
				.all(resource.id, resource.id)
				.map((row) => row.project_id),
		);
		const weak = targets.find((item) => onNode.has(item.projectId) && item.belowTarget);
		const issue = haDrillLevelIssue(entry, weak ? { declared: weak.declared, effective: weak.effective ?? 'L0' } : { declared: null, effective: 'L3' });
		return issue && weak ? `${weak.slug} runs on ${resource.name}: ${issue}` : issue;
	}

	// ---------------------------------------------------------------- records

	#record(
		principal: Principal,
		entry: HaDrillScenario,
		resource: Resource,
		batchId: string | null,
		result: {
			status: HaDrillRunStatus;
			recordId?: string;
			startedAt?: number;
			finishedAt?: number;
			measured?: Partial<HaDrillMeasured>;
			message?: string;
		},
	): HaDrillRunView {
		const now = this.ctx.now();
		const id = newId('hdr_');
		const measured = { ...emptyMeasured(), ...result.measured };
		this.ctx.sqlite.run(
			`INSERT INTO ha_drills (id, scenario, resource_kind, resource_id, resource_name, status, record_id, batch_id, started_at, finished_at,
			  rto_ms, lost_commits, lag_bytes, failed_requests, refused, message, created_by, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				entry.id,
				resource.kind,
				resource.id,
				resource.name,
				result.status,
				result.recordId ?? null,
				batchId,
				result.status === 'skipped' ? null : (result.startedAt ?? now),
				result.finishedAt ?? (result.status === 'skipped' ? now : null),
				measured.rtoMs,
				measured.lostCommits,
				measured.lagBytes,
				measured.failedRequests,
				measured.refused === null ? null : measured.refused ? 1 : 0,
				result.message ?? null,
				principal.userId ?? principal.kind,
				now,
			],
		);
		this.ctx.audit.record({
			principal,
			action: 'ha.drill',
			resource: resource.kind === 'database' ? 'database' : resource.kind === 'project' ? 'project' : 'node',
			resourceId: resource.id,
			args: { scenario: entry.id, resource: resource.name, drillId: id, status: result.status, recordId: result.recordId ?? null },
			result: result.status === 'failed' ? 'error' : 'ok',
		});
		return this.get(principal, id);
	}

	#view(principal: Principal, row: HaDrillRow): HaDrillRunView {
		const entry = haDrillScenario(row.scenario as HaDrillScenarioId);
		const view: HaDrillRunView = {
			id: row.id,
			scenario: entry.id,
			resource: { kind: row.resource_kind as HaDrillResourceKind, id: row.resource_id, name: row.resource_name },
			status: row.status,
			startedAt: iso(row.started_at),
			finishedAt: iso(row.finished_at),
			measured: {
				rtoMs: row.rto_ms,
				lostCommits: row.lost_commits,
				lagBytes: row.lag_bytes,
				failedRequests: row.failed_requests,
				refused: row.refused === null ? null : row.refused === 1,
			},
			bound: entry.bound,
			recordId: row.record_id ?? row.id,
			message: row.message,
		};
		if (!row.record_id) return view;
		if (entry.recordsIn === 'node_drills') {
			let drill: NodeDrillView;
			try {
				drill = this.ctx.nodeDrills.get(principal, row.record_id);
			} catch {
				return { ...view, message: view.message ?? 'The node offline drill record is gone.' };
			}
			return { ...view, ...fromNodeDrill(entry, drill) };
		}
		if (entry.recordsIn === 'database_failover_drills') {
			const drill = this.ctx.sqlite
				.query<
					{ status: string; started_at: number; finished_at: number | null; time_to_writable_ms: number | null; lost_commits: number | null; message: string | null },
					[string]
				>('SELECT status, started_at, finished_at, time_to_writable_ms, lost_commits, message FROM database_failover_drills WHERE id = ?')
				.get(row.record_id);
			if (!drill) return { ...view, message: view.message ?? 'The failover drill record is gone.' };
			return {
				...view,
				status: drill.status as HaDrillRunStatus,
				startedAt: iso(drill.started_at),
				finishedAt: iso(drill.finished_at),
				measured: { ...view.measured, rtoMs: drill.time_to_writable_ms, lostCommits: drill.lost_commits },
				message: drill.message,
			};
		}
		return view;
	}
}

/** A D235 drill as a catalogue run: detection is the RTO for `node-offline`, ingress withdrawal for `ingress-offline`. */
function fromNodeDrill(entry: HaDrillScenario, drill: NodeDrillView): Partial<HaDrillRunView> {
	const status: HaDrillRunStatus =
		drill.status === 'running' ? 'running' : drill.status === 'completed' ? 'passed' : drill.status === 'cancelled' ? 'cancelled' : 'failed';
	const observations = drill.observations;
	let rtoMs: number | null = observations?.offlineDetectedAfterMs ?? (drill.offlineAt === null ? null : drill.offlineAt - drill.startedAt);
	let message = drill.message;
	if (entry.id === 'ingress-offline') {
		const withdrawn = observations?.events.find((event) => /ingress/i.test(event.kind) || /ingress/i.test(event.stage));
		rtoMs = withdrawn ? withdrawn.detectedAt - drill.startedAt : null;
		message = [
			message,
			withdrawn ? null : 'No ingress withdrawal was recorded in the drill window.',
			'Failed requests are not measured on a fleet: the external prober (W15) or the balancer’s own logs show them.',
		]
			.filter(Boolean)
			.join(' ');
	}
	const finishedAt = drill.finishedAt ?? drill.restoredAt;
	return {
		status,
		startedAt: iso(drill.startedAt),
		finishedAt: iso(finishedAt),
		measured: { rtoMs, lostCommits: null, lagBytes: null, failedRequests: null, refused: null },
		message,
	};
}
