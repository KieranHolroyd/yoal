/**
 * S4 scenario runner (on the Mac, drives OrbStack Docker). Usage: bun run.ts <scenario…> | down
 *
 *   a          design A: three Caddys share certmagic storage on MinIO (techknowlogick/certmagic-s3,
 *              conditional-write lock); start together, renewals under 1,000 keep-alive
 *              connections, MinIO outage across a renewal, ingress removal + forced reissue.
 *   a-nolock   design A with ss098/certmagic-s3 (Lock is a no-op): duplicate issuance count.
 *   a-local    per-ingress ACME, no shared storage (today, and the fallback without a relay).
 *   a-ari      design A for two lifetimes, no load: the reason certmagic gives for each renewal.
 *   b          design B: lego on the "control plane", agents pull and POST /load; HTTP-01 relayed by
 *              every ingress; renewals under load; control-plane outage; removal + reissue.
 *   b-hot      design B, but Caddy takes the pair from the agent per handshake (no config reload).
 *   b-norelay  design B without the relay: HTTP-01 must fail.
 *   dns01      lego DNS-01 for *.s4.test and s4.test against pebble-challtestsrv.
 *
 * Env: S4_LIFETIME (certificate lifetime, s; default 240), S4_OUTAGE (s; default 40).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { caddyConfig, type Storage } from './caddy.ts';
import { IN, LAB } from './lab.ts';

const RIG = import.meta.dir;
const TMP = join(RIG, 'tmp');
const OUT = join(TMP, 'out');
const LIFETIME = Number(process.env.S4_LIFETIME ?? 240);
const OUTAGE = Number(process.env.S4_OUTAGE ?? 40);
const ING = LAB.ingress;
const RESULTS = join(OUT, 'results.json');

// ---------------------------------------------------------------------------------------------
const say = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

function sh(args: string[], allowFail = false): string {
	const p = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
	const out = p.stdout.toString().trim();
	if (p.exitCode !== 0 && !allowFail) throw new Error(`${args.join(' ')} → ${p.exitCode}: ${p.stderr.toString().trim()}`);
	return out;
}
const docker = (...args: string[]) => sh(['docker', ...args]);
const dockerTry = (...args: string[]) => sh(['docker', ...args], true);

async function shAsync(args: string[]): Promise<string> {
	const p = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	if (code !== 0) throw new Error(`${args.join(' ')} → ${code}: ${err.trim()}`);
	return out.trim();
}
const clientAsync = (...args: string[]) => shAsync(['docker', 'exec', LAB.client.container, 'bun', `${IN.rig}/load.ts`, ...args]);

function results(): Record<string, unknown> {
	return existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : {};
}
function record(key: string, value: unknown) {
	const r = results();
	r[key] = value;
	writeFileSync(RESULTS, JSON.stringify(r, null, 2));
}

// ---------------------------------------------------------------------------------------------
const ALL = [
	LAB.pebble.container, LAB.dns.container, LAB.haproxy.container, LAB.minio.container, LAB.cp.container,
	LAB.client.container, ...ING.map((i) => i.container),
];

export function down() {
	for (const c of ALL) dockerTry('rm', '-f', c);
	dockerTry('network', 'rm', LAB.network);
}

function netRun(name: string, ip: string, extra: string[], image: string, cmd: string[] = []) {
	docker('run', '-d', '--name', name, '--network', LAB.network, '--ip', ip, ...extra, image, ...cmd);
}

/** Pebble (fresh CA and fresh issuance log per scenario), challtestsrv, HAProxy, the client. */
async function base(opts: { minio?: boolean; haproxyBackends?: string[] } = {}) {
	down();
	rmSync(TMP, { recursive: true, force: true });
	mkdirSync(OUT, { recursive: true });
	mkdirSync(join(TMP, 'shared'), { recursive: true });
	// --internal: no route off the lab segment, so nothing in it can reach a public CA or DNS.
	docker('network', 'create', '--internal', '--subnet', LAB.subnet, LAB.network);

	// challtestsrv answers every A query with HAProxy's address, so Pebble's VA always goes
	// through the balancer.
	netRun(LAB.dns.container, LAB.dns.ip, [], LAB.images.challtestsrv, [
		'-defaultIPv4', LAB.haproxy.ip, '-defaultIPv6', '', '-http01', '', '-https01', '', '-tlsalpn01', '', '-doh', '',
	]);
	const pebbleConfig = {
		pebble: {
			listenAddress: '0.0.0.0:14000',
			managementListenAddress: '0.0.0.0:15000',
			certificate: 'test/certs/localhost/cert.pem',
			privateKey: 'test/certs/localhost/key.pem',
			httpPort: 80,
			tlsPort: 443,
			ocspResponderURL: '',
			externalAccountBindingRequired: false,
			domainBlocklist: ['blocked-domain.example'],
			retryAfter: { authz: 1, order: 1 },
			keyAlgorithm: 'ecdsa',
			profiles: { default: { description: `S4: ${LIFETIME} s`, validityPeriod: LIFETIME } },
		},
	};
	mkdirSync(join(TMP, 'pebble'), { recursive: true });
	writeFileSync(join(TMP, 'pebble', 'pebble-config.json'), JSON.stringify(pebbleConfig, null, 2));
	netRun(
		LAB.pebble.container, LAB.pebble.ip,
		['--network-alias', LAB.pebble.alias, '-v', `${join(TMP, 'pebble')}:/config:ro`,
			// No nonce rejections, no sleeping VA, no authorization reuse: every order validates afresh.
			'-e', 'PEBBLE_VA_NOSLEEP=1', '-e', 'PEBBLE_WFE_NONCEREJECT=0', '-e', 'PEBBLE_AUTHZREUSE=0'],
		LAB.images.pebble, ['-config', '/config/pebble-config.json', '-dnsserver', `${LAB.dns.ip}:8053`],
	);
	// The image is distroless: copy the API root out with docker cp.
	const ca = sh(['sh', '-c', `docker cp ${LAB.pebble.container}:/test/certs/pebble.minica.pem - | tar -xO`]).trim();
	writeFileSync(join(TMP, 'shared', 'pebble-ca.pem'), `${ca}\n`);

	if (opts.minio) {
		const m = LAB.minio;
		netRun(m.container, m.ip, ['--network-alias', m.alias, '-e', `MINIO_ROOT_USER=${m.user}`, '-e', `MINIO_ROOT_PASSWORD=${m.pass}`],
			LAB.images.minio, ['server', '/data']);
		for (let i = 0; ; i++) {
			const r = Bun.spawnSync(['docker', 'exec', m.container, 'sh', '-c',
				`mc alias set s4 http://127.0.0.1:9000 '${m.user}' '${m.pass}' >/dev/null && mc mb --ignore-existing s4/${m.bucket}`]);
			if (r.exitCode === 0) break;
			if (i > 30) throw new Error(`minio not ready: ${r.stderr}`);
			await Bun.sleep(500);
		}
	}
	haproxy(opts.haproxyBackends ?? ING.map((i) => i.name));
	netRun(LAB.client.container, LAB.client.ip, ['-v', `${RIG}:${IN.rig}:ro`, '-v', `${OUT}:${IN.out}`], LAB.images.bun, ['sleep', 'infinity']);
	say(`base up: pebble ${LAB.images.pebble.split('@')[0]}, lifetime ${LIFETIME} s${opts.minio ? ', minio' : ''}`);
}

