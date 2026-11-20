/**
 * S4 cloud half: ACME DNS-01 against a real Cloudflare zone, Let's Encrypt **staging** only.
 * Usage (from cloud.sh, which sources creds.env into this process only):
 *   bun cloud.ts <step…>
 *     account       register the one ACME account (no email) with lego; Caddy reuses its key
 *     lego-wild     (a) lego, one order for *.<label>.<zone> + <label>.<zone>
 *     caddy-wild    (b) pinned Caddy, the same two names
 *     lego-5b       lego, Cloudflare API blacked out for 60 s from the moment the TXT exists
 *     caddy-5b      Caddy, the same
 *     lego-5a       lego, blackout from the first API call (one order: lego is one-shot; retrying is
 *                   the issuer loop's job, so legoIssue takes an optional backoff list)
 *     caddy-5a      Caddy (its own backoff, 1 m first), blackout from the first API call; capped at 2
 *                   orders. Its first retry lands ~0.2 s after a 60 s blackout ends, so it can race.
 *     sweep         list `_acme-challenge.yoal-w0-s4-*` TXT, delete what is left, prove none remain
 *     wipe          delete the account, certificates and keys from disk
 *
 * Orders on a clean run of every step: 8 (lego-wild 1, caddy-wild 2, lego-5b 1, caddy-5b 1, caddy-5a ≤ 2,
 * lego-5a 1); the rig refuses a step that could take the total past 10.
 *
 * Every Cloudflare API call from a client goes through an in-process CONNECT proxy on the Mac's
 * loopback (containers reach it as host.docker.internal) that only allows api.cloudflare.com:443
 * and can black it out. ACME traffic goes direct to the staging host. Env: CF_ZONE_NAME,
 * CF_ZONE_ID, CF_API_TOKEN (never printed; every log line passes through `redact`).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Socket } from 'bun';

const STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';
const FORBIDDEN = /acme-v02\.api\.letsencrypt\.org|zerossl/i;
const PREFIX = 'yoal-w0-s4-';
const MAX_ORDERS = 10;
const BLACKOUT_S = Number(process.env.S4C_BLACKOUT ?? 60);
const LEGO_IMAGE = 'goacme/lego:v5.6.0';
const CADDY_IMAGE = 'yoal-w0-s4c-caddy';
// Belt and braces beside the config grep: the clients cannot resolve production or ZeroSSL.
const BLOCK_HOSTS = ['acme-v02.api.letsencrypt.org', 'acme.zerossl.com', 'api.zerossl.com'].flatMap((h) => ['--add-host', `${h}:127.0.0.1`]);
// OrbStack's container resolver (0.250.250.200) times out on lego's and certmagic's raw DNS queries,
// so the clients get public resolvers, as a cloud host would have; neither client is tuned.
const NET = ['--dns', '1.1.1.1', '--dns', '8.8.8.8', '--add-host', 'host.docker.internal:host-gateway'];

const RIG = import.meta.dir;
const DATA = join(RIG, 'tmp', 'cloud');
const LEGO_DIR = join(DATA, 'lego');
const CADDY_DIR = join(DATA, 'caddy');
const LOGS = join(DATA, 'logs');
const STATE = join(DATA, 'state.json');
const RESULTS = join(RIG, 'results-cloud.json');

const ZONE = must('CF_ZONE_NAME');
const ZONE_ID = must('CF_ZONE_ID');
const TOKEN = must('CF_API_TOKEN');
function must(k: string): string {
	const v = process.env[k];
	if (!v) throw new Error(`${k} is not set (run through cloud.sh)`);
	return v;
}

// CF_ZONE_NAME may be a subdomain inside the Cloudflare zone; APEX is the zone's own name (from the API).
let APEX = '';
const redact = (s: string) => {
	s = s.split(TOKEN).join('<token>').split(ZONE_ID).join('<zone-id>').split(ZONE).join('<zone>');
	if (!APEX) return s;
	// certmagic logs record names relative to the apex: redact the part of <zone> above the apex.
	const sub = ZONE.length > APEX.length ? ZONE.slice(0, -(APEX.length + 1)) : '';
	if (sub) s = s.split(`.${sub}"`).join('.<sub>"');
	return s.split(APEX).join('<apex>');
};
const say = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${redact(msg)}`);
const now = () => Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------
// State and results (redacted; results-cloud.json is git-ignored)

type State = { orders: number; accountKeyFile?: string; accountId?: string };
const state = (): State => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { orders: 0 });
const saveState = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 2));
function record(key: string, value: unknown) {
	const r = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : {};
	r[key] = JSON.parse(redact(JSON.stringify(value)));
	writeFileSync(RESULTS, JSON.stringify(r, null, 2));
}

// ------------------------------------------------------------------------------------------------
// Cloudflare API (host side): only TXT records under _acme-challenge.yoal-w0-s4-*

type Rec = { id: string; name: string; type: string; content: string; created_on: string };
const OURS = new RegExp(`^_acme-challenge\\.${PREFIX}[a-z0-9]+\\.${ZONE.replace(/\./g, '\\.')}$`);

async function cf(path: string, init: RequestInit = {}): Promise<any> {
	const r = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}${path}`, {
		...init,
		headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
	});
	const body = (await r.json()) as any;
	if (!body.success) throw new Error(`cloudflare ${init.method ?? 'GET'} ${path.split('?')[0]}: ${r.status} ${JSON.stringify(body.errors)}`);
	return body;
}
async function listOurs(): Promise<Rec[]> {
	const body = await cf(`/dns_records?type=TXT&per_page=100&name.startswith=${encodeURIComponent(`_acme-challenge.${PREFIX}`)}`);
	return (body.result as Rec[]).filter((r) => r.type === 'TXT' && OURS.test(r.name));
}
async function deleteOurs(rec: Rec) {
	if (rec.type !== 'TXT' || !OURS.test(rec.name)) throw new Error(`refusing to delete ${rec.type} ${rec.name}`);
	await cf(`/dns_records/${rec.id}`, { method: 'DELETE' });
}

/** Polls the API every second; remembers when each of our TXT records appeared and disappeared. */
class Watcher {
	seen = new Map<string, { name: string; content: string; createdOn: number; firstSeen: number; goneAt?: number; ansAll?: number }>();
	onNew?: (rec: Rec) => void;
	private stop = false;
	private loop?: Promise<void>;
	start() {
		this.loop = (async () => {
			while (!this.stop) {
				try {
					const recs = await listOurs();
					const t = now();
					const ids = new Set(recs.map((r) => r.id));
					for (const r of recs) {
						if (this.seen.has(r.id)) continue;
						this.seen.set(r.id, { name: r.name, content: r.content, createdOn: Date.parse(r.created_on), firstSeen: t });
						say(`TXT appeared ${r.name}`);
						this.onNew?.(r);
						void probeAuthoritative(r).then((ms) => {
							const s = this.seen.get(r.id);
							if (s && ms) s.ansAll = ms;
						});
					}
					for (const [id, s] of this.seen) {
						if (!s.goneAt && !ids.has(id)) {
							s.goneAt = t;
							say(`TXT gone ${s.name} (lived ${((t - s.createdOn) / 1000).toFixed(1)} s)`);
						}
					}
				} catch (e) {
					say(`watcher: ${(e as Error).message}`);
				}
				await sleep(1000);
			}
		})();
	}
	async halt() {
		this.stop = true;
		await this.loop;
	}
	report() {
		return [...this.seen.values()].map((s) => ({
			name: s.name,
			createdOn: new Date(s.createdOn).toISOString(),
			firstSeenByPollS: +((s.firstSeen - s.createdOn) / 1000).toFixed(1),
			allAuthoritativeS: s.ansAll ? +((s.ansAll - s.createdOn) / 1000).toFixed(1) : null,
			removedAfterS: s.goneAt ? +((s.goneAt - s.createdOn) / 1000).toFixed(1) : null,
			removedAt: s.goneAt ? new Date(s.goneAt).toISOString() : null,
		}));
	}
}

