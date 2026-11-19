import { CHECKS, runChecks } from './checks.ts';
import { ensureSchema, eventSeen, queueSeen } from './db.ts';
import { QUEUES, isLocal, type Env, type JobMessage } from './env.ts';
import { reportError } from './report.ts';

// Durable Object classes and named entrypoints must be exported from the main module; the Yoal
// shim re-exports everything from here.
export { ChatRoom, Counter } from './objects.ts';
export { Toolbox } from './toolbox.ts';

/**
 * Per-isolate identity: shows cold starts and which replica answered. Created on first use,
 * because workerd forbids random values (and the clock is frozen) in global scope.
 */
let isolate: { id: string; startedAt: number } | null = null;
const ISOLATE = () => (isolate ??= { id: crypto.randomUUID().slice(0, 8), startedAt: Date.now() });

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
	Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
	const [api, area, name, action] = parts;
	if (api !== 'api') throw new HttpError(404, 'not found');
	const method = request.method;

	switch (area) {
		case 'health':
			return json({ ok: true });

		case 'info':
			return json({
				suite: 'function-suite',
				greeting: env.SUITE_GREETING,
				config: env.SUITE_CONFIG,
				isolate: { ...ISOLATE(), ageMs: Date.now() - ISOLATE().startedAt },
				local: isLocal(env),
				bindings: Object.fromEntries(
					Object.entries(env).map(([key, value]) => [key, key.includes('SECRET') || key === 'SENTRY_DSN' ? '(set)' : describe(value)]),
				),
				checks: CHECKS.map((check) => ({ name: check.name, system: check.system })),
				request: {
					host: request.headers.get('host'),
					forwardedFor: request.headers.get('x-forwarded-for'),
					forwardedProto: request.headers.get('x-forwarded-proto'),
				},
			});

		// The full in-Worker suite: GET /api/suite?only=kv,d1&skip=events
		case 'suite': {
			const list = (key: string) => url.searchParams.get(key)?.split(',').map((v) => v.trim()).filter(Boolean);
			const only = name ? [name] : list('only');
			const result = await runChecks(env, ctx, { only, skip: list('skip'), runId: url.searchParams.get('run') ?? undefined });
			return json(result, result.ok ? 200 : 500);
		}

		case 'echo':
			return json({
				method,
				path: url.pathname,
				query: Object.fromEntries(url.searchParams),
				headers: Object.fromEntries(request.headers),
				body: method === 'GET' || method === 'HEAD' ? null : await request.text(),
			});

		// run_worker_first: public/api/shadow.txt exists, but /api/* must reach the Worker.
		case 'shadow.txt':
			return new Response('from-worker\n', { headers: { 'content-type': 'text/plain' } });

		case 'status': {
			const code = Number(name ?? 200);
			if (!Number.isInteger(code) || code < 200 || code > 599) throw new HttpError(400, 'status must be 200–599');
			return json({ status: code }, code);
		}

		// Bounded busy loop: one event loop per host, so this blocks every other request on it.
		case 'cpu': {
			const ms = Math.min(Number(url.searchParams.get('ms') ?? 200), 2000);
			const end = Date.now() + ms;
			let spins = 0;
			while (Date.now() < end) spins += 1;
			return json({ ms, spins });
		}

		case 'error':
			throw new Error(`function-suite deliberate error ${url.searchParams.get('marker') ?? ''}`.trim());

		case 'log': {
			const marker = url.searchParams.get('marker') ?? crypto.randomUUID();
			console.log(JSON.stringify({ evt: 'log-probe', marker }));
			console.error(JSON.stringify({ evt: 'log-probe-stderr', marker }));
			return json({ marker });
		}

		case 'counter': {
			const counterName = (name ?? 'default').slice(0, 80);
			const stub = env.COUNTER.get(env.COUNTER.idFromName(counterName));
			if (method === 'POST') {
				const by = Number(url.searchParams.get('by') ?? 1);
				return json({ name: counterName, value: await stub.increment(Number.isFinite(by) ? by : 1) });
			}
			return json({ name: counterName, value: await stub.value() });
		}

		case 'room': {
			const stub = env.ROOM.get(env.ROOM.idFromName((name ?? 'lobby').slice(0, 80)));
			if (action === 'ws') {
				if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'expected a WebSocket upgrade');
				return stub.fetch(request);
			}
			return stub.fetch(new Request('https://room/'));
		}

		case 'queue': {
			if (name === 'send' && method === 'POST') {
				const input = (await request.json().catch(() => ({}))) as Partial<JobMessage> & { delaySeconds?: number };
				const kinds: JobMessage['kind'][] = ['echo', 'retry-once', 'fail', 'delay', 'external'];
				const kind = kinds.includes(input.kind as JobMessage['kind']) ? (input.kind as JobMessage['kind']) : 'echo';
				const message: JobMessage = { id: input.id ?? crypto.randomUUID(), kind, sentAt: Date.now() };
				await env.JOBS.send(message, { contentType: 'json', delaySeconds: input.delaySeconds });
				return json({ sent: message }, 202);
			}
			if (name === 'seen' && action) return json({ id: action, rows: await queueSeen(env, action) });
			throw new HttpError(404, 'queue: POST /api/queue/send or GET /api/queue/seen/:id');
		}

		case 'events':
			if (name === 'seen') {
				const key = url.searchParams.get('key');
				if (!key) throw new HttpError(400, 'key is required');
				return json({ key, rows: await eventSeen(env, key) });
			}
			throw new HttpError(404, 'events: GET /api/events/seen?key=');

		case 'cron':
			return json({ last: await env.KV.get('cron:last', 'json') });

		// A plain R2 passthrough, so scripts can drive uploads (and storage events) over HTTP.
		case 'r2': {
			const key = parts.slice(2).join('/');
			if (!key) {
				const listed = await env.BUCKET.list({ prefix: url.searchParams.get('prefix') ?? undefined, limit: 100 });
				return json({ objects: listed.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded })) });
			}
			if (method === 'PUT') {
				const object = await env.BUCKET.put(key, request.body, {
					httpMetadata: { contentType: request.headers.get('content-type') ?? 'application/octet-stream' },
				});
				return json({ key, size: object?.size, etag: object?.etag }, 201);
			}
			if (method === 'DELETE') {
				await env.BUCKET.delete(key);
				return json({ deleted: key });
			}
			const object = await env.BUCKET.get(key);
			if (!object) throw new HttpError(404, `no object ${key}`);
			const headers = new Headers();
			object.writeHttpMetadata(headers);
			headers.set('etag', object.httpEtag);
			return new Response(object.body, { headers });
		}

		case 'auth': {
			if (!env.AUTH) throw new HttpError(501, 'no user pool attached to this project');
			const user = await env.AUTH.verify(request);
			return user ? json({ user }) : json({ user: null }, 401);
		}
	}
	throw new HttpError(404, `no route for ${url.pathname}`);
}