/** Plain TCP round-robin on :80 and :443 over the named ingresses; no health checks, no stickiness. */
function haproxy(backends: string[]) {
	const servers = (port: number) =>
		backends.map((n) => `  server ${n} ${ING.find((i) => i.name === n)!.ip}:${port}`).join('\n');
	const cfg = `global
  maxconn 20000
defaults
  mode tcp
  timeout connect 5s
  timeout client 1h
  timeout server 1h
frontend f80
  bind :80
  default_backend b80
frontend f443
  bind :443
  default_backend b443
backend b80
  balance roundrobin
${servers(80)}
backend b443
  balance roundrobin
${servers(443)}
`;
	mkdirSync(join(TMP, 'haproxy'), { recursive: true });
	writeFileSync(join(TMP, 'haproxy', 'haproxy.cfg'), cfg);
	dockerTry('rm', '-f', LAB.haproxy.container);
	netRun(LAB.haproxy.container, LAB.haproxy.ip,
		['--sysctl', 'net.ipv4.ip_unprivileged_port_start=0', '-v', `${join(TMP, 'haproxy')}:/usr/local/etc/haproxy:ro`], LAB.images.haproxy);
}

interface IngressStart {
	image: string;
	config: (node: string) => Record<string, unknown>;
	env?: Record<string, string>;
}

