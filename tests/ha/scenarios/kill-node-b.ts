#!/usr/bin/env bun
/**
 * Scenario: kill node-b (docs/HA-PLAN.md W1 exit, §1.2 "one app copy or its node").
 *
 * On a running lab (`bun tests/lab/lab.ts up`):
 *
 *   1. deploy the checker app (tests/ha/checker/app) as a process app with a Postgres database on
 *      lab-a, in two copies spread across lab-a and lab-b (MULTI_NODE_REPLICAS, failover.enabled)
 *   2. run the checker through lab-a's public route for --duration-s
 *   3. after --kill-after-s, take lab-b away: power it off (`--method kill`, docker kill) or cut it
 *      off from every peer with the helper's partition verb (`--method partition`)
 *   4. watch the fleet: lab-b offline, its copy re-placed on another node, the new copy answering
 *   5. write the checker's report plus the timings to --out
 *
 *   bun tests/ha/scenarios/kill-node-b.ts [--duration-s 300] [--rate 20] [--seed 1]
 *       [--kill-after-s 30] [--method kill|partition] [--out <dir>] [--keep-down]
 *       [--checker tests/ha/checker/cli.ts]
 *
 * Exit code: the checker's (non-zero when an invariant fails), or 2 when the scenario itself could
 * not run. The numbers are reported either way; this scenario has no pass bound yet, it measures
 * the current tree (HA-PLAN §1.2 sets the bounds later work must meet).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CONTROL, LAB, containerName, labNode } from '../../lab/lab.config.ts';
import { docker, exec } from '../../lab/lib/docker.ts';
import { Observer, PUBLIC_BASE, api, fleetNodes, helperCall, labToken, ownerAction, type FleetNode } from '../../lab/lib/api.ts';

const { values: flags } = parseArgs({
	options: {
		'duration-s': { type: 'string', default: '300' },
		rate: { type: 'string', default: '20' },
		seed: { type: 'string', default: '1' },
		'kill-after-s': { type: 'string', default: '30' },
		method: { type: 'string', default: 'kill' },
		out: { type: 'string' },
		'keep-down': { type: 'boolean', default: false },
		checker: { type: 'string', default: 'tests/ha/checker/cli.ts' },
		project: { type: 'string', default: 'ha-checker' },
	},
});

const REPO = resolve(import.meta.dir, '../../..');
const PROJECT = flags.project!;
const VICTIM = 'lab-b';
const KEEPER = CONTROL.name;
const OTHERS = LAB.nodes.map((node) => node.name).filter((name) => name !== VICTIM && name !== KEEPER);
const durationS = Number(flags['duration-s']);
const killAfterS = Number(flags['kill-after-s']);
const method = flags.method as 'kill' | 'partition';
if (method !== 'kill' && method !== 'partition') throw new Error('--method is kill or partition');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = resolve(flags.out ?? join(REPO, 'tests/ha/.out', `kill-node-b-${stamp}`));
mkdirSync(OUT, { recursive: true });
const observations = join(OUT, 'observations.jsonl');
writeFileSync(observations, '');
const observer = new Observer(observations);

const say = (message: string) => console.log(`\x1b[1m==> ${message}\x1b[0m`);
const note = (message: string) => console.log(`    ${message}`);

interface Copy {
	id: string;
	index: number;
	nodeName: string;
	status: string;
}

async function copies(): Promise<Copy[]> {
	const view = await api<{ copies: Copy[] }>('GET', `/api/v1/projects/${PROJECT}/scaling`);
	return view.body.copies ?? [];
}

async function waitFor<T>(label: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false>): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown = null;
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (value) return value;
		} catch (error) {
			last = error;
		}
		await Bun.sleep(2000);
	}
	throw new Error(`timed out waiting for ${label}${last ? `: ${(last as Error).message}` : ''}`);
}

function yoalCli(args: string[]): string {
	return exec(containerName(CONTROL.name), ['yoal', ...args], {
		env: { YOAL_URL: `http://${CONTROL.ip}`, YOAL_TOKEN: labToken() },
	}).stdout;
}

/** The app's public host on lab-a (`<slug>.<content domain>` for production). */
async function appHost(): Promise<string> {
	const project = (await api<any>('GET', `/api/v1/projects/${PROJECT}`)).body;
	const candidates: unknown[] = [project?.url, project?.productionUrl, project?.project?.url, project?.urls?.production, ...(project?.domains ?? []).map((domain: any) => domain?.hostname ?? domain)];
	for (const candidate of candidates) {
		if (typeof candidate !== 'string' || !candidate) continue;
		try {
			return new URL(candidate.includes('://') ? candidate : `http://${candidate}`).host;
		} catch {
			// next
		}
	}
	const status = await fetch(`${PUBLIC_BASE}/api/setup/status`, { headers: { host: CONTROL.ip } }).then((response) => response.json() as Promise<{ contentDomain: string }>);
	return `${PROJECT}.${status.contentDomain}`;
}

