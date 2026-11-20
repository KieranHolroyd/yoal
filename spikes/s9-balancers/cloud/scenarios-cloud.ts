/**
 * S9 cloud scenarios against a real Hetzner LB11. Load runs from this Mac (`../load.ts`) to the LB's
 * public address; node faults go over SSH or the Hetzner API. `bun cloud/scenarios-cloud.ts <step>...`
 * with steps: deploy, lb, kill, poweroff, lameduck, lameduck-l7, address, reload-tcp, reload-same,
 * reload-l7, reload-direct. Results go to tmp/cloud/out/results.json (merged across invocations).
 */
import { $ } from 'bun';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, waitAction } from './hcloud.ts';
import { DIR, loadState, OUT, PLAN, RIG, say, scp, ssh, waitSsh, type Node, type State } from './infra.ts';
import { DOMAIN, HEALTH_PORT, L7_PORT, renderCloudCaddy } from './render-cloud.ts';

$.throws(false);
const RESULTS = join(OUT, 'results.json');
const results: Record<string, any> = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : {};
const save = () => writeFileSync(RESULTS, JSON.stringify(results, null, 2));
const state: State = loadState();
const node = (name: string) => state.nodes.find((n) => n.name === name)!;
const LB_TLS = () => `${state.lbPublicIp}:443`;
const LB_L7 = () => `${state.lbPublicIp}:8080`;
const HEALTH_PATH = '/.well-known/yoal/health';

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
	return out;
}

// ---- deploy: binary, app, site, configs ---------------------------------------------------------

function renderAll() {
	const env = { trustedProxies: [`${PLAN.lbPrivateIp}/32`], allow: [`${state.macIp}/32`] };
	for (const n of state.nodes) {
		for (const g of [0, 1, 2, 3]) writeFileSync(join(DIR, `caddy-${n.name}-g${g}.json`), JSON.stringify(renderCloudCaddy(n.name, g, env), null, 2));
	}
}

const admin = (n: Node, path: string, method = 'GET', file?: string) =>
	ssh(n, `curl -sS --unix-socket /run/caddy/admin.sock -X ${method} ${file ? `-H 'Content-Type: application/json' --data-binary @${file}` : ''} http://admin${path}`);

async function startCaddy(n: Node, generation = 0) {
	await ssh(n, `cp /etc/caddy/g${generation}.json /etc/caddy/config.json && systemctl start caddy`);
	for (let i = 0; i < 50; i++) {
		if ((await ssh(n, 'test -S /run/caddy/admin.sock && echo up', { quiet: true })).out === 'up') break;
		await Bun.sleep(200);
	}
	await Bun.sleep(500);
	// The agent's job: mark ready once routes, releases and certificates are in place.
	await ssh(n, 'rm -f /run/yoal/health/drain && touch /run/yoal/health/ready');
}

