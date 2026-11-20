/**
 * Spike S2 rig: Litestream follow lag, promotion, faults and the restore-and-swap fallback.
 *
 *   bun spikes/s2-litestream-follow/run.ts            # all scenarios, defaults below
 *
 * Env (all optional):
 *   S2_SCENARIOS   unit,tuned,fallback,walstall,gap,cuts,idle   which scenarios to run, in order
 *   S2_GAP_MIN     7      follower downtime in `gap` (longer than the 5 min L0 retention)
 *   S2_SOAK_MIN    60     steady minutes in `unit` before faults
 *   S2_TUNED_MIN   15     steady minutes in `tuned`
 *   S2_CUT_S       60     length of each network cut / store freeze
 *   S2_SWAPS       5      restore-and-swap iterations in `fallback`
 *   S2_OBSERVE_S   120    observation after each fault (60 s after a restart)
 *   S2_AUDIT_ROWS  200000
 *   S2_S3_ENDPOINT / S2_S3_ACCESS_KEY / S2_S3_SECRET_KEY / S2_S3_BUCKET
 *                  point at a real store (e.g. R2) instead of local MinIO; then each scenario uses
 *                  a distinct prefix inside S2_S3_BUCKET instead of its own bucket. (MinIO-only
 *                  steps: store freeze and request metrics.)
 *   S2_KEEP=1      leave containers running at the end
 *
 * R2 mode (S2_TARGET=r2): reads R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 * from the environment, keeps every object under yoal-w0-spikes/s2-<S2_RUN_ID>/<scenario>/,
 * counts store operations through proxy.ts, stops when the projected cost passes S2_BUDGET_USD
 * (default 0.8), and deletes the whole prefix at the end. Credentials reach containers only
 * through a 0600 env file that is removed afterwards; logs and errors are scrubbed.
 *   S2_FAULTS      comma list of unit faults (default all; R2 default follower-cut,follower-kill9)
 *   S2_UNIT_FAST   0 to run `unit` with the 1 s follower only (R2 default 0)
 *   S2_IDLE_WINDOW_S 60  length of each `idle` measurement window
 *
 * Containers, network and volumes are all named yoal-w0-s2-*. Output goes to out/<stamp>/
 * (gitignored): logs, lag CSVs, events.jsonl, summary.json and summary.md.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const RIG = import.meta.dir;
const REPO = resolve(RIG, '../..');
const IMAGE = 'yoal-w0-s2-node:1';
const MINIO_IMAGE = 'quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e';
const NET = 'yoal-w0-s2-net';
const P = 'yoal-w0-s2';
const env = process.env;
const SCENARIOS = (env.S2_SCENARIOS ?? 'unit,tuned,fallback,walstall,gap,cuts,idle').split(',').filter(Boolean);
const SOAK_MIN = Number(env.S2_SOAK_MIN ?? 60);
const TUNED_MIN = Number(env.S2_TUNED_MIN ?? 15);
const CUT_S = Number(env.S2_CUT_S ?? 60);
const SWAPS = Number(env.S2_SWAPS ?? 5);
const OBSERVE_MS = Number(env.S2_OBSERVE_S ?? 120) * 1000;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = resolve(env.S2_OUT_DIR ?? join(RIG, 'out', stamp));
mkdirSync(OUT, { recursive: true });

const R2 = env.S2_TARGET === 'r2';
const external = R2 || Boolean(env.S2_S3_ENDPOINT);
const R2_HOST = R2 ? new URL(env.R2_ENDPOINT!).host : '';
const S3 = {
	endpointInNet: R2 ? `http://${R2_HOST}` : (env.S2_S3_ENDPOINT ?? `http://${P}-minio:9000`),
	hostEndpoint: R2 ? env.R2_ENDPOINT! : (env.S2_S3_ENDPOINT ?? ''), // MinIO: filled in after it starts
	key: R2 ? env.R2_ACCESS_KEY_ID! : (env.S2_S3_ACCESS_KEY ?? `s2${randomBytes(6).toString('hex')}`),
	secret: R2 ? env.R2_SECRET_ACCESS_KEY! : (env.S2_S3_SECRET_KEY ?? randomBytes(18).toString('hex')),
	bucket: R2 ? env.R2_BUCKET! : (env.S2_S3_BUCKET ?? ''),
};
const RUN_ID = env.S2_RUN_ID ?? stamp.toLowerCase();
const R2_PREFIX = `yoal-w0-spikes/s2-${RUN_ID}`;
const BUDGET_USD = Number(env.S2_BUDGET_USD ?? 0.8);
const FAULTS = (env.S2_FAULTS ?? (R2 ? 'follower-cut,follower-kill9' : 'follower-cut,primary-cut,store-freeze,follower-kill9,follower-container-restart')).split(',');
const UNIT_FAST = (env.S2_UNIT_FAST ?? (R2 ? '0' : '1')) === '1';
const IDLE_WINDOW_MS = Number(env.S2_IDLE_WINDOW_S ?? 60) * 1000;
const PROXY_IP = '172.29.247.250';
const ENV_FILE = join(OUT, '.store.env');
const SECRETS = [S3.key, S3.secret, R2 ? R2_HOST : '', R2 ? R2_HOST.split('.')[0]! : '', R2 ? S3.bucket : ''].filter((x) => x && x.length >= 6);
function scrub(text: string): string {
	let t = text;
	for (const x of SECRETS) t = t.split(x).join('***');
	return t.replace(/X-Amz-[A-Za-z-]+=[^&\s"]+/g, 'X-Amz-***');
}

// ---------- small helpers ----------------------------------------------------------------------
function log(msg: string) {
	const line = scrub(`${new Date().toISOString()} ${msg}`);
	console.log(line);
	appendFileSync(join(OUT, 'run.log'), line + '\n');
}
function run(cmd: string[], opts: { allowFail?: boolean; quiet?: boolean } = {}): string {
	const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
	const out = r.stdout.toString().trim();
	if (r.exitCode !== 0 && !opts.allowFail) throw new Error(scrub(`${cmd.join(' ')} -> ${r.exitCode}: ${r.stderr.toString().trim()} ${out}`));
	return out;
}
const docker = (...args: string[]) => run(['docker', ...args]);
const dockerTry = (...args: string[]) => run(['docker', ...args], { allowFail: true });
const sh = (c: string, script: string) => run(['docker', 'exec', c, 'sh', '-c', script]);
const shTry = (c: string, script: string) => run(['docker', 'exec', c, 'sh', '-c', script], { allowFail: true });
const bg = (c: string, script: string, e: Record<string, string> = {}) =>
	run(['docker', 'exec', '-d', ...Object.entries(e).flatMap(([k, v]) => ['-e', `${k}=${v}`]), c, 'sh', '-c', script]);
const sleep = (ms: number) => Bun.sleep(ms);
function vmNow(): number {
	for (const c of [`${P}-follower`, `${P}-primary`, `${P}-follower-fast`]) {
		const v = run(['docker', 'exec', c, 'date', '+%s%3N'], { allowFail: true });
		if (/^\d+$/.test(v)) return Number(v);
	}
	return Date.now();
}
let scenarioName = '';
function event(kind: string, extra: Record<string, unknown> = {}) {
	const e = { scenario: scenarioName, kind, t: vmNow(), ...extra };
	appendFileSync(join(OUT, 'events.jsonl'), JSON.stringify(e) + '\n');
	log(`event ${kind} ${JSON.stringify(extra)}`);
	return e;
}
async function waitFor(what: string, fn: () => boolean, timeoutMs: number, everyMs = 250): Promise<number> {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (fn()) return Date.now() - t0;
		await sleep(everyMs);
	}
	throw new Error(`timeout waiting for ${what}`);
}
const fileHas = (path: string, re: RegExp) => existsSync(path) && re.test(readFileSync(path, 'utf8'));

function createBucket(bucket: string): string {
	return run(['docker', 'exec', `${P}-minio`, 'sh', '-c', `mc alias set s2 http://127.0.0.1:9000 '${S3.key}' '${S3.secret}' >/dev/null && mc mb --ignore-existing s2/${bucket}`], { allowFail: true });
}
const hostOps = { ListObjects: 0, DeleteObject: 0 }; // R2 calls made from the host, outside the proxy
const s3client = (bucket: string) => new Bun.S3Client({ endpoint: S3.hostEndpoint, accessKeyId: S3.key, secretAccessKey: S3.secret, bucket, region: 'auto' });
async function listKeys(bucket: string, prefix: string): Promise<string[]> {
	if (R2 && !prefix.startsWith(R2_PREFIX + '/')) throw new Error('refusing to list outside the run prefix');
	const client = s3client(bucket);
	const keys: string[] = [];
	let token: string | undefined;
	for (;;) {
		const page = await client.list({ prefix, continuationToken: token, maxKeys: 1000 });
		hostOps.ListObjects++;
		keys.push(...(page.contents ?? []).map((o) => o.key));
		if (!page.isTruncated || !page.nextContinuationToken) return keys;
		token = page.nextContinuationToken;
	}
}
async function minioRequests(): Promise<Record<string, number>> {
	if (R2) {
		const port = docker('port', `${P}-proxy`, '9999/tcp').split('\n')[0]!.split(':').pop();
		const j = (await (await fetch(`http://127.0.0.1:${port}/counts`)).json()) as Record<string, { n: number; status: Record<string, number> }>;
		const totals: Record<string, number> = {};
		for (const [k, v] of Object.entries(j)) {
			totals[k] = v.n;
			for (const [st, n] of Object.entries(v.status)) if (!/^2\d\d$/.test(st)) totals[`${k}:${st}`] = n;
		}
		for (const [k, v] of Object.entries(hostOps)) totals[`host:${k}`] = v;
		return totals;
	}
	if (external) return {};
	const r = Bun.spawnSync(['curl', '-s', `${S3.hostEndpoint}/minio/v2/metrics/cluster`]);
	const totals: Record<string, number> = {};
	for (const m of r.stdout.toString().matchAll(/^minio_s3_requests_total\{api="([^"]+)"[^}]*\} ([\d.e+]+)/gm)) totals[m[1]!] = (totals[m[1]!] ?? 0) + Number(m[2]);
	return totals;
}
const diff = (a: Record<string, number>, b: Record<string, number>) =>
	Object.fromEntries(Object.keys(b).map((k) => [k, b[k]! - (a[k] ?? 0)]).filter(([, v]) => (v as number) > 0));
// R2 list prices: Class A $4.50/M, Class B $0.36/M. DeleteObject and AbortMultipartUpload are free;
// DeleteObjects is priced as Class A here to be safe.
const CLASS_A = new Set(['ListObjects', 'PutObject', 'UploadPart', 'CreateMultipartUpload', 'CompleteMultipartUpload', 'PutBucket', 'DeleteObjects', 'host:ListObjects']);
const CLASS_B = new Set(['GetObject', 'HeadObject', 'HeadBucket', 'GetBucketLocation']);
function cost(c: Record<string, number>) {
	let a = 0;
	let b = 0;
	for (const [k, v] of Object.entries(c)) {
		if (CLASS_A.has(k)) a += v;
		else if (CLASS_B.has(k)) b += v;
	}
	return { classA: a, classB: b, usd: Math.round((a * 4.5e-6 + b * 0.36e-6) * 10000) / 10000 };
}
async function checkBudget(where: string) {
	if (!R2) return;
	const c = cost(await minioRequests());
	log(`budget ${where}: ${JSON.stringify(c)}`);
	if (c.usd > BUDGET_USD) throw new Error(`budget: $${c.usd} spent passes the $${BUDGET_USD} stop line`);
}

// ---------- environment -----------------------------------------------------------------------
function cleanup() {
	for (const c of ['primary', 'follower', 'follower-fast', 'minio', 'proxy']) dockerTry('rm', '-f', `${P}-${c}`);
	for (const v of ['primary-data', 'follower-data', 'follower-fast-data', 'minio-data']) dockerTry('volume', 'rm', '-f', `${P}-${v}`);
	dockerTry('network', 'rm', NET);
}

async function setup() {
	cleanup();
	log(`building ${IMAGE}`);
	run(['docker', 'build', '-q', '-t', IMAGE, RIG]);
	if (R2) {
		docker('network', 'create', '--subnet', '172.29.247.0/24', NET);
		writeFileSync(ENV_FILE, `R2_ACCESS_KEY_ID=${S3.key}\nR2_SECRET_ACCESS_KEY=${S3.secret}\nR2_BUCKET=${S3.bucket}\nR2_ENDPOINT=${S3.endpointInNet}\n`, { mode: 0o600 });
		docker('run', '-d', '--name', `${P}-proxy`, '--network', NET, '--ip', PROXY_IP, '-p', '127.0.0.1::9999', '-e', `S2_UPSTREAM_HOST=${R2_HOST}`, IMAGE, 'bun', '/rig/proxy.ts');
		await waitFor('proxy', () => /proxy up/.test(dockerTry('logs', `${P}-proxy`)), 15_000);
		log(`R2 via counting proxy; prefix ${R2_PREFIX}/`);
	} else docker('network', 'create', NET);
	if (!external) {
		docker('run', '-d', '--name', `${P}-minio`, '--network', NET, '-p', '127.0.0.1::9000', '-v', `${P}-minio-data:/data`,
			'-e', `MINIO_ROOT_USER=${S3.key}`, '-e', `MINIO_ROOT_PASSWORD=${S3.secret}`, '-e', 'MINIO_PROMETHEUS_AUTH_TYPE=public', MINIO_IMAGE, 'server', '/data');
		const port = docker('port', `${P}-minio`, '9000/tcp').split('\n')[0]!.split(':').pop();
		S3.hostEndpoint = `http://127.0.0.1:${port}`;
		await waitFor('minio', () => run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `${S3.hostEndpoint}/minio/health/ready`], { allowFail: true }) === '200', 30_000);
		log(`minio at ${S3.hostEndpoint} (${docker('exec', `${P}-minio`, 'minio', '--version').split('\n')[0]})`);
	}
	const seed = join(OUT, 'seed.db');
	log('seeding control-plane-sized database from packages/db migrations');
	log(run(['bun', join(RIG, 'seed.ts'), seed, env.S2_AUDIT_ROWS ?? '200000']));
}

interface Scenario {
	name: string;
	primaryVersion: '0.3.13' | '0.5.18';
	config: string; // host path to litestream.yml
	followers: { name: string; interval: string }[];
	steadyMin: number;
	faults: boolean;
	promote: boolean;
	kill9: boolean;
	fallback: boolean;
	walstall?: boolean;
	gapMin?: number;
	cuts?: boolean;
	idle?: boolean;
}

function bucketFor(name: string) {
	return external ? S3.bucket : `${P}-${name}`;
}
const replicaPrefix = (sc: Scenario) => (R2 ? `${R2_PREFIX}/${sc.name}/yoal/sqlite/` : 'yoal/sqlite/');
/** R2: the scenario's config is the given one with only the replica path moved under the run prefix. */
function configFor(sc: Scenario): string {
	if (!R2) return sc.config;
	const out = join(OUT, `litestream-${sc.name}-r2.yml`);
	const body = readFileSync(sc.config, 'utf8');
	if (!/^\s+path: yoal\/sqlite$/m.test(body)) throw new Error('unexpected replica path in config');
	writeFileSync(out, body.replace(/^(\s+)path: yoal\/sqlite$/m, `$1path: ${R2_PREFIX}/${sc.name}/yoal/sqlite`));
	return out;
}