async function whoami(host: string): Promise<{ node: string; copy: string } | null> {
	try {
		const response = await fetch(`${PUBLIC_BASE}/whoami`, { headers: { host }, signal: AbortSignal.timeout(3000) });
		if (!response.ok) return null;
		const node = response.headers.get('x-checker-node');
		const copy = response.headers.get('x-checker-copy');
		if (node) return { node, copy: copy ?? '' };
		const body = (await response.json()) as { node?: string; copy?: string };
		return body.node ? { node: body.node, copy: body.copy ?? '' } : null;
	} catch {
		return null;
	}
}

// --- 0. preflight ------------------------------------------------------------------------------

say('preflight');
const fleet = fleetNodes();
for (const node of LAB.nodes) {
	const row = fleet.find((candidate) => candidate.name === node.name);
	if (row?.status !== 'online') {
		console.error(`${node.name} is ${row?.status ?? 'missing'}: run \`bun tests/lab/lab.ts up\` (and \`lab start ${node.name}\`) first`);
		process.exit(2);
	}
}
note(`fleet: ${fleet.map((node) => `${node.name}=${node.status}`).join(', ')}`);
const checkerCli = resolve(REPO, flags.checker!);
if (!existsSync(checkerCli)) {
	console.error(`checker CLI ${checkerCli} not found (Lane B: tests/ha/checker/cli.ts)`);
	process.exit(2);
}

// --- 1. deploy the checker app: database and copy 0 on lab-a, copy 1 on lab-b ------------------

say(`deploying ${PROJECT} (database and first copy on ${KEEPER}, second copy on ${VICTIM})`);
const created = await api('POST', '/api/v1/projects', { name: PROJECT, slug: PROJECT, runtime: 'process' }, { allowStatus: [409] });
note(created.status === 409 ? 'project exists' : 'project created');
// Only lab-a may take new placements while the database and the first copy land.
ownerAction(['--drain', [VICTIM, ...OTHERS].join(',')]);
try {
	await api('PUT', `/api/v1/projects/${PROJECT}/workload`, {
		runtime: 'process',
		command: ['bun', 'run', 'start'],
		port: 8080,
		memoryMb: 128,
		cpus: 0.5,
		healthPath: '/healthz',
		socketActivation: false,
		idleStopSeconds: 0,
	});
	const databases = yoalCli(['db', 'list', '--json']);
	if (!databases.includes(`"${PROJECT}-db"`)) {
		note(yoalCli(['db', 'create', `${PROJECT}-db`, '-p', PROJECT]).trim().split('\n').slice(-1)[0] ?? '');
	}
	note(yoalCli(['deploy', `${LAB.sourceDir}/tests/ha/checker/app`, '--project', PROJECT, '--message', 'kill-node-b']).trim().split('\n').slice(-1)[0] ?? '');
	await waitFor(`${PROJECT} copy 0 running`, 300_000, async () => (await copies()).some((copy) => copy.status === 'running') || (await api<any>('GET', `/api/v1/projects/${PROJECT}`)).body?.workload?.status === 'running');
	ownerAction(['--resume', VICTIM]);
	await api('POST', `/api/v1/projects/${PROJECT}/scale`, { replicas: 2 });
	await waitFor(`two running copies on ${KEEPER} and ${VICTIM}`, 300_000, async () => {
		const list = await copies();
		return list.length === 2 && [KEEPER, VICTIM].every((name) => list.some((copy) => copy.nodeName === name && copy.status === 'running'));
	});
} finally {
	ownerAction(['--resume', [VICTIM, ...OTHERS].join(',')]);
}
const host = await appHost();
note(`public route http://${host} via ${PUBLIC_BASE}`);
const seen = await waitFor('both copies answering through the public route', 120_000, async () => {
	const nodes = new Set<string>();
	for (let i = 0; i < 30; i++) {
		const who = await whoami(host);
		if (who) nodes.add(who.node);
	}
	return nodes.has(KEEPER) && nodes.has(VICTIM) ? [...nodes] : null;
});
note(`copies answering: ${seen.join(', ')}`);
const before = await copies();
for (const copy of before) observer.note('route', copy.nodeName, { copy: copy.id, status: copy.status, phase: 'before' });