/** Start the ingresses at the same instant (one `docker run` each, concurrently). */
async function startIngresses(nodes: typeof ING, s: IngressStart) {
	await Promise.all(
		nodes.map((n) => {
			const dir = join(TMP, n.name);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, 'caddy.json'), JSON.stringify(s.config(n.name), null, 2));
			const env = Object.entries({ S4_NODE: n.name, ...s.env }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
			return shAsync(['docker', 'run', '-d', '--name', n.container, '--hostname', n.name, '--network', LAB.network, '--ip', n.ip,
				'--sysctl', 'net.ipv4.ip_unprivileged_port_start=0',
				'-v', `${RIG}:${IN.rig}:ro`, '-v', `${dir}:${IN.node}:ro`, '-v', `${join(TMP, 'shared')}:${IN.shared}:ro`,
				...env, s.image, '/rig/images/ingress-entry.sh']);
		}),
	);
}

// ---------------------------------------------------------------------------------------------
interface ProbeResult { target: string; ok: boolean; fingerprint?: string; notAfter?: number; error?: string }
const targetsOf = (nodes: readonly { ip: string }[]) => nodes.map((n) => `${n.ip}:443`).join(',');

async function probe(nodes: readonly { ip: string }[], host: string): Promise<ProbeResult[]> {
	return JSON.parse(await clientAsync('probe', '--targets', targetsOf(nodes), '--host', host));
}

async function waitSameFingerprint(nodes: readonly { ip: string }[], host: string, timeoutS: number, notFp?: string) {
	const start = Date.now();
	for (;;) {
		const p = await probe(nodes, host);
		const fps = new Set(p.map((x) => x.fingerprint ?? `err:${x.error}`));
		if (p.every((x) => x.ok) && fps.size === 1 && !fps.has(notFp ?? '')) return { ms: Date.now() - start, probes: p };
		if (Date.now() - start > timeoutS * 1000) return { ms: null, probes: p };
		await Bun.sleep(250);
	}
}

/** Pebble's own issuance log: one "Issued certificate serial" line per certificate. */
function pebbleIssuances(): { count: number; at: string[]; orders: number; invalidAuthz: number } {
	const logs = sh(['sh', '-c', `docker logs ${LAB.pebble.container} 2>&1`]);
	const issued = logs.split('\n').filter((l) => l.includes('Issued certificate serial'));
	return {
		count: issued.length,
		at: issued.map((l) => /(\d{2}:\d{2}:\d{2})/.exec(l)?.[1] ?? '?'),
		orders: logs.split('\n').filter((l) => /POST \/order-plz/.test(l)).length,
		invalidAuthz: logs.split('\n').filter((l) => /authz .* (?:invalid|failed)|validation .*fail|Error/i.test(l) && /valid/i.test(l)).length,
	};
}

function containerLogs(name: string): string {
	return sh(['sh', '-c', `docker logs ${name} 2>&1`], true);
}

/** certmagic's "served key authentication" lines per ingress (distributed = answered from storage). */
function challengeAnswers(nodes: readonly { name: string; container: string }[]) {
	return Object.fromEntries(
		nodes.map((n) => {
			const lines = containerLogs(n.container).split('\n').filter((l) => l.includes('served key authentication'));
			return [n.name, { served: lines.length, distributed: lines.filter((l) => l.includes('"distributed":true')).length }];
		}),
	);
}

