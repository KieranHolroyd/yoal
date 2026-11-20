/**
 * The checker app (tests/ha/checker/app) on the lab: a project, a Postgres database on a chosen
 * node, a process or container workload, and N copies placed on chosen nodes. Every call goes
 * through the platform's own API or CLI, as an operator would.
 *
 * Placement is steered with drain/resume: copy k is added while every node outside the first k+1
 * named nodes is drained, so the scheduler (one HTTP copy per node, `spread`) has one choice. The
 * drains are always undone, also on failure.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CONTROL, LAB, containerName } from '../../../lab/lab.config.ts';
import { docker, exec, run } from '../../../lab/lib/docker.ts';
import { PUBLIC_BASE, api, fleetNodes, labToken, ownerAction, type FleetNode } from '../../../lab/lib/api.ts';
import { REPO, waitFor, type Scenario } from './scenario.ts';

export interface Copy {
	id: string;
	index: number;
	nodeName: string;
	status: string;
	release?: 'current' | 'previous';
}

export interface ScalingView {
	replicas: number;
	mode: string;
	blocker: string | null;
	copies: Copy[];
	rollout: { status: string; message: string | null; updated: number; total: number; surge: boolean; automatic: boolean } | null;
	lastRollback: { at: string; note: string } | null;
}

export type Runtime = 'process' | 'container';

/** The checker app's directory on every lab node (the shipped checkout). */
export const CHECKER_APP_DIR = `${LAB.sourceDir}/tests/ha/checker/app`;

export function yoalCli(args: string[], options: { allowFailure?: boolean } = {}): { code: number; stdout: string; stderr: string } {
	return exec(containerName(CONTROL.name), ['yoal', ...args], {
		env: { YOAL_URL: `http://${CONTROL.ip}`, YOAL_TOKEN: labToken() },
		allowFailure: options.allowFailure,
	});
}

export function nodeId(name: string, fleet: FleetNode[] = fleetNodes()): string {
	const node = fleet.find((candidate) => candidate.name === name);
	if (!node) throw new Error(`no fleet node named ${name}`);
	return node.id;
}

export async function scaling(project: string): Promise<ScalingView> {
	return (await api<ScalingView>('GET', `/api/v1/projects/${project}/scaling`)).body;
}

export async function copies(project: string): Promise<Copy[]> {
	return (await scaling(project)).copies ?? [];
}

export function describeCopies(list: Copy[]): string[] {
	return list.map((copy) => `${copy.id}@${copy.nodeName}:${copy.status}${copy.release ? `:${copy.release}` : ''}`);
}

/** The app's public host on lab-a (`<slug>.<content domain>`). */
export async function appHost(project: string): Promise<string> {
	const body = (await api<any>('GET', `/api/v1/projects/${project}`)).body;
	const candidates: unknown[] = [body?.url, body?.productionUrl, body?.project?.url, body?.urls?.production, ...(body?.domains ?? []).map((domain: any) => domain?.hostname ?? domain)];
	for (const candidate of candidates) {
		if (typeof candidate !== 'string' || !candidate) continue;
		try {
			return new URL(candidate.includes('://') ? candidate : `http://${candidate}`).host;
		} catch {
			// next
		}
	}
	const status = await fetch(`${PUBLIC_BASE}/api/setup/status`, { headers: { host: CONTROL.ip } }).then((response) => response.json() as Promise<{ contentDomain: string }>);
	return `${project}.${status.contentDomain}`;
}

/** Create the project (placement auto: the default `edge` pins an app to one node), or reuse it. */
export async function ensureProject(project: string, runtime: Runtime): Promise<'created' | 'exists'> {
	const created = await api('POST', '/api/v1/projects', { name: project, slug: project, runtime, placement: 'auto' }, { allowStatus: [409] });
	if (created.status === 409) {
		const existing = (await api<any>('GET', `/api/v1/projects/${project}`)).body;
		const existingRuntime = existing?.runtime ?? existing?.project?.runtime;
		if (existingRuntime && existingRuntime !== runtime)
			throw new Error(`project ${project} exists with runtime ${existingRuntime}, not ${runtime}: pass another --project`);
		await api('PATCH', `/api/v1/projects/${project}`, { placement: 'auto' });
		return 'exists';
	}
	return 'created';
}

