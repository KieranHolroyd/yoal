#!/usr/bin/env bun
/**
 * Scenario: kill node-b (docs/HA-PLAN.md W1 exit, §1.2 "one app copy or its node").
 *
 * On a running lab (`bun tests/lab/lab.ts up`):
 *
 *   1. deploy the checker app (tests/ha/checker/app) as a process app with a Postgres database on
 *      lab-a, in two copies spread across lab-a and lab-b (MULTI_NODE_REPLICAS, failover.enabled)
 *   2. measure each copy's share of traffic; if lab-b's copy takes none, the run cannot measure a
 *      failover: the report is `invalid` and the exit code is 2
 *   3. run the checker for --duration-s, through lab-a's public route (`--target edge`, the default)
 *      or through the scenario's own client-side balancer straight to each copy's node
 *      (`--target direct`: the edge is bypassed, and the report says so)
 *   4. after --kill-after-s, take lab-b away: power it off (`--method kill`, docker kill) or cut it
 *      off from everything on the lab network and the overlay, s3lab and the host gateway included
 *      (`--method partition`, the helper's partition verb)
 *   5. watch the fleet: lab-b offline, its copy re-placed on another node, the new copy answering;
 *      measure each copy's share of traffic again at the end
 *   6. write the checker's report plus the timings to --out
 *
 *   bun tests/ha/scenarios/kill-node-b.ts [--duration-s 300] [--rate 20] [--seed 1]
 *       [--kill-after-s 30] [--method kill|partition] [--target edge|direct] [--out <dir>]
 *       [--keep-down] [--checker tests/ha/checker/cli.ts]
 *
 * Exit code: the checker's (non-zero when an invariant fails), or 2 when the scenario is invalid
 * (lab-b's copy never served) or could not run. The numbers are reported either way; this scenario
 * has no pass bound yet, it measures the current tree (HA-PLAN §1.2 sets the bounds later work must
 * meet).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CONTROL, LAB, containerName, labNode } from '../../lab/lab.config.ts';
import { docker, exec } from '../../lab/lib/docker.ts';
import { Observer, PUBLIC_BASE, api, fleetNodes, helperCall, labToken, ownerAction, type FleetNode } from '../../lab/lib/api.ts';
import { cidrComplement } from '../../lab/lib/net.ts';
import { LabRelay, RelayError } from '../../lab/lib/relay.ts';

const { values: flags } = parseArgs({
	options: {
		'duration-s': { type: 'string', default: '300' },
		rate: { type: 'string', default: '20' },
		seed: { type: 'string', default: '1' },
		'kill-after-s': { type: 'string', default: '30' },
		method: { type: 'string', default: 'kill' },
		target: { type: 'string', default: 'edge' },
		samples: { type: 'string', default: '60' },
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
/** The partition verb's own bound (apps/helper/src/faults.ts MAX_DURATION_S). */
const PARTITION_MAX_S = 3600;
/** The lab's overlay (README: managed WireGuard 10.47.0.0/22). */
const OVERLAY = '10.47.0.0/22';
const durationS = Number(flags['duration-s']);
const killAfterS = Number(flags['kill-after-s']);
const samples = Number(flags.samples);
const method = flags.method as 'kill' | 'partition';
const target = flags.target as 'edge' | 'direct';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = resolve(flags.out ?? join(REPO, 'tests/lab/.out', `kill-node-b-${target}-${stamp}`));

const say = (message: string) => console.log(`\x1b[1m==> ${message}\x1b[0m`);
const note = (message: string) => console.log(`    ${message}`);

/** Partition length: the whole run, so the fault cannot lapse before the scenario restores lab-b. */
const partitionDurationS = durationS;
function refuse(message: string): never {
	console.error(`kill-node-b: ${message}`);
	process.exit(2);
}
if (method !== 'kill' && method !== 'partition') refuse('--method is kill or partition');
if (target !== 'edge' && target !== 'direct') refuse('--target is edge or direct');
for (const [name, value] of [['--duration-s', durationS], ['--kill-after-s', killAfterS], ['--samples', samples]] as const)
	if (!Number.isInteger(value) || value < 1) refuse(`${name} must be a positive integer`);