function readJsonl(file: string): Record<string, unknown>[] {
	const p = join(OUT, file);
	if (!existsSync(p)) return [];
	return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** From watch events: for each new fingerprint, when each ingress first served it. */
function distribution(file: string, nodes: readonly { ip: string; name: string }[]) {
	const ev = readJsonl(file) as unknown as (ProbeResult & { t: number })[];
	const byFp = new Map<string, Map<string, number>>();
	const errors: Record<string, number> = {};
	for (const e of ev) {
		const node = nodes.find((n) => e.target.startsWith(n.ip))?.name ?? e.target;
		if (!e.ok) {
			errors[node] = (errors[node] ?? 0) + 1;
			continue;
		}
		const m = byFp.get(e.fingerprint!) ?? new Map();
		if (!m.has(node)) m.set(node, e.t);
		byFp.set(e.fingerprint!, m);
	}
	const rows = [...byFp.entries()].map(([fp, m]) => {
		const ts = [...m.values()];
		return {
			fp: fp.slice(0, 16),
			nodes: m.size,
			first: new Date(Math.min(...ts)).toISOString().slice(11, 23),
			spreadMs: Math.max(...ts) - Math.min(...ts),
		};
	});
	return { fingerprints: rows, errorEvents: errors };
}

async function holdAndWatch(label: string, nodes: readonly { ip: string; name: string }[], host: string, seconds: number, during?: () => Promise<void>) {
	const watchFile = `${label}-watch.jsonl`;
	const holdFile = `${label}-hold.jsonl`;
	say(`${label}: 1,000 keep-alive TLS connections via HAProxy for ${seconds} s, fingerprints watched every 500 ms`);
	const watch = clientAsync('watch', '--targets', targetsOf(nodes), '--host', host, '--seconds', String(seconds + 5), '--out', `${IN.out}/${watchFile}`);
	const hold = clientAsync('hold', '--target', `${LAB.haproxy.ip}:443`, '--host', host, '--conns', '1000', '--period', '2000', '--seconds', String(seconds), '--out', `${IN.out}/${holdFile}`);
	if (during) await during();
	const [w, h] = await Promise.all([watch, hold]);
	const holdSummary = JSON.parse(h);
	const drops = readJsonl(holdFile);
	return { hold: holdSummary, dropTimes: drops.slice(0, 50).map((d) => `${new Date(d.t as number).toISOString().slice(11, 23)} ${d.kind}`), watch: JSON.parse(w), distribution: distribution(watchFile, nodes) };
}

// ---------------------------------------------------------------------------------------------
// Design A
function aConfig(storage: Storage, host: string) {
	return (node: string) => caddyConfig({ node, host, design: 'A', storage });
}

async function scenarioA() {
	const host = `a.${LAB.domain}`;
	await base({ minio: true });
	const t0 = Date.now();
	await startIngresses(ING, { image: LAB.images.ingressLock, config: aConfig('s3-lock', host) });
	const first = await waitSameFingerprint(ING, host, 120);
	const firstMs = Date.now() - t0;
	const firstIssued = pebbleIssuances();
	say(`A: all three serve one certificate after ${firstMs} ms; Pebble issued ${firstIssued.count}`);
	record('a.start', { firstMs, probes: first.probes, pebble: firstIssued, challenges: challengeAnswers(ING) });

	// Renewals under load: hold for one lifetime plus 30 s, so at least one renewal falls inside.
	const load = await holdAndWatch('a-load', ING, host, LIFETIME + 30);
	record('a.load', { ...load, pebble: pebbleIssuances() });
	say(`A load: ${JSON.stringify(load.hold)}`);

	// Object-store outage across the next renewal point. certmagic renews at 1/3 of the lifetime
	// left (or the ARI window); stop MinIO 10 s before that and keep it down OUTAGE s.
	const now = await probe(ING, host);
	const notAfter = Math.min(...now.map((p) => p.notAfter ?? Infinity));
	const due = notAfter - (LIFETIME / 3) * 1000;
	const stopAt = due - 10_000;
	const outage = await holdAndWatch('a-outage', ING, host, Math.round((notAfter - Date.now()) / 1000) + 30, async () => {
		await Bun.sleep(Math.max(0, stopAt - Date.now()));
		say(`A: MinIO stopped for ${OUTAGE} s (renewal due at ${new Date(due).toISOString().slice(11, 19)}, old certificate expires ${new Date(notAfter).toISOString().slice(11, 19)})`);
		docker('stop', '-t', '0', LAB.minio.container);
		await Bun.sleep(OUTAGE * 1000);
		docker('start', LAB.minio.container);
		say('A: MinIO back');
	});
	record('a.outage', { ...outage, outageS: OUTAGE, dueAt: new Date(due).toISOString(), oldNotAfter: new Date(notAfter).toISOString(), pebble: pebbleIssuances() });

	// Ingress removal: nothing in design A notices. Then force a reissue the only way certmagic
	// allows without a restart: delete the stored certificate and reload one ingress's config.
	await removalA(host);
	record('a.final', { pebble: pebbleIssuances(), challenges: challengeAnswers(ING), lockLog: lockLines() });
}

function lockLines() {
	return Object.fromEntries(
		ING.map((n) => {
			const l = containerLogs(n.container).split('\n');
			return [n.name, {
				acquired: l.filter((x) => x.includes('acquiring lock')).length,
				obtained: l.filter((x) => x.includes('certificate obtained successfully')).length,
				renewed: l.filter((x) => /certificate renewed successfully|renewing certificate/.test(x)).length,
				reloadedFromStorage: l.filter((x) => /reloading managed certificate|reloaded|already renewed|certificate.*newer.*storage/i.test(x)).length,
				staleLock: l.filter((x) => x.includes('replaced stale lock')).length,
				errors: l.filter((x) => /"level":"error"/.test(x)).length,
			}];
		}),
	);
}

async function removalA(host: string) {
	const remaining = ING.slice(0, 2);
	const before = await probe(remaining, host);
	docker('rm', '-f', ING[2]!.container);
	// The balancer has to drop it too: Pebble's three validations must all pass, and one would
	// otherwise time out on the dead node (seen in the first run).
	haproxy(remaining.map((n) => n.name));
	say('A: ing-c removed (and taken out of HAProxy); waiting 20 s to see whether anything reissues');
	await Bun.sleep(20_000);
	const after = await probe(remaining, host);
	const issuedBefore = pebbleIssuances().count;
	// Forced reissue, step 1: remove the certificate from shared storage and reload ing-a's config.
	sh(['docker', 'exec', LAB.minio.container, 'sh', '-c',
		`mc alias set s4 http://127.0.0.1:9000 '${LAB.minio.user}' '${LAB.minio.pass}' >/dev/null && mc rm -r --force s4/${LAB.minio.bucket}/caddy/certificates/`]);
	sh(['docker', 'exec', ING[0]!.container, 'sh', '-c',
		`curl -sf -X POST -H 'Content-Type: application/json' -H 'Cache-Control: must-revalidate' --data-binary @/etc/s4/caddy.json localhost:2019/load`], true);
	await Bun.sleep(20_000);
	const afterReload = { issued: pebbleIssuances().count - issuedBefore, probes: (await probe(remaining, host)).map((p) => p.fingerprint?.slice(0, 16)) };
	// Step 2: restart ing-a's Caddy process (its in-memory cache is what survived the reload).
	const t = Date.now();
	docker('restart', ING[0]!.container);
	let aNew: { ms: number | null; fp?: string } = { ms: null };
	while (Date.now() - t < 150_000) {
		const p = await probe([ING[0]!], host);
		if (p[0]?.ok && p[0].fingerprint !== before[0]?.fingerprint) {
			aNew = { ms: Date.now() - t, fp: p[0].fingerprint };
			break;
		}
		await Bun.sleep(500);
	}
	await Bun.sleep(15_000);
	const b = (await probe([ING[1]!], host))[0]!;
	record('a.removal', {
		reissuedByRemoval: before[0]?.fingerprint !== after[0]?.fingerprint,
		afterStorageDeleteAndReload: afterReload,
		afterRestartOfIngA: {
			issued: pebbleIssuances().count - issuedBefore,
			ingANewCertAfterMs: aNew.ms,
			ingBFollowedWithin15s: b.fingerprint === aNew.fp,
			ingBOldCertSecondsLeft: b.notAfter ? Math.round((b.notAfter - Date.now()) / 1000) : null,
			renewalWindowS: Math.round(LIFETIME / 3),
		},
	});
	say(`A removal: ${JSON.stringify(results()['a.removal'])}`);
}

/** Design A for two lifetimes, no load: why each renewal happened (ARI vs ratio), per ingress. */
async function scenarioAAri() {
	const host = `a.${LAB.domain}`;
	await base({ minio: true });
	await startIngresses(ING, { image: LAB.images.ingressLock, config: aConfig('s3-lock', host) });
	await waitSameFingerprint(ING, host, 120);
	await Bun.sleep(LIFETIME * 2 * 1000);
	const reasons = Object.fromEntries(ING.map((n) => {
		const rows = containerLogs(n.container).split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))
			.filter((e) => /needs renewal based on ARI|ephemeral|renewal window based on expiration|renewed already|renewing certificate|certificate renewed successfully|emergency/.test(e.msg));
		return [n.name, rows.map((e) => `${new Date(e.ts * 1000).toISOString().slice(11, 19)} ${e.msg}${e.selected_time ? ` selected=${String(e.selected_time).slice(11, 19)}` : ''}${e.ephemeral_selected_time ? ` ephemeral=${String(e.ephemeral_selected_time).slice(11, 19)}` : ''}${e.window_start ? ` window=${String(e.window_start).slice(11, 19)}..${String(e.window_end).slice(11, 19)}` : ''}`)];
	}));
	record('a-ari', { pebble: pebbleIssuances(), reasons });
}