let NS_IPS: string[] = [];
function digShort(...args: string[]): string[] {
	const p = Bun.spawnSync(['dig', '+short', '+time=2', '+tries=1', ...args], { stdout: 'pipe', stderr: 'pipe' });
	return p.stdout.toString().trim().split('\n').filter(Boolean);
}
async function loadNameservers() {
	const z = (await cf('')).result as { name: string; status: string; name_servers: string[] };
	APEX = z.name;
	if (ZONE !== APEX && !ZONE.endsWith(`.${APEX}`)) throw new Error('CF_ZONE_NAME is not inside the Cloudflare zone');
	NS_IPS = z.name_servers.flatMap((n) => digShort('A', n)).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
	if (!NS_IPS.length) throw new Error('no authoritative nameserver addresses for the zone');
	say(`zone ${z.status}; <zone> is ${ZONE === APEX ? 'the apex' : 'a subdomain inside it'}; ${z.name_servers.length} nameservers, ${NS_IPS.length} IPv4 addresses`);
}
/** Time (epoch ms) at which every authoritative nameserver answered the record's value, or 0. */
async function probeAuthoritative(r: Rec): Promise<number> {
	const want = r.content.replace(/^"|"$/g, '');
	const pending = new Set(NS_IPS);
	const deadline = now() + 180_000;
	while (pending.size && now() < deadline) {
		for (const ip of [...pending]) {
			const ans = digShort(`@${ip}`, 'TXT', r.name, '+norecurse').map((a) => a.replace(/"/g, ''));
			if (ans.includes(want)) pending.delete(ip);
		}
		if (pending.size) await sleep(250);
	}
	return pending.size ? 0 : now();
}

// ------------------------------------------------------------------------------------------------
// CONNECT proxy with a blackout switch (the "Cloudflare API unreachable" fault)

type Tunnel = { client: Socket<any>; upstream?: Socket<any> };
const proxy = {
	port: 0,
	blockedUntil: 0,
	armFirstConnect: false,
	tunnels: new Set<Tunnel>(),
	stats: { connects: 0, refused: 0, denied: 0, killed: 0, events: [] as { t: string; ev: string }[] },
	blocked() {
		return now() < this.blockedUntil;
	},
	block(seconds: number, why: string) {
		this.blockedUntil = now() + seconds * 1000;
		this.stats.events.push({ t: new Date().toISOString(), ev: `blackout ${seconds}s (${why})` });
		say(`Cloudflare API blackout for ${seconds} s (${why})`);
		for (const t of this.tunnels) {
			t.client.end();
			t.upstream?.end();
			this.stats.killed++;
		}
		this.tunnels.clear();
		setTimeout(() => {
			this.stats.events.push({ t: new Date().toISOString(), ev: 'blackout over' });
			say('Cloudflare API reachable again');
		}, seconds * 1000);
	},
	reset() {
		this.blockedUntil = 0;
		this.armFirstConnect = false;
		this.stats = { connects: 0, refused: 0, denied: 0, killed: 0, events: [] };
	},
};
function startProxy() {
	const server = Bun.listen<{ buf: string; tunnel?: Tunnel }>({
		hostname: '127.0.0.1',
		port: 0,
		socket: {
			open(s) {
				s.data = { buf: '' };
			},
			async data(s, chunk) {
				const d = s.data;
				if (d.tunnel) {
					d.tunnel.upstream?.write(chunk);
					return;
				}
				d.buf += Buffer.from(chunk).toString('latin1');
				const end = d.buf.indexOf('\r\n\r\n');
				if (end < 0) return;
				const m = /^CONNECT ([^\s:]+):(\d+) HTTP/.exec(d.buf);
				const rest = Buffer.from(d.buf.slice(end + 4), 'latin1');
				if (!m || m[1] !== 'api.cloudflare.com' || m[2] !== '443') {
					proxy.stats.denied++;
					proxy.stats.events.push({ t: new Date().toISOString(), ev: `denied ${m ? `${m[1]}:${m[2]}` : 'non-CONNECT'}` });
					s.end('HTTP/1.1 403 Forbidden\r\n\r\n');
					return;
				}
				proxy.stats.connects++;
				if (proxy.armFirstConnect) {
					proxy.armFirstConnect = false;
					proxy.block(BLACKOUT_S, 'first API call');
				}
				if (proxy.blocked()) {
					// Unreachable: the connection closes with no response.
					proxy.stats.refused++;
					s.end();
					return;
				}
				const tunnel: Tunnel = { client: s };
				d.tunnel = tunnel;
				proxy.tunnels.add(tunnel);
				try {
					tunnel.upstream = await Bun.connect({
						hostname: 'api.cloudflare.com',
						port: 443,
						socket: {
							data(_u, c) {
								s.write(c);
							},
							close() {
								s.end();
								proxy.tunnels.delete(tunnel);
							},
							error() {
								s.end();
							},
						},
					});
					s.write('HTTP/1.1 200 Connection established\r\n\r\n');
					if (rest.length) tunnel.upstream.write(rest);
				} catch {
					s.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
				}
			},
			close(s) {
				const t = s.data?.tunnel;
				if (t) {
					t.upstream?.end();
					proxy.tunnels.delete(t);
				}
			},
		},
	});
	proxy.port = server.port;
	say(`CONNECT proxy on 127.0.0.1:${server.port} (allows api.cloudflare.com:443 only)`);
}

// ------------------------------------------------------------------------------------------------
// Clients

const label = () => PREFIX + Math.random().toString(36).slice(2, 6).replace(/[^a-z0-9]/g, 'x');
const proxyEnv = () => [
	'-e', `HTTPS_PROXY=http://host.docker.internal:${proxy.port}`,
	'-e', `https_proxy=http://host.docker.internal:${proxy.port}`,
	'-e', 'NO_PROXY=acme-staging-v02.api.letsencrypt.org,.lencr.org',
	'-e', 'no_proxy=acme-staging-v02.api.letsencrypt.org,.lencr.org',
];

/** Refuses to run if a rendered config or argument list names a non-staging CA. */
function guard(name: string, rendered: string) {
	if (FORBIDDEN.test(rendered)) throw new Error(`guard: ${name} names a forbidden CA; refusing to run`);
	if (!rendered.includes(STAGING)) throw new Error(`guard: ${name} does not name the staging directory; refusing to run`);
	writeFileSync(join(LOGS, `${name}.rendered`), redact(rendered));
	say(`guard ok: ${name} names only ${STAGING}`);
}

type Run = { code: number; startedAt: number; endedAt: number; lines: { t: number; line: string }[] };
/** Runs a container to completion (or until `until` matches a line), keeping redacted, timestamped lines. */
async function runContainer(name: string, args: string[], logName: string, opts: { until?: RegExp; timeoutS: number; onLine?: (l: string) => void }): Promise<Run> {
	Bun.spawnSync(['docker', 'rm', '-f', name], { stdout: 'ignore', stderr: 'ignore' });
	const startedAt = now();
	const p = Bun.spawn(['docker', 'run', '--rm', '--name', name, ...BLOCK_HOSTS, ...NET, ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, CF_DNS_API_TOKEN: TOKEN },
	});
	const lines: Run['lines'] = [];
	const logFile = join(LOGS, `${logName}.log`);
	let done = false;
	const pump = async (stream: ReadableStream<Uint8Array>) => {
		const dec = new TextDecoder();
		let buf = '';
		for await (const chunk of stream) {
			buf += dec.decode(chunk);
			let i: number;
			while ((i = buf.indexOf('\n')) >= 0) {
				const line = redact(buf.slice(0, i));
				buf = buf.slice(i + 1);
				const t = now();
				lines.push({ t, line });
				appendFileSync(logFile, `${new Date(t).toISOString()} ${line}\n`);
				if (FORBIDDEN.test(line)) say(`!! forbidden CA named in ${logName}: ${line.slice(0, 200)}`);
				opts.onLine?.(line);
				if (opts.until?.test(line) && !done) {
					done = true;
					Bun.spawnSync(['docker', 'stop', '-t', '5', name], { stdout: 'ignore', stderr: 'ignore' });
				}
			}
		}
	};
	const timer = setTimeout(() => {
		say(`${logName}: timeout ${opts.timeoutS} s, stopping`);
		Bun.spawnSync(['docker', 'stop', '-t', '5', name], { stdout: 'ignore', stderr: 'ignore' });
	}, opts.timeoutS * 1000);
	await Promise.all([pump(p.stdout), pump(p.stderr)]);
	const code = await p.exited;
	clearTimeout(timer);
	return { code: done ? 0 : code, startedAt, endedAt: now(), lines };
}

function legoArgs(cmd: string[], extraEnv: string[] = []): string[] {
	const args = [
		...proxyEnv(), ...extraEnv,
		'-e', 'CF_DNS_API_TOKEN',
		'-v', `${LEGO_DIR}:/data`,
		LEGO_IMAGE,
		...cmd,
		'--server', STAGING,
		'--path', '/data',
	];
	return args;
}

// Order counting from the client logs (each counted pattern is one newOrder at the CA).
const LEGO_ORDER = /msg="?(acme: )?Obtaining (bundled )?(SAN )?certificate/i;
const CADDY_ORDER = /"msg":"trying to solve challenge"/;

function budget(need: number, what: string): boolean {
	const s = state();
	if (s.orders + need > MAX_ORDERS) {
		say(`SKIP ${what}: needs up to ${need} orders, ${s.orders}/${MAX_ORDERS} used`);
		return false;
	}
	return true;
}
function addOrders(n: number) {
	const s = state();
	s.orders += n;
	saveState(s);
	say(`orders used: ${s.orders}/${MAX_ORDERS}`);
}

function certInfo(file: string) {
	const p = Bun.spawnSync(['openssl', 'x509', '-noout', '-issuer', '-ext', 'subjectAltName', '-enddate', '-in', file], { stdout: 'pipe', stderr: 'pipe' });
	const out = redact(p.stdout.toString());
	return {
		issuer: /issuer=(.*)/.exec(out)?.[1]?.trim(),
		sans: [...out.matchAll(/DNS:([^,\s]+)/g)].map((m) => m[1]),
		notAfter: /notAfter=(.*)/.exec(out)?.[1]?.trim(),
		staging: /STAGING|\(STAGING\)|Fake|False Fennel|Counterfeit|Pretend|Bogus|Puzzling|Mysterious|Doctored|Riddling|Ersatz|Yearning|Wannabe|Sham|Imitation/i.test(out),
	};
}
function findFiles(dir: string, re: RegExp, acc: string[] = []): string[] {
	if (!existsSync(dir)) return acc;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) findFiles(p, re, acc);
		else if (re.test(e.name)) acc.push(p);
	}
	return acc;
}

