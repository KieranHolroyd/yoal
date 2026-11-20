/**
 * Spikes S3 (R2) and S7 (GCS) against real cloud buckets. Credentials come from the environment
 * only and never reach the output: every line printed is scrubbed of the endpoint, account, bucket,
 * key ids and service-account identity.
 *
 *   set -a; . creds.env; set +a; bun spikes/s3-cas/run-cloud.ts > results.json
 *
 *   R2:  R2_ENDPOINT R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
 *   GCS: GCS_BUCKET GCS_SERVICE_ACCOUNT_JSON (path to a service-account key file)
 *   STORES=r2,gcs (default both; `r2-identity` = R2 with the Accept-Encoding: identity read fix)
 *   ONLY=lease (clock + ControlLease only) RUN_ID=<id> FLOOD_MAX_ATTEMPTS=2000 RENEW=1 (renewal-rate probe)
 *   The spike's knobs (WRITERS, ATTEMPTS, SECONDS, FLOOD_SECONDS, LEASE_SECONDS) pass through;
 *   LEASE_SECONDS is forced to 0 for GCS (ControlLease runs on R2 only, per the brief).
 *
 * Objects: only `yoal-w0-spikes/<run-id>/…`. Afterwards every key under that prefix is deleted and
 * a fresh LIST of the prefix must come back empty.
 */
import { readFileSync } from 'node:fs';
import { runSpike, type SpikeResult } from './spike.ts';
import { openTarget, type CasTarget, type TargetConfig } from './targets.ts';

const env = process.env;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pct = (sorted: number[], q: number) =>
	sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! * 10) / 10 : NaN;

// ── Scrubbing: anything that identifies the account or authenticates is replaced before printing. ──
const secrets: [string, string][] = [];
const hide = (value: string | undefined, label: string) => {
	if (value && value.length >= 4) secrets.push([value, `<${label}>`]);
};
if (env.R2_ENDPOINT) {
	hide(env.R2_ENDPOINT.replace(/\/+$/, ''), 'r2-endpoint');
	const host = new URL(env.R2_ENDPOINT).host;
	hide(host, 'r2-host');
	hide(host.split('.')[0], 'r2-account');
}
hide(env.R2_BUCKET, 'r2-bucket');
hide(env.R2_ACCESS_KEY_ID, 'r2-key-id');
hide(env.R2_SECRET_ACCESS_KEY, 'r2-secret');
hide(env.GCS_BUCKET, 'gcs-bucket');
hide(env.GCS_SERVICE_ACCOUNT_JSON, 'gcs-key-file');
if (env.GCS_SERVICE_ACCOUNT_JSON) {
	try {
		const key = JSON.parse(readFileSync(env.GCS_SERVICE_ACCOUNT_JSON, 'utf8')) as Record<string, string>;
		for (const field of ['client_email', 'project_id', 'private_key_id', 'client_id']) hide(key[field], `gcs-${field}`);
	} catch {
		// Unreadable key: the GCS run fails with its own (scrubbed) error.
	}
}
secrets.sort((a, b) => b[0].length - a[0].length);
const scrub = (text: string) => secrets.reduce((out, [value, label]) => out.split(value).join(label), text);
const rawLog = console.log.bind(console);
const rawError = console.error.bind(console);
console.log = (...args: unknown[]) => rawLog(scrub(args.map(String).join(' ')));
console.error = (...args: unknown[]) => rawError(scrub(args.map(String).join(' ')));

const runId = env.RUN_ID ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
const prefix = `yoal-w0-spikes/${runId}`;

function configFor(store: string): TargetConfig {
	const need = (name: string) => {
		const value = env[name];
		if (!value) throw new Error(`missing ${name}`);
		return value;
	};
	if (store === 'r2' || store === 'r2-identity')
		return {
			name: store === 'r2' ? 'r2' : 'r2+identity-reads',
			...(store === 'r2-identity' ? { identityReads: true } : {}),
			protocol: 's3',
			endpoint: need('R2_ENDPOINT'),
			bucket: need('R2_BUCKET'),
			region: 'auto',
			accessKeyId: need('R2_ACCESS_KEY_ID'),
			secretAccessKey: need('R2_SECRET_ACCESS_KEY'),
			forcePathStyle: true,
			version: 'Cloudflare R2 (service; S3 API, SigV4 region auto, path style)',
		};
	if (store === 'gcs')
		return {
			name: 'gcs',
			protocol: 'gcs',
			endpoint: 'https://storage.googleapis.com',
			bucket: need('GCS_BUCKET'),
			keyFile: need('GCS_SERVICE_ACCOUNT_JSON'),
			version: 'Google Cloud Storage JSON API v1 (service-account OAuth)',
		};
	throw new Error(`unknown store ${store}`);
}

