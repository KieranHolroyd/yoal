/**
 * S9 orchestrator: brings the lab up, runs every scenario, prints the numbers, tears the lab down.
 * `bun run scenarios.ts [up|down|<scenario>...]`; with no argument it runs `up`, all, `down`.
 */
import { $ } from 'bun';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAB } from './lab.ts';

$.throws(false);
const RIG = import.meta.dir;
const CONF = join(RIG, 'tmp', 'conf');
const OUT = join(RIG, 'tmp', 'out');
mkdirSync(OUT, { recursive: true });
const results: Record<string, unknown> = {};
/** Lame-duck runs per variant (`S9_REPEAT`). */
const REPEAT = Number(process.env.S9_REPEAT ?? 3);
const say = (msg: string) => console.error(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);

async function sh(cmd: ReturnType<typeof $>): Promise<string> {
	const r = await cmd.quiet();
	return r.stdout.toString().trim();
}

const ingressByName = (name: string) => LAB.ingress.find((i) => i.name === name)!;
async function exec(container: string, ...cmd: string[]) {
	return sh($`docker exec ${container} ${cmd}`);
}
const admin = (container: string, path: string, method = 'GET', file?: string) =>
	file
		? exec(container, 'curl', '-sS', '--unix-socket', '/run/caddy/admin.sock', '-X', method, '-H', 'Content-Type: application/json', '--data-binary', `@${file}`, `http://admin${path}`)
		: exec(container, 'curl', '-sS', '--unix-socket', '/run/caddy/admin.sock', '-X', method, `http://admin${path}`);

async function startIngress(name: string, config = 'g0') {
	const ing = ingressByName(name);
	const keepalived = name === 'ing-a' ? 'keepalived-a.conf' : name === 'ing-b' ? 'keepalived-b.conf' : null;
	await sh($`docker rm -f ${ing.container}`);
	const ka = keepalived ? ['-v', `${CONF}/${keepalived}:/etc/keepalived/keepalived.conf:ro`] : [];
	await sh(
		$`docker run -d --name ${ing.container} --hostname ${name} --network ${LAB.network} --ip ${ing.ip} --cap-add NET_ADMIN --cap-add NET_RAW --cap-add NET_BROADCAST -v ${CONF}/caddy-${name}-${config}.json:/etc/caddy/config.json:ro -v ${CONF}:/conf:ro -v ${RIG}/site:/srv/site:ro ${ka} ${LAB.images.ingress}`,
	);
	for (let i = 0; i < 50; i++) {
		if ((await exec(ing.container, 'sh', '-c', 'test -S /run/caddy/admin.sock && echo up')) === 'up') break;
		await Bun.sleep(100);
	}
	// The agent's job: mark ready once routes, releases and certificates are in place.
	await Bun.sleep(500);
	await exec(ing.container, 'touch', '/run/yoal/health/ready');
}

async function up() {
	await down();
	// Empty, never recreate: the client container bind-mounts this directory.
	for (const f of readdirSync(OUT)) rmSync(join(OUT, f), { force: true });
	say('lab up');
	const rendered = await $`bun run ${join(RIG, 'render.ts')}`.quiet();
	if (rendered.exitCode !== 0) throw new Error(`render failed: ${rendered.stderr}`);
	await sh($`docker network create --subnet ${LAB.subnet} ${LAB.network}`);
	for (const app of LAB.apps)
		await sh($`docker run -d --name ${app.container} --network ${LAB.network} --ip ${app.ip} -e APP_NAME=${app.name} -v ${RIG}:/rig:ro ${LAB.images.bun} bun /rig/app.ts`);
	await Promise.all(LAB.ingress.map((i) => startIngress(i.name)));
	await sh(
		$`docker run -d --name ${LAB.haproxy.name} --network ${LAB.network} --ip ${LAB.haproxy.ip} --sysctl net.ipv4.ip_unprivileged_port_start=0 -v ${CONF}/haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro ${LAB.images.haproxy}`,
	);
	for (const box of [LAB.client, LAB.attacker])
		await sh($`docker run -d --name ${box.name} --network ${LAB.network} --ip ${box.ip} -v ${RIG}:/rig:ro -v ${OUT}:/out ${LAB.images.bun} sleep infinity`);
	await waitAllUp();
	results.versions = {
		caddy: await exec(LAB.ingress[0]!.container, 'caddy', 'version'),
		keepalived: (await exec(LAB.ingress[0]!.container, 'sh', '-c', 'keepalived --version 2>&1')).split('\n')[0],
		haproxy: (await sh($`docker exec ${LAB.haproxy.name} haproxy -v`)).split('\n')[0],
		bun: await exec(LAB.client.name, 'bun', '--version'),
	};
	say(`versions ${JSON.stringify(results.versions)}`);
}