// --- 2–4. checker run, fault, watch -------------------------------------------------------------

say(`checker: ${durationS}s at ${flags.rate}/s, seed ${flags.seed}; ${method} ${VICTIM} at +${killAfterS}s`);
const reportPath = join(OUT, 'report.json');
const checker = Bun.spawn(
	['bun', checkerCli, '--url', PUBLIC_BASE, '--host', host, '--duration-s', String(durationS), '--rate', flags.rate!, '--seed', flags.seed!, '--observe', observations, '--out', reportPath],
	{ cwd: REPO, stdout: Bun.file(join(OUT, 'checker.log')), stderr: 'inherit' },
);
const runStart = Date.now();
const timings: Record<string, number | string | null> = { method, victim: VICTIM, durationS, killAfterS, runStartedAt: new Date(runStart).toISOString() };
const rel = (t: number) => Math.round(t - (timings.faultAtMs as number));

await Bun.sleep(killAfterS * 1000);
const faultAt = Date.now();
timings.faultAtMs = faultAt;
if (method === 'kill') {
	docker(['kill', containerName(VICTIM)]);
	note(`${VICTIM} powered off (docker kill)`);
} else {
	const peers = [...LAB.nodes.filter((node) => node.name !== VICTIM).flatMap((node) => [node.ip, fleet.find((row) => row.name === node.name)?.privateAddress ?? null]), '172.30.147.1'].filter((value): value is string => Boolean(value));
	const result = helperCall(VICTIM, 'POST', '/v1/faults/partition', { peers, direction: 'both', durationS: Math.max(60, durationS) });
	if (result.status !== 200) throw new Error(`partition failed: ${JSON.stringify(result.body)}`);
	note(`${VICTIM} partitioned from every peer and the host gateway (fault ${result.body.fault.id})`);
}
observer.note('fault', VICTIM, { action: method === 'kill' ? 'power-off' : 'partition' });

let victimOffline: number | null = null;
let replacedPlaced: number | null = null;
let replacedRunning: number | null = null;
let newCopyAnswering: number | null = null;
let replacementNode: string | null = null;
let lastNodes = 0;
const watchUntil = runStart + durationS * 1000;
while (Date.now() < watchUntil && checker.exitCode === null) {
	const now = Date.now();
	if (victimOffline === null && now - lastNodes > 3000) {
		lastNodes = now;
		try {
			const status = fleetNodes().find((node: FleetNode) => node.name === VICTIM)?.status;
			if (status && status !== 'online') {
				victimOffline = now;
				observer.note('ingress', VICTIM, { status, afterMs: rel(now) });
				note(`+${(rel(now) / 1000).toFixed(1)}s ${VICTIM} is ${status}`);
			}
		} catch {
			// lab-a busy; next tick
		}
	}
	if (replacedRunning === null) {
		try {
			const list = await copies();
			const moved = list.find((copy) => copy.nodeName !== KEEPER && copy.nodeName !== VICTIM);
			if (moved && replacedPlaced === null) {
				replacedPlaced = Date.now();
				replacementNode = moved.nodeName;
				observer.note('route', moved.nodeName, { copy: moved.id, status: moved.status, phase: 'placed', afterMs: rel(replacedPlaced) });
				note(`+${(rel(replacedPlaced) / 1000).toFixed(1)}s copy ${moved.id} placed on ${moved.nodeName} (${moved.status})`);
			}
			if (moved?.status === 'running') {
				replacedRunning = Date.now();
				observer.note('route', moved.nodeName, { copy: moved.id, status: 'running', phase: 'running', afterMs: rel(replacedRunning) });
				note(`+${(rel(replacedRunning) / 1000).toFixed(1)}s copy ${moved.id} running on ${moved.nodeName}`);
			}
		} catch {
			// control plane slow; next tick
		}
	}
	if (replacementNode && newCopyAnswering === null) {
		const who = await whoami(host);
		if (who?.node === replacementNode) {
			newCopyAnswering = Date.now();
			observer.note('route', replacementNode, { phase: 'answering', afterMs: rel(newCopyAnswering) });
			note(`+${(rel(newCopyAnswering) / 1000).toFixed(1)}s ${replacementNode} answers through the public route`);
		}
	}
	if (victimOffline && replacedRunning && newCopyAnswering) {
		await Promise.race([checker.exited, Bun.sleep(1000)]);
		continue;
	}
	await Bun.sleep(1000);
}
const checkerExit = await checker.exited;

