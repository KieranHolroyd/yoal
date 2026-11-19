import postgres from 'postgres';
import { EVENT_PREFIX, QUEUES, isLocal, type Env, type JobMessage } from './env.ts';
import { ensureSchema, eventSeen, queueSeen } from './db.ts';
import { reportError } from './report.ts';
import { sha256Hex } from './toolbox.ts';

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface CheckResult {
	name: string;
	system: string;
	status: CheckStatus;
	ms: number;
	detail?: unknown;
	error?: string;
}

interface CheckContext {
	env: Env;
	ctx: ExecutionContext;
	runId: string;
}

/** Thrown by a check to report `skip` with a reason instead of a failure. */
class Skip extends Error {}

interface Check {
	name: string;
	system: string;
	run(context: CheckContext): Promise<unknown>;
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, what: string): void {
	if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false>): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let delay = 100;
	while (true) {
		const value = await probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMs} ms`);
		await new Promise((resolve) => setTimeout(resolve, delay));
		delay = Math.min(delay * 2, 1000);
	}
}

const job = (runId: string, kind: JobMessage['kind'], suffix: string = kind): JobMessage => ({
	id: `${runId}-${suffix}`,
	kind,
	sentAt: Date.now(),
});

export const CHECKS: Check[] = [
	{
		name: 'vars',
		system: 'vars (text + json)',
		async run({ env }) {
			assert(typeof env.SUITE_GREETING === 'string' && env.SUITE_GREETING.length > 0, 'SUITE_GREETING is missing');
			assert(typeof env.SUITE_CONFIG === 'object' && env.SUITE_CONFIG !== null, 'SUITE_CONFIG is not a JSON binding');
			equal(env.SUITE_CONFIG.version, 1, 'SUITE_CONFIG.version');
			return { greeting: env.SUITE_GREETING, config: env.SUITE_CONFIG };
		},
	},
	{
		name: 'secret',
		system: 'secrets',
		async run({ env }) {
			assert(env.SUITE_SECRET, 'SUITE_SECRET is not bound (set it as a project secret)');
			// Only a digest leaves the isolate; the provision script compares it with its own.
			return { sha256: await sha256Hex(env.SUITE_SECRET), length: env.SUITE_SECRET.length };
		},
	},
	{
		name: 'assets',
		system: 'static assets',
		async run({ env }) {
			const response = await env.ASSETS.fetch(new Request('https://assets.local/'));
			equal(response.status, 200, 'ASSETS GET /');
			const html = await response.text();
			assert(html.includes('data-suite-marker'), 'index.html was not served by the ASSETS binding');
			return { status: response.status, bytes: html.length, contentType: response.headers.get('content-type') };
		},
	},
	{
		name: 'kv',
		system: 'KV',
		async run({ env, runId }) {
			const key = `check:${runId}`;
			await env.KV.put(key, JSON.stringify({ runId }), { metadata: { runId }, expirationTtl: 300 });
			const value = await env.KV.get<{ runId: string }>(key, 'json');
			equal(value?.runId, runId, 'get json');
			const withMeta = await env.KV.getWithMetadata<{ runId: string }>(key);
			equal(withMeta.metadata?.runId, runId, 'metadata');
			const listed = await env.KV.list({ prefix: key });
			assert(listed.keys.some((entry) => entry.name === key), 'list did not return the key');
			await env.KV.delete(key);
			equal(await env.KV.get(key), null, 'get after delete');
			return { listed: listed.keys.length };
		},
	},
	{
		name: 'd1',
		system: 'D1',
		async run({ env, runId }) {
			await ensureSchema(env);
			const insert = env.DB.prepare('INSERT INTO items (id, name, n) VALUES (?, ?, ?)');
			await env.DB.batch([insert.bind(`${runId}-a`, 'a', 1), insert.bind(`${runId}-b`, 'b', 2)]);
			const sum = await env.DB.prepare('SELECT COUNT(*) AS c, SUM(n) AS s FROM items WHERE id LIKE ?')
				.bind(`${runId}-%`)
				.first<{ c: number; s: number }>();
			equal(sum?.c, 2, 'row count');
			equal(sum?.s, 3, 'sum');
			// A batch is one transaction: the duplicate key aborts the whole batch.
			let rolledBack = false;
			try {
				await env.DB.batch([insert.bind(`${runId}-c`, 'c', 3), insert.bind(`${runId}-a`, 'dup', 4)]);
			} catch {
				rolledBack = true;
			}
			assert(rolledBack, 'a batch with a duplicate key succeeded');
			const after = await env.DB.prepare('SELECT COUNT(*) AS c FROM items WHERE id LIKE ?').bind(`${runId}-%`).first<number>('c');
			equal(after, 2, 'rows after the failed batch (atomicity)');
			const raw = await env.DB.prepare('SELECT id, n FROM items WHERE id = ?').bind(`${runId}-b`).raw<[string, number]>();
			equal(raw[0]?.[1], 2, 'raw()');
			await env.DB.prepare('DELETE FROM items WHERE id LIKE ?').bind(`${runId}-%`).run();
			return { rows: 2, atomicBatch: true };
		},
	},
	{
		name: 'r2',
		system: 'R2 (managed object storage)',
		async run({ env, runId }) {
			const key = `checks/${runId}.txt`;
			const body = `function-suite ${runId} `.repeat(40);
			await env.BUCKET.put(key, body, {
				httpMetadata: { contentType: 'text/plain; charset=utf-8' },
				customMetadata: { runId },
			});
			const head = await env.BUCKET.head(key);
			assert(head, 'head returned null after put');
			equal(head.size, body.length, 'size');
			equal(head.customMetadata?.runId, runId, 'customMetadata');
			const object = await env.BUCKET.get(key);
			equal(await object?.text(), body, 'body');
			const range = await env.BUCKET.get(key, { range: { offset: 0, length: 14 } });
			equal(await range?.text(), 'function-suite', 'ranged get');
			const listed = await env.BUCKET.list({ prefix: 'checks/' });
			assert(listed.objects.some((entry) => entry.key === key), 'list did not return the object');
			await env.BUCKET.delete(key);
			equal(await env.BUCKET.head(key), null, 'head after delete');
			return { bytes: body.length, etag: head.etag };
		},
	},
	{
		name: 'cache',
		system: 'Cache API',
		async run({ runId }) {
			const url = `https://cache.function-suite.internal/${runId}`;
			const cache = caches.default;
			await cache.put(url, new Response(runId, { headers: { 'cache-control': 'public, max-age=120', 'content-type': 'text/plain' } }));
			const hit = await cache.match(url);
			assert(hit, 'cache miss right after put');
			equal(await hit.text(), runId, 'cached body');
			const named = await caches.open('function-suite');
			await named.put(url, new Response('named', { headers: { 'cache-control': 'max-age=60' } }));
			equal(await (await named.match(url))?.text(), 'named', 'named cache body');
			equal(await cache.delete(url), true, 'delete');
			equal(await cache.match(url), undefined, 'match after delete');
			await named.delete(url);
			return { hit: true };
		},
	},
	{
		name: 'do-sql',
		system: 'Durable Objects (SQLite)',
		async run({ env, runId }) {
			const stub = env.COUNTER.get(env.COUNTER.idFromName(`check-${runId}`));
			equal(await stub.increment(2), 2, 'first increment');
			equal(await stub.increment(3), 5, 'second increment');
			equal(await stub.value(), 5, 'value');
			const kv = await stub.kvRoundTrip(runId);
			equal(kv.got?.token, runId, 'storage.get');
			equal(kv.listed, 1, 'storage.list');
			equal(kv.afterDelete, false, 'value still present after storage.delete');
			return { value: 5 };
		},
	},
	{
		name: 'do-alarm',
		system: 'Durable Object alarms',
		async run({ env, runId }) {
			const stub = env.COUNTER.get(env.COUNTER.idFromName(`alarm-${runId}`));
			const scheduledAt = Date.now();
			await stub.scheduleAlarm(runId, 300);
			const firedAt = await waitFor('alarm', 15_000, () => stub.alarmFiredAt(runId));
			return { delayMs: firedAt - scheduledAt };
		},
	},
	{
		name: 'do-websocket',
		system: 'Durable Object WebSockets (hibernation)',
		async run({ env, runId }) {
			const stub = env.ROOM.get(env.ROOM.idFromName(`check-${runId}`));
			const response = await stub.fetch('https://room/ws?name=checker', { headers: { upgrade: 'websocket' } });
			equal(response.status, 101, 'upgrade status');
			const ws = response.webSocket;
			assert(ws, 'no webSocket on the 101 response');
			ws.accept();
			const messages: Array<{ type: string; text?: string }> = [];
			ws.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))));
			await waitFor('welcome frame', 5000, async () => messages.some((m) => m.type === 'welcome'));
			ws.send(`hello ${runId}`);
			await waitFor('broadcast', 5000, async () => messages.some((m) => m.type === 'message' && m.text === `hello ${runId}`));
			const stats = (await (await stub.fetch('https://room/')).json()) as { connections: number };
			ws.close(1000, 'done');
			equal(stats.connections, 1, 'connections');
			return { frames: messages.length };
		},
	},
	{
		name: 'service-rpc',
		system: 'service binding (same Worker, JS RPC)',
		async run({ env }) {
			equal(await env.TOOLBOX.add(2, 3), 5, 'add');
			equal(
				await env.TOOLBOX.sha256('abc'),
				'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
				'sha256',
			);
			equal(await env.TOOLBOX.greeting(), env.SUITE_GREETING, 'greeting (callee sees env)');
			return { rpc: true };
		},
	},
	{
		name: 'app-binding',
		system: 'binding to another project',
		async run({ env, runId }) {
			if (!env.COMPANION) throw new Skip('COMPANION is not bound');
			const response = await env.COMPANION.fetch('https://companion/ping', { method: 'POST', body: runId });
			equal(response.status, 200, 'status');
			const body = (await response.json()) as { ok: boolean; service: string; echo: string };
			equal(body.echo, runId, 'echo');
			return { service: body.service };
		},
	},
	{
		name: 'hyperdrive',
		system: 'Hyperdrive (managed Postgres)',
		async run({ env, ctx, runId }) {
			if (!env.HYPERDRIVE) throw new Skip('HYPERDRIVE is not bound');
			const sql = postgres(env.HYPERDRIVE.connectionString, {
				max: 1,
				fetch_types: false,
				// PgBouncer runs in transaction mode; unnamed statements are always safe there.
				prepare: false,
				connect_timeout: 10,
			});
			try {
				const [{ version }] = await sql<[{ version: string }]>`SELECT version()`;
				await sql`CREATE TABLE IF NOT EXISTS suite_pg (id text PRIMARY KEY, n int NOT NULL, at timestamptz NOT NULL DEFAULT now())`;
				await sql`INSERT INTO suite_pg (id, n) VALUES (${runId}, 42)`;
				const [row] = await sql<[{ n: number }]>`SELECT n FROM suite_pg WHERE id = ${runId}`;
				equal(row?.n, 42, 'round trip');
				await sql`DELETE FROM suite_pg WHERE id = ${runId}`;
				return { version: version.split(' ').slice(0, 2).join(' ') };
			} finally {
				ctx.waitUntil(sql.end({ timeout: 2 }));
			}
		},
	},
	{
		name: 'analytics',
		system: 'Analytics Engine',
		async run({ env, runId }) {
			// Fire-and-forget like Cloudflare's: the write must not throw. Query it from the
			// function's Runtime card (ClickHouse) to see it land.
			env.ANALYTICS.writeDataPoint({ blobs: ['suite-check', runId], doubles: [1, Date.now()], indexes: ['function-suite'] });
			return { written: 1, dataset: 'function_suite' };
		},
	},
	{
		name: 'queue-send',
		system: 'queues: send → consume',
		async run({ env, runId }) {
			const message = job(runId, 'echo');
			await env.JOBS.send(message, { contentType: 'json' });
			const rows = await waitFor('consumer to see the message', 20_000, async () => (await queueSeen(env, message.id)).length > 0 && queueSeen(env, message.id));
			return { latencyMs: rows[0]!.received_at - message.sentAt };
		},
	},
	{
		name: 'queue-batch',
		system: 'queues: sendBatch',
		async run({ env, runId }) {
			const messages = [0, 1, 2].map((index) => job(runId, 'echo', `batch-${index}`));
			await env.JOBS.sendBatch(messages.map((body) => ({ body, contentType: 'json' as const })));
			for (const message of messages)
				await waitFor(`batch message ${message.id}`, 20_000, async () => (await queueSeen(env, message.id)).length > 0);
			return { sent: messages.length };
		},
	},
	{
		name: 'queue-retry',
		system: 'queues: retry → redelivery',
		async run({ env, runId }) {
			const message = job(runId, 'retry-once');
			await env.JOBS.send(message, { contentType: 'json' });
			const rows = await waitFor('the redelivered attempt', 30_000, async () => {
				const seen = await queueSeen(env, message.id);
				return seen.some((row) => row.attempts >= 2) && seen;
			});
			return { attempts: rows.map((row) => row.attempts) };
		},
	},
	{
		name: 'queue-delay',
		system: 'queues: delayed send',
		async run({ env, runId }) {
			const message = job(runId, 'delay');
			await env.JOBS.send(message, { contentType: 'json', delaySeconds: 2 });
			const rows = await waitFor('the delayed message', 30_000, async () => (await queueSeen(env, message.id)).length > 0 && queueSeen(env, message.id));
			const waited = rows[0]!.received_at - message.sentAt;
			assert(waited >= 1800, `delivered after ${waited} ms, before the 2 s delay`);
			return { waitedMs: waited };
		},
	},
	{
		name: 'queue-dlq',
		system: 'queues: max_retries → dead-letter queue',
		async run({ env, runId }) {
			const message = job(runId, 'fail');
			await env.JOBS.send(message, { contentType: 'json' });
			const rows = await waitFor('the dead letter', 45_000, async () => {
				const seen = await queueSeen(env, message.id);
				return seen.some((row) => row.queue === QUEUES.dlq) && seen;
			});
			const attempts = rows.filter((row) => row.queue === QUEUES.jobs).length;
			return { attemptsBeforeDlq: attempts, dlq: QUEUES.dlq };
		},
	},
	{
		name: 'events',
		system: 'events: R2 upload → event rule → queue',
		async run({ env, runId }) {
			if (isLocal(env)) throw new Skip('storage events need a Yoal event rule');
			const key = `${EVENT_PREFIX}${runId}.txt`;
			await env.BUCKET.put(key, `event probe ${runId}`);
			try {
				const rows = await waitFor('the storage event', 30_000, async () => (await eventSeen(env, key)).length > 0 && eventSeen(env, key));
				return { actions: rows.map((row) => row.action) };
			} finally {
				await env.BUCKET.delete(key);
			}
		},
	},
	{
		name: 'cron',
		system: 'cron triggers',
		async run({ env }) {
			const last = await env.KV.get<{ cron: string; scheduledTime: number; ranAt: number; count: number }>('cron:last', 'json');
			if (!last) throw new Skip('no cron run yet (the schedule is every 5 minutes; run it now from the Test tab)');
			const ageSeconds = Math.round((Date.now() - last.ranAt) / 1000);
			// The schedule is every 5 minutes; a stale value means the node's scheduler stopped.
			if (!isLocal(env)) assert(ageSeconds < 420, `the last cron run was ${ageSeconds}s ago`);
			return { ...last, ageSeconds };
		},
	},
	{
		name: 'egress',
		system: 'egress policy (public allowed, private denied)',
		async run({ env }) {
			const publicStatus = await fetch('https://example.com/', { signal: AbortSignal.timeout(8000) }).then(
				async (response) => {
					await response.body?.cancel();
					return response.status;
				},
				(error: unknown) => `error: ${String(error)}`,
			);
			assert(typeof publicStatus === 'number', `public fetch failed (${publicStatus})`);
			if (isLocal(env)) return { public: publicStatus, private: 'not enforced by wrangler dev' };
			const privateTargets = ['http://127.0.0.1:2019/config/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/'];
			const leaks: string[] = [];
			for (const target of privateTargets) {
				try {
					const response = await fetch(target, { signal: AbortSignal.timeout(3000) });
					await response.body?.cancel();
					leaks.push(`${target} → ${response.status}`);
				} catch {
					// Refused, as it should be.
				}
			}
			assert(leaks.length === 0, `private addresses answered: ${leaks.join(', ')}`);
			return { public: publicStatus, privateBlocked: privateTargets.length };
		},
	},
	{
		name: 'auth',
		system: 'user-pool auth (env.AUTH)',
		async run({ env }) {
			if (!env.AUTH) throw new Skip('no user pool attached to the project');
			equal(await env.AUTH.verify(new Request('https://x/')), null, 'verify without a token');
			equal(await env.AUTH.verify('Bearer not-a-jwt'), null, 'verify with garbage');
			return { verify: 'rejects missing and malformed tokens' };
		},
	},
	{
		name: 'app-errors',
		system: 'app errors (SENTRY_DSN)',
		async run({ env, runId }) {
			if (!env.SENTRY_DSN) throw new Skip('app errors are not enabled for the project');
			const sent = await reportError(env, new Error(`function-suite check ${runId}`), { run: runId });
			assert(sent && sent.status === 200, `ingest answered ${sent?.status}`);
			return { eventId: sent.eventId, marker: `function-suite check ${runId}` };
		},
	},
];