async function scenarioANoLock() {
	const host = `a.${LAB.domain}`;
	await base({ minio: true });
	await startIngresses(ING, { image: LAB.images.ingressNoLock, config: aConfig('s3-nolock', host) });
	const first = await waitSameFingerprint(ING, host, 120);
	await Bun.sleep(10_000);
	const p = await probe(ING, host);
	const atStart = pebbleIssuances();
	say(`A-nolock: Pebble issued ${atStart.count} at start; fingerprints ${new Set(p.map((x) => x.fingerprint)).size}`);
	// One renewal window, all three instances due at the same moment.
	const notAfter = Math.min(...p.map((x) => x.notAfter ?? Infinity));
	const w = await holdAndWatch('a-nolock', ING, host, Math.round((notAfter - Date.now()) / 1000) + 15);
	record('a-nolock', { firstSameMs: first.ms, atStart, probes: p, renewal: w.distribution, pebble: pebbleIssuances(), challenges: challengeAnswers(ING), hold: w.hold });
}

async function scenarioALocal() {
	const host = `a.${LAB.domain}`;
	await base();
	await startIngresses(ING, { image: LAB.images.ingressLock, config: aConfig('local', host) });
	await Bun.sleep(90_000);
	const p = await probe(ING, host);
	const logs = Object.fromEntries(ING.map((n) => {
		const l = containerLogs(n.container).split('\n');
		return [n.name, {
			obtained: l.filter((x) => x.includes('certificate obtained successfully')).length,
			challengeFailed: l.filter((x) => /challenge failed|could not validate|"level":"error".*(obtain|challenge)/i.test(x)).length,
			sample: l.filter((x) => /error/i.test(x) && /challenge|authorization/i.test(x)).slice(0, 1),
		}];
	}));
	record('a-local', { probes: p.map((x) => ({ target: x.target, fp: x.fingerprint?.slice(0, 16), error: x.error })), distinctFingerprints: new Set(p.filter((x) => x.ok).map((x) => x.fingerprint)).size, pebble: pebbleIssuances(), challenges: challengeAnswers(ING), logs });
	say(`A-local: ${JSON.stringify(results()['a-local'])}`);
}