export interface DatabaseInfo {
	name: string;
	node: string;
	created: boolean;
}

/**
 * A Postgres database for the app on `node` (by node id: the create API's `placement`), attached
 * to the project as `DATABASE`. An existing one is reused wherever it is; the caller checks.
 */
export async function ensureDatabase(project: string, name: string, node: string): Promise<DatabaseInfo> {
	const listed = (await api<{ databases: Array<{ name: string; nodeName?: string; node?: string; nodeId?: string }> }>('GET', '/api/v1/databases')).body.databases ?? [];
	const found = listed.find((database) => database.name === name);
	let created = false;
	if (!found) {
		await api('POST', '/api/v1/databases', { name, engine: 'postgres', placement: nodeId(node), memoryMb: 256, storageMb: 1024, pooler: false });
		created = true;
	}
	const attachments = (await api<{ attachments: Array<{ database?: string; databaseName?: string; name?: string }> }>('GET', `/api/v1/projects/${project}/databases`)).body.attachments ?? [];
	if (!attachments.some((item) => [item.database, item.databaseName, item.name].includes(name)))
		await api('POST', `/api/v1/projects/${project}/databases`, { database: name });
	const view = (await api<any>('GET', `/api/v1/databases/${name}`)).body;
	const where = view?.nodeName ?? view?.database?.nodeName ?? view?.node ?? node;
	await waitFor(`database ${name} running`, 300_000, async () => {
		const current = (await api<any>('GET', `/api/v1/databases/${name}`)).body;
		const status = current?.status ?? current?.database?.status;
		return status === 'running' || status === 'ready';
	});
	return { name, node: String(where), created };
}

/**
 * The app's port. A process app with socket activation off, and every container app, holds its port
 * on the node's loopback, so two scenario projects on one node must not share one: each project gets
 * its own in 24000–24999, a range no platform service or reservation uses (packages/contracts/src/host-ports.ts).
 */
export function appPort(project: string): number {
	let hash = 2166136261;
	for (const char of project) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
	return 24000 + (hash % 1000);
}

export interface WorkloadOptions {
	runtime: Runtime;
	/** Default: appPort(project) via setWorkload. */
	port?: number;
	/** Container only: the image (lab-loaded images are `localhost/...`). */
	image?: string;
	env?: Record<string, string>;
	healthPath?: string;
	memoryMb?: number;
	/** Extra spec fields (W5's `release`, `readinessPath`, …); the API decides whether it keeps them. */
	extra?: Record<string, unknown>;
}

export function workloadSpec(options: WorkloadOptions): Record<string, unknown> {
	const common = {
		runtime: options.runtime,
		port: options.port ?? 8080,
		memoryMb: options.memoryMb ?? 128,
		cpus: 0.5,
		healthPath: options.healthPath ?? '/healthz',
		env: { PORT: String(options.port ?? 8080), ...(options.env ?? {}) },
		...(options.extra ?? {}),
	};
	return options.runtime === 'process'
		? { ...common, command: ['bun', 'run', 'start'], socketActivation: false, idleStopSeconds: 0 }
		: { ...common, image: options.image };
}

export async function setWorkload(project: string, options: WorkloadOptions): Promise<any> {
	return (await api('PUT', `/api/v1/projects/${project}/workload`, workloadSpec({ port: appPort(project), ...options }))).body;
}

export async function workload(project: string): Promise<any> {
	return (await api<any>('GET', `/api/v1/projects/${project}/workload`, undefined, { allowStatus: [404] })).body;
}

/** Deploy a directory that is on lab-a (the checker app, or a copy of it with extra files). */
export function deployDirectory(project: string, dir: string, message: string): string {
	return yoalCli(['deploy', dir, '--project', project, '--message', message]).stdout.trim().split('\n').slice(-1)[0] ?? '';
}