// ------------------------------------------------------------------------------------------------
// Steps

/** Free check before any order: the client network resolves through public DNS and reaches the proxy. */
async function preflight() {
	const script = `const fs = require('node:fs'), dns = require('node:dns').promises;
if (!/^nameserver 1\\.1\\.1\\.1/m.test(fs.readFileSync('/etc/resolv.conf', 'utf8'))) throw new Error('resolver not public');
await dns.resolveSoa(process.argv[1]);
await fetch('https://api.cloudflare.com/client/v4/', { proxy: process.argv[2] }).catch(() => {});
console.log('ok');`;
	const p = Bun.spawn(['docker', 'run', '--rm', '--name', 'yoal-w0-s4c-preflight', ...BLOCK_HOSTS, ...NET, 'oven/bun:1.4.4-alpine', 'bun', '-e', script, APEX, `http://host.docker.internal:${proxy.port}`], { stdout: 'pipe', stderr: 'pipe' });
	const out = redact((await new Response(p.stdout).text()) + (await new Response(p.stderr).text())).trim();
	await p.exited;
	if (p.exitCode !== 0 || proxy.stats.connects < 1) throw new Error(`preflight failed (${p.exitCode}, proxy connects ${proxy.stats.connects}): ${out}`);
	proxy.reset();
	say('preflight ok: public resolver, proxy reachable');
}