function describe(value: unknown): string {
	if (typeof value === 'string') return 'text';
	if (value === null || typeof value !== 'object') return typeof value;
	const name = value.constructor?.name;
	return name && name !== 'Object' ? name : 'json/object';
}

export default {
	async fetch(request, env, ctx) {
		ISOLATE();
		const started = Date.now();
		let response: Response;
		try {
			response = await route(request, env, ctx);
		} catch (error) {
			if (error instanceof HttpError) {
				response = json({ error: error.message }, error.status);
			} else {
				const marker = new URL(request.url).searchParams.get('marker') ?? undefined;
				console.error(JSON.stringify({ evt: 'error', path: new URL(request.url).pathname, message: String(error) }));
				ctx.waitUntil(
					reportError(env, error, marker ? { marker } : {}).catch((reportFailure: unknown) =>
						console.error(JSON.stringify({ evt: 'report-failed', message: String(reportFailure) })),
					),
				);
				response = json({ error: 'internal', message: error instanceof Error ? error.message : String(error) }, 500);
			}
		}
		env.ANALYTICS.writeDataPoint({
			blobs: ['request', request.method, new URL(request.url).pathname],
			doubles: [response.status, Date.now() - started],
			indexes: ['function-suite'],
		});
		return response;
	},

	async scheduled(controller, env, ctx) {
		await ensureSchema(env);
		const previous = await env.KV.get<{ count: number }>('cron:last', 'json');
		const record = {
			cron: controller.cron,
			scheduledTime: controller.scheduledTime,
			ranAt: Date.now(),
			count: (previous?.count ?? 0) + 1,
			isolate: ISOLATE().id,
		};
		await env.KV.put('cron:last', JSON.stringify(record));
		await env.DB.prepare('INSERT INTO cron_log (cron, scheduled_time, ran_at) VALUES (?, ?, ?)')
			.bind(controller.cron, controller.scheduledTime, record.ranAt)
			.run();
		// Keep the D1 tables from growing without bound on a long-lived install.
		ctx.waitUntil(
			env.DB.batch([
				env.DB.prepare('DELETE FROM cron_log WHERE ran_at < ?').bind(Date.now() - 86_400_000),
				env.DB.prepare('DELETE FROM queue_log WHERE received_at < ?').bind(Date.now() - 86_400_000),
				env.DB.prepare('DELETE FROM event_log WHERE received_at < ?').bind(Date.now() - 86_400_000),
			]),
		);
		env.ANALYTICS.writeDataPoint({ blobs: ['cron', controller.cron], doubles: [record.count], indexes: ['function-suite'] });
		console.log(JSON.stringify({ evt: 'cron', ...record }));
	},

	async queue(batch, env) {
		await ensureSchema(env);
		const log = env.DB.prepare(
			'INSERT OR IGNORE INTO queue_log (id, queue, kind, attempts, sent_at, received_at) VALUES (?, ?, ?, ?, ?, ?)',
		);
		for (const message of batch.messages) {
			// Messages sent from the dashboard or REST arrive as JSON text; parse those too.
			const body = (typeof message.body === 'string' ? safeParse(message.body) : message.body) as Record<string, unknown> | null;
			if (batch.queue === QUEUES.events) {
				const key = String((body?.object as { key?: string } | undefined)?.key ?? '?');
				await env.DB.prepare('INSERT INTO event_log (key, action, received_at, body) VALUES (?, ?, ?, ?)')
					.bind(key, String(body?.action ?? '?'), Date.now(), JSON.stringify(body).slice(0, 4000))
					.run();
				message.ack();
				continue;
			}
			const job = body as Partial<JobMessage> | null;
			const id = String(job?.id ?? message.id);
			const kind = String(job?.kind ?? 'unknown');
			await log.bind(id, batch.queue, kind, message.attempts, job?.sentAt ?? null, Date.now()).run();
			if (batch.queue === QUEUES.jobs && kind === 'fail') {
				message.retry();
			} else if (batch.queue === QUEUES.jobs && kind === 'retry-once' && message.attempts < 2) {
				message.retry({ delaySeconds: 1 });
			} else {
				message.ack();
			}
		}
		console.log(JSON.stringify({ evt: 'queue', queue: batch.queue, messages: batch.messages.length }));
	},
} satisfies ExportedHandler<Env, unknown>;

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return { raw: text };
	}
}