/** R2 §6.3 claim: concurrent conditional writes on one key answer 409 ConditionalRequestConflict. */
async function conflictProbe(target: CasTarget, key: string, bursts = 10, width = 20) {
	const created = await target.writeConditional(key, JSON.stringify({ epoch: 0 }), { ifNoneMatch: '*' });
	if (created.status !== 200) return { error: `create ${created.status}` };
	const codes: Record<string, number> = {};
	let winnersPerBurst: number[] = [];
	for (let b = 0; b < bursts; b++) {
		const read = await target.readVersioned(key);
		if (!read.etag) break;
		const results = await Promise.all(
			Array.from({ length: width }, (_, i) => target.putRaw(key, JSON.stringify({ epoch: b + 1, writer: i }), { 'if-match': read.etag! })),
		);
		for (const r of results) codes[`${r.status}${r.code ? ` ${r.code}` : ''}`] = (codes[`${r.status}${r.code ? ` ${r.code}` : ''}`] ?? 0) + 1;
		winnersPerBurst.push(results.filter((r) => r.status === 200).length);
		await sleep(1_500);
	}
	return { bursts, width, codes, winnersPerBurst };
}

/**
 * Renewal cadence against a per-key write limit: sequential CAS renewals on one key every
 * `intervalMs` (0 = back to back), bodies shaped like the lease (`expiresAt` moves).
 */
async function renewals(target: CasTarget, key: string, intervalMs: number, count: number) {
	const created = await target.writeConditional(key, JSON.stringify({ epoch: 1, n: 0 }), { ifNoneMatch: '*' });
	if (created.status !== 200 || !created.etag) return { error: `create ${created.status}` };
	let token = created.etag;
	const statuses: Record<string, number> = {};
	const latencies: number[] = [];
	const started = Date.now();
	let ok = 0;
	for (let i = 1; i <= count; i++) {
		if (intervalMs) await sleep(Math.max(0, started + i * intervalMs - Date.now()));
		const t0 = performance.now();
		const write = await target.writeConditional(key, JSON.stringify({ epoch: 1, n: i, expiresAt: new Date(Date.now() + 30_000).toISOString() }), { ifMatch: token });
		latencies.push(performance.now() - t0);
		statuses[write.status] = (statuses[write.status] ?? 0) + 1;
		if (write.status === 200 && write.etag) {
			token = write.etag;
			ok++;
		} else {
			const read = await target.readVersioned(key);
			if (read.etag) token = read.etag;
		}
	}
	latencies.sort((a, b) => a - b);
	return {
		intervalMs,
		count,
		ok,
		statuses,
		achievedPerSecond: Math.round((count / ((Date.now() - started) / 1000)) * 100) / 100,
		p50: pct(latencies, 0.5),
		p99: pct(latencies, 0.99),
		max: Math.round(latencies.at(-1) ?? NaN),
	};
}

async function cleanup(target: CasTarget) {
	const listed = await target.list(`${prefix}/`);
	let deleted = 0;
	for (const key of listed) {
		if (!key.startsWith(`${prefix}/`)) throw new Error('refusing to delete a key outside the run prefix');
		await target.delete(key);
		deleted++;
	}
	const remaining = await target.list(`${prefix}/`);
	return { listedBeforeCleanup: listed.length, deleted, remainingAfterCleanup: remaining.length };
}

const stores = (env.STORES ?? 'r2,gcs').split(',').map((s) => s.trim()).filter(Boolean);
const out: (SpikeResult & { extras?: Record<string, unknown>; cleanup?: unknown })[] = [];
let failed = false;
for (const store of stores) {
	let target: CasTarget | null = null;
	try {
		const config = configFor(store);
		target = openTarget(config);
		console.error(`[${store}] run ${runId}, prefix ${prefix}/`);
		const result: SpikeResult & { extras?: Record<string, unknown>; cleanup?: unknown } = await runSpike(config, {
			...env,
			RUN_PREFIX: `${prefix}/${store}`,
			FLOOD_MAX_ATTEMPTS: env.FLOOD_MAX_ATTEMPTS ?? '2000',
			...(store === 'gcs' ? { LEASE_SECONDS: '0' } : {}),
		});
		if (env.RENEW !== '0') {
			const extras: Record<string, unknown> = {};
			if (store.startsWith('r2')) extras.conflictProbe = await conflictProbe(target, `${prefix}/${store}/conflict`);
			extras.renewEvery5s = await renewals(target, `${prefix}/${store}/renew-5s`, 5_000, 24);
			extras.renewEvery1s = await renewals(target, `${prefix}/${store}/renew-1s`, 1_000, 60);
			extras.renewBackToBack = await renewals(target, `${prefix}/${store}/renew-0s`, 0, 30);
			result.extras = extras;
			console.error(`[${store}] extras ${JSON.stringify(extras)}`);
		}
		result.cleanup = await cleanup(target);
		console.error(`[${store}] cleanup ${JSON.stringify(result.cleanup)}`);
		out.push(result);
		if (!result.pass) failed = true;
	} catch (error) {
		failed = true;
		const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		console.error(`[${store}] ERROR ${message}`);
		const cleaned = target ? await cleanup(target).catch((e) => `cleanup failed: ${(e as Error).message}`) : 'no target';
		console.error(`[${store}] cleanup after error ${JSON.stringify(cleaned)}`);
		out.push({ spike: store === 'gcs' ? 'S7' : 'S3', target: store, at: new Date().toISOString(), pass: false, checks: {}, codes: {}, numbers: { error: message }, cleanup: cleaned });
	}
}
console.log(JSON.stringify({ runId, prefix: `${prefix}/`, results: out }, null, 2));
process.exit(failed ? 1 : 0);