timings.victimOfflineAfterMs = victimOffline ? rel(victimOffline) : null;
timings.replacementPlacedAfterMs = replacedPlaced ? rel(replacedPlaced) : null;
timings.replacementRunningAfterMs = replacedRunning ? rel(replacedRunning) : null;
timings.replacementAnsweringAfterMs = newCopyAnswering ? rel(newCopyAnswering) : null;
timings.replacementNode = replacementNode;
timings.checkerExit = checkerExit;
delete timings.faultAtMs;
timings.faultAt = new Date(faultAt).toISOString();

// --- 5. restore and report -----------------------------------------------------------------------

if (!flags['keep-down']) {
	if (method === 'kill') docker(['start', containerName(VICTIM)]);
	else helperCall(VICTIM, 'POST', '/v1/faults/clear-all', {});
	note(`${VICTIM} restored (${method === 'kill' ? 'docker start' : 'faults cleared'}); it rejoins on its own`);
}

const report = existsSync(reportPath) ? (JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, any>) : null;
const summary = {
	scenario: 'kill-node-b',
	...timings,
	failedRequests: report?.failedRequests ?? null,
	requests: report?.requests ?? null,
	failedByStatus: report?.failedByStatus ?? null,
	longestWriteGapMs: report?.longestWriteGapMs ?? null,
	acknowledgedWrites: report?.acknowledgedWrites ?? null,
	lostAcknowledgedWrites: report?.lostAcknowledgedWrites ?? null,
	invariants: report ? Object.fromEntries(Object.entries(report.invariants ?? {}).map(([key, value]: [string, any]) => [key, value?.status])) : null,
	copiesBefore: before.map((copy) => `${copy.id}@${copy.nodeName}`),
	labNodes: LAB.nodes.map((node) => labNode(node.name).name),
};
writeFileSync(join(OUT, 'timings.json'), `${JSON.stringify(summary, null, 2)}\n`);
const secs = (ms: unknown) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)} s` : 'not observed');
writeFileSync(
	join(OUT, 'summary.md'),
	[
		`# kill-node-b — ${timings.runStartedAt}`,
		'',
		`Method: ${method} ${VICTIM} at +${killAfterS} s of a ${durationS} s checker run (${flags.rate}/s, seed ${flags.seed}).`,
		'',
		'| Measure | Value |',
		'|---|---|',
		`| Requests / failed | ${summary.requests ?? '?'} / ${summary.failedRequests ?? '?'} |`,
		`| Failed by status | ${JSON.stringify(summary.failedByStatus ?? {})} |`,
		`| Longest write gap | ${secs(summary.longestWriteGapMs)} |`,
		`| Acknowledged / lost writes | ${summary.acknowledgedWrites ?? '?'} / ${summary.lostAcknowledgedWrites ?? '?'} |`,
		`| ${VICTIM} reported offline after | ${secs(timings.victimOfflineAfterMs)} |`,
		`| Copy re-placed (row on ${replacementNode ?? 'another node'}) after | ${secs(timings.replacementPlacedAfterMs)} |`,
		`| Re-placed copy running after | ${secs(timings.replacementRunningAfterMs)} |`,
		`| Re-placed copy answering through the public route after | ${secs(timings.replacementAnsweringAfterMs)} |`,
		`| Checker exit | ${checkerExit} |`,
		'',
	].join('\n'),
);
say(`results in ${OUT}`);
console.log(readFileSync(join(OUT, 'summary.md'), 'utf8'));
process.exit(checkerExit);