async function down() {
	say('lab down');
	const names = [...LAB.ingress.map((i) => i.container), ...LAB.apps.map((a) => a.container), LAB.haproxy.name, LAB.client.name, LAB.attacker.name];
	await sh($`docker rm -f ${names}`);
	await sh($`docker network rm ${LAB.network}`);
}

async function waitAllUp(timeoutMs = 40_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const log = await haproxyLog();
		const ups = new Map<string, boolean>();
		for (const e of log) ups.set(e.server, e.state === 'UP');
		// No line means the server started UP (HAProxy assumes UP until checks say otherwise only at start-up after rise).
		const down = [...ups].filter(([, up]) => !up).map(([s]) => s);
		if (down.length === 0) return;
		await Bun.sleep(500);
	}
	say('warning: not every server is UP');
}

/** HAProxy state-change lines with daemon timestamps. */
async function haproxyLog(): Promise<{ t: number; server: string; state: string; line: string }[]> {
	const r = await $`docker logs -t ${LAB.haproxy.name}`.quiet();
	const text = r.stdout.toString() + r.stderr.toString();
	const events: { t: number; server: string; state: string; line: string }[] = [];
	for (const line of text.split('\n')) {
		const m = /^(\S+) .*Server (be_\w+\/[\w-]+) is (UP|DOWN)/.exec(line);
		if (m) events.push({ t: Date.parse(m[1]!), server: m[2]!, state: m[3]!, line: line.slice(31, 200) });
	}
	return events;
}

/** Host-to-VM clock offset (ms): VM time ≈ host time + offset. */
async function clockOffset(): Promise<number> {
	const samples: number[] = [];
	for (let i = 0; i < 5; i++) {
		const before = Date.now();
		const vm = Number(await exec(LAB.client.name, 'bun', '-e', 'console.log(Date.now())'));
		const after = Date.now();
		samples.push(vm - (before + after) / 2);
	}
	samples.sort((a, b) => a - b);
	return samples[2]!;
}

interface LoadRun {
	summary: Record<string, any>;
	events: Record<string, any>[];
}

function startLoad(label: string, flags: string[]): Promise<LoadRun> {
	return (async () => {
		const r = await $`docker exec ${LAB.client.name} bun /rig/load.ts --out /out/${label}.jsonl ${flags}`.quiet();
		const lines = r.stdout.toString().trim().split('\n');
		const summary = JSON.parse(lines.at(-1)!);
		const events = readFileSync(join(OUT, `${label}.jsonl`), 'utf8')
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		return { summary, events };
	})();
}

function failures(run: LoadRun) {
	return run.events.filter((e) => e.ev === 'req' && !e.ok);
}

// ---- criterion 1: kill and lame duck behind HAProxy ----------------------------------------------

async function killScenario() {
	say('C1 kill: 200 req/s through HAProxy tcp; kill ing-b at +15 s');
	const offset = await clockOffset();
	const load = startLoad('c1-kill', ['--target', `${LAB.haproxy.ip}:443`, '--tls', '--rps', '200', '--seconds', '45', '--ka', '20']);
	await Bun.sleep(15_000);
	const killAt = Date.now() + offset;
	await sh($`docker kill ${ingressByName('ing-b').container}`);
	const run = await load;
	const fails = failures(run);
	const down = (await haproxyLog()).filter((e) => e.t >= killAt && e.state === 'DOWN' && e.server.includes('ing-b'));
	const afterKill = run.events.filter((e) => e.ev === 'req' && e.t > killAt);
	results.c1_kill = {
		killAt,
		haproxyDownMs: Object.fromEntries(down.map((d) => [d.server, d.t - killAt])),
		failed: fails.length,
		total: run.events.filter((e) => e.ev === 'req').length,
		failedByKind: countBy(fails, (f) => `${f.kind}:${f.err ?? f.status}`),
		lastFailureMs: fails.length ? Math.max(...fails.map((f) => f.t)) - killAt : null,
		servedByBAfterKill: afterKill.filter((e) => e.node === 'ing-b').length,
		counts: run.summary.counts,
	};
	say(`C1 kill: ${JSON.stringify(results.c1_kill)}`);
	await startIngress('ing-b');
	await waitAllUp();
}