// ---------------------------------------------------------------------------------------------
// Design B
function startCp(env: Record<string, string>) {
	dockerTry('rm', '-f', LAB.cp.container);
	netRun(LAB.cp.container, LAB.cp.ip,
		['--network-alias', LAB.cp.alias, '-v', `${RIG}:${IN.rig}:ro`, '-v', `${join(TMP, 'shared')}:${IN.shared}:ro`,
			...Object.entries({ S4_LIFETIME: String(LIFETIME), ...env }).flatMap(([k, v]) => ['-e', `${k}=${v}`])],
		LAB.images.cp, ['bun', `${IN.rig}/cp.ts`]);
}

function cpEvents(): Record<string, unknown>[] {
	return containerLogs(LAB.cp.container).split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
}

function agentEvents(nodes: readonly { container: string }[]) {
	return nodes.flatMap((n) => containerLogs(n.container).split('\n').filter((l) => l.startsWith('{"t"') && l.includes('"src":"agent"')).map((l) => JSON.parse(l)));
}

async function startB(relay: boolean, host: string, delivery: 'load' | 'manager' = 'load') {
	startCp({ S4_DOMAINS: host });
	await startIngresses(ING, {
		image: LAB.images.ingressLock,
		config: (node) => caddyConfig({ node, host, design: 'B', relay: relay ? `${LAB.cp.alias}:80` : null, certFiles: null, delivery }),
		env: { S4_AGENT: '1', S4_HOST: host, S4_RELAY: relay ? `${LAB.cp.alias}:80` : '', S4_DELIVERY: delivery },
	});
}

/** For each generation: issued at the cp, loaded by each agent, and the spread. */
function bTimeline(nodes: readonly { container: string; name: string }[]) {
	const cp = cpEvents().filter((e) => e.event === 'issued');
	const ag = agentEvents(nodes).filter((e) => e.event === 'loaded');
	return cp.map((e) => {
		const loads = ag.filter((a) => a.generation === e.generation);
		const ts = loads.map((a) => a.t as number);
		return {
			generation: e.generation,
			reason: e.reason,
			issueMs: e.ms,
			loadedBy: loads.length,
			lastLoadAfterIssueMs: ts.length ? Math.max(...ts) - (e.t as number) : null,
			loadMs: loads.map((a) => a.ms),
		};
	});
}