function startNode(name: string, sc: Scenario) {
	const bucket = bucketFor(sc.name);
	docker('run', '-d', '--name', `${P}-${name}`, '--hostname', name, '--network', NET,
		'-v', `${P}-${name}-data:/data`, '-v', `${OUT}:/out`,
		'-v', `${configFor(sc)}:/etc/yoal/litestream.yml:ro`,
		'-v', `${REPO}/scripts/yoal-db-fingerprint.ts:/rig/fingerprint.ts:ro`,
		'-e', 'YOAL_DATA_DIR=/data',
		...(R2
			? ['--env-file', ENV_FILE, '--add-host', `${R2_HOST}:${PROXY_IP}`]
			: ['-e', `R2_BUCKET=${bucket}`, '-e', `R2_ENDPOINT=${S3.endpointInNet}`, '-e', `R2_ACCESS_KEY_ID=${S3.key}`, '-e', `R2_SECRET_ACCESS_KEY=${S3.secret}`]),
		IMAGE);
}

const lsPrimary = (sc: Scenario) => `echo $$ > /run/ls.pid; exec litestream-${sc.primaryVersion} replicate -config /etc/yoal/litestream.yml >> /out/${sc.name}-primary-ls.log 2>&1`;
const lsFollow = (sc: Scenario, f: { name: string; interval: string }) =>
	`echo $$ > /run/ls.pid; exec litestream-0.5.18 restore -config /etc/yoal/litestream.yml -f -follow-interval ${f.interval} -o /data/yoal.db /data/yoal.db >> /out/${sc.name}-${f.name}-ls.log 2>&1`;