async function deploy() {
	renderAll();
	await Promise.all(
		state.nodes.map(async (n) => {
			await scp(n, join(RIG, 'tmp', 'bin', 'caddy'), '/usr/local/bin/caddy');
			await scp(n, join(RIG, 'app.ts'), '/opt/s9/app.ts');
			await scp(n, join(RIG, 'site', 'index.html'), '/srv/site/index.html');
			for (const g of [0, 1, 2, 3]) await scp(n, join(DIR, `caddy-${n.name}-g${g}.json`), `/etc/caddy/g${g}.json`);
			await ssh(n, 'chmod 0755 /usr/local/bin/caddy && systemctl daemon-reload && systemctl enable --now s9-app && systemctl enable caddy');
			await ssh(n, 'systemctl stop caddy; true');
			await startCaddy(n);
		}),
	);
	const n0 = state.nodes[0]!;
	results.versions = {
		caddy: (await ssh(n0, '/usr/local/bin/caddy version')).out,
		os: (await ssh(n0, '. /etc/os-release; echo $PRETTY_NAME; uname -r')).out.replace('\n', ' / '),
		bun: (await ssh(n0, 'bun --version')).out,
		serverType: state.serverType,
		location: PLAN.location,
		macBun: Bun.version,
	};
	for (const n of state.nodes) {
		const h = await ssh(n, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${HEALTH_PORT}${HEALTH_PATH}`);
		say(`${n.name} health ${h.out}`);
	}
	save();
	say(`deployed: ${JSON.stringify(results.versions)}`);
}

// ---- LB services and targets, with the tightest health check Hetzner accepts ---------------------

function healthCheck(interval: number, timeout: number, retries: number) {
	return {
		protocol: 'http',
		port: HEALTH_PORT,
		interval,
		timeout,
		retries,
		http: { domain: null, path: HEALTH_PATH, status_codes: ['200'], tls: false, response: null },
	};
}

async function addService(body: Record<string, unknown>) {
	const r = await api('POST', `/load_balancers/${state.lbId}/actions/add_service`, body);
	await waitAction(r.action.id);
}

async function lb() {
	// Search: start at 1 s / 1 s / 0 retries and raise only the fields the API rejects.
	let [interval, timeout, retries] = [1, 1, 0];
	const rejected: string[] = [];
	const tls = { protocol: 'tcp', listen_port: 443, destination_port: 443, proxyprotocol: true };
	let added = false;
	for (let attempt = 0; attempt < 30 && !added; attempt++) {
		try {
			await addService({ ...tls, health_check: healthCheck(interval, timeout, retries) });
			added = true;
		} catch (error) {
			const msg = (error as Error).message;
			rejected.push(`${interval}/${timeout}/${retries}: ${msg.slice(msg.indexOf('HTTP'), 400)}`);
			say(`health check ${interval}/${timeout}/${retries} rejected: ${msg}`);
			const fields = /"name":"([^"]+)"/g;
			const names = [...msg.matchAll(fields)].map((m) => m[1]!.toLowerCase());
			if (names.some((f) => f.includes('interval'))) interval++;
			if (names.some((f) => f.includes('timeout'))) timeout++;
			if (names.some((f) => f.includes('retries'))) retries++;
			if (names.length === 0) throw error;
		}
	}
	if (!added) throw new Error('no health check accepted');
	state.health = { interval, timeout, retries };
	results.healthCheck = { interval, timeout, retries, port: HEALTH_PORT, path: HEALTH_PATH, protocol: 'http', expect: '200', rejected };
	say(`tcp/443 service added with health check interval ${interval} s, timeout ${timeout} s, retries ${retries}`);
	// L7: Hetzner terminates HTTP on 8080 and speaks plain HTTP to the lab_l7 server (adds X-Forwarded-For).
	await addService({
		protocol: 'http',
		listen_port: 8080,
		destination_port: L7_PORT,
		proxyprotocol: false,
		http: { sticky_sessions: false },
		health_check: healthCheck(interval, timeout, retries),
	});
	for (const n of state.nodes) {
		const r = await api('POST', `/load_balancers/${state.lbId}/actions/add_target`, { type: 'server', server: { id: n.id }, use_private_ip: true });
		await waitAction(r.action.id);
	}
	const { load_balancer } = await api('GET', `/load_balancers/${state.lbId}`);
	results.lbServices = load_balancer.services.map((s: any) => ({ ...s, health_check: s.health_check }));
	save();
	await waitHealthy();
}

/** Per target and listen port: 'healthy' | 'unhealthy' | 'unknown'. */
async function lbHealth(): Promise<Record<string, Record<number, string>>> {
	const { load_balancer } = await api('GET', `/load_balancers/${state.lbId}`);
	const out: Record<string, Record<number, string>> = {};
	for (const t of load_balancer.targets) {
		const n = state.nodes.find((x) => x.id === t.server?.id);
		if (!n) continue;
		out[n.name] = Object.fromEntries((t.health_status ?? []).map((h: any) => [h.listen_port, h.status]));
	}
	return out;
}

async function waitHealthy(timeoutMs = 180_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const h = await lbHealth();
		const all = Object.values(h).flatMap((ports) => Object.values(ports));
		if (all.length === state.nodes.length * 2 && all.every((s) => s === 'healthy')) {
			say(`all targets healthy after ${((Date.now() - start) / 1000).toFixed(1)} s`);
			return Date.now() - start;
		}
		await Bun.sleep(2000);
	}
	say(`warning: not all targets healthy: ${JSON.stringify(await lbHealth())}`);
	return null;
}

/** Polls the LB API every second; resolves with the first time each port of `target` left 'healthy'. */
function watchTarget(target: string, since: number, untilMs: number) {
	const firstUnhealthy: Record<number, number> = {};
	const samples: { t: number; h: Record<number, string> }[] = [];
	const done = (async () => {
		while (Date.now() < untilMs) {
			try {
				const h = (await lbHealth())[target] ?? {};
				const t = Date.now();
				samples.push({ t: t - since, h });
				for (const [port, status] of Object.entries(h)) if (status !== 'healthy' && firstUnhealthy[Number(port)] === undefined && t >= since) firstUnhealthy[Number(port)] = t - since;
			} catch (error) {
				say(`poll: ${(error as Error).message}`);
			}
			await Bun.sleep(1000);
		}
		return { firstUnhealthyMs: firstUnhealthy, samples: samples.filter((_, i) => i % 3 === 0).slice(0, 40) };
	})();
	return done;
}

// ---- load ---------------------------------------------------------------------------------------

interface LoadRun {
	summary: Record<string, any>;
	events: Record<string, any>[];
}
async function runLoad(label: string, flags: string[]): Promise<LoadRun> {
	const out = join(OUT, `${label}.jsonl`);
	const r = await $`bun ${join(RIG, 'load.ts')} --out ${out} --host app.${DOMAIN} ${flags}`.quiet();
	const lines = r.stdout.toString().trim().split('\n');
	if (r.exitCode !== 0) throw new Error(`load ${label} failed: ${r.stderr.toString().slice(0, 400)}`);
	const summary = JSON.parse(lines.at(-1)!);
	const events = readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
	return { summary, events };
}
const failures = (run: LoadRun) => run.events.filter((e) => e.ev === 'req' && !e.ok);

// ---- criterion 1a: killed node ------------------------------------------------------------------

async function killScenario(label: string, how: 'sigkill' | 'poweroff', via: 'tcp' | 'l7' = 'tcp') {
	const target = node('ing-b');
	const flags = via === 'tcp' ? ['--target', LB_TLS(), '--tls'] : ['--target', LB_L7()];
	say(`C1 kill (${label}): 200 req/s via LB ${via}; ${how} ing-b at +15 s`);
	const load = runLoad(`c1-${label}`, [...flags, '--rps', '200', '--seconds', '50', '--ka', '20']);
	await Bun.sleep(15_000);
	const killAt = Date.now();
	const watch = watchTarget('ing-b', killAt, killAt + 34_000);
	let faultCallMs = 0;
	if (how === 'sigkill') {
		await ssh(target, 'systemctl kill -s KILL caddy');
		faultCallMs = Date.now() - killAt;
	} else {
		const r = await api('POST', `/servers/${target.id}/actions/poweroff`);
		faultCallMs = Date.now() - killAt;
		await waitAction(r.action.id);
	}
	const run = await load;
	const w = await watch;
	const fails = failures(run);
	const reqs = run.events.filter((e) => e.ev === 'req');
	results[`c1_kill_${label}`] = {
		how,
		via,
		faultCallMs,
		lbUnhealthyMs: w.firstUnhealthyMs,
		failed: fails.length,
		total: reqs.length,
		failedByKind: countBy(fails, (f) => `${f.kind}:${f.err ?? f.status}`),
		firstFailureMs: fails.length ? Math.min(...fails.map((f) => f.t)) - killAt : null,
		lastFailureMs: fails.length ? Math.max(...fails.map((f) => f.t)) - killAt : null,
		failuresAfter15s: fails.filter((f) => f.t - killAt > 15_000).length,
		servedByBAfterKill: reqs.filter((e) => e.node === 'ing-b' && e.t > killAt + 1000).length,
		healthSamples: w.samples,
	};
	save();
	const { healthSamples, ...brief } = results[`c1_kill_${label}`];
	say(`C1 ${label}: ${JSON.stringify(brief)}`);
	if (how === 'poweroff') {
		const r = await api('POST', `/servers/${target.id}/actions/poweron`);
		await waitAction(r.action.id);
		await waitSsh(target);
	}
	await ssh(target, 'systemctl stop caddy; true');
	await startCaddy(target);
	await waitHealthy();
}

// ---- criterion 1b: lame duck --------------------------------------------------------------------

async function lameDuckScenario(label: string, via: 'tcp' | 'l7', drainSeconds = 20) {
	const target = node('ing-c');
	const flags = via === 'tcp' ? ['--target', LB_TLS(), '--tls'] : ['--target', LB_L7()];
	say(`C2 lame duck (${label}): 200 req/s via LB ${via}; drain ing-c at +10 s for ${drainSeconds} s, then POST /stop`);
	const load = runLoad(`c2-${label}`, [...flags, '--rps', '200', '--seconds', String(10 + drainSeconds + 15), '--ka', '20']);
	await Bun.sleep(10_000);
	const drainAt = Date.now();
	const watch = watchTarget('ing-c', drainAt, drainAt + drainSeconds * 1000 + 3000);
	await ssh(target, 'touch /run/yoal/health/drain');
	await Bun.sleep(drainSeconds * 1000 - (Date.now() - drainAt));
	const stopAt = Date.now();
	await admin(target, '/stop', 'POST');
	const stoppedAt = Date.now();
	const run = await load;
	const w = await watch;
	const fails = failures(run);
	const reqs = run.events.filter((e) => e.ev === 'req');
	results[`c2_lameduck_${label}`] = {
		via,
		drainSeconds,
		lbUnhealthyAfterDrainMs: w.firstUnhealthyMs,
		stopCallMs: stoppedAt - stopAt,
		failed: fails.length,
		total: reqs.length,
		failedDetail: fails.slice(0, 10).map((f) => ({ atMs: f.t - drainAt, kind: f.kind, err: f.err, status: f.status, node: f.node })),
		servedByCDuringDrain: reqs.filter((e) => e.node === 'ing-c' && e.t >= drainAt && e.t < stopAt).length,
		servedByCAfterStop: reqs.filter((e) => e.node === 'ing-c' && e.t > stoppedAt).length,
		kaReopens: run.events.filter((e) => e.ev === 'ka-reopen' && e.t >= drainAt).length,
		counts: run.summary.counts,
	};
	save();
	say(`C2 ${label}: ${JSON.stringify(results[`c2_lameduck_${label}`])}`);
	await startCaddy(target);
	await waitHealthy();
}

// ---- criterion 4: reload under 1,000 keep-alive connections -------------------------------------

let generation = 0;
async function reloadScenario(label: string, flags: string[], same = false, only?: Node[], spread = process.env.S9_VERIFY_SPREAD ?? '5000') {
	const targets = only ?? state.nodes;
	say(`C4 reload (${label}): 1,000 held + 50 slow + 20 new/s; POST /load ${same ? '(identical config)' : '(changed config)'} on ${targets.map((t) => t.name).join(',')}`);
	const out = join(OUT, `c4-${label}.jsonl`);
	// An identical POST must match what each node runs now: post the current generation first.
	if (same) {
		await Promise.all(targets.map((n) => admin(n, '/load', 'POST', `/etc/caddy/g${generation}.json`)));
		await Bun.sleep(3000);
	}
	const load = runLoad(`c4-${label}`, ['--mode', 'hold', ...flags, '--conns', '1000', '--slow', '50', '--newrps', '20', '--seconds', '25', '--verify-spread', spread]);
	for (let i = 0; i < 300; i++) {
		if (existsSync(out) && readFileSync(out, 'utf8').includes('"ev":"held"')) break;
		await Bun.sleep(200);
	}
	await Bun.sleep(8000);
	if (!same) generation = (generation % 3) + 1;
	const reloadAt = Date.now();
	const answers = await Promise.all(targets.map((n) => admin(n, '/load', 'POST', `/etc/caddy/g${generation}.json`)));
	const reloadDoneAt = Date.now();
	const run = await load;
	const fails = failures(run);
	results[`c4_${label}`] = {
		generation,
		identical: same,
		reloadMs: reloadDoneAt - reloadAt,
		adminAnswers: answers.map((a) => (a.code === 0 ? a.out || 'ok' : `exit ${a.code} ${a.err}`)),
		held: run.summary.held,
		openFailures: run.summary.openFailures,
		dropped: run.summary.drops,
		droppedPct: run.summary.held ? (100 * run.summary.drops) / run.summary.held : null,
		droppedInflight: run.summary.dropsInflight,
		firstDropMs: run.summary.firstDrop ? run.summary.firstDrop - reloadAt : null,
		lastDropMs: run.summary.lastDrop ? run.summary.lastDrop - reloadAt : null,
		aliveAtEnd: run.summary.aliveAtEnd,
		failed: fails.length,
		failedByKind: countBy(fails, (f) => `${f.kind}:${f.err ?? f.status}`),
		counts: run.summary.counts,
	};
	save();
	say(`C4 ${label}: ${JSON.stringify(results[`c4_${label}`])}`);
}

// ---- criterion 3: client address ----------------------------------------------------------------

async function address() {
	const proc = await $`bun ${join(import.meta.dir, 'probe-cloud.ts')} --lb ${state.lbPublicIp} --node ${state.nodes[0]!.publicIp} --mac ${state.macIp} --lbprivate ${PLAN.lbPrivateIp}`.quiet();
	if (proc.exitCode !== 0) throw new Error(`probe failed: ${proc.stderr}`);
	const cases = JSON.parse(proc.stdout.toString().trim().split('\n').at(-1)!);
	// Source addresses: SYNs to the health port (probes) and to 443 / 8081 (proxied traffic), and whether
	// the probe's first bytes are a PROXY header.
	const n = state.nodes[0]!;
	const capture = (
		await ssh(n, `timeout 12 tcpdump -n -l -i any -c 400 '(tcp port ${HEALTH_PORT} or tcp port 443 or tcp port ${L7_PORT}) and not host ${state.macIp}' 2>/dev/null; true`)
	).out;
	const synSources = countBy(
		capture.split('\n').filter((l) => /Flags \[S\]/.test(l)),
		(l) => {
			const m = /IP (\S+)\.\d+ > \S+\.(\d+):/.exec(l);
			return m ? `${m[1]} -> :${m[2]}` : 'other';
		},
	);
	const payload = (
		await ssh(n, `timeout 12 tcpdump -n -i any -c 2 -X 'tcp dst port ${HEALTH_PORT} and (tcp[tcpflags] & tcp-push != 0)' 2>/dev/null; true`)
	).out;
	const probeStartsWithProxy = /0d0a 0d0a 000d 0a51 5549 540a|PROXY TCP/i.test(payload);
	// Through the LB (tcp + PROXY), with a held connection open so its SYN source is captured.
	const viaLb = await (async () => {
		const cap = ssh(n, `timeout 8 tcpdump -n -l -i any -c 20 'tcp dst port 443 and tcp[tcpflags] & tcp-syn != 0' 2>/dev/null; true`);
		await Bun.sleep(1500);
		for (let i = 0; i < 6; i++) await $`curl -sk --resolve whoami.${DOMAIN}:443:${state.lbPublicIp} https://whoami.${DOMAIN}/ -o /dev/null`.quiet();
		return countBy((await cap).out.split('\n').filter(Boolean), (l) => /IP (\S+)\.\d+ >/.exec(l)?.[1] ?? 'other');
	})();
	const access = (await ssh(n, 'tail -n 2000 /var/log/caddy/access.log'))
		.out.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.filter((e) => e.request?.host === `whoami.${DOMAIN}`)
		.map((e) => `${e.request.remote_ip} -> client_ip ${e.request.client_ip}`);
	// Spoofing from ing-b (a peer outside trusted_proxies, on the same private network): claim the
	// Mac's (allowed) address with a PROXY header or XFF, against ing-a's private and public address.
	const b = node('ing-b');
	for (const [where, ip] of [['private', n.privateIp], ['public', n.publicIp]] as const) {
		for (const host of [`allow.${DOMAIN}`, `allowci.${DOMAIN}`]) {
			const base = `curl -sk -o /dev/null -w '%{http_code}' --max-time 5 --resolve ${host}:443:${ip} https://${host}/`;
			const v1 = (await ssh(b, `${base} --haproxy-protocol --haproxy-clientip ${state.macIp}`)).out;
			const xff = (await ssh(b, `${base} -H 'X-Forwarded-For: ${state.macIp}'`)).out;
			cases.push({ name: `from ing-b to ing-a ${where}: ${host} with PROXY v1 claiming the allowed address is refused`, pass: v1 === '403', detail: v1 });
			cases.push({ name: `from ing-b to ing-a ${where}: ${host} with XFF claiming the allowed address is refused`, pass: xff === '403', detail: xff });
		}
	}
	const pids = await Promise.all(state.nodes.map((x) => ssh(x, 'systemctl show -p MainPID --value caddy')));
	results.c3 = {
		cases,
		failedCases: cases.filter((c: any) => !c.pass),
		synSourcesOther: synSources,
		synSourcesViaLb443: viaLb,
		probeFirstBytesProxyHeader: probeStartsWithProxy,
		probePayloadSample: payload.split('\n').slice(0, 8),
		accessLogPairs: countBy(access, (a) => a),
		caddyPids: pids.map((p) => p.out),
	};
	save();
	say(`C3: ${results.c3.failedCases.length} failed of ${cases.length}; syn sources ${JSON.stringify(synSources)}; via LB ${JSON.stringify(viaLb)}; probe PROXY header ${probeStartsWithProxy}`);
}