async function account() {
	if (state().accountKeyFile) {
		const acct = findFiles(join(LEGO_DIR, 'accounts'), /account\.json$/)[0];
		if (acct) record('account', { ca: STAGING, contact: JSON.parse(readFileSync(acct, 'utf8')).email || 'none', location: JSON.parse(readFileSync(acct, 'utf8')).registration?.accountURL });
		return say('account already registered; reusing');
	}
	const args = legoArgs(['accounts', 'register', '--accept-tos', '--log.format', 'text']);
	guard('lego-account', args.join(' '));
	const r = await runContainer('yoal-w0-s4c-lego', args, 'lego-account', { timeoutS: 120 });
	if (r.code !== 0) throw new Error(`lego accounts register exited ${r.code}`);
	const keys = findFiles(join(LEGO_DIR, 'accounts'), /\.key$/);
	if (keys.length !== 1) throw new Error(`expected one account key, found ${keys.length}`);
	const acct = findFiles(join(LEGO_DIR, 'accounts'), /account\.json$/)[0];
	const id = acct ? (JSON.parse(readFileSync(acct, 'utf8')).registration?.accountURL ?? '') : '';
	saveState({ ...state(), accountKeyFile: keys[0]!, accountId: id });
	record('account', { ca: STAGING, contact: 'none', location: id, keyFile: keys[0]!.replace(RIG, '.') });
	say(`account registered: ${id}`);
}

