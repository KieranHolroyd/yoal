import { eq } from 'drizzle-orm';
import { databasePitr, nodes as nodesTable } from '@yoal/db';
import {
	DATABASE_REPLICAS_CAPABILITY,
	DATABASE_REPLICATION_MAX_SLOTS,
	DB_MEMBER_CAPABILITY,
	DB_MEMBER_SELF_FENCING_CAPABILITY,
	PITR_REWIND_CAPABILITY,
	databaseEngineRegistry,
	pitrUnsupportedReason,
	regionOf,
	releaseCommandSpecSchema,
	releasePhaseSpecIssues,
	rolloutSpecSchema,
	standbyRegionRefusal,
	workloadPlacementSpecSchema,
	workloadSpecSchema,
	type Blueprint,
	type BlueprintChange,
	type BlueprintCluster,
	type BlueprintPlanAction,
	type ClusterConfigUpdate,
	type FailoverArmRefusal,
	type Principal,
	type ReplicaSpread,
	type WorkloadSpec,
} from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import type { DatabaseRow } from './databases.ts';
import { ConflictError, CoreError, NotFoundError } from './errors.ts';
import type { NodeView } from './nodes.ts';
import type { ItemResult } from './operations/types.ts';
import { pitrStoreProblem } from './pitr-store-gate.ts';
import type { ProjectRow } from './projects.ts';
import { assertRegionWrites } from './region-gate.ts';

/**
 * Blueprint HA keys (HA-PLAN §8 and H27, W14; Wave 5 lane C). One plan step per resource, all of
 * kind `ha`, so the plan shows an **HA section**:
 *
 * - `cluster.requires` — assertions about the fleet (`zones`, `ingressNodes`, `dataNodes`), counted
 *   over **online** nodes. Nothing is provisioned: a shortfall fails the plan with the exact gap.
 *   Always `noop`; its reason states what the fleet has.
 * - `cluster.steering` — `steering.driver`, `steering.stacked` and `ingress.drainSeconds` through
 *   `ClusterConfigService.update`, the path the cluster config REST and `ha init` use, so the last
 *   write wins and the plan shows the diff against the live value. Needs a platform admin signed in
 *   to the dashboard, exactly as that service does.
 * - `projects.<slug>.ha` — `readinessPath`, `release`, `rollout`, `drainSeconds` and
 *   `placement: { spread }` merged into the workload spec and saved by one `WorkloadService.setSpec`
 *   call, so `RELEASE_PHASE` and `REGIONS` refuse exactly as they do for the dashboard. The object
 *   `placement` is the workload's `placement.spread`, never the project's `placementSpec`.
 * - `databases.<name>.ha` — `standbyRegion` (`DatabaseService.update`), `pitr`
 *   (`setPitrPolicy`), `replicas` (`DatabaseReplicaService.add`, one per missing replica, on nodes
 *   chosen by `spread`), `durability` (`DatabaseMemberService.setDurability`) and `failover`
 *   (`DatabaseFailoverPolicyService.arm` / `disarm`). `backups.target` and `backups.immutable` are
 *   assertions: a database has no backup target of its own (resolution is org → platform), so the
 *   plan fails when its backups would not go to the named target or that target is not immutable.
 *
 * **Checked at plan time.** Each step runs, without writing, the checks its services run before
 * they write, and every refusal fails the plan with its path, one problem per refusal:
 * - projects: the release-phase and region gates and the spec schema (`setSpec`'s other checks, the
 *   memory quota and port conflicts, run at apply, as they do for the `service` step);
 * - steering: the platform-admin rule and the stacked-driver rules of `ClusterConfigService.update`;
 * - databases: the region gates (a not-built stub shows its own `not_built` message), every check of
 *   `setPitrPolicy` (a replica being removed counts), `DatabaseReplicaService.add`'s node, disk,
 *   max-replica and memory-quota checks for all new replicas together, `setDurability`'s
 *   preconditions (`durabilityRefusal`), `arm`'s policy (`armRefusals`), and whether the database is
 *   moving or failing over;
 * - AI agents (an OAuth/MCP principal) may not change `durability` or `failover`, as they may not prune.
 *
 * Some keys cannot apply in the same run as the change they depend on, and the plan refuses them:
 * `durability: sync` needs replicas that already stream; `failover: auto` needs a passed drill on the
 * database, a settled durability and no replicas being added in the same plan.
 *
 * **Checked only at apply.** Apply re-runs every check above before the run (`checkBeforeApply`) and
 * again in each step before its first write. What it cannot see in advance is a change between that
 * check and a write: `setDurability` writes the arbiter lease and `arm` re-evaluates the policy when
 * they run, and the plan warns about both. A database step makes several writes in order (standby
 * region, PITR, replicas, durability, failover policy); if one of those is refused at that moment, the
 * writes before it stay, and nothing is rolled back, as for every other blueprint step.
 *
 * **Idempotence.** Each step compares the file with live state and changes only what differs, so a
 * second apply is a no-op. A key removed from the file is no longer managed and keeps its value; an
 * HA step is never pruned. A blueprint never lowers `replicas` (remove a replica by hand).
 */

/** The plan keys of the HA section. */
export const blueprintHaStepKeys = {
	requires: 'cluster.requires',
	steering: 'cluster.steering',
	project: (slug: string) => `projects.${slug}.ha`,
	database: (name: string) => `databases.${name}.ha`,
} as const;

export type BlueprintHaTarget = { section: 'requires' } | { section: 'steering' } | { section: 'project'; name: string } | { section: 'database'; name: string };