async function scenarioB(delivery: 'load' | 'manager' = 'load') {
	const K = delivery === 'load' ? 'b' : 'b-hot';
	const host = `b.${LAB.domain}`;
	await base();
	const t0 = Date.now();
	await startB(true, host, delivery);
	const first = await waitSameFingerprint(ING, host, 120);
	say(`${K}: all three serve one certificate after ${Date.now() - t0} ms; Pebble issued ${pebbleIssuances().count}`);
	record(`${K}.start`, { firstMs: Date.now() - t0, probes: first.probes, pebble: pebbleIssuances(), relayed: relayedChallenges() });

	const load = await holdAndWatch(`${K}-load`, ING, host, LIFETIME + 30);
	record(`${K}.load`, { ...load, pebble: pebbleIssuances(), timeline: bTimeline(ING) });
	say(`${K} load: ${JSON.stringify(load.hold)}`);

	// Control-plane outage across the renewal point: the cp renews at LIFETIME/3 remaining.
	const status = JSON.parse(docker('exec', LAB.client.container, 'wget', '-qO-', `http://${LAB.cp.ip}:8080/status`));
	const notAfter = Date.parse(status.notAfter);
	const due = notAfter - (LIFETIME / 3) * 1000;
	const outage = await holdAndWatch(`${K}-outage`, ING, host, Math.round((notAfter - Date.now()) / 1000) + 30, async () => {
		await Bun.sleep(Math.max(0, due - 5_000 - Date.now()));
		say(`${K}: control plane stopped for ${OUTAGE} s (renewal due ${new Date(due).toISOString().slice(11, 19)}, old certificate expires ${new Date(notAfter).toISOString().slice(11, 19)})`);
		docker('stop', '-t', '0', LAB.cp.container);
		await Bun.sleep(OUTAGE * 1000);
		docker('start', LAB.cp.container);
		say('B: control plane back');
	});
	record(`${K}.outage`, { ...outage, outageS: OUTAGE, dueAt: new Date(due).toISOString(), oldNotAfter: new Date(notAfter).toISOString(), pebble: pebbleIssuances(), timeline: bTimeline(ING), agentOutage: agentEvents(ING).filter((e) => /issuer-/.test(e.event as string)) });

	// Ingress removal: remove ing-c, then the issuer reissues and the rest pick it up.
	const remaining = ING.slice(0, 2);
	const before = await probe(remaining, host);
	docker('rm', '-f', ING[2]!.container);
	haproxy(remaining.map((n) => n.name));
	const issuedBefore = pebbleIssuances().count;
	const t = Date.now();
	docker('exec', LAB.client.container, 'wget', '-qO-', '--header', 'Authorization: Bearer s4-node-token', '--post-data', '', `http://${LAB.cp.ip}:8080/reissue`);
	const issuedMs = Date.now() - t;
	const w = await waitSameFingerprint(remaining, host, 60, before[0]?.fingerprint);
	record(`${K}.removal`, { issued: pebbleIssuances().count - issuedBefore, issuedMs, allSwitchedMs: Date.now() - t, waited: w.ms });
	record(`${K}.final`, { pebble: pebbleIssuances(), timeline: bTimeline(ING.slice(0, 2)), relayed: relayedChallenges(), custody: custody() });
}

/** Challenge requests each ingress forwarded to the cp (Caddy access log on the :80 server). */
function relayedChallenges() {
	return Object.fromEntries(ING.map((n) => {
		const l = containerLogs(n.container).split('\n').filter((x) => x.includes('acme-challenge') && x.includes('http.log.access'));
		return [n.name, { requests: l.length, status200: l.filter((x) => x.includes('"status":200')).length }];
	}));
}

function custody() {
	return sh(['docker', 'exec', ING[0]!.container, 'sh', '-c', 'ls -ln /etc/caddy-certs; stat -c "%a %U:%G %n" /etc/caddy-certs/*; ps -o user= -C caddy'], true);
}