const probeCmd = (sc: Scenario, f: { name: string }) => `exec bun /rig/probe.ts >> /out/${sc.name}-${f.name}-probe.log 2>&1`;
const probeEnv = (sc: Scenario, f: { name: string }) => ({ S2_DB: '/data/yoal.db', S2_OUT: `/out/${sc.name}-${f.name}-lag.csv` });
const writerCmd = (sc: Scenario, db = '/data/yoal.db') => `echo $$ > /run/writer.pid; S2_DB=${db} exec bun /rig/writer.ts >> /out/${sc.name}-writer.log 2>&1`;

function lastSeen(sc: Scenario, f: string): number {
	const p = join(OUT, `${sc.name}-${f}-lag.csv.state`);
	return existsSync(p) ? Number(readFileSync(p, 'utf8')) : -1;
}
function rss(c: string): Record<string, number> {
	// VmRSS (kB) and CPU seconds of each litestream/bun process in the container.
	const out = shTry(c, `for p in /proc/[0-9]*; do n=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null | cut -c1-40); case "$n" in litestream*|bun*) r=$(awk '/VmRSS/{print $2}' $p/status); t=$(awk '{print $14+$15}' $p/stat); echo "$n|$r|$t";; esac; done`);
	const res: Record<string, number> = {};
	for (const line of out.split('\n').filter(Boolean)) {
		const [n, r, t] = line.split('|');
		const key = n!.includes('replicate') ? 'replicate' : n!.includes('restore') ? 'restore' : n!.includes('writer') ? 'writer' : n!.includes('probe') ? 'probe' : 'other';
		res[`${key}RssKb`] = Number(r);
		res[`${key}CpuS`] = Number(t) / 100;
	}
	return res;
}
async function sampleResources(sc: Scenario, label: string) {
	const row = { scenario: sc.name, label, t: vmNow(), primary: rss(`${P}-primary`), ...Object.fromEntries(sc.followers.map((f) => [f.name, rss(`${P}-${f.name}`)])) };
	appendFileSync(join(OUT, 'resources.jsonl'), JSON.stringify(row) + '\n');
}
async function steady(sc: Scenario, minutes: number) {
	const end = Date.now() + minutes * 60_000;
	let i = 0;
	while (Date.now() < end) {
		await sleep(Math.min(60_000, end - Date.now()));
		await sampleResources(sc, `steady-${++i}`);
		await checkBudget(`${sc.name} steady-${i}`);
		log(`${sc.name}: ${Math.round((end - Date.now()) / 1000)} s left; seen ${sc.followers.map((f) => `${f.name}=${lastSeen(sc, f.name)}`).join(' ')}`);
	}
}
function fingerprint(c: string, db: string): string {
	return sh(c, `bun /rig/fingerprint.ts ${db}`);
}