const STEPS: Record<string, () => Promise<unknown>> = {
	deploy,
	lb,
	health: () => waitHealthy(),
	kill: () => killScenario('sigkill-tcp', 'sigkill'),
	'kill-l7': () => killScenario('sigkill-l7', 'sigkill', 'l7'),
	poweroff: () => killScenario('poweroff-tcp', 'poweroff'),
	lameduck: async () => {
		for (let i = 1; i <= 3; i++) await lameDuckScenario(`tcp-${i}`, 'tcp');
	},
	'lameduck-l7': async () => {
		for (let i = 1; i <= 2; i++) await lameDuckScenario(`l7-${i}`, 'l7');
	},
	address,
	'reload-tcp': async () => {
		for (let i = 1; i <= 2; i++) await reloadScenario(`lb-tcp-${i}`, ['--target', LB_TLS(), '--tls']);
	},
	'reload-same': () => reloadScenario('lb-tcp-identical', ['--target', LB_TLS(), '--tls'], true),
	'reload-l7': async () => {
		for (let i = 1; i <= 2; i++) await reloadScenario(`lb-l7-${i}`, ['--target', LB_L7()]);
	},
	'reload-l7-same': () => reloadScenario('lb-l7-identical', ['--target', LB_L7()], true),
	// The same, with all 1,000 verify requests at once: shows the L7 service's own limit, with no reload in play.
	'reload-l7-same-burst': () => reloadScenario('lb-l7-identical-burst', ['--target', LB_L7()], true, undefined, '0'),
	'kill-2': () => killScenario('sigkill-tcp-2', 'sigkill'),
	'poweroff-2': () => killScenario('poweroff-tcp-2', 'poweroff'),
	'kill-l7-2': () => killScenario('sigkill-l7-2', 'sigkill', 'l7'),
	'reload-direct': () => reloadScenario('direct-ing-a', ['--target', `${state.nodes[0]!.publicIp}:443`, '--tls'], false, [state.nodes[0]!]),
};

export const ALL = ['deploy', 'lb', 'address', 'kill', 'kill-2', 'kill-l7', 'kill-l7-2', 'poweroff', 'poweroff-2', 'lameduck', 'lameduck-l7', 'reload-same', 'reload-l7-same', 'reload-l7-same-burst', 'reload-tcp', 'reload-l7', 'reload-direct'];

if (import.meta.main) {
	const steps = process.argv.slice(2);
	for (const step of steps.length ? steps : ALL) {
		const fn = STEPS[step];
		if (!fn) throw new Error(`unknown step ${step}`);
		await fn();
	}
}