async function scenarioBNoRelay() {
	const host = `b.${LAB.domain}`;
	await base();
	startCp({ S4_DOMAINS: host, S4_RETRY_S: '5' });
	await startIngresses(ING, {
		image: LAB.images.ingressLock,
		config: (node) => caddyConfig({ node, host, design: 'B', relay: null, certFiles: null }),
		env: { S4_AGENT: '1', S4_HOST: host, S4_RELAY: '' },
	});
	await Bun.sleep(45_000);
	const ev = cpEvents();
	record('b-norelay', {
		attempts: ev.filter((e) => e.event === 'issue-start').length,
		failed: ev.filter((e) => e.event === 'issue-failed').length,
		issued: ev.filter((e) => e.event === 'issued').length,
		sampleError: ev.find((e) => e.event === 'issue-failed')?.tail,
		pebble: pebbleIssuances(),
		challengeRequestsAtIngresses: Object.fromEntries(ING.map((n) => [n.name, containerLogs(n.container).split('\n').filter((x) => x.includes('acme-challenge') && x.includes('http.log.access')).map((x) => JSON.parse(x).status)])),
	});
	say(`B-norelay: ${JSON.stringify(results()['b-norelay'])}`);

	// Same lab, relay switched on at every ingress via one config reload each: issuance must succeed.
	for (const n of ING) {
		const cfg = caddyConfig({ node: n.name, host, design: 'B', relay: `${LAB.cp.alias}:80`, certFiles: null });
		writeFileSync(join(TMP, n.name, 'caddy.json'), JSON.stringify(cfg));
		sh(['docker', 'exec', n.container, 'curl', '-sf', '-X', 'POST', '-H', 'Content-Type: application/json', '--data-binary', '@/etc/s4/caddy.json', 'localhost:2019/load']);
	}
	const w = await waitSameFingerprint(ING, host, 60);
	record('b-norelay.then-relay', { allServeMs: w.ms, pebble: pebbleIssuances(), relayed: relayedChallenges() });
	say(`B-norelay then relay: ${JSON.stringify(results()['b-norelay.then-relay'])}`);
}

async function scenarioDns01() {
	await base();
	startCp({ S4_DOMAINS: `*.${LAB.domain},${LAB.domain}`, S4_CHALLENGE: 'dns' });
	for (let i = 0; i < 150; i++) {
		if (cpEvents().some((e) => e.event === 'issued' || e.event === 'issue-failed')) break;
		await Bun.sleep(1000);
	}
	const ev = cpEvents();
	record('dns01', { events: ev.filter((e) => e.event !== 'start'), pebble: pebbleIssuances() });
	say(`DNS-01: ${JSON.stringify(results()['dns01'])}`);
}

/** Hard rule: no real CA. Fail the run if any lab container's log names a public ACME endpoint. */
function assertNoPublicCa(scenario: string) {
	for (const c of ALL) {
		const hits = containerLogs(c).split('\n').filter((l) => /acme(-staging)?-v02\.api\.letsencrypt\.org|acme\.zerossl\.com|dv\.acme-v02(\.test-)?api\.pki\.goog|api\.buypass/i.test(l));
		if (hits.length) throw new Error(`${scenario}: ${c} logged a public CA (${hits.length} lines): ${hits[0]!.slice(0, 200)}`);
	}
}

// ---------------------------------------------------------------------------------------------
const SCENARIOS: Record<string, () => Promise<void>> = {
	a: scenarioA,
	'a-nolock': scenarioANoLock,
	'a-ari': scenarioAAri,
	'a-local': scenarioALocal,
	b: () => scenarioB('load'),
	'b-hot': () => scenarioB('manager'),
	'b-norelay': scenarioBNoRelay,
	dns01: scenarioDns01,
};

if (import.meta.main) {
	const wanted = process.argv.slice(2);
	if (wanted[0] === 'down') {
		down();
		process.exit(0);
	}
	const list = wanted.length ? wanted : Object.keys(SCENARIOS);
	mkdirSync(OUT, { recursive: true });
	const KEEP = join(RIG, 'results.json');
	const keep: Record<string, unknown> = existsSync(KEEP) ? JSON.parse(readFileSync(KEEP, 'utf8')) : {};
	try {
		for (const name of list) {
			const fn = SCENARIOS[name];
			if (!fn) throw new Error(`unknown scenario ${name}`);
			say(`=== ${name}`);
			await fn();
			assertNoPublicCa(name);
			// base() wipes tmp/; carry results across scenarios.
			Object.assign(keep, results());
			writeFileSync(KEEP, JSON.stringify(keep, null, 2));
		}
	} finally {
		if (!process.env.S4_KEEP) down();
	}
}