// ---------- the scenario ----------------------------------------------------------------------
async function scenario(sc: Scenario, results: Record<string, unknown>) {
	scenarioName = sc.name;
	const r: Record<string, unknown> = { primaryVersion: sc.primaryVersion, config: sc.config.replace(REPO + '/', ''), followers: sc.followers };
	results[sc.name] = r;
	for (const c of ['primary', 'follower', 'follower-fast']) dockerTry('rm', '-f', `${P}-${c}`);
	for (const v of ['primary-data', 'follower-data', 'follower-fast-data']) dockerTry('volume', 'rm', '-f', `${P}-${v}`);
	const bucket = bucketFor(sc.name);
	if (!external) log(`create bucket: ${createBucket(bucket)}`);
	startNode('primary', sc);
	for (const f of sc.followers) startNode(f.name, sc);
	docker('cp', join(OUT, 'seed.db'), `${P}-primary:/data/yoal.db`);
	const req0 = await minioRequests();

	event('primary-replicate-start', { version: sc.primaryVersion });
	bg(`${P}-primary`, lsPrimary(sc));
	const prefix = replicaPrefix(sc);
	const t0 = Date.now();
	for (;;) {
		const keys = await listKeys(bucket, prefix);
		if (keys.some((k) => /\/0009\/|\/snapshots\//.test(k))) break;
		if (Date.now() - t0 > 180_000) throw new Error('no snapshot after 180 s');
		await sleep(500);
	}
	r.initialSnapshotS = (Date.now() - t0) / 1000;
	event('snapshot-present', { s: r.initialSnapshotS });
	bg(`${P}-primary`, writerCmd(sc));
	await sleep(5000);

	if (sc.fallback) return fallback(sc, r, bucket, req0);
	if (sc.walstall) return walstall(sc, r);
	if (sc.idle) return idle(sc, r);

	for (const f of sc.followers) {
		const t = Date.now();
		bg(`${P}-${f.name}`, lsFollow(sc, f));
		await waitFor(`${f.name} follow mode`, () => fileHas(join(OUT, `${sc.name}-${f.name}-ls.log`), /entering follow mode/), 600_000, 100);
		(r[`initialRestoreS_${f.name}`] as number) = (Date.now() - t) / 1000;
		event('follower-following', { follower: f.name, initialRestoreS: (Date.now() - t) / 1000 });
		bg(`${P}-${f.name}`, probeCmd(sc, f), probeEnv(sc, f));
	}
	await sampleResources(sc, 'start');
	event('steady-start');
	await steady(sc, sc.steadyMin);
	event('steady-end');
	const reqSteady = await minioRequests();
	r.requestsSteady = diff(req0, reqSteady);
	r.steadySeconds = sc.steadyMin * 60;

	const main = sc.followers[0]!;
	const F = `${P}-${main.name}`;
	const reconnect = (c: string) => docker('network', 'connect', NET, c);
	if (sc.faults) {
		// 1. follower cut off from the store
		if (FAULTS.includes('follower-cut')) {
			event('fault-start', { fault: 'follower-cut' });
			docker('network', 'disconnect', NET, F);
			await sleep(CUT_S * 1000);
			reconnect(F);
			event('fault-end', { fault: 'follower-cut' });
			await sleep(OBSERVE_MS);
			await checkBudget(`${sc.name} after follower-cut`);
		}
		// 2. primary cut off from the store (writes continue locally)
		if (FAULTS.includes('primary-cut')) {
			event('fault-start', { fault: 'primary-cut' });
			docker('network', 'disconnect', NET, `${P}-primary`);
			await sleep(CUT_S * 1000);
			reconnect(`${P}-primary`);
			event('fault-end', { fault: 'primary-cut' });
			await sleep(OBSERVE_MS);
		}
		// 3. the store hangs silently (frozen, not refusing)
		if (!external && FAULTS.includes('store-freeze')) {
			event('fault-start', { fault: 'store-freeze' });
			docker('pause', `${P}-minio`);
			await sleep(CUT_S * 1000);
			docker('unpause', `${P}-minio`);
			event('fault-end', { fault: 'store-freeze' });
			await sleep(OBSERVE_MS + 30_000);
		}
		// 4. follower process killed -9 and restarted
		if (FAULTS.includes('follower-kill9')) {
		event('fault-start', { fault: 'follower-kill9' });
		sh(F, 'kill -9 $(cat /run/ls.pid)');
		await sleep(5000);
		const before = readFileSync(join(OUT, `${sc.name}-${main.name}-ls.log`), 'utf8').length;
		bg(F, lsFollow(sc, main));
		event('fault-end', { fault: 'follower-kill9' });
		await sleep(OBSERVE_MS / 2);
		const after = readFileSync(join(OUT, `${sc.name}-${main.name}-ls.log`), 'utf8').slice(before);
		r.restartKill9 = { resumed: /resuming follow mode/.test(after), fullRestore: /restoring snapshot|snapshot restored|restore.*level=9/i.test(after), log: after.split('\n').slice(0, 6) };
		}
		// 5. whole follower container killed and started (probe restarts too, keeps its position)
		if (FAULTS.includes('follower-container-restart')) {
		event('fault-start', { fault: 'follower-container-restart' });
		docker('kill', F);
		await sleep(5000);
		docker('start', F);
		const before2 = readFileSync(join(OUT, `${sc.name}-${main.name}-ls.log`), 'utf8').length;
		bg(F, lsFollow(sc, main));
		bg(F, probeCmd(sc, main), probeEnv(sc, main));
		event('fault-end', { fault: 'follower-container-restart' });
		await sleep(OBSERVE_MS / 2);
		const after2 = readFileSync(join(OUT, `${sc.name}-${main.name}-ls.log`), 'utf8').slice(before2);
		r.restartContainer = { resumed: /resuming follow mode/.test(after2), log: after2.split('\n').slice(0, 6) };
		}
		await sampleResources(sc, 'after-faults');
	}

	if (sc.cuts) {
		// Second samples of the 60 s cuts, and a follower cut with a no-progress watchdog: if the
		// follower's -txid file has not moved for 10 s it is killed and restarted (it resumes from
		// the file in about 1 s). Prototype only; a real one would compare with the replica's
		// latest TXID so a quiet primary does not cause restarts.
		const cut = async (fault: string, c: string, observe: number) => {
			event('fault-start', { fault });
			docker('network', 'disconnect', NET, c);
			await sleep(CUT_S * 1000);
			docker('network', 'connect', NET, c);
			event('fault-end', { fault });
			await sleep(observe);
		};
		await cut('follower-cut-2', F, OBSERVE_MS + 30_000);
		const wd = `last=; n=0; while sleep 1; do t=$(cat /data/yoal.db-txid 2>/dev/null); if [ "$t" = "$last" ]; then n=$((n+1)); else n=0; last=$t; fi; if [ $n -ge 10 ]; then echo "$(date -u +%FT%T.%3NZ) watchdog restart at $t" >> /out/${sc.name}-watchdog.log; kill -9 $(cat /run/ls.pid); sleep 0.2; sh -c '${lsFollow(sc, main).replace(/'/g, "")}' & n=0; fi; done`;
		bg(F, `echo $$ > /run/wd.pid; ${wd}`);
		await cut('follower-cut-watchdog', F, OBSERVE_MS);
		sh(F, 'kill $(cat /run/wd.pid)');
		await cut('primary-cut-2', `${P}-primary`, OBSERVE_MS + 30_000);
		r.watchdogLog = existsSync(join(OUT, `${sc.name}-watchdog.log`)) ? readFileSync(join(OUT, `${sc.name}-watchdog.log`), 'utf8').trim().split('\n') : [];
	}
	if (sc.gapMin) {
		// Follower down longer than L0 retention (5 min): on restart it must bridge the gap from
		// compacted levels (fillFollowGap) rather than fail or re-restore.
		const log0 = readFileSync(join(OUT, `${sc.name}-${main.name}-ls.log`), 'utf8').length;
		event('fault-start', { fault: `follower-down-${sc.gapMin}m` });
		sh(F, 'kill -9 $(cat /run/ls.pid)');
		await sleep(sc.gapMin * 60_000);
		bg(F, lsFollow(sc, main));
		event('fault-end', { fault: `follower-down-${sc.gapMin}m` });
		await sleep(OBSERVE_MS);
		const after = readFileSync(join(OUT, `${sc.name}-${main.name}-ls.log`), 'utf8').slice(log0);
		r.gap = { resumed: /resuming follow mode/.test(after), errors: after.split('\n').filter((l) => /level=(WARN|ERROR)/.test(l)).slice(0, 6), first: after.split('\n').slice(0, 5) };
	}
	if (sc.promote) await promote(sc, r, bucket);
	if (sc.kill9) await kill9(sc, r);
	r.requestsTotal = diff(req0, await minioRequests());
	r.replicaObjects = (await listKeys(bucket, prefix)).length;
}

async function promote(sc: Scenario, r: Record<string, unknown>, bucket: string) {
	const main = sc.followers[0]!;
	const F = `${P}-${main.name}`;
	event('promote-quiesce');
	sh(`${P}-primary`, 'kill -TERM $(cat /run/writer.pid)');
	await waitFor('writer exit', () => fileHas(join(OUT, `${sc.name}-writer.log`), /final \d+/), 30_000);
	const finalSeq = Number(readFileSync(join(OUT, `${sc.name}-writer.log`), 'utf8').match(/final (\d+)/)![1]);
	sh(`${P}-primary`, 'kill -TERM $(cat /run/ls.pid)');
	await sleep(3000);
	const catchUpMs = await waitFor('follower catch-up', () => lastSeen(sc, main.name) >= finalSeq, 120_000, 100);
	await sleep(5000); // let any trailing LTX (Litestream's own bookkeeping) land
	event('promote-caught-up', { finalSeq, catchUpMs });
	sh(F, 'kill -TERM $(cat /run/ls.pid); sleep 1; cp /data/yoal.db /data/promoted.db');
	const t = Date.now();
	const pr = JSON.parse(sh(F, 'bun /rig/promote.ts /data/promoted.db'));
	const fpFollower = fingerprint(F, '/data/promoted.db');
	const fpPrimary = fingerprint(`${P}-primary`, '/data/yoal.db');
	writeFileSync(join(OUT, `${sc.name}-fp-primary.json`), fpPrimary);
	writeFileSync(join(OUT, `${sc.name}-fp-follower.json`), fpFollower);
	const tablesDiff = diffFingerprints(fpPrimary, fpFollower);
	r.promotion = { finalSeq, catchUpMs, promote: pr, promoteMs: Date.now() - t, identical: fpPrimary === fpFollower, tablesDiff };
	event('promoted', r.promotion as Record<string, unknown>);

	// The promoted node now replicates to the same replica path (as a promoted standby would), and
	// a fresh restore elsewhere must equal it.
	sh(F, 'mkdir -p /data2 && cp /data/promoted.db /data2/yoal.db');
	bg(F, `echo $$ > /run/ls2.pid; YOAL_DATA_DIR=/data2 exec litestream-${sc.primaryVersion} replicate -config /etc/yoal/litestream.yml >> /out/${sc.name}-promoted-ls.log 2>&1`);
	await sleep(3000);
	bg(F, `echo $$ > /run/writer.pid; S2_DB=/data2/yoal.db exec bun /rig/writer.ts >> /out/${sc.name}-promoted-writer.log 2>&1`);
	await sleep(30_000);
	sh(F, 'kill -TERM $(cat /run/writer.pid)');
	await waitFor('promoted writer exit', () => fileHas(join(OUT, `${sc.name}-promoted-writer.log`), /final \d+/), 30_000);
	await sleep(3000);
	sh(F, 'kill -TERM $(cat /run/ls2.pid)');
	await sleep(3000);
	const restore = shTry(`${P}-primary`, `rm -f /data/after-promo.db*; litestream-0.5.18 restore -config /etc/yoal/litestream.yml -o /data/after-promo.db /data/yoal.db 2>&1 | tail -5`);
	let identical = false;
	let afterSeq = -1;
	let tables: string[] = [];
	if (shTry(`${P}-primary`, 'test -f /data/after-promo.db && echo yes') === 'yes') {
		const a = fingerprint(F, '/data2/yoal.db');
		const b = fingerprint(`${P}-primary`, '/data/after-promo.db');
		identical = a === b;
		tables = diffFingerprints(a, b);
		afterSeq = JSON.parse(sh(`${P}-primary`, 'bun /rig/promote.ts /data/after-promo.db')).maxSeq;
	}
	const promotedFinal = Number(readFileSync(join(OUT, `${sc.name}-promoted-writer.log`), 'utf8').match(/final (\d+)/)![1]);
	const lsLog = readFileSync(join(OUT, `${sc.name}-promoted-ls.log`), 'utf8');
	r.afterPromotion = { promotedFinalSeq: promotedFinal, restoredSeq: afterSeq, identical, tablesDiff: tables, restoreTail: restore.split('\n'), replicateWarnings: lsLog.split('\n').filter((l) => /level=(WARN|ERROR)|error/i.test(l)).slice(0, 8) };
	event('after-promotion', r.afterPromotion as Record<string, unknown>);
	// A plain (non-follow) restore of the control-plane-sized database, for the fallback numbers.
	const t2 = Date.now();
	shTry(F, 'rm -f /data/plain.db*; litestream-0.5.18 restore -config /etc/yoal/litestream.yml -o /data/plain.db /data/yoal.db');
	r.plainRestoreS_0518 = (Date.now() - t2) / 1000;
	void bucket;
}

async function kill9(sc: Scenario, r: Record<string, unknown>) {
	const main = sc.followers[0]!;
	const F = `${P}-${main.name}`;
	await sleep(1000 + Math.floor(Math.random() * 1000));
	event('fault-start', { fault: 'primary-kill9' });
	docker('kill', '-s', 'KILL', `${P}-primary`);
	// Wait for the follower to stop advancing.
	let last = -2;
	let stableSince = Date.now();
	while (Date.now() - stableSince < 10_000) {
		await sleep(500);
		const s = lastSeen(sc, main.name);
		if (s !== last) {
			last = s;
			stableSince = Date.now();
		}
	}
	event('fault-end', { fault: 'primary-kill9', followerSeq: last });
	sh(F, 'kill -TERM $(cat /run/ls.pid); sleep 1; cp /data/yoal.db /data/promoted.db');
	const pr = JSON.parse(sh(F, 'bun /rig/promote.ts /data/promoted.db'));
	shTry(F, 'rm -f /data/fresh.db*; litestream-0.5.18 restore -config /etc/yoal/litestream.yml -o /data/fresh.db /data/yoal.db');
	const fresh = JSON.parse(sh(F, 'bun /rig/promote.ts /data/fresh.db'));
	const fpA = fingerprint(F, '/data/promoted.db');
	const fpB = fingerprint(F, '/data/fresh.db');
	docker('start', `${P}-primary`);
	const dead = JSON.parse(sh(`${P}-primary`, 'bun /rig/promote.ts /data/yoal.db'));
	const tsOf = (c: string, db: string, seq: number) => Number(sh(c, `bun -e "const {Database}=require('bun:sqlite');const d=new Database('${db}',{readonly:true});console.log(d.query('select ts_ms from s2_heartbeat where seq=?').get(${seq})?.ts_ms ?? 0)"`));
	const lostRows = dead.maxSeq - pr.maxSeq;
	const lostMs = tsOf(`${P}-primary`, '/data/yoal.db', dead.maxSeq) - tsOf(F, '/data/promoted.db', pr.maxSeq);
	r.kill9 = { primaryCommittedSeq: dead.maxSeq, followerSeq: pr.maxSeq, freshRestoreSeq: fresh.maxSeq, lostRows, lostMs, followerIntegrity: pr.integrity, freshIntegrity: fresh.integrity, followerEqualsFreshRestore: fpA === fpB, tablesDiff: diffFingerprints(fpA, fpB) };
	event('kill9-result', r.kill9 as Record<string, unknown>);
}

async function fallback(sc: Scenario, r: Record<string, unknown>, bucket: string, req0: Record<string, number>) {
	// Restore into a staging file every 60 s and swap it in atomically (CLUSTERING §15.2 fallback).
	const F = `${P}-${sc.followers[0]!.name}`;
	const swaps: { restoreMs: number; swapMs: number; ageAtSwapMs: number; integrity: string }[] = [];
	for (let i = 0; i < SWAPS; i++) {
		const t = Date.now();
		const out = sh(F, `set -e; rm -f /data/staging.db*; a=$(date +%s%3N); litestream-${sc.primaryVersion} restore -config /etc/yoal/litestream.yml -o /data/staging.db /data/yoal.db >/out/${sc.name}-restore-${i}.log 2>&1; b=$(date +%s%3N); mv /data/staging.db /data/yoal.db; sync -f /data/yoal.db; c=$(date +%s%3N); echo $a $b $c`);
		const [a, b, c] = out.split(' ').map(Number) as [number, number, number];
		const q = JSON.parse(sh(F, `bun -e "const {Database}=require('bun:sqlite');const d=new Database('/data/yoal.db',{readonly:true});console.log(JSON.stringify({ts:d.query('select max(ts_ms) as t from s2_heartbeat').get().t, ic:d.query('pragma quick_check').get().quick_check}))"`));
		swaps.push({ restoreMs: b - a, swapMs: c - b, ageAtSwapMs: c - q.ts, integrity: q.ic });
		log(`fallback swap ${i}: ${JSON.stringify(swaps.at(-1))}`);
		await sleep(Math.max(0, 60_000 - (Date.now() - t)));
	}
	r.swaps = swaps;
	// Can 0.5.18 read the 0.3.13 replica (an upgrade path)?
	const t2 = Date.now();
	const v5 = shTry(F, `rm -f /data/v5.db*; litestream-0.5.18 restore -config /etc/yoal/litestream.yml -o /data/v5.db /data/yoal.db 2>&1 | tail -3; test -f /data/v5.db && echo RESTORED`);
	r.restore0518From0313 = { ok: v5.includes('RESTORED'), s: (Date.now() - t2) / 1000, tail: v5.split('\n') };
	const t3 = Date.now();
	const fl = shTry(F, `timeout 20 litestream-0.5.18 restore -config /etc/yoal/litestream.yml -f -o /data/v5f.db /data/yoal.db 2>&1 | tail -4`);
	r.follow0518On0313Replica = { s: (Date.now() - t3) / 1000, tail: fl.split('\n') };
	r.requestsTotal = diff(req0, await minioRequests());
	r.replicaObjects = (await listKeys(bucket, 'yoal/sqlite/')).length;
	sh(`${P}-primary`, 'kill -TERM $(cat /run/writer.pid); kill -TERM $(cat /run/ls.pid)');
}

async function walstall(sc: Scenario, r: Record<string, unknown>) {
	// Reproduce the stall seen in the first smoke run: a reader that opens the follower's file
	// before the first follow apply (header still WAL) holds a SHARED lock while open, and
	// Litestream's apply waits for an exclusive lock on F_SETLKW.
	const F = `${P}-${sc.followers[0]!.name}`;
	const txid = () => shTry(F, 'cat /data/yoal.db-txid 2>/dev/null') || 'none';
	bg(F, lsFollow(sc, sc.followers[0]!));
	bg(F, `until [ -f /data/yoal.db-txid ]; do sleep 0.01; done; exec bun -e "const {Database}=require('bun:sqlite');const d=new Database('/data/yoal.db',{readonly:true});console.log('hdr-mode',d.query('pragma journal_mode').get().journal_mode, d.query('select count(*) n from s2_heartbeat').get().n);setTimeout(()=>{d.close();console.log('closed')},30000)" >> /out/${sc.name}-holder.log 2>&1`);
	await sleep(3000);
	const atOpen = txid();
	await sleep(25_000);
	const beforeClose = txid();
	await sleep(8000);
	const afterClose = txid();
	r.walstall = { txidAtHolderOpen: atOpen, txidAfter28sHeld: beforeClose, txidAfterRelease: afterClose, stalled: atOpen === beforeClose, resumedAfterRelease: afterClose !== beforeClose, holder: readFileSync(join(OUT, `${sc.name}-holder.log`), 'utf8').trim().split('\n') };
	event('walstall', r.walstall as Record<string, unknown>);
	sh(`${P}-primary`, 'kill -TERM $(cat /run/writer.pid); kill -TERM $(cat /run/ls.pid)');
}

async function idle(sc: Scenario, r: Record<string, unknown>) {
	// Store requests per second by phase, to price a follower on R2 (Class A = PUT/LIST/multipart).
	// Phases run one follower at a time so the deltas can be attributed.
	const window = async (label: string) => {
		const a = await minioRequests();
		await sleep(IDLE_WINDOW_MS);
		const d = diff(a, await minioRequests());
		await checkBudget(`idle ${label}`);
		const perS = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Math.round(((v as number) / (IDLE_WINDOW_MS / 1000)) * 100) / 100]));
		log(`idle ${label}: ${JSON.stringify(perS)}`);
		return perS;
	};
	const [slow, fast] = sc.followers as [{ name: string; interval: string }, { name: string; interval: string }];
	const phases: Record<string, unknown> = {};
	phases.primaryOnlyWriting = await window('primary only, writing');
	bg(`${P}-${slow.name}`, lsFollow(sc, slow));
	await sleep(10_000);
	phases.follower1sWriting = await window('follower 1s, writing');
	sh(`${P}-primary`, 'kill -TERM $(cat /run/writer.pid)');
	await sleep(10_000);
	phases.follower1sIdle = await window('follower 1s, idle');
	sh(`${P}-${slow.name}`, 'kill -TERM $(cat /run/ls.pid)');
	await sleep(3000);
	phases.primaryOnlyIdle = await window('primary only, idle');
	bg(`${P}-${fast.name}`, lsFollow(sc, fast));
	await sleep(10_000);
	phases.follower250msIdle = await window('follower 250ms, idle');
	r.requestsPerSecond = phases;
	sh(`${P}-primary`, 'kill -TERM $(cat /run/ls.pid)');
}