if (killAfterS >= durationS) refuse('--kill-after-s must be less than --duration-s');
// Checked before anything starts: a partition the helper refuses must not leave a checker running.
if (method === 'partition' && partitionDurationS > PARTITION_MAX_S)
	refuse(`--method partition holds the partition for --duration-s (${partitionDurationS} s), above the verb's limit of ${PARTITION_MAX_S} s`);

mkdirSync(OUT, { recursive: true });
const observations = join(OUT, 'observations.jsonl');
writeFileSync(observations, '');
const observer = new Observer(observations);

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

/** Which copy answered one request to `base` for `host`. */
async function whoami(base: string, host: string): Promise<{ node: string; copy: string } | null> {
	try {
		const response = await fetch(`${base}/whoami`, { headers: { host }, signal: AbortSignal.timeout(3000) });
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

/** `count` requests through `base`: how many each node's copy answered (`none` = no answer). */
async function share(base: string, host: string, count: number): Promise<Record<string, number>> {
	const counts: Record<string, number> = {};
	for (let i = 0; i < count; i++) {
		const who = await whoami(base, host);
		const key = who?.node ?? 'none';
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

// --- the direct target: the scenario's own client-side balancer -------------------------------------

/**
 * `--target direct`. Bypasses lab-a's edge balancer: each request goes straight to one copy, round
 * robin over the running copies the API lists, at the address the edge itself would dial (a worker
 * copy's node Caddy on the overlay, `<privateAddress>:8080`; lab-a's copy on its local port, read
 * from lab-a's Caddy config). The host cannot route to those, so requests ride a stdio relay on lab-a
 * (tests/lab/node/relay.ts); lab-a is not the node this scenario takes away.
 *
 * A copy that refuses the connection or answers 502–504 is marked down for 5 s and the request goes
 * to the next one (it never reached a copy, so the retry cannot double a write); a timeout is
 * answered 504 and not retried (it may have). After the 5 s, one request at a time probes the copy
 * (half-open) until one succeeds, so a dead node costs one request per probe, not a burst.
 */
class CopyBalancer {
	private backends = new Map<string, string>();
	private readonly downUntil = new Map<string, number>();
	/** Nodes that were down and have one probe request in flight. */
	private readonly probing = new Set<string>();
	private next = 0;
	readonly served: Record<string, number> = {};
	private readonly server: ReturnType<typeof Bun.serve>;
	private localDial: string | null = null;

	constructor(
		private readonly host: string,
		private readonly relay: LabRelay,
		private readonly fleet: FleetNode[],
	) {
		this.server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => this.forward(request) });
	}

	get url(): string {
		return `http://127.0.0.1:${this.server.port}`;
	}

	/** The address the edge dials for `node`'s copy. */
	async address(node: string): Promise<string | null> {
		if (node === CONTROL.name) {
			this.localDial ??= (await this.relay.dials(this.host)).find((dial) => /^(127\.0\.0\.1|localhost):\d+$/.test(dial)) ?? null;
			return this.localDial ? `http://${this.localDial}` : null;
		}
		const row = this.fleet.find((candidate) => candidate.name === node) as (FleetNode & { publicAddress?: string | null }) | undefined;
		return row?.publicAddress ? `http://${row.publicAddress}` : row?.privateAddress ? `http://${row.privateAddress}:8080` : null;
	}

	async setNodes(nodes: string[]): Promise<void> {
		const next = new Map<string, string>();
		for (const node of [...new Set(nodes)].sort()) {
			const address = await this.address(node);
			if (address) next.set(node, address);
		}
		this.backends = next;
	}

	describe(): string {
		return [...this.backends].map(([node, address]) => `${node} (${address})`).join(', ');
	}

	/** One request straight to `node`'s copy (no balancing): who answered. */
	async probe(node: string, path = '/whoami'): Promise<{ node: string } | null> {
		const address = this.backends.get(node) ?? (await this.address(node));
		if (!address) return null;
		try {
			const response = await this.relay.fetch(`${address}${path}`, { method: 'GET', headers: [['host', this.host]], timeoutMs: 3000 });
			const answered = response.headers.find(([name]) => name.toLowerCase() === 'x-checker-node')?.[1];
			return response.status === 200 && answered ? { node: answered } : null;
		} catch {
			return null;
		}
	}

	async stop(): Promise<void> {
		this.server.stop(true);
		await this.relay.close();
	}

	/** Healthy copies first (round robin); a recovering copy only when no probe is in flight. */
	private order(): [string, string][] {
		const now = Date.now();
		const all = [...this.backends];
		const start = this.next++ % Math.max(1, all.length);
		const rotated = all.slice(start).concat(all.slice(0, start));
		const healthy = rotated.filter(([node]) => !this.downUntil.has(node));
		const recovering = rotated.filter(([node]) => this.downUntil.has(node) && this.downUntil.get(node)! <= now && !this.probing.has(node));
		const chosen = [...recovering.slice(0, 1), ...healthy];
		return chosen.length ? chosen : rotated;
	}

	private failed(node: string): void {
		this.probing.delete(node);
		this.downUntil.set(node, Date.now() + 5000);
	}

	private succeeded(node: string): void {
		this.probing.delete(node);
		this.downUntil.delete(node);
	}

	private async forward(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
		const headers: [string, string][] = [...request.headers].filter(([name]) => !['host', 'connection', 'content-length', 'transfer-encoding'].includes(name.toLowerCase()));
		headers.push(['host', this.host]);
		let last = 'no running copy';
		for (const [node, address] of this.order()) {
			if (this.downUntil.has(node)) this.probing.add(node);
			let response: Awaited<ReturnType<LabRelay['fetch']>>;
			try {
				response = await this.relay.fetch(`${address}${url.pathname}${url.search}`, { method: request.method, headers, body, timeoutMs: 3000 });
			} catch (error) {
				this.failed(node);
				if (error instanceof RelayError && error.timeout) return new Response(`copy on ${node} timed out`, { status: 504, headers: { 'x-lab-backend': node } });
				last = `${node}: ${(error as Error).message}`;
				continue;
			}
			if ([502, 503, 504].includes(response.status)) {
				this.failed(node);
				last = `${node}: HTTP ${response.status}`;
				continue;
			}
			this.succeeded(node);
			this.served[node] = (this.served[node] ?? 0) + 1;
			const out = new Headers(response.headers.filter(([name]) => !['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(name.toLowerCase())));
			out.set('x-lab-backend', node);
			return new Response(response.body as unknown as ConstructorParameters<typeof Response>[0], { status: response.status, headers: out });
		}
		return new Response(`no copy answered (${last})`, { status: 502 });
	}
}

// --- report --------------------------------------------------------------------------------------

const report: Record<string, unknown> = {
	scenario: 'kill-node-b',
	verdict: 'error',
	invalidReason: null,
	method,
	target: target === 'edge' ? 'edge (lab-a public route)' : 'direct (EDGE BYPASSED: scenario client-side balancer to each copy’s node)',
	victim: VICTIM,
	durationS,
	killAfterS,
	rate: Number(flags.rate),
	seed: Number(flags.seed),
};

function writeReport(): void {
	const checker = existsSync(join(OUT, 'report.json')) ? (JSON.parse(readFileSync(join(OUT, 'report.json'), 'utf8')) as Record<string, any>) : null;
	const summary = {
		...report,
		failedRequests: checker?.failedRequests ?? null,
		requests: checker?.requests ?? null,
		failedByStatus: checker?.failedByStatus ?? null,
		longestWriteGapMs: checker?.longestWriteGapMs ?? null,
		acknowledgedWrites: checker?.acknowledgedWrites ?? null,
		lostAcknowledgedWrites: checker?.lostAcknowledgedWrites ?? null,
		invariants: checker ? Object.fromEntries(Object.entries(checker.invariants ?? {}).map(([key, value]: [string, any]) => [key, value?.status])) : null,
		labNodes: LAB.nodes.map((node) => labNode(node.name).name),
	};
	writeFileSync(join(OUT, 'timings.json'), `${JSON.stringify(summary, null, 2)}\n`);
	const secs = (ms: unknown) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)} s` : 'not observed');
	const pct = (counts: unknown) => {
		if (!counts || typeof counts !== 'object') return 'not measured';
		const entries = Object.entries(counts as Record<string, number>);
		const total = entries.reduce((sum, [, value]) => sum + value, 0);
		return entries.map(([node, value]) => `${node} ${value}/${total} (${Math.round((100 * value) / Math.max(1, total))} %)`).join(', ') || 'none';
	};
	const lines = [
		`# kill-node-b — ${report.runStartedAt ?? new Date().toISOString()}`,
		'',
		`**Verdict: ${String(report.verdict).toUpperCase()}**${report.invalidReason ? ` — ${report.invalidReason}` : ''}`,
		'',
		`Target: ${report.target}.`,
		...(target === 'direct'
			? [
				'',
				'> **Edge bypassed.** Requests went through this scenario’s own client-side balancer (round robin, 5 s passive mark-down, half-open probes) straight to each copy, at the address lab-a’s edge would dial (relayed through lab-a), not through the edge’s own balancer. This measures copy failover and re-placement; it says nothing about the edge’s load balancing or health checks.',
			]
			: []),
		'',
		`Method: ${method} ${VICTIM} at +${killAfterS} s of a ${durationS} s checker run (${flags.rate}/s, seed ${flags.seed}).`,
		'',
		'| Measure | Value |',
		'|---|---|',
		`| Share of traffic before the fault | ${pct(report.shareBefore)} |`,
		`| Share of traffic after the fault (end of run) | ${pct(report.shareAfter)} |`,
		`| Requests / failed | ${summary.requests ?? '?'} / ${summary.failedRequests ?? '?'} |`,
		`| Failed by status | ${JSON.stringify(summary.failedByStatus ?? {})} |`,
		`| Longest write gap | ${secs(summary.longestWriteGapMs)} |`,
		`| Acknowledged / lost writes | ${summary.acknowledgedWrites ?? '?'} / ${summary.lostAcknowledgedWrites ?? '?'} |`,
		`| ${VICTIM} reported offline after | ${secs(report.victimOfflineAfterMs)} |`,
		`| Copy re-placed (row on ${report.replacementNode ?? 'another node'}) after | ${secs(report.replacementPlacedAfterMs)} |`,
		`| Re-placed copy running after | ${secs(report.replacementRunningAfterMs)} |`,
		`| Re-placed copy answering (${target === 'edge' ? 'through the public route' : 'on its node'}) after | ${secs(report.replacementAnsweringAfterMs)} |`,
		`| Checker exit | ${report.checkerExit ?? 'not run'} |`,
		...(method === 'partition' ? [`| Partition check (from ${VICTIM}) | ${report.partitionCheck ?? 'not run'} |`] : []),
		'',
		`Copies before the fault: ${(report.copiesBefore as string[] | undefined)?.join(', ') || '?'}. Copies at the end: ${(report.copiesAfter as string[] | undefined)?.join(', ') || '?'}.`,
		'',
	];
	writeFileSync(join(OUT, 'summary.md'), lines.join('\n'));
	say(`results in ${OUT}`);
	console.log(lines.join('\n'));
}

// --- run -----------------------------------------------------------------------------------------

// `as`: assigned inside run(), so TypeScript must not narrow them to null here.
let checker = null as ReturnType<typeof Bun.spawn> | null;
let balancer = null as CopyBalancer | null;
let faulted = false;
let restored = false;
const stopChecker = () => {
	if (checker && checker.exitCode === null) checker.kill();
};
function restoreVictim(): void {
	if (!faulted || restored || flags['keep-down']) return;
	restored = true;
	try {
		if (method === 'kill') docker(['start', containerName(VICTIM)]);
		else helperCall(VICTIM, 'POST', '/v1/faults/clear-all', {});
		note(`${VICTIM} restored (${method === 'kill' ? 'docker start' : 'faults cleared'}); it rejoins on its own`);
	} catch (error) {
		console.error(`could not restore ${VICTIM}: ${(error as Error).message}`);
	}
}
const signals = process as unknown as { once(event: 'SIGINT' | 'SIGTERM', listener: () => void): void };
for (const signal of ['SIGINT', 'SIGTERM'] as const)
	signals.once(signal, () => {
		stopChecker();
		restoreVictim();
		void balancer?.stop();
		process.exit(130);
	});

let exitCode = 2;
try {
	exitCode = await run();
} catch (error) {
	report.verdict = 'error';
	report.error = (error as Error).message;
	console.error(`\x1b[31mkill-node-b: ${(error as Error).message}\x1b[0m`);
	exitCode = 2;
} finally {
	stopChecker();
	if (checker) await checker.exited;
	restoreVictim();
	await balancer?.stop();
	writeReport();
}
process.exit(exitCode);

async function run(): Promise<number> {
	// --- 0. preflight ----------------------------------------------------------------------------
	say('preflight');
	const fleet = await waitFor('every lab node online', 180_000, async () => {
		const rows = fleetNodes();
		return LAB.nodes.every((node) => rows.find((row) => row.name === node.name)?.status === 'online') ? rows : null;
	}).catch((error: Error) => {
		throw new Error(`${error.message}: run \`bun tests/lab/lab.ts up\` (and \`lab start <node>\`) first`);
	});
	note(`fleet: ${fleet.map((node) => `${node.name}=${node.status}`).join(', ')}`);
	const checkerCli = resolve(REPO, flags.checker!);
	if (!existsSync(checkerCli)) throw new Error(`checker CLI ${checkerCli} not found (Lane B: tests/ha/checker/cli.ts)`);

	// --- 1. deploy: database and copy 0 on lab-a, copy 1 on lab-b -----------------------------------
	say(`deploying ${PROJECT} (database and first copy on ${KEEPER}, second copy on ${VICTIM})`);
	// `auto` placement: the default (`edge`) pins an app to one node, and a pinned app cannot spread.
	const created = await api('POST', '/api/v1/projects', { name: PROJECT, slug: PROJECT, runtime: 'process', placement: 'auto' }, { allowStatus: [409] });
	if (created.status === 409) await api('PATCH', `/api/v1/projects/${PROJECT}`, { placement: 'auto' });
	note(created.status === 409 ? 'project exists (placement auto)' : 'project created (placement auto)');
	// A re-run: an earlier run's re-placed copy is on another node. Back to one copy first.
	const existing = await copies().catch(() => [] as Copy[]);
	if (existing.length > 1 && !(existing.length === 2 && [KEEPER, VICTIM].every((name) => existing.some((copy) => copy.nodeName === name)))) {
		note(`existing copies ${existing.map((copy) => copy.nodeName).join(', ')}: scaling to 1 before placing again`);
		await api('POST', `/api/v1/projects/${PROJECT}/scale`, { replicas: 1 });
		await waitFor(`${PROJECT} back to one copy`, 180_000, async () => (await copies()).length === 1);
	}
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
		if (!databases.includes(`"${PROJECT}-db"`)) note(yoalCli(['db', 'create', `${PROJECT}-db`, '-p', PROJECT]).trim().split('\n').slice(-1)[0] ?? '');
		if (!existing.some((copy) => copy.status === 'running'))
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
	const before = await copies();
	report.copiesBefore = before.map((copy) => `${copy.id}@${copy.nodeName}:${copy.status}`);
	for (const copy of before) observer.note('route', copy.nodeName, { copy: copy.id, status: copy.status, phase: 'before' });

	// --- 2. who serves: each copy's share of traffic before the fault --------------------------------
	let base = PUBLIC_BASE;
	if (target === 'direct') {
		balancer = new CopyBalancer(host, new LabRelay(CONTROL.name), fleet);
		await balancer.setNodes(before.filter((copy) => copy.status === 'running').map((copy) => copy.nodeName));
		base = balancer.url;
		note(`EDGE BYPASSED: client-side balancer ${base} → ${balancer.describe()} (relayed through ${CONTROL.name}), Host ${host}`);
	} else note(`public route http://${host} via ${PUBLIC_BASE}`);
	let shareBefore: Record<string, number> = {};
	for (let round = 0; round < 6 && !shareBefore[VICTIM]; round++) {
		if (round > 0) await Bun.sleep(5000);
		shareBefore = await share(base, host, samples);
	}
	report.shareBefore = shareBefore;
	note(`share of ${samples} requests before the fault: ${JSON.stringify(shareBefore)}`);
	observer.note('route', KEEPER, { phase: 'before', share: shareBefore, target });
	if (!shareBefore[VICTIM]) {
		// Without traffic on lab-b's copy, losing lab-b loses nothing the checker can see: any number
		// this run produced would read as a clean failover that never happened.
		report.verdict = 'invalid';
		report.invalidReason =
			target === 'edge'
				? `${VICTIM}'s copy is running but took 0 of ${samples} requests through the edge (on this tree the edge's active health check reaches a remote copy without the app Host and marks it unhealthy; packages/site-config/src/compile.ts). Run --target direct to measure the copy failover path without the edge.`
				: `${VICTIM}'s copy did not answer any of ${samples} direct requests (${balancer?.describe() ?? 'no balancer'}).`;
		return 2;
	}

	// --- 3–5. checker run, fault, watch -------------------------------------------------------------
	say(`checker: ${durationS}s at ${flags.rate}/s, seed ${flags.seed}; ${method} ${VICTIM} at +${killAfterS}s (target ${target})`);
	const reportPath = join(OUT, 'report.json');
	checker = Bun.spawn(
		['bun', checkerCli, '--url', base, '--host', host, '--duration-s', String(durationS), '--rate', flags.rate!, '--seed', flags.seed!, '--observe', observations, '--out', reportPath],
		{ cwd: REPO, stdout: Bun.file(join(OUT, 'checker.log')), stderr: 'inherit' },
	);
	const runStart = Date.now();
	report.runStartedAt = new Date(runStart).toISOString();
	let faultAt = 0;
	const rel = (t: number) => Math.round(t - faultAt);

	await Promise.race([Bun.sleep(killAfterS * 1000), checker.exited]);
	if (checker.exitCode !== null) throw new Error(`the checker exited (${checker.exitCode}) before the fault; see ${join(OUT, 'checker.log')}`);
	faultAt = Date.now();
	report.faultAt = new Date(faultAt).toISOString();
	if (method === 'kill') {
		faulted = true;
		docker(['kill', containerName(VICTIM)]);
		note(`${VICTIM} powered off (docker kill)`);
	} else {
		// Everything on the lab network (other nodes, s3lab proxy and MinIO, the host gateway) and on
		// the overlay, except lab-b's own addresses: lab-b keeps running, alone.
		const own = [labNode(VICTIM).ip];
		const overlay = fleet.find((row: FleetNode) => row.name === VICTIM)?.privateAddress ?? null;
		const peers = [...cidrComplement(LAB.network.subnet, own), ...cidrComplement(OVERLAY, overlay ? [overlay] : [])];
		faulted = true;
		const result = helperCall(VICTIM, 'POST', '/v1/faults/partition', { peers, direction: 'both', durationS: partitionDurationS });
		if (result.status !== 200) throw new Error(`partition failed (${result.status}): ${JSON.stringify(result.body)}`);
		note(`${VICTIM} partitioned from ${peers.length} CIDRs covering ${LAB.network.subnet} and ${OVERLAY} except its own addresses (fault ${result.body.fault.id}, ${partitionDurationS}s)`);
		const probe = (argv: string[]) => exec(containerName(VICTIM), argv, { allowFailure: true }).code;
		const s3 = probe(['curl', '-s', '-o', '/dev/null', '--max-time', '3', `http://${LAB.s3lab.proxyIp}:${LAB.s3lab.s3Port}/minio/health/live`]);
		const minio = probe(['curl', '-s', '-o', '/dev/null', '--max-time', '3', `http://${LAB.s3lab.minioIp}:${LAB.s3lab.s3Port}/minio/health/live`]);
		const control = probe(['ping', '-c', '1', '-W', '1', CONTROL.ip]);
		report.partitionCheck = `s3lab proxy curl exit ${s3}, MinIO curl exit ${minio}, ping ${KEEPER} exit ${control} (non-zero = cut off)`;
		note(String(report.partitionCheck));
		if (s3 === 0 || minio === 0 || control === 0) throw new Error(`the partition left ${VICTIM} able to reach the lab: ${report.partitionCheck}`);
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
		if (replacedRunning === null || balancer) {
			try {
				const list = await copies();
				await balancer?.setNodes(list.filter((copy) => copy.status === 'running').map((copy) => copy.nodeName));
				const moved = list.find((copy) => copy.nodeName !== KEEPER && copy.nodeName !== VICTIM);
				if (moved && replacedPlaced === null) {
					replacedPlaced = Date.now();
					replacementNode = moved.nodeName;
					observer.note('route', moved.nodeName, { copy: moved.id, status: moved.status, phase: 'placed', afterMs: rel(replacedPlaced) });
					note(`+${(rel(replacedPlaced) / 1000).toFixed(1)}s copy ${moved.id} placed on ${moved.nodeName} (${moved.status})`);
				}
				if (moved?.status === 'running' && replacedRunning === null) {
					replacedRunning = Date.now();
					observer.note('route', moved.nodeName, { copy: moved.id, status: 'running', phase: 'running', afterMs: rel(replacedRunning) });
					note(`+${(rel(replacedRunning) / 1000).toFixed(1)}s copy ${moved.id} running on ${moved.nodeName}`);
				}
			} catch {
				// control plane slow; next tick
			}
		}
		if (replacementNode && newCopyAnswering === null) {
			// Edge: the new copy answers through the public route. Direct: it answers on its node.
			const who: { node: string } | null = balancer ? await balancer.probe(replacementNode) : await whoami(PUBLIC_BASE, host);
			if (who?.node === replacementNode) {
				newCopyAnswering = Date.now();
				observer.note('route', replacementNode, { phase: 'answering', afterMs: rel(newCopyAnswering) });
				note(`+${(rel(newCopyAnswering) / 1000).toFixed(1)}s ${replacementNode} answers ${target === 'edge' ? 'through the public route' : 'on its node'}`);
			}
		}
		await Promise.race([checker.exited, Bun.sleep(victimOffline && replacedRunning && newCopyAnswering && !balancer ? 1000 : 2000)]);
	}
	// Share after the fault, before lab-b comes back: who serves now.
	const shareAfter = await share(base, host, samples);
	report.shareAfter = shareAfter;
	note(`share of ${samples} requests after the fault: ${JSON.stringify(shareAfter)}`);
	observer.note('route', KEEPER, { phase: 'after', share: shareAfter, target });
	if (balancer) report.balancerServed = balancer.served;
	const checkerExit = await checker.exited;
	const after = await copies().catch(() => [] as Copy[]);
	for (const copy of after) observer.note('route', copy.nodeName, { copy: copy.id, status: copy.status, phase: 'after' });
	report.copiesAfter = after.map((copy) => `${copy.id}@${copy.nodeName}:${copy.status}`);
	report.victimOfflineAfterMs = victimOffline ? rel(victimOffline) : null;
	report.replacementPlacedAfterMs = replacedPlaced ? rel(replacedPlaced) : null;
	report.replacementRunningAfterMs = replacedRunning ? rel(replacedRunning) : null;
	report.replacementAnsweringAfterMs = newCopyAnswering ? rel(newCopyAnswering) : null;
	report.replacementNode = replacementNode;
	report.checkerExit = checkerExit;
	report.verdict = 'measured';
	return checkerExit;
}