export async function deployImage(project: string, image: string, message: string): Promise<any> {
	return (await api('POST', `/api/v1/projects/${project}/deploy-image`, { image, message })).body;
}

export async function deploy(project: string, runtime: Runtime, options: { image?: string; dir?: string; message: string }): Promise<string> {
	if (runtime === 'container') {
		const result = await deployImage(project, options.image!, options.message);
		return String(result?.deployment?.id ?? '');
	}
	return deployDirectory(project, options.dir ?? CHECKER_APP_DIR, options.message);
}

/**
 * Build the checker app's image on the host and load it into every named node's Podman, so a
 * container app runs it without a registry: `localhost/` images run by tag (no digest pin, see
 * packages/core/src/deployments.ts resolveImagePin) and Quadlet's default pull policy is `missing`.
 */
export function loadCheckerImage(nodes: string[]): string {
	const context = `${REPO}/tests/ha/checker/app`;
	const hash = createHash('sha256');
	for (const file of ['Dockerfile', 'package.json', 'server.ts']) hash.update(readFileSync(`${context}/${file}`));
	const tag = `${LAB.prefix}-checker-app:${hash.digest('hex').slice(0, 12)}`;
	const ref = `localhost/${tag}`;
	if (docker(['image', 'inspect', tag], { allowFailure: true }).code !== 0) docker(['build', '-q', '--label', LAB.label, '-t', tag, context]);
	const archive = run(['docker', 'save', tag], { binary: true }).bytes!;
	for (const node of nodes) {
		if (exec(containerName(node), ['podman', 'image', 'exists', ref], { allowFailure: true }).code === 0) continue;
		exec(containerName(node), ['podman', 'load', '-q'], { stdin: archive });
	}
	return ref;
}

/**
 * Place copies on exactly `nodes`, in order: copy 0 on nodes[0], copy 1 on nodes[1], … Drains every
 * other node while each copy lands, and resumes every node it drained afterwards, whatever happens.
 * `deployFirst` runs while only nodes[0] takes new work (the first deploy, if the app has none).
 */