export async function runChecks(
	env: Env,
	ctx: ExecutionContext,
	options: { only?: string[]; skip?: string[]; runId?: string } = {},
): Promise<{ ok: boolean; runId: string; durationMs: number; results: CheckResult[] }> {
	const runId = options.runId ?? `run-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
	const started = Date.now();
	const selected = CHECKS.filter(
		(check) =>
			(!options.only?.length || options.only.includes(check.name)) && !options.skip?.includes(check.name),
	);
	const results = await Promise.all(
		selected.map(async (check): Promise<CheckResult> => {
			const t0 = Date.now();
			try {
				const detail = await Promise.race([
					check.run({ env, ctx, runId }),
					new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out after 60 s')), 60_000)),
				]);
				return { name: check.name, system: check.system, status: 'pass', ms: Date.now() - t0, detail };
			} catch (error) {
				const status: CheckStatus = error instanceof Skip ? 'skip' : 'fail';
				return {
					name: check.name,
					system: check.system,
					status,
					ms: Date.now() - t0,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}),
	);
	const ok = results.every((result) => result.status !== 'fail');
	console.log(
		JSON.stringify({
			evt: 'suite',
			runId,
			ok,
			pass: results.filter((r) => r.status === 'pass').length,
			fail: results.filter((r) => r.status === 'fail').map((r) => r.name),
		}),
	);
	return { ok, runId, durationMs: Date.now() - started, results };
}