async function lameDuckScenario(label: string, target: string, tlsOn: boolean, drainSeconds = 20, restartConfig = 'g0') {
	say(`C1 lame duck (${label}): 200 req/s via ${target}; drain ing-c at +10 s for ${drainSeconds} s, then stop`);
	const offset = await clockOffset();
	const ing = ingressByName('ing-c');
	const load = startLoad(`c1-lameduck-${label}`, ['--target', target, ...(tlsOn ? ['--tls'] : []), '--rps', '200', '--seconds', String(10 + drainSeconds + 15), '--ka', '20']);
	await Bun.sleep(10_000);
	const drainAt = Date.now() + offset;
	await exec(ing.container, 'touch', '/run/yoal/health/drain');
	await Bun.sleep(drainSeconds * 1000);
	const stopAt = Date.now() + offset;
	await admin(ing.container, '/stop', 'POST');
	const stoppedAt = Date.now() + offset;
	const run = await load;
	const fails = failures(run);
	const log = (await haproxyLog()).filter((e) => e.t >= drainAt && e.server.includes('ing-c'));
	const reqs = run.events.filter((e) => e.ev === 'req');
	results[`c1_lameduck_${label}`] = {
		drainSeconds,
		haproxyDownAfterDrainMs: Object.fromEntries(log.filter((l) => l.state === 'DOWN').map((d) => [d.server, d.t - drainAt])),
		stopCallMs: stoppedAt - stopAt,
		failed: fails.length,
		total: reqs.length,
		failedDetail: fails.slice(0, 10).map((f) => ({ atMs: f.t - drainAt, kind: f.kind, err: f.err, status: f.status, node: f.node })),
		servedByCDuringDrain: reqs.filter((e) => e.node === 'ing-c' && e.t >= drainAt && e.t < stopAt).length,
		servedByCAfterStop: reqs.filter((e) => e.node === 'ing-c' && e.t > stoppedAt).length,
		kaReopens: run.events.filter((e) => e.ev === 'ka-reopen' && e.t >= drainAt).length,
		counts: run.summary.counts,
	};
	say(`C1 lame duck ${label}: ${JSON.stringify(results[`c1_lameduck_${label}`])}`);
	await startIngress('ing-c', restartConfig);
	await waitAllUp();
}

// ---- criterion 2 and 5: addresses, forgeries, garbage, health body -----------------------------

async function addressScenario() {
	say('C2 client address and forgeries');
	const pidBefore = await Promise.all(LAB.ingress.map((i) => exec(i.container, 'pidof', 'caddy')));
	const suites: Record<string, unknown> = {};
	suites.client = JSON.parse(await exec(LAB.client.name, 'bun', '/rig/probe.ts', '--suite', 'client'));
	suites.attacker = JSON.parse(await exec(LAB.attacker.name, 'bun', '/rig/probe.ts', '--suite', 'attacker'));
	// A container in HAProxy's network namespace speaks from the trusted address.
	suites.trusted = JSON.parse(
		await sh($`docker run --rm --network container:${LAB.haproxy.name} -v ${RIG}:/rig:ro ${LAB.images.bun} bun /rig/probe.ts --suite trusted`),
	);
	const pidAfter = await Promise.all(LAB.ingress.map((i) => exec(i.container, 'pidof', 'caddy')));
	const access = (await exec(LAB.ingress[0]!.container, 'sh', '-c', 'tail -n 400 /var/log/caddy/access.log'))
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.filter((e) => e.request?.host === `whoami.${LAB.domain}`)
		.map((e) => `${e.request.remote_ip} -> client_ip ${e.request.client_ip}`);
	results.c2 = {
		suites,
		failedCases: Object.values(suites).flat().filter((c: any) => !c.pass),
		caddyPidUnchanged: pidBefore.every((p, i) => p === pidAfter[i]),
		accessLogPairs: countBy(access, (a) => a),
	};
	say(`C2: ${(results.c2 as any).failedCases.length} failed cases; pids unchanged ${(results.c2 as any).caddyPidUnchanged}`);
}