export async function placeCopies(
	project: string,
	nodes: string[],
	deployFirst: () => Promise<unknown>,
	options: {
		timeoutMs?: number;
		log?: (line: string) => void;
		redeploy?: boolean;
		/** Register a cleanup that also runs on Ctrl-C, where this function's `finally` does not. */
		onCleanup?: (label: string, fn: () => unknown) => void;
	} = {},
): Promise<Copy[]> {
	const timeoutMs = options.timeoutMs ?? 300_000;
	const log = options.log ?? (() => {});
	// Only nodes in the fleet: a one-node lab has no lab-b to drain.
	const all = fleetNodes().map((node) => node.name);
	const want = nodes.slice();
	// A re-run: copies elsewhere, or more than wanted. Back to one copy first.
	const existing = await copies(project).catch(() => [] as Copy[]);
	const aligned = existing.length <= want.length && existing.every((copy, index) => copy.nodeName === want[index] || want.includes(copy.nodeName));
	if (existing.length > 1 && !aligned) {
		log(`existing copies ${describeCopies(existing).join(', ')}: scaling to 1 before placing again`);
		await api('POST', `/api/v1/projects/${project}/scale`, { replicas: 1 });
		await waitFor(`${project} back to one copy`, timeoutMs, async () => (await copies(project)).length === 1);
	}
	const drained = new Set<string>();
	options.onCleanup?.('resume nodes drained for placement', () => {
		if (drained.size) ownerAction(['--resume', [...drained].join(',')]);
		drained.clear();
	});
	const drainExcept = (keep: string[]) => {
		const drain = all.filter((name) => !keep.includes(name) && !drained.has(name));
		const resume = [...drained].filter((name) => keep.includes(name));
		if (drain.length) ownerAction(['--drain', drain.join(',')]);
		if (resume.length) ownerAction(['--resume', resume.join(',')]);
		for (const name of drain) drained.add(name);
		for (const name of resume) drained.delete(name);
	};
	try {
		const current = await copies(project).catch(() => [] as Copy[]);
		if (!current.some((copy) => copy.status === 'running' && copy.nodeName === want[0])) {
			if (current.length) {
				// One copy, somewhere else (or not running): back to nothing placed is not possible, so
				// move it by scaling to one and letting the drain push the redeploy onto want[0].
				log(`existing copy ${describeCopies(current).join(', ')} is not running on ${want[0]}: redeploying there`);
			}
			drainExcept([want[0]!]);
			await deployFirst();
			await waitFor(`${project} copy 0 running on ${want[0]}`, timeoutMs, async () => (await copies(project)).some((copy) => copy.status === 'running' && copy.nodeName === want[0]));
		} else if (options.redeploy) {
			// Copies already in place: deploy anyway, so the current spec (port, env) is what runs.
			await deployFirst();
			await waitFor(`${project} redeployed`, timeoutMs, async () => {
				const view = await scaling(project);
				return !view.rollout && view.copies.length > 0 && view.copies.every((copy) => copy.status === 'running' && copy.release !== 'previous');
			}, 3000);
		}
		for (let k = 1; k < want.length; k++) {
			const have = await copies(project);
			if (have.length > k && want.slice(0, k + 1).every((name) => have.some((copy) => copy.nodeName === name))) continue;
			drainExcept(want.slice(0, k + 1));
			const scaled = await api('POST', `/api/v1/projects/${project}/scale`, { replicas: k + 1 }, { allowStatus: [400, 409, 422] });
			if (scaled.status !== 200) {
				const message = typeof scaled.body === 'object' ? (scaled.body?.error?.message ?? scaled.body?.message ?? JSON.stringify(scaled.body)) : String(scaled.body);
				throw new ScaleRefused(message, scaled.status);
			}
			await waitFor(`copy ${k} running on ${want[k]}`, timeoutMs, async () => {
				const list = await copies(project);
				return want.slice(0, k + 1).every((name) => list.some((copy) => copy.nodeName === name && copy.status === 'running'));
			});
		}
	} finally {
		if (drained.size) ownerAction(['--resume', [...drained].join(',')]);
		drained.clear();
	}
	return copies(project);
}

export class ScaleRefused extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = 'ScaleRefused';
	}
}

/** What the node says about one copy's unit: when it started, its invocation, its env file's hash. */
export interface UnitInfo {
	copy: string;
	node: string;
	unit: string | null;
	activeState: string | null;
	invocationId: string | null;
	startedMonotonicUs: number | null;
	mainPid: number | null;
	/** sha256 over the sorted lines of the unit's environment file(s); never the values. */
	envHash: string | null;
	envFiles: string[];
}