/** lego, one order (or an issuer loop of up to 1 + backoff.length orders). */
async function legoIssue(key: string, names: string[], mode: 'plain' | '5a' | '5b', backoffS: number[] = []) {
	const maxOrders = 1 + backoffS.length;
	if (!budget(maxOrders, key)) return;
	await account();
	const lbl = names[0]!.replace(/^\*\./, '').split('.')[0]!;
	proxy.reset();
	const w = new Watcher();
	if (mode === '5b') w.onNew = (r) => r.name.includes(`.${lbl}.`) && !proxy.blocked() && proxy.block(BLACKOUT_S, 'TXT record exists');
	if (mode === '5a') proxy.armFirstConnect = true;
	w.start();
	const attempts: unknown[] = [];
	let orders = 0;
	const t0 = now();
	let issued = false;
	for (let i = 0; i <= backoffS.length; i++) {
		if (i > 0) {
			say(`${key}: issuer loop backs off ${backoffS[i - 1]} s`);
			await sleep(backoffS[i - 1]! * 1000);
		}
		const args = legoArgs(
			['run', '--accept-tos', '--dns', 'cloudflare', '--log.format', 'text', '--log.level', 'debug', ...names.flatMap((n) => ['-d', n])],
			['-e', 'CLOUDFLARE_HTTP_TIMEOUT=30'],
		);
		guard(`${key}-${i + 1}`, args.join(' '));
		let n = 0;
		const r = await runContainer('yoal-w0-s4c-lego', args, `${key}-${i + 1}`, { timeoutS: 420, onLine: (l) => LEGO_ORDER.test(l) && n++ });
		// If the pattern missed but lego reached an order or authorization URL, count one; a failure
		// while setting up the client (before any ACME request) counts none.
		if (n === 0 && r.lines.some((x) => /\/acme\/(order|authz|new-order)/.test(x.line))) n = 1;
		orders += n;
		addOrders(n);
		attempts.push({ attempt: i + 1, exit: r.code, seconds: +((r.endedAt - r.startedAt) / 1000).toFixed(1), orders: n, lastLines: r.lines.slice(-6).map((x) => x.line.slice(0, 300)) });
		if (r.code === 0) {
			issued = true;
			break;
		}
	}
	const tIssued = now();
	// Let cleanup land and the watcher see it; for 5b wait past the blackout plus 120 s.
	const settle = mode === '5b' ? Math.max(0, proxy.blockedUntil - now()) + 120_000 : 60_000;
	say(`${key}: settling ${Math.round(settle / 1000)} s for cleanup`);
	await sleep(settle);
	await w.halt();
	const left = (await listOurs()).filter((r) => r.name.includes(lbl));
	const crt = findFiles(join(LEGO_DIR, 'certificates'), /\.crt$/).filter((f) => f.includes(lbl) && !f.endsWith('.issuer.crt'));
	record(key, {
		client: 'lego v5.6.0 (cloudflare provider)',
		names,
		mode,
		issued,
		timeToIssueS: +((tIssued - t0) / 1000).toFixed(1),
		orders,
		attempts,
		txt: w.report().filter((x) => x.name.includes(`.${lbl}.`)),
		staleTxtLeft: left.map((r) => ({ name: r.name, createdOn: r.created_on })),
		proxy: proxy.stats,
		certificate: crt[0] ? certInfo(crt[0]) : null,
	});
	say(`${key}: issued=${issued} orders=${orders} stale=${left.length}`);
}