async function healthScenario() {
	say('C5 health endpoint answers in every state');
	const ing = LAB.ingress[0]!;
	const states: Record<string, unknown> = {};
	states.ok = JSON.parse(await exec(LAB.attacker.name, 'bun', '/rig/probe.ts', '--suite', 'health'));
	await exec(ing.container, 'rm', '-f', '/run/yoal/health/ready');
	states.notready = JSON.parse(await exec(LAB.attacker.name, 'bun', '/rig/probe.ts', '--suite', 'health'));
	await exec(ing.container, 'touch', '/run/yoal/health/ready', '/run/yoal/health/drain');
	states.draining = JSON.parse(await exec(LAB.attacker.name, 'bun', '/rig/probe.ts', '--suite', 'health'));
	await exec(ing.container, 'rm', '-f', '/run/yoal/health/drain');
	const sizes = Object.values(states).flatMap((s: any) => s.filter((a: any) => a.status).map((a: any) => a.bodyBytes));
	results.c5 = { states, distinctBodySizes: [...new Set(sizes)] };
	say(`C5: body sizes ${JSON.stringify([...new Set(sizes)])}`);
	await waitAllUp();
}

// ---- criterion 4: reload under 1,000 keep-alive connections ------------------------------------

let generation = 0;
/** `S9_SAME=1`: post the config already running (the agent's no-change reconcile). */
async function reloadAll(names: string[]) {
	if (process.env.S9_SAME !== '1') generation = (generation % 3) + 1;
	return Promise.all(names.map((n) => admin(ingressByName(n).container, '/load', 'POST', `/conf/caddy-${n}-g${generation}.json`)));
}

async function reloadScenario(label: string, target: string, tlsOn: boolean, reload: string[]) {
	say(`C4 reload (${label}): 1,000 held + 50 slow + 20 new/s via ${target}; POST /load on ${reload.join(',')} at +8 s`);
	const offset = await clockOffset();
	const load = startLoad(`c4-${label}`, ['--mode', 'hold', '--target', target, ...(tlsOn ? ['--tls'] : []), '--conns', '1000', '--slow', '50', '--newrps', '20', '--seconds', '20']);
	// Opening 1,000 TLS connections takes a few seconds; reload once they are held.
	for (let i = 0; i < 100; i++) {
		if (existsSync(join(OUT, `c4-${label}.jsonl`)) && readFileSync(join(OUT, `c4-${label}.jsonl`), 'utf8').includes('"ev":"held"')) break;
		await Bun.sleep(200);
	}
	await Bun.sleep(8000);
	const reloadAt = Date.now() + offset;
	const answers = await reloadAll(reload);
	const reloadDoneAt = Date.now() + offset;
	const run = await load;
	const fails = failures(run);
	results[`c4_${label}`] = {
		reloadMs: reloadDoneAt - reloadAt,
		adminAnswers: answers.map((a) => a || 'ok'),
		held: run.summary.held,
		dropped: run.summary.drops,
		droppedPct: run.summary.held ? (100 * run.summary.drops) / run.summary.held : null,
		droppedInflight: run.summary.dropsInflight,
		firstDropMs: run.summary.firstDrop ? run.summary.firstDrop - reloadAt : null,
		lastDropMs: run.summary.lastDrop ? run.summary.lastDrop - reloadAt : null,
		failed: fails.length,
		failedByKind: countBy(fails, (f) => `${f.kind}:${f.err ?? f.status}`),
		counts: run.summary.counts,
	};
	say(`C4 ${label}: ${JSON.stringify(results[`c4_${label}`])}`);
}

// ---- criterion 3: keepalived VIP -------------------------------------------------------------------

async function vipHolder(): Promise<string | null> {
	for (const name of ['ing-a', 'ing-b']) {
		const out = await exec(ingressByName(name).container, 'ip', '-4', 'addr', 'show', 'eth0');
		if (out.includes(LAB.vip)) return name;
	}
	return null;
}