/** The HA target a plan key names, or null. */
export function parseBlueprintHaKey(key: string): BlueprintHaTarget | null {
	if (key === blueprintHaStepKeys.requires) return { section: 'requires' };
	if (key === blueprintHaStepKeys.steering) return { section: 'steering' };
	const parts = key.split('.');
	if (parts.length === 3 && parts[2] === 'ha' && parts[1]) {
		if (parts[0] === 'projects') return { section: 'project', name: parts[1] };
		if (parts[0] === 'databases') return { section: 'database', name: parts[1] };
	}
	return null;
}

export interface BlueprintHaProblem {
	path: string[];
	message: string;
}

/** One HA step as `BlueprintService.diff` records it. */
export interface BlueprintHaStep {
	key: string;
	action: BlueprintPlanAction;
	changes: BlueprintChange[];
	reason: string | null;
	/** Permissions the step needs when it changes something (org permissions; platform ones are checked here). */
	permissions: ('project:update' | 'database:update')[];
}

export interface BlueprintHaPlan {
	steps: BlueprintHaStep[];
	problems: BlueprintHaProblem[];
	warnings: string[];
}

/** What `BlueprintService` knows that the HA plan needs: the workload spec each project will have. */
export interface BlueprintHaPlanInput {
	/** The spec after the project's `service` step (or the live one); null when there is none. */
	baseSpec(slug: string): WorkloadSpec | null;
	/** True when the file also sets workload fields, so a missing spec is already reported there. */
	declaresWorkload(slug: string): boolean;
	/** The project row, when it exists. */
	projectRow(slug: string): ProjectRow | undefined;
}

// ---------------------------------------------------------------- plan

/** The HA section of a plan: one step per HA target, with every refusal as a problem. Read-only. */
export function planBlueprintHa(ctx: CoreContext, principal: Principal, doc: Blueprint, input: BlueprintHaPlanInput): BlueprintHaPlan {
	const plan: BlueprintHaPlan = { steps: [], problems: [], warnings: [] };
	const add = (result: StepResult | null) => {
		if (!result) return;
		plan.steps.push(result.step);
		plan.problems.push(...result.problems);
		plan.warnings.push(...result.warnings);
	};
	if (doc.cluster?.requires) add(requiresStep(ctx, principal, doc.cluster.requires));
	if (doc.cluster?.steering) add(steeringStep(ctx, principal, doc.cluster.steering).result);
	for (const [slug, project] of Object.entries(doc.projects)) {
		if (!projectHaFields(project)) continue;
		const row = input.projectRow(slug);
		const current = row && !row.deletedAt ? safeSpec(ctx, row) : null;
		add(projectStep(ctx, slug, project, current, input.baseSpec(slug), input.declaresWorkload(slug)).result);
	}
	for (const [name, database] of Object.entries(doc.databases)) {
		if (!databaseHaFields(database)) continue;
		const outcome = databaseStep(ctx, principal, name, database);
		if (outcome) add(outcome.result);
	}
	return plan;
}

/**
 * Apply one HA step of a reviewed plan. Live state is re-read and every check re-run first; a
 * refusal fails the step before anything is written.
 */
export async function applyBlueprintHa(ctx: CoreContext, principal: Principal, doc: Blueprint, key: string): Promise<ItemResult> {
	const target = parseBlueprintHaKey(key);
	if (!target) return { status: 'failed', error: `Unknown HA step ${key}.` };
	const upToDate: ItemResult = { status: 'skipped', reason: 'up to date' };
	const refuse = (problems: BlueprintHaProblem[]) => {
		if (problems.length) throw new ConflictError(problems.map((problem) => `${problem.path.join('.')}: ${problem.message}`).join(' '));
	};
	switch (target.section) {
		case 'requires': {
			const result = requiresStep(ctx, principal, doc.cluster?.requires ?? {});
			refuse(result.problems);
			return upToDate;
		}
		case 'steering': {
			const steering = doc.cluster?.steering;
			if (!steering) return { status: 'failed', error: 'cluster.steering is no longer in the plan.' };
			const { result, update } = steeringStep(ctx, principal, steering);
			refuse(result.problems);
			if (!update) return upToDate;
			ctx.cluster.update(principal, update);
			return { status: 'succeeded' };
		}
		case 'project': {
			const project = doc.projects[target.name];
			if (!project) return { status: 'failed', error: `projects.${target.name} is no longer in the plan.` };
			const row = ctx.projects.requireRow(principal, target.name);
			// The project's `service` step ran before this one, so the live spec is the base.
			const current = safeSpec(ctx, row);
			const { result, spec } = projectStep(ctx, target.name, project, current, current, false);
			refuse(result.problems);
			if (!spec) return upToDate;
			ctx.workloads.setSpec(principal, row, spec);
			return { status: 'succeeded' };
		}
		case 'database': {
			const database = doc.databases[target.name];
			if (!database) return { status: 'failed', error: `databases.${target.name} is no longer in the plan.` };
			const outcome = databaseStep(ctx, principal, target.name, database);
			if (!outcome) return upToDate;
			refuse(outcome.result.problems);
			const writes = outcome.writes;
			if (!writes || isEmptyWrite(writes)) return upToDate;
			// Order: the region label, PITR (so replicas start on the PITR image), replicas, durability
			// (which needs them), then the failover policy (which needs a settled durability).
			if (writes.standbyRegion !== undefined) ctx.databases.update(principal, target.name, { standbyRegion: writes.standbyRegion });
			if (writes.pitr !== undefined) ctx.databases.setPitrPolicy(principal, target.name, { enabled: writes.pitr });
			for (const nodeId of writes.addReplicaNodes) ctx.databaseReplicas.add(principal, target.name, { node: nodeId, mode: 'async' });
			if (writes.durability !== undefined) await ctx.databaseMembers.setDurability(principal, target.name, { durability: writes.durability });
			if (writes.failover?.mode === 'auto')
				await ctx.failoverPolicies.arm(principal, target.name, { confirm: true, acceptDataLoss: writes.failover.acceptDataLoss });
			else if (writes.failover?.mode === 'manual') await ctx.failoverPolicies.disarm(principal, target.name);
			return { status: 'succeeded' };
		}
	}
}