export function unitInfo(copy: Copy): UnitInfo {
	const box = containerName(copy.nodeName);
	const info: UnitInfo = { copy: copy.id, node: copy.nodeName, unit: null, activeState: null, invocationId: null, startedMonotonicUs: null, mainPid: null, envHash: null, envFiles: [] };
	const units = exec(box, ['systemctl', 'list-units', '--all', '--plain', '--no-legend', 'yoal-workload-*'], { allowFailure: true })
		.stdout.split('\n')
		.map((line) => line.trim().split(/\s+/)[0] ?? '')
		.filter((unit) => unit.endsWith('.service') && unit.includes(copy.id));
	// The exact copy id (`wld_x` must not match `wld_x-r1`).
	const unit = units.find((name) => name === `yoal-workload-${copy.id}.service`) ?? units[0];
	if (!unit) return info;
	info.unit = unit;
	const props = Object.fromEntries(
		exec(box, ['systemctl', 'show', unit, '-p', 'ActiveState', '-p', 'InvocationID', '-p', 'ExecMainStartTimestampMonotonic', '-p', 'MainPID', '-p', 'EnvironmentFiles'], { allowFailure: true })
			.stdout.split('\n')
			.filter(Boolean)
			.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
	);
	info.activeState = props.ActiveState ?? null;
	info.invocationId = props.InvocationID || null;
	info.startedMonotonicUs = props.ExecMainStartTimestampMonotonic ? Number(props.ExecMainStartTimestampMonotonic) : null;
	info.mainPid = props.MainPID ? Number(props.MainPID) : null;
	const files = new Set<string>();
	for (const match of String(props.EnvironmentFiles ?? '').matchAll(/(\/[^\s(]+)/g)) files.add(match[1]!);
	if (!files.size) {
		// Quadlet passes the file to podman (`--env-file`), not to systemd.
		const text = exec(box, ['systemctl', 'cat', unit], { allowFailure: true }).stdout;
		for (const match of text.matchAll(/(?:--env-file[= ]|EnvironmentFile=-?)(\/[^\s]+)/g)) files.add(match[1]!);
	}
	info.envFiles = [...files];
	if (info.envFiles.length) {
		const hashed = exec(box, ['sh', '-c', 'cat "$@" 2>/dev/null | LC_ALL=C sort | sha256sum | cut -c1-16', 'hash', ...info.envFiles], { allowFailure: true }).stdout.trim();
		info.envHash = hashed || null;
	}
	return info;
}

export interface DeployedChecker {
	project: string;
	host: string;
	database: DatabaseInfo | null;
	copies: Copy[];
	/** Container only: the image the copies run. */
	image: string | null;
}

/**
 * The checker app in `nodes.length` copies, copy k on nodes[k], with a Postgres database on
 * `dbNode` attached as DATABASE (or none, with CHECKER_STORE=memory: then reads only see the copy
 * that took the write, so only single-copy runs make sense without a database).
 * Throws ScaleRefused when the platform refuses a copy (the caller decides what that means).
 */
export async function deployChecker(
	scenario: Pick<Scenario, 'note' | 'event' | 'measure' | 'onCleanup'>,
	options: {
		project: string;
		runtime: Runtime;
		nodes: string[];
		dbNode: string | null;
		message: string;
		env?: Record<string, string>;
		extra?: Record<string, unknown>;
		/** Before placing: refuse (ScaleRefused) unless the scaling view says copies may spread. */
		requireSpread?: boolean;
	},
): Promise<DeployedChecker> {
	scenario.note(`project ${options.project}: ${await ensureProject(options.project, options.runtime)}`);
	const image = options.runtime === 'container' ? loadCheckerImage([...new Set([...options.nodes, ...fleetNodes().map((node) => node.name)])]) : null;
	if (image) scenario.note(`checker image ${image} loaded into every node's Podman`);
	await setWorkload(options.project, { runtime: options.runtime, image: image ?? undefined, env: { ...(options.dbNode ? {} : { CHECKER_STORE: 'memory' }), ...(options.env ?? {}) }, extra: options.extra });
	let database: DatabaseInfo | null = null;
	if (options.dbNode) {
		database = await ensureDatabase(options.project, `${options.project}-db`, options.dbNode);
		scenario.measure('database', database);
		if (database.node !== options.dbNode) scenario.note(`database ${database.name} already existed on ${database.node}, not ${options.dbNode}; reused`);
	}
	if (options.requireSpread && options.nodes.length > 1) {
		const view = await scaling(options.project);
		scenario.measure('scalingBeforePlace', { mode: view.mode, blocker: view.blocker });
		if (view.mode !== 'spread') throw new ScaleRefused(`scaling mode ${view.mode}: ${view.blocker ?? 'no blocker given'}`, 0);
	}
	const placed = await placeCopies(options.project, options.nodes, () => deploy(options.project, options.runtime, { image: image ?? undefined, message: options.message }), { log: scenario.note, redeploy: true, onCleanup: scenario.onCleanup.bind(scenario) });
	scenario.event('copies placed', { copies: describeCopies(placed) });
	return { project: options.project, host: await appHost(options.project), database, copies: placed, image };
}