async function vipScenario(label: string, fault: 'kill-container' | 'kill-caddy' | 'kill-caddy-agent' | 'lameduck' | 'restore') {
	const holder = await vipHolder();
	say(`C3 VIP (${label}): holder ${holder}; 200 req/s to ${LAB.vip}:443; fault ${fault} at +10 s`);
	const offset = await clockOffset();
	const load = startLoad(`c3-${label}`, ['--target', `${LAB.vip}:443`, '--tls', '--rps', '200', '--seconds', '30', '--ka', '20']);
	await Bun.sleep(10_000);
	const faultAt = Date.now() + offset;
	if (fault === 'kill-container') await sh($`docker kill ${ingressByName('ing-a').container}`);
	const a = ingressByName('ing-a').container;
	if (fault === 'kill-caddy' || fault === 'kill-caddy-agent') await exec(a, 'pkill', '-KILL', 'caddy');
	// The agent notices Caddy is gone (a 1 s liveness poll) and has the helper write the track file.
	if (fault === 'kill-caddy-agent') {
		await Bun.sleep(1000);
		await exec(a, 'sh', '-c', 'echo 1 > /run/yoal/health/vrrp');
	}
	// Lame duck on a VIP: drain (503 + Connection: close) for 5 s, then give up the address.
	if (fault === 'lameduck') {
		await exec(a, 'touch', '/run/yoal/health/drain');
		await Bun.sleep(5000);
		await exec(a, 'sh', '-c', 'echo 1 > /run/yoal/health/vrrp');
	}
	if (fault === 'restore') await startIngress('ing-a');
	const run = await load;
	const reqs = run.events.filter((e) => e.ev === 'req');
	const fails = failures(run);
	const firstOther = reqs.find((e) => e.t > faultAt && e.ok && e.node && e.node !== holder);
	const lastFail = fails.length ? Math.max(...fails.map((f) => f.t)) : null;
	results[`c3_${label}`] = {
		holderBefore: holder,
		holderAfter: await vipHolder(),
		firstSuccessOnNewHolderMs: firstOther ? firstOther.t - faultAt : null,
		lastFailureMs: lastFail ? lastFail - faultAt : null,
		failed: fails.length,
		total: reqs.length,
		failedByKind: countBy(fails, (f) => `${f.kind}:${f.err ?? f.status}`),
		counts: run.summary.counts,
	};
	say(`C3 ${label}: ${JSON.stringify(results[`c3_${label}`])}`);
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
	return out;
}

const SCENARIOS: Record<string, () => Promise<void>> = {
	address: addressScenario,
	health: healthScenario,
	kill: killScenario,
	lameduck: async () => {
		for (let i = 1; i <= REPEAT; i++) await lameDuckScenario(`tcp-close-${i}`, `${LAB.haproxy.ip}:443`, true);
	},
	'lameduck-http': async () => {
		for (let i = 1; i <= REPEAT; i++) await lameDuckScenario(`http-close-${i}`, `${LAB.haproxy.ip}:8080`, false);
	},
	'lameduck-plain': async () => {
		// The same drain without `Connection: close`: only the health answer changes.
		for (let i = 1; i <= REPEAT; i++) {
			for (const n of LAB.ingress) await admin(ingressByName(n.name).container, '/load', 'POST', `/conf/caddy-${n.name}-plain.json`);
			await lameDuckScenario(`tcp-plain-${i}`, `${LAB.haproxy.ip}:443`, true, 20, 'plain');
			for (const n of LAB.ingress) await admin(ingressByName(n.name).container, '/load', 'POST', `/conf/caddy-${n.name}-g0.json`);
		}
	},
	'reload-direct': () => reloadScenario('direct', `${LAB.ingress[0]!.ip}:443`, true, ['ing-a']),
	'reload-tcp': () => reloadScenario('haproxy-tcp', `${LAB.haproxy.ip}:443`, true, ['ing-a', 'ing-b', 'ing-c']),
	'reload-http': () => reloadScenario('haproxy-http', `${LAB.haproxy.ip}:8080`, false, ['ing-a', 'ing-b', 'ing-c']),
	vip: async () => {
		const restore = async () => {
			await startIngress('ing-a');
			await Bun.sleep(5000);
		};
		await vipScenario('kill-container', 'kill-container');
		await vipScenario('failback', 'restore');
		await Bun.sleep(5000);
		await vipScenario('kill-caddy-undetected', 'kill-caddy');
		await restore();
		await vipScenario('kill-caddy-agent', 'kill-caddy-agent');
		await restore();
		await vipScenario('lameduck', 'lameduck');
		await restore();
	},
};

const argv = process.argv.slice(2);
const plan = argv.length ? argv : ['up', ...Object.keys(SCENARIOS), 'down'];
try {
	for (const step of plan) {
		if (step === 'up') await up();
		else if (step === 'down') await down();
		else await SCENARIOS[step]!();
	}
} finally {
	if (!argv.length) await down().catch(() => {});
	if (Object.keys(results).length > 0) {
		writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
		console.log(JSON.stringify(results, null, 2));
	}
}