// ---------------------------------------------------------------- shared

interface StepResult {
	step: BlueprintHaStep;
	problems: BlueprintHaProblem[];
	warnings: string[];
}

const PROJECT_HA_FIELDS = ['readinessPath', 'release', 'rollout', 'drainSeconds'] as const;
const DATABASE_HA_FIELDS = ['replicas', 'durability', 'failover', 'acceptDataLoss', 'spread', 'pitr', 'backups', 'standbyRegion'] as const;

function projectHaFields(project: Blueprint['projects'][string]): boolean {
	return typeof project.placement === 'object' || PROJECT_HA_FIELDS.some((field) => project[field] !== undefined);
}

function databaseHaFields(database: Blueprint['databases'][string]): boolean {
	return DATABASE_HA_FIELDS.some((field) => database[field] !== undefined);
}

function render(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	const text = typeof value === 'string' ? value : Array.isArray(value) ? value.join(' ') : JSON.stringify(value);
	return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value && typeof value === 'object')
		return `{${Object.keys(value as Record<string, unknown>)
			.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
			.join(',')}}`;
	return JSON.stringify(value ?? null);
}

const same = (a: unknown, b: unknown): boolean => canonical(a ?? null) === canonical(b ?? null);

/** The message a gate throws, or null. Only `CoreError`s are refusals; anything else is a bug. */
function refusalOf(check: () => void): string | null {
	try {
		check();
		return null;
	} catch (error) {
		if (error instanceof CoreError) return error.message;
		throw error;
	}
}

function safeSpec(ctx: CoreContext, row: ProjectRow): WorkloadSpec | null {
	try {
		return ctx.workloads.projectSpec(row);
	} catch {
		return null;
	}
}