function caddyConfig(names: string[], accountKeyPem: string): string {
	return JSON.stringify(
		{
			admin: { disabled: true },
			logging: { logs: { default: { level: 'DEBUG', writer: { output: 'stdout' }, encoder: { format: 'json' } } } },
			storage: { module: 'file_system', root: '/data' },
			apps: {
				tls: {
					certificates: { automate: names },
					automation: {
						policies: [
							{
								subjects: names,
								issuers: [
									{
										module: 'acme',
										ca: STAGING,
										test_ca: STAGING,
										account_key: accountKeyPem,
										challenges: {
											http: { disabled: true },
											'tls-alpn': { disabled: true },
											dns: { provider: { name: 'cloudflare', api_token: '{env.CF_API_TOKEN}' } },
										},
									},
								],
							},
						],
					},
				},
			},
		},
		null,
		2,
	);
}

/** Caddy: runs until every name is obtained or the timeout; Caddy's own retries count as orders. */
async function caddyIssue(key: string, names: string[], mode: 'plain' | '5a' | '5b', maxOrders: number, timeoutS: number) {
	if (!budget(maxOrders, key)) return;
	await account();
	const lbl = names[0]!.replace(/^\*\./, '').split('.')[0]!;
	const s = state();
	const cfgFile = join(CADDY_DIR, `${key}.json`);
	mkdirSync(CADDY_DIR, { recursive: true });
	const cfg = caddyConfig(names, readFileSync(s.accountKeyFile!, 'utf8'));
	writeFileSync(cfgFile, cfg, { mode: 0o600 });
	guard(key, cfg.replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '<account key>'));
	proxy.reset();
	const w = new Watcher();
	if (mode === '5b') w.onNew = (r) => r.name.includes(`.${lbl}.`) && !proxy.blocked() && proxy.block(BLACKOUT_S, 'TXT record exists');
	if (mode === '5a') proxy.armFirstConnect = true;
	w.start();
	const obtained = new Set<string>();
	let orders = 0;
	const t0 = now();
	let tIssued = 0;
	let capHit = false;
	const run = runContainer(
		'yoal-w0-s4c-caddy',
		[...proxyEnv(), '-e', 'CF_API_TOKEN', '-v', `${CADDY_DIR}:/data`, '-v', `${cfgFile}:/etc/caddy.json:ro`, CADDY_IMAGE, 'run', '--config', '/etc/caddy.json'],
		key,
		{
			timeoutS,
			onLine: (l) => {
				if (CADDY_ORDER.test(l)) {
					// acmez logs this once per authorization; each Caddy order here has one authorization
					orders++;
					addOrders(1);
				}
				const m = /"msg":"certificate obtained successfully".*?"identifier":"([^"]+)"/.exec(l);
				if (m) {
					obtained.add(m[1]!);
					if (obtained.size === names.length) tIssued = now();
				}
				// Stop before Caddy can start an order past the cap.
				if (orders >= maxOrders && obtained.size < names.length && /"msg":"(could not get certificate from issuer|will retry)"/.test(l)) capHit = true;
			},
		},
	);
	const stop = () => Bun.spawnSync(['docker', 'stop', '-t', '5', 'yoal-w0-s4c-caddy'], { stdout: 'ignore', stderr: 'ignore' });
	let exited = false;
	void run.then(() => (exited = true));
	while (!exited && !tIssued && !capHit) await sleep(250);
	if (capHit) say(`${key}: order cap ${maxOrders} reached without a certificate; stopping Caddy`);
	const tEnd = tIssued || now();
	// Keep Caddy running while cleanup lands (5b: past the blackout plus 120 s) to see any late retry.
	const settle = mode === '5b' ? Math.max(0, proxy.blockedUntil - now()) + 120_000 : 30_000;
	if (!capHit && !exited) {
		say(`${key}: settling ${Math.round(settle / 1000)} s with Caddy running`);
		await Promise.race([sleep(settle), run]);
	}
	stop();
	await run;
	await w.halt();
	const left = (await listOurs()).filter((x) => x.name.includes(lbl));
	const crts = findFiles(join(CADDY_DIR, 'certificates'), /\.crt$/).filter((f) => f.includes(lbl));
	record(key, {
		client: 'Caddy 2.11.8 + caddy-dns/cloudflare v0.2.4 (certmagic v0.25.6, acmez v3.1.7, libdns/cloudflare v0.2.2)',
		names,
		mode,
		issued: obtained.size === names.length,
		obtained: [...obtained],
		timeToIssueS: +((tEnd - t0) / 1000).toFixed(1),
		authorizationsTried: orders,
		txt: w.report().filter((x) => x.name.includes(`.${lbl}.`)),
		staleTxtLeft: left.map((x) => ({ name: x.name, createdOn: x.created_on })),
		proxy: proxy.stats,
		certificates: crts.map((f) => ({ file: f.replace(RIG, '.'), ...certInfo(f) })),
	});
	say(`${key}: obtained ${obtained.size}/${names.length}, authorizations tried=${orders}, stale=${left.length}`);
}