function diffFingerprints(a: string, b: string): string[] {
	try {
		const A = JSON.parse(a).tables ?? JSON.parse(a);
		const B = JSON.parse(b).tables ?? JSON.parse(b);
		return [...new Set([...Object.keys(A), ...Object.keys(B)])].filter((k) => JSON.stringify(A[k]) !== JSON.stringify(B[k]));
	} catch {
		return ['<unparseable>'];
	}
}

// ---------- analysis --------------------------------------------------------------------------
function pct(sorted: number[], p: number) {
	if (!sorted.length) return NaN;
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}
function stats(xs: number[]) {
	const s = [...xs].sort((a, b) => a - b);
	return { n: s.length, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s.at(-1) ?? NaN, mean: Math.round(s.reduce((a, b) => a + b, 0) / (s.length || 1)) };
}
function analyse(results: Record<string, any>) {
	const events = existsSync(join(OUT, 'events.jsonl')) ? readFileSync(join(OUT, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
	for (const [name, r] of Object.entries(results)) {
		if (!r.followers || r.swaps) continue;
		const ev = events.filter((e) => e.scenario === name);
		const steadyStart = ev.find((e) => e.kind === 'steady-start')?.t ?? 0;
		const steadyEnd = ev.find((e) => e.kind === 'steady-end')?.t ?? Infinity;
		const faults = ev.filter((e) => e.kind === 'fault-start').map((s) => ({ fault: s.fault, start: s.t, end: ev.find((e) => e.kind === 'fault-end' && e.fault === s.fault)?.t ?? s.t }));
		const promoteAt = ev.find((e) => e.kind === 'promote-quiesce')?.t ?? Infinity;
		r.lag = {};
		for (const f of r.followers) {
			const p = join(OUT, `${name}-${f.name}-lag.csv`);
			if (!existsSync(p)) continue;
			const lines = readFileSync(p, 'utf8').split('\n');
			const rows = lines.filter((l) => /^\d/.test(l)).map((l) => l.split(',').map(Number) as [number, number, number]);
			const errors = lines.filter((l) => l.startsWith('#err')).map((l) => l.split(',')[2]);
			const lag = (x: [number, number, number]) => x[2] - x[1];
			// Rows committed in the last seconds before the first fault are delayed by that fault, not by
			// steady replication, so the steady window stops 5 s before it.
			const steadyRows = rows.filter((x) => x[1] >= steadyStart && x[1] < steadyEnd - 5000);
			const wholeRows = rows.filter((x) => x[1] >= steadyStart && x[1] < promoteAt);
			const recovery = faults.map((fl) => {
				const first = rows.find((x) => x[1] >= fl.end && lag(x) < 1000);
				const maxLag = Math.max(0, ...rows.filter((x) => x[1] >= fl.start - 2000 && x[1] <= fl.end + 120_000).map(lag));
				return { fault: fl.fault, recoveryS: first ? (first[2] - fl.end) / 1000 : null, maxLagS: maxLag / 1000 };
			});
			const errorCounts: Record<string, number> = {};
			for (const e of errors) errorCounts[e!] = (errorCounts[e!] ?? 0) + 1;
			r.lag[f.name] = { steady: stats(steadyRows.map(lag)), wholeRun: stats(wholeRows.map(lag)), recovery: f.name === r.followers[0].name ? recovery : undefined, readErrors: errorCounts };
		}
	}
	writeFileSync(join(OUT, 'summary.json'), JSON.stringify(results, null, 2));
	const md: string[] = [`# S2 run ${stamp}`, ''];
	for (const [name, r] of Object.entries(results)) {
		md.push(`## ${name}`, '', '```json', JSON.stringify(r, null, 2), '```', '');
	}
	writeFileSync(join(OUT, 'summary.md'), md.join('\n'));
}

// ---------- main ------------------------------------------------------------------------------
const tunedConfig = join(OUT, 'litestream-tuned.yml');
{
	// The unit's own config with the two intervals that bound replay lag shortened.
	const unit = readFileSync(join(REPO, 'scripts/litestream.yml'), 'utf8');
	writeFileSync(tunedConfig, unit.replace(/^  - path: (.*)$/m, '  - path: $1\n    monitor-interval: 250ms').replace('sync-interval: 1s', 'sync-interval: 250ms'));
}
const all: Scenario[] = [
	{ name: 'unit', primaryVersion: '0.5.18', config: join(REPO, 'scripts/litestream.yml'), followers: [{ name: 'follower', interval: '1s' }, ...(UNIT_FAST ? [{ name: 'follower-fast', interval: '250ms' }] : [])], steadyMin: SOAK_MIN, faults: true, promote: true, kill9: false, fallback: false },
	{ name: 'tuned', primaryVersion: '0.5.18', config: tunedConfig, followers: [{ name: 'follower', interval: '250ms' }], steadyMin: TUNED_MIN, faults: false, promote: false, kill9: true, fallback: false },
	{ name: 'fallback', primaryVersion: '0.3.13', config: join(REPO, 'scripts/litestream.yml'), followers: [{ name: 'follower', interval: '1s' }], steadyMin: 0, faults: false, promote: false, kill9: false, fallback: true },
];
all.push({ name: 'walstall', primaryVersion: '0.5.18', config: join(REPO, 'scripts/litestream.yml'), followers: [{ name: 'follower', interval: '1s' }], steadyMin: 0, faults: false, promote: false, kill9: false, fallback: false, walstall: true });
all.push({ name: 'gap', primaryVersion: '0.5.18', config: join(REPO, 'scripts/litestream.yml'), followers: [{ name: 'follower', interval: '1s' }], steadyMin: 2, faults: false, promote: false, kill9: false, fallback: false, gapMin: Number(env.S2_GAP_MIN ?? 7) });
all.push({ name: 'cuts', primaryVersion: '0.5.18', config: join(REPO, 'scripts/litestream.yml'), followers: [{ name: 'follower', interval: '1s' }], steadyMin: 2, faults: false, promote: false, kill9: false, fallback: false, cuts: true });
all.push({ name: 'idle', primaryVersion: '0.5.18', config: join(REPO, 'scripts/litestream.yml'), followers: [{ name: 'follower', interval: '1s' }, { name: 'follower-fast', interval: '250ms' }], steadyMin: 0, faults: false, promote: false, kill9: false, fallback: false, idle: true });
const results: Record<string, unknown> = {};
let failed = false;
try {
	await setup();
	for (const sc of all.filter((s) => SCENARIOS.includes(s.name))) {
		log(`=== scenario ${sc.name}`);
		try {
			await scenario(sc, results);
		} catch (err) {
			failed = true;
			(results[sc.name] as Record<string, unknown>).error = scrub(String((err as Error).stack ?? err));
			log(`scenario ${sc.name} failed: ${(err as Error).message}`);
			if (/^budget:/.test((err as Error).message)) break;
		}
		analyse(results);
	}
} finally {
	if (R2) {
		try {
			results.r2Total = { ...cost(await minioRequests()), ops: await minioRequests() };
			const proxyPort = docker('port', `${P}-proxy`, '9999/tcp').split('\n')[0]!.split(':').pop();
			results.r2Latency = await (await fetch(`http://127.0.0.1:${proxyPort}/counts`)).json();
		} catch (err) {
			log(`could not read proxy counts: ${(err as Error).message}`);
		}
	}
	analyse(results);
	if (!env.S2_KEEP) cleanup();
	if (R2) {
		// Delete everything under the run prefix (only there), then prove it is empty.
		try {
			const client = s3client(S3.bucket);
			const keys = await listKeys(S3.bucket, `${R2_PREFIX}/`);
			for (const k of keys) {
				if (!k.startsWith(`${R2_PREFIX}/`)) throw new Error('refusing to delete outside the run prefix');
				await client.delete(k);
				hostOps.DeleteObject++;
			}
			const left = await listKeys(S3.bucket, `${R2_PREFIX}/`);
			results.r2Cleanup = { deleted: keys.length, remaining: left.length, hostOps };
			log(`R2 cleanup: deleted ${keys.length} objects under ${R2_PREFIX}/, ${left.length} remain`);
		} catch (err) {
			log(`R2 cleanup FAILED: ${(err as Error).message}`);
			results.r2Cleanup = { error: scrub((err as Error).message) };
		}
		if (existsSync(ENV_FILE)) unlinkSync(ENV_FILE);
		writeFileSync(join(OUT, 'summary.json'), scrub(JSON.stringify(results, null, 2)));
	}
	log(`done; output in ${OUT}`);
}
process.exit(failed ? 1 : 0);