/** Every node, as the services see it. */
function fleet(ctx: CoreContext): NodeView[] {
	return ctx.db
		.select()
		.from(nodesTable)
		.all()
		.map((row) => ctx.nodes.view(row))
		.sort((a, b) => a.name.localeCompare(b.name));
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// ---------------------------------------------------------------- cluster.requires

function requiresStep(ctx: CoreContext, principal: Principal, requires: NonNullable<BlueprintCluster['requires']>): StepResult {
	const problems: BlueprintHaProblem[] = [];
	const key = blueprintHaStepKeys.requires;
	if (!ctx.platformIam.canView(principal)) {
		problems.push({ path: [key], message: 'Checking the fleet needs a platform admin role.' });
		return { step: { key, action: 'noop', changes: [], reason: null, permissions: [] }, problems, warnings: [] };
	}
	const all = fleet(ctx);
	const online = all.filter((node) => node.status === 'online');
	const notOnline = all.filter((node) => node.status !== 'online').map((node) => `${node.name} is ${node.status}`);
	const offlineNote = notOnline.length ? ` Not counted: ${notOnline.join(', ')}.` : '';
	const zones = [...new Set(online.map((node) => node.zone))].sort();
	const ingress = online.filter((node) => node.roles.includes('ingress')).length;
	const data = online.filter((node) => node.roles.includes('data')).length;
	if (requires.zones !== undefined && zones.length < requires.zones)
		problems.push({
			path: ['cluster.requires.zones'],
			message: `The file requires ${plural(requires.zones, 'zone')}; the online nodes span ${zones.length} (${zones.join(', ') || 'none'}), ${requires.zones - zones.length} short. Enrol a node with --zone in another zone; a blueprint provisions nothing.${offlineNote}`,
		});
	if (requires.ingressNodes !== undefined && ingress < requires.ingressNodes)
		problems.push({
			path: ['cluster.requires.ingressNodes'],
			message: `The file requires ${plural(requires.ingressNodes, 'ingress node')}; ${ingress} online node${ingress === 1 ? ' has' : 's have'} the ingress role, ${requires.ingressNodes - ingress} short. Enrol one with --roles ingress, or add the role to a node.${offlineNote}`,
		});
	if (requires.dataNodes !== undefined && data < requires.dataNodes)
		problems.push({
			path: ['cluster.requires.dataNodes'],
			message: `The file requires ${plural(requires.dataNodes, 'data node')}; ${data} online node${data === 1 ? ' has' : 's have'} the data role, ${requires.dataNodes - data} short. Enrol one with --roles data, or add the role to a node.${offlineNote}`,
		});
	const reason = `online: ${plural(zones.length, 'zone')}, ${plural(ingress, 'ingress node')}, ${plural(data, 'data node')}`;
	return { step: { key, action: 'noop', changes: [], reason, permissions: [] }, problems, warnings: [] };
}

// ---------------------------------------------------------------- cluster.steering

function steeringStep(
	ctx: CoreContext,
	principal: Principal,
	steering: NonNullable<BlueprintCluster['steering']>,
): { result: StepResult; update: ClusterConfigUpdate | null } {
	const key = blueprintHaStepKeys.steering;
	const live = ctx.cluster.get();
	const changes: BlueprintChange[] = [];
	const problems: BlueprintHaProblem[] = [];
	const warnings: string[] = [];
	const update: { steering?: { driver?: typeof steering.driver; stacked?: typeof live.steering.stacked }; ingress?: { drainSeconds: number } } = {};
	if (steering.driver !== live.steering.driver) {
		update.steering = { driver: steering.driver };
		changes.push({ path: 'steering.driver', from: live.steering.driver, to: steering.driver });
	}
	if (steering.stacked !== undefined && !same(steering.stacked, live.steering.stacked)) {
		update.steering = { ...update.steering, stacked: steering.stacked };
		changes.push({ path: 'steering.stacked', from: render(live.steering.stacked) , to: render(steering.stacked) });
	}
	if (steering.drainSeconds !== undefined && steering.drainSeconds !== live.ingress.drainSeconds) {
		update.ingress = { drainSeconds: steering.drainSeconds };
		changes.push({ path: 'ingress.drainSeconds', from: String(live.ingress.drainSeconds), to: String(steering.drainSeconds) });
	}
	// `ha init` writes the same settings; whichever runs last wins, so say what this replaces.
	if (changes.length) {
		if (!ctx.platformIam.canAdminister(principal))
			problems.push({
				path: [key],
				message: 'Only a platform admin role signed in to the dashboard can change the cluster configuration, so the CLI and API keys cannot set cluster.steering. Change it in Settings → High availability, or remove it from the file.',
			});
		// The same rules `ClusterConfigService.update` enforces on the merged value.
		const driver = steering.driver;
		const stacked = steering.stacked ?? live.steering.stacked;
		if (stacked.includes('direct')) problems.push({ path: ['cluster.steering.stacked'], message: 'direct cannot be stacked: it means no steering.' });
		if (new Set(stacked).size !== stacked.length)
			problems.push({ path: ['cluster.steering.stacked'], message: 'A stacked steering driver can appear only once.' });
		if (stacked.includes(driver))
			problems.push({ path: ['cluster.steering.stacked'], message: `The steering driver ${driver} cannot also be stacked.` });
		if (driver !== 'direct' && !featureEnabled(ctx.config, 'STEERING'))
			warnings.push(
				`cluster.steering: the ${driver} driver is stored but does nothing until steering is enabled on this platform (YOAL_FEATURE_STEERING).`,
			);
	}
	return {
		result: {
			step: {
				key,
				action: changes.length ? 'update' : 'noop',
				changes,
				reason: changes.length ? 'cluster setting shared with ha init; the last write wins' : null,
				permissions: [],
			},
			problems,
			warnings,
		},
		update: changes.length ? (update as ClusterConfigUpdate) : null,
	};
}

// ---------------------------------------------------------------- projects.<slug>.ha

/** The HA fields as the spec stores them (defaults filled), so equal values compare equal. */
function projectHaValues(project: Blueprint['projects'][string]): Partial<Pick<WorkloadSpec, 'readinessPath' | 'release' | 'rollout' | 'drainSeconds'>> & {
	spread?: ReplicaSpread;
} {
	return {
		...(project.readinessPath !== undefined ? { readinessPath: project.readinessPath } : {}),
		...(project.release !== undefined ? { release: releaseCommandSpecSchema.parse(project.release) } : {}),
		...(project.rollout !== undefined ? { rollout: rolloutSpecSchema.parse(project.rollout) } : {}),
		...(project.drainSeconds !== undefined ? { drainSeconds: project.drainSeconds } : {}),
		...(typeof project.placement === 'object' && project.placement.spread !== undefined
			? { spread: workloadPlacementSpecSchema.parse(project.placement).spread }
			: {}),
	};
}

function projectStep(
	ctx: CoreContext,
	slug: string,
	project: Blueprint['projects'][string],
	current: WorkloadSpec | null,
	base: WorkloadSpec | null,
	declaresWorkload: boolean,
): { result: StepResult; spec: WorkloadSpec | null } {
	const key = blueprintHaStepKeys.project(slug);
	const problems: BlueprintHaProblem[] = [];
	const changes: BlueprintChange[] = [];
	const wanted = projectHaValues(project);
	const path = (field: string) => [`projects.${slug}.${field}`];

	for (const field of PROJECT_HA_FIELDS) {
		if (wanted[field] === undefined || same(current?.[field], wanted[field])) continue;
		changes.push({ path: field, from: render(current?.[field]), to: render(wanted[field]) });
	}
	if (wanted.spread !== undefined && wanted.spread !== current?.placement?.spread)
		changes.push({ path: 'placement.spread', from: current?.placement?.spread ?? null, to: wanted.spread });

	const empty = { result: { step: { key, action: 'noop' as const, changes, reason: null, permissions: ['project:update' as const] }, problems, warnings: [] }, spec: null };
	if (!base) {
		// The `service` step already reports why the file's workload settings do not validate.
		if (!declaresWorkload)
			problems.push({
				path: [key],
				message: `Project "${slug}" has no workload settings yet. Set its image or command, port and health path (in the file or the dashboard) before readiness, release, rollout, drain or spread.`,
			});
		return { ...empty, result: { ...empty.result, step: { ...empty.result.step, action: changes.length ? 'create' : 'noop' } } };
	}
	if (!changes.length) return empty;

	const { spread, ...fields } = wanted;
	const merged: Record<string, unknown> = { ...base, ...fields };
	if (spread !== undefined) merged.placement = { ...(base.placement ?? {}), spread };
	// The gates `setSpec` runs (`assertReleasePhaseSpec`), with every refusal listed, not only the first.
	const gated = { ...fields, ...(spread !== undefined ? { placement: { spread } } : {}) };
	for (const issue of releasePhaseSpecIssues(gated, { RELEASE_PHASE: featureEnabled(ctx.config, 'RELEASE_PHASE') }, current))
		problems.push({ path: path(issue.path), message: issue.message });
	const region = refusalOf(() =>
		assertRegionWrites(ctx.config, [{ field: 'blueprint.projects.placement.spread', value: spread, current: current?.placement?.spread }]),
	);
	if (region) problems.push({ path: path('placement'), message: region });
	const parsed = workloadSpecSchema.safeParse(merged);
	if (!parsed.success)
		for (const issue of parsed.error.issues) problems.push({ path: path(issue.path.join('.') || 'workload'), message: issue.message });

	return {
		result: {
			step: { key, action: current ? 'update' : 'create', changes, reason: null, permissions: ['project:update'] },
			problems,
			warnings: [],
		},
		spec: parsed.success ? parsed.data : null,
	};
}

// ---------------------------------------------------------------- databases.<name>.ha

interface DatabaseWrites {
	standbyRegion?: string | null;
	pitr?: boolean;
	addReplicaNodes: string[];
	durability?: 'async' | 'sync';
	failover?: { mode: 'auto'; acceptDataLoss: boolean } | { mode: 'manual' };
}

function isEmptyWrite(writes: DatabaseWrites): boolean {
	return (
		writes.standbyRegion === undefined &&
		writes.pitr === undefined &&
		writes.addReplicaNodes.length === 0 &&
		writes.durability === undefined &&
		writes.failover === undefined
	);
}

/** `DatabaseFailoverPolicyService`'s messages for the refusals a database that does not exist yet must meet. */
const NEW_DATABASE_ARM_REFUSALS = {
	'auto-promote-off': 'Automatic database failover is off globally; enable DB_AUTO_PROMOTE first (HA-PLAN W11).',
	'no-drill': (name: string) =>
		`No failover drill has run for this database; run one before arming auto. A database cannot be armed in the apply that creates it: apply with failover: manual, run a drill (\`yoal db failover ${name} --drill --target <disposable-database>\`), then set failover: auto.`,
	'no-self-fencing-path':
		'Every data node must advertise db-member-self-fencing (a real arbiter transport and peer channel); without it an automatic promotion could leave two primaries (HA-PLAN F1).',
} as const;

function databaseStep(
	ctx: CoreContext,
	principal: Principal,
	name: string,
	database: Blueprint['databases'][string],
): { result: StepResult; writes: DatabaseWrites | null } | null {
	const key = blueprintHaStepKeys.database(name);
	let row: DatabaseRow | undefined;
	try {
		row = ctx.databases.requireRow(principal, name, { includeDeleted: true });
	} catch (error) {
		if (!(error instanceof NotFoundError)) throw error;
	}
	// The `database` step reports a trashed database; there is nothing to plan HA against.
	if (row?.deletedAt) return null;
	const creating = !row;
	const problems: BlueprintHaProblem[] = [];
	const warnings: string[] = [];
	const changes: BlueprintChange[] = [];
	const writes: DatabaseWrites = { addReplicaNodes: [] };
	const path = (field: string) => [`databases.${name}.${field}`];
	const refuse = (field: string, message: string | null) => {
		if (message) problems.push({ path: path(field), message });
	};
	const nodes = fleet(ctx);
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const allReplicas = row ? ctx.databaseReplicas.rowsFor(row.id) : [];
	const liveReplicas = allReplicas.filter((replica) => !replica.removingAt);

	// ---- standbyRegion (DatabaseService.update; the REGIONS gate, then lane A's rule once built)
	if (database.standbyRegion !== undefined && database.standbyRegion !== (row?.standbyRegion ?? null)) {
		changes.push({ path: 'standbyRegion', from: row?.standbyRegion ?? null, to: database.standbyRegion });
		writes.standbyRegion = database.standbyRegion;
		const gate = refusalOf(() =>
			assertRegionWrites(ctx.config, [{ field: 'blueprint.databases.standbyRegion', value: database.standbyRegion, current: row?.standbyRegion ?? null }]),
		);
		refuse('standbyRegion', gate);
		if (!gate && row) {
			const primary = byId.get(row.nodeId);
			const refusal = standbyRegionRefusal({
				primaryRegion: primary?.region,
				standbyRegion: database.standbyRegion,
				candidateNodes: nodes
					.filter((node) => node.status === 'online' && node.roles.includes('data') && regionOf(node) === database.standbyRegion)
					.map((node) => node.name),
			});
			refuse('standbyRegion', refusal?.message ?? null);
		}
	}

	// ---- spread (a placement rule for replicas; no stored value, so every `region` is a write)
	const spread = database.spread;
	if (spread !== undefined) {
		refuse('spread', refusalOf(() => assertRegionWrites(ctx.config, [{ field: 'blueprint.databases.spread', value: spread }])));
		if (row && spread !== 'region') {
			const members = [row.nodeId, ...liveReplicas.map((replica) => replica.nodeId)];
			const domain = (nodeId: string) => (spread === 'zone' ? (byId.get(nodeId)?.zone ?? nodeId) : nodeId);
			const seen = new Map<string, string>();
			for (const nodeId of members) {
				const at = domain(nodeId);
				const other = seen.get(at);
				if (other !== undefined)
					refuse(
						'spread',
						`spread: ${spread} is not met: ${byId.get(other)?.name ?? other} and ${byId.get(nodeId)?.name ?? nodeId} share ${spread === 'zone' ? `zone "${at}"` : 'a node'}. A blueprint never moves a replica; remove one (\`yoal db replica remove\`) and plan again.`,
					);
				else seen.set(at, nodeId);
			}
		}
	}

	// ---- pitr (DatabaseService.setPitrPolicy)
	// The stored policy (`pitrStatus` needs a configured repository just to describe it).
	const pitrLive = row
		? (ctx.db.select({ enabled: databasePitr.enabled }).from(databasePitr).where(eq(databasePitr.databaseId, row.id)).get()?.enabled ?? false)
		: false;
	const pitrAfter = database.pitr ?? pitrLive;
	if (database.pitr !== undefined && database.pitr !== pitrLive) {
		changes.push({ path: 'pitr', from: String(pitrLive), to: String(database.pitr) });
		writes.pitr = database.pitr;
		// `setPitrPolicy`'s checks, in its order. It reads the repository in both directions, so
		// turning PITR off without one is refused as well.
		if (!featureEnabled(ctx.config, 'PITR')) refuse('pitr', 'PITR is disabled on this control plane (YOAL_FEATURE_PITR).');
		else if (!ctx.config.pitrRepository)
			refuse(
				'pitr',
				'PITR is enabled but no pgBackRest repository is configured; set YOAL_PITR_REPO_BUCKET, YOAL_PITR_ACCESS_KEY_ID and YOAL_PITR_SECRET_ACCESS_KEY.',
			);
		else if (database.pitr) {
			const info = databaseEngineRegistry[database.engine];
			refuse('pitr', pitrStoreProblem(ctx, ctx.config.pitrRepository, row?.nodeId ?? null));
			refuse(
				'pitr',
				pitrUnsupportedReason(database.engine, row?.version ?? database.version ?? info.defaultVersion, row?.variant ?? database.variant ?? 'standard'),
			);
			// A replica being removed still counts, and refuses, exactly as in `setPitrPolicy`.
			if (row && liveReplicas.length > 0) {
				const capable =
					featureEnabled(ctx.config, 'PITR_REWIND') &&
					ctx.databases.pitrRewindForNode(row.nodeId) &&
					allReplicas.every((replica) => !replica.removingAt && ctx.databases.pitrRewindForNode(replica.nodeId));
				if (!capable)
					refuse(
						'pitr',
						`"${name}" has read replicas; turning point-in-time recovery on needs YOAL_FEATURE_PITR_REWIND and the "pitr-rewind" agent capability on every member, or remove the replicas first.`,
					);
			}
		}
	}

	// ---- replicas (DatabaseReplicaService.add, on nodes chosen by spread)
	const wantedReplicas = database.replicas;
	let addingReplicas = false;
	if (wantedReplicas !== undefined && wantedReplicas !== liveReplicas.length) {
		changes.push({ path: 'replicas', from: String(liveReplicas.length), to: String(wantedReplicas) });
		if (wantedReplicas < liveReplicas.length)
			refuse(
				'replicas',
				`"${name}" has ${liveReplicas.length} replicas and the file asks for ${wantedReplicas}. A blueprint never removes a replica; remove one with \`yoal db replica remove\` and plan again.`,
			);
		else {
			addingReplicas = true;
			const count = wantedReplicas - liveReplicas.length;
			const maxReplicas = Math.min(ctx.cluster.get().database.maxReplicas, DATABASE_REPLICATION_MAX_SLOTS);
			if (wantedReplicas > maxReplicas) refuse('replicas', `This install allows at most ${maxReplicas} replica(s) per database.`);
			if (pitrAfter && !featureEnabled(ctx.config, 'PITR_REWIND'))
				refuse('replicas', `"${name}" has point-in-time recovery on; replicas of a PITR database need YOAL_FEATURE_PITR_REWIND.`);
			const memoryMb = row?.memoryMb ?? database.memoryMb ?? databaseEngineRegistry[database.engine].defaultMemoryMb;
			const picked = pickReplicaNodes(ctx, { row, nodes, liveReplicas: liveReplicas.map((replica) => replica.nodeId), removingOn: allReplicas.filter((replica) => replica.removingAt).map((replica) => replica.nodeId), count, spread, memoryMb, pitr: pitrAfter });
			refuse('replicas', picked.problem);
			// `add` admits each copy's memory one at a time; all of them together must fit. A database
			// this plan creates reserves its own memory first.
			refuse(
				'replicas',
				refusalOf(() => ctx.quota.assertCanAdmitMemory(principal.orgId, null, memoryMb * count + (creating ? memoryMb : 0))),
			);
			if (row && !picked.problem) {
				writes.addReplicaNodes = picked.nodes.map((node) => node.id);
				changes.push({ path: 'replicas.nodes', from: null, to: picked.nodes.map((node) => `${node.name} (${node.zone})`).join(', ') });
			} else if (!row) changes.push({ path: 'replicas.nodes', from: null, to: `chosen when the database exists, spread by ${spread ?? 'node'}` });
		}
	}

	// ---- durability (DatabaseMemberService.setDurability)
	const durabilityChanges = database.durability !== undefined && database.durability !== (row?.durability ?? 'async');
	if (database.durability !== undefined && durabilityChanges) {
		changes.push({ path: 'durability', from: row?.durability ?? 'async', to: database.durability });
		writes.durability = database.durability;
		if (principal.credential === 'oauth')
			refuse('durability', 'AI agents cannot change durability through a blueprint; it changes how the database commits. Apply it from the dashboard or CLI.');
		else if (!featureEnabled(ctx.config, 'SYNC_REPLICA'))
			refuse('durability', 'Synchronous replicas are off: enable SYNC_REPLICA first (HA-PLAN H23).');
		else if (database.durability === 'sync' && (creating || addingReplicas))
			refuse(
				'durability',
				`durability: sync picks a replica that is already streaming, and this plan ${creating ? 'creates the database' : 'adds its replicas'}. Apply without durability first, wait for the replicas to stream (\`yoal db replica list ${name}\`), then set durability: sync and apply again.`,
			);
		else if (row) refuse('durability', ctx.databaseMembers.durabilityRefusal(principal, name, { durability: database.durability }));
		warnings.push(
			`databases.${name}.durability: the change writes the arbiter lease when it runs, so a lease that moves in the meantime (a concurrent sync-set change or switchover) can still refuse it then.`,
		);
	}

	// ---- failover (DatabaseFailoverPolicyService.arm / disarm)
	const liveMode = row?.failoverMode ?? 'manual';
	const agentRefusal = 'AI agents cannot change failover through a blueprint; it arms or disarms automatic promotion. Apply it from the dashboard or CLI.';
	if (database.failover === 'manual' && liveMode === 'auto') {
		changes.push({ path: 'failover', from: 'auto', to: 'manual' });
		writes.failover = { mode: 'manual' };
		if (principal.credential === 'oauth') refuse('failover', agentRefusal);
	} else if (database.failover === 'auto') {
		const acceptDataLoss = database.acceptDataLoss ?? false;
		const liveAccept = row?.acceptDataLoss ?? false;
		const rearm = liveMode === 'auto' && database.acceptDataLoss === true && !liveAccept;
		// `arm` never clears the acknowledgement; `disarm` does, so that is the way back.
		if (liveMode === 'auto' && database.acceptDataLoss === false && liveAccept)
			refuse(
				'acceptDataLoss',
				`"${name}" is armed with acceptDataLoss: true, and arming never clears it. Set failover: manual and apply, then set failover: auto with acceptDataLoss: false and apply again.`,
			);
		if (liveMode !== 'auto' || rearm) {
			changes.push(rearm ? { path: 'acceptDataLoss', from: 'false', to: 'true' } : { path: 'failover', from: liveMode, to: 'auto' });
			writes.failover = { mode: 'auto', acceptDataLoss };
			const refusals: Pick<FailoverArmRefusal, 'code' | 'message'>[] = [];
			if (principal.credential === 'oauth') refuse('failover', agentRefusal);
			// A database this plan creates gets W11's own codes below (`no-drill` names the staging).
			else if (addingReplicas && row)
				refuse(
					'failover',
					`failover: auto is refused: this plan also adds replicas, which must stream before automatic failover can count on them. Apply without failover: auto first, wait for the replicas to stream (\`yoal db replica list ${name}\`), then set failover: auto and apply again.`,
				);
			else if (!row) {
				if (!featureEnabled(ctx.config, 'DB_AUTO_PROMOTE'))
					refusals.push({ code: 'auto-promote-off', message: NEW_DATABASE_ARM_REFUSALS['auto-promote-off'] });
				refusals.push({ code: 'no-drill', message: NEW_DATABASE_ARM_REFUSALS['no-drill'](name) });
				const fencing = nodes.some(
					(node) => node.status === 'online' && node.roles.includes('data') && node.capabilities.includes(DB_MEMBER_SELF_FENCING_CAPABILITY),
				);
				if (!fencing) refusals.push({ code: 'no-self-fencing-path', message: NEW_DATABASE_ARM_REFUSALS['no-self-fencing-path'] });
			} else {
				refusals.push(...ctx.failoverPolicies.armRefusals(principal, name, { acceptDataLoss }));
				if (durabilityChanges && !refusals.some((refusal) => refusal.code === 'sync-transition-open'))
					refusals.push({
						code: 'sync-transition-open',
						message: 'This plan also changes durability, which opens a sync-set transition; arm auto in a later apply, once it has closed.',
					});
			}
			for (const refusal of refusals) refuse('failover', `failover: auto is refused [${refusal.code}]: ${refusal.message}`);
			if (row && !problems.some((problem) => problem.path[0] === path('failover')[0]))
				warnings.push(
					`databases.${name}.failover: arming re-checks the policy when it runs, so a change in the meantime (a member going offline, a drill expiring) can still refuse it then.`,
				);
		}
	}

	// ---- backups (assertions: where this database's backups go)
	if (database.backups) {
		const resolved = ctx.backupTargets.resolveTarget(principal.orgId);
		if (database.backups.target !== undefined && resolved.target.name !== database.backups.target)
			refuse(
				'backups.target',
				`Backups of "${name}" go to "${resolved.target.name}" (the ${resolved.source} target), not "${database.backups.target}". A database has no backup target of its own: make "${database.backups.target}" this organisation's first backup target in Settings → Backups.`,
			);
		if (database.backups.immutable === true && !resolved.target.objectLock)
			refuse(
				'backups.immutable',
				`Backups of "${name}" go to "${resolved.target.name}", which is not immutable. Turn on object lock (S3) or an immutability policy (Azure, GCS) for that target in Settings → Backups.`,
			);
	}

	// Every service this step calls refuses a database that is moving or failing over, so say that
	// once, instead of the knock-on refusals.
	if (row && changes.length) {
		const blocked =
			refusalOf(() => ctx.moves.assertNotMoving(row)) ??
			(ctx.databaseReplicas.isFailingOver(row.id) ? `"${name}" is failing over; wait for the promotion to finish.` : null);
		if (blocked) problems.splice(0, problems.length, { path: [`databases.${name}`], message: blocked });
	}

	const action: BlueprintPlanAction = changes.length ? (creating ? 'create' : 'update') : 'noop';
	return {
		result: { step: { key, action, changes, reason: null, permissions: ['database:update'] }, problems, warnings },
		writes: changes.length ? writes : null,
	};
}

/**
 * Nodes for new replicas: online data nodes whose agent runs replicas and that have an overlay
 * address, never the primary's node or one that already holds a replica, each in a new failure
 * domain under `spread` (`node`, the default, or `zone`), with room for a full copy. Chosen in a
 * stable order (zone, then name), so the same live state always plans the same nodes.
 */
function pickReplicaNodes(
	ctx: CoreContext,
	input: {
		row: DatabaseRow | undefined;
		nodes: NodeView[];
		liveReplicas: string[];
		/** Nodes whose previous replica is still being removed: `add` refuses them. */
		removingOn: string[];
		count: number;
		spread: ReplicaSpread | undefined;
		memoryMb: number;
		pitr: boolean;
	},
): { nodes: NodeView[]; problem: string | null } {
	const spread = input.spread === 'zone' || input.spread === 'region' ? 'zone' : 'node';
	const free = new Map(ctx.workloads.placementCandidates().map((candidate) => [candidate.id, candidate.sliceMemoryMb - candidate.reservedMemoryMb]));
	const eligible = input.nodes
		.filter(
			(node) =>
				node.status === 'online' &&
				node.roles.includes('data') &&
				node.capabilities.includes(DATABASE_REPLICAS_CAPABILITY) &&
				node.privateAddress !== null &&
				(free.get(node.id) ?? 0) >= input.memoryMb &&
				// `pitrRewindForNode`'s capability rule; the PITR_REWIND flag is refused on its own.
				(!input.pitr || node.capabilities.includes(PITR_REWIND_CAPABILITY) || node.capabilities.includes(DB_MEMBER_CAPABILITY)),
		)
		.sort((a, b) => a.zone.localeCompare(b.zone) || a.name.localeCompare(b.name));
	const domain = (node: Pick<NodeView, 'id' | 'zone'>) => (spread === 'zone' ? node.zone : node.id);
	const byId = new Map(input.nodes.map((node) => [node.id, node]));
	const need = `${plural(input.count, 'more replica')} with spread: ${spread}`;
	const rule = `an online data node that advertises "${DATABASE_REPLICAS_CAPABILITY}"${input.pitr ? ' and "pitr-rewind"' : ''}, has an overlay address and ${input.memoryMb} MB free`;
	if (!input.row) {
		// The primary's node is chosen when the database is created; the replicas need their own domains besides it.
		const domains = new Set(eligible.map(domain)).size;
		if (domains < input.count + 1)
			return {
				nodes: [],
				problem: `The primary and ${need} need ${input.count + 1} different ${spread === 'zone' ? 'zones' : 'nodes'}, each with ${rule}; the fleet has ${domains}.`,
			};
		return { nodes: [], problem: null };
	}
	const primary = byId.get(input.row.nodeId);
	if (!primary?.capabilities.includes(DATABASE_REPLICAS_CAPABILITY))
		return { nodes: [], problem: `The agent on "${primary?.name ?? input.row.nodeId}" is too old to run database replicas (it does not advertise "${DATABASE_REPLICAS_CAPABILITY}"). Update it first.` };
	if (!primary.privateAddress)
		return { nodes: [], problem: `The primary's node "${primary.name}" has no managed overlay address, so a replica on another node cannot reach it.` };
	const row = input.row;
	const members = [row.nodeId, ...input.liveReplicas];
	const taken = new Set([...members, ...input.removingOn]);
	const used = new Set(members.map((id) => domain(byId.get(id) ?? { id, zone: id })));
	const chosen: NodeView[] = [];
	const unusable: string[] = [];
	for (const node of eligible) {
		if (chosen.length === input.count) break;
		if (taken.has(node.id) || used.has(domain(node))) continue;
		// The disk `add` would pick on that node: the primary's kind of disk, with room for a copy.
		const disk = refusalOf(() => ctx.disks.pick(ctx.disks.plan('databases', ctx.disks.targetOf(row.diskId), node.id), node.id, row.storageMb));
		if (disk) {
			unusable.push(disk);
			continue;
		}
		chosen.push(node);
		used.add(domain(node));
	}
	if (chosen.length < input.count)
		return {
			nodes: [],
			problem: `${need} need${input.count === 1 ? 's' : ''} ${input.count} ${spread === 'zone' ? 'zones' : 'nodes'} not yet used by "${row.name}", each with ${rule}; ${chosen.length} ${chosen.length === 1 ? 'is' : 'are'} available.${unusable.length ? ` Not usable: ${unusable.join(' ')}` : ''}`,
		};
	return { nodes: chosen, problem: null };
}