async function sweep() {
	const before = await listOurs();
	say(`sweep: ${before.length} TXT record(s) under _acme-challenge.${PREFIX}*`);
	for (const r of before) {
		await deleteOurs(r);
		say(`sweep: deleted ${r.name}`);
	}
	const after = await listOurs();
	record('sweep', { found: before.map((r) => ({ name: r.name, createdOn: r.created_on })), deleted: before.length, remaining: after.length, at: new Date().toISOString() });
	if (after.length) throw new Error(`sweep: ${after.length} record(s) remain`);
	say('sweep: none remain');
}

function wipe() {
	rmSync(DATA, { recursive: true, force: true });
	say('wiped account, certificates and keys');
}

// ------------------------------------------------------------------------------------------------

mkdirSync(LOGS, { recursive: true });
mkdirSync(LEGO_DIR, { recursive: true });
const steps = process.argv.slice(2);
if (steps.some((s) => s !== 'wipe')) await loadNameservers();
if (steps.some((s) => s !== 'sweep' && s !== 'wipe')) {
	startProxy();
	await preflight();
}
const fqdn = (l: string) => `${l}.${ZONE}`;
for (const step of steps) {
	say(`== ${step}`);
	const l = label();
	switch (step) {
		case 'account':
			await account();
			break;
		case 'lego-wild':
			await legoIssue(step, [`*.${fqdn(l)}`, fqdn(l)], 'plain');
			break;
		case 'caddy-wild':
			await caddyIssue(step, [`*.${fqdn(l)}`, fqdn(l)], 'plain', 2, 240);
			break;
		case 'lego-5b':
			await legoIssue(step, [fqdn(l)], '5b');
			break;
		case 'caddy-5b':
			await caddyIssue(step, [fqdn(l)], '5b', 1, 150);
			break;
		case 'lego-5a':
			await legoIssue(step, [fqdn(l)], '5a');
			break;
		case 'caddy-5a':
			await caddyIssue(step, [fqdn(l)], '5a', 2, 240);
			break;
		case 'sweep':
			await sweep();
			break;
		case 'wipe':
			wipe();
			break;
		default:
			throw new Error(`unknown step ${step}`);
	}
}
say(`orders used in total: ${existsSync(STATE) ? state().orders : 'n/a (wiped)'}`);
process.exit(0);
