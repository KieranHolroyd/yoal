#!/usr/bin/env bun
/**
 * Black-box test of a deployed function-suite: the edge path, every binding (through the
 * in-Worker suite), Durable Objects from outside, queues and storage events end to end, load,
 * and — with an API key — the control plane's view and test tools.
 *
 *   bun scripts/suite.ts                                   # base URL from .state.json
 *   bun scripts/suite.ts --base http://127.0.0.1:8799 --local
 *   bun scripts/suite.ts --cold-start                       # also waits for idle stop
 *
 * Exits non-zero when any check fails. Writes .suite-report.json.
 */
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Api, EXAMPLE_DIR, apiFromEnv, dim, green, poll, readState, red, sleep, yellow } from './lib.ts';

const { values: flags } = parseArgs({
	options: {
		base: { type: 'string' },
		url: { type: 'string' },
		token: { type: 'string' },
		local: { type: 'boolean', default: false },
		'no-api': { type: 'boolean', default: false },
		requests: { type: 'string', default: '200' },
		concurrency: { type: 'string', default: '20' },
		'p95-ms': { type: 'string', default: '1000' },
		'cold-start': { type: 'boolean', default: false },
		skip: { type: 'string' },
		help: { type: 'boolean', short: 'h', default: false },
	},
});

if (flags.help) {
	console.log(`Usage: bun scripts/suite.ts [options]

  --base <url>          Deployed URL (default: .state.json, else http://127.0.0.1:8799)
  --local               Target \`bun run dev\` (skips platform-only checks)
  --url, --token        Control-plane checks (default: $YOAL_URL, $YOAL_TOKEN); --no-api skips them
  --requests <n>        Load sample size (default 200), --concurrency <n> (default 20)
  --p95-ms <ms>         Load p95 budget (default 1000)
  --cold-start          Wait for the idle stop, then measure a cold start
  --skip a,b            In-Worker checks to skip (e.g. events,egress)`);
	process.exit(0);
}

const state = readState();
const base = (flags.base ?? (flags.local ? 'http://127.0.0.1:8799' : state.url) ?? 'http://127.0.0.1:8799').replace(/\/+$/, '');
const local = flags.local || /^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(base);
const api: Api | null = flags['no-api'] || local ? null : apiFromEnv(flags);
const slug = state.slug ?? 'function-suite';
const run = `bb-${Date.now().toString(36)}`;

type Status = 'pass' | 'fail' | 'warn' | 'skip';
interface Result {
	section: string;
	name: string;
	status: Status;
	ms: number;
	detail?: string;
}
const results: Result[] = [];

function print(result: Result) {
	const tag = { pass: green('PASS'), fail: red('FAIL'), warn: yellow('WARN'), skip: dim('SKIP') }[result.status];
	console.log(`  ${tag} ${result.name.padEnd(34)} ${dim(String(result.ms).padStart(6) + ' ms')}  ${result.detail ? dim(result.detail.slice(0, 160)) : ''}`);
}

class SoftFail extends Error {}
class Skip extends Error {}

async function check(section: string, name: string, fn: () => Promise<string | void>) {
	const t0 = performance.now();
	let result: Result;
	try {
		const detail = await fn();
		result = { section, name, status: 'pass', ms: Math.round(performance.now() - t0), detail: detail ?? undefined };
	} catch (error) {
		const status: Status = error instanceof Skip ? 'skip' : error instanceof SoftFail ? 'warn' : 'fail';
		result = { section, name, status, ms: Math.round(performance.now() - t0), detail: error instanceof Error ? error.message : String(error) };
	}
	results.push(result);
	print(result);
}

function expect(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function get(path: string, init?: RequestInit) {
	const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(90_000) });
	const text = await response.text();
	let body: any = text;
	try {
		body = JSON.parse(text);
	} catch {
		// not JSON
	}
	return { status: response.status, headers: response.headers, body, text };
}

function section(title: string) {
	console.log(`\n${title}`);
}

console.log(`function-suite against ${base}${local ? ' (local)' : ''}${api ? ` · control plane ${api.baseUrl}` : ''} · run ${run}`);

// ── Edge ─────────────────────────────────────────────────────────────────────────────────────
section('Edge and assets');
await check('edge', 'health', async () => {
	const r = await get('/api/health');
	expect(r.status === 200 && r.body?.ok === true, `got ${r.status}: ${r.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)}`);
});
await check('edge', 'static index (assets first)', async () => {
	const r = await get('/');
	expect(r.status === 200, `got ${r.status}`);
	expect(r.text.includes('data-suite-marker'), 'index.html marker missing');
	return r.headers.get('content-type') ?? '';
});
await check('edge', 'static file', async () => {
	const r = await get('/probe.txt');
	expect(r.status === 200 && r.text.startsWith('asset-probe'), `got ${r.status} ${r.text.slice(0, 40)}`);
});
await check('edge', 'run_worker_first for /api/*', async () => {
	const r = await get('/api/shadow.txt');
	expect(r.text.trim() === 'from-worker', `served "${r.text.trim()}" (the asset shadowed the Worker)`);
});
await check('edge', 'request echo + Host', async () => {
	const r = await get('/api/echo?x=1', { method: 'POST', body: `payload ${run}`, headers: { 'x-suite': run } });
	expect(r.body.body === `payload ${run}`, 'body did not round-trip');
	expect(r.body.headers['x-suite'] === run, 'custom header lost');
	expect(r.body.headers.host === new URL(base).host, `Host was ${r.body.headers.host}`);
});
await check('edge', 'status passthrough', async () => {
	for (const code of [404, 418, 503]) {
		const r = await get(`/api/status/${code}`);
		expect(r.status === code, `${code} came back as ${r.status}`);
	}
	return '404 418 503';
});
await check('edge', 'unhandled error → 500', async () => {
	const r = await get(`/api/error?marker=${run}`);
	expect(r.status === 500 && r.body.error === 'internal', `got ${r.status}`);
});

// ── In-Worker suite ──────────────────────────────────────────────────────────────────────────
section('Bindings (in-Worker suite)');
const skip = [...(flags.skip?.split(',') ?? [])];
const suite = await get(`/api/suite?run=${run}${skip.length ? `&skip=${skip.join(',')}` : ''}`).catch((error: unknown) => ({
	status: 0,
	body: null as any,
	text: `request failed: ${error instanceof Error ? error.message : String(error)} (run single checks with /api/suite/<name> to find the one that hangs)`,
}));
if (!Array.isArray(suite.body?.results)) {
	results.push({ section: 'bindings', name: 'suite', status: 'fail', ms: 0, detail: `GET /api/suite → ${suite.status} ${suite.text.slice(0, 200)}` });
	print(results.at(-1)!);
} else {
	for (const r of suite.body.results as Array<{ name: string; system: string; status: 'pass' | 'fail' | 'skip'; ms: number; detail?: unknown; error?: string }>) {
		let status: Status = r.status;
		let detail = r.error ?? JSON.stringify(r.detail ?? '');
		if (r.name === 'secret' && r.status === 'pass' && state.secretSha256 && !local) {
			const digest = (r.detail as { sha256?: string }).sha256;
			if (digest !== state.secretSha256) {
				status = 'fail';
				detail = `digest ${digest?.slice(0, 12)}… ≠ provisioned ${state.secretSha256.slice(0, 12)}… (rotated without a restart?)`;
			} else detail = 'matches the provisioned value';
		}
		const result: Result = { section: 'bindings', name: `${r.name} · ${r.system}`, status, ms: r.ms, detail };
		results.push(result);
		print(result);
	}
}

// ── Durable Objects from outside ─────────────────────────────────────────────────────────────
section('Durable Objects over HTTP');
await check('do', 'WebSocket room: A → B broadcast', async () => {
	const wsBase = base.replace(/^http/, 'ws');
	const open = (name: string) =>
		new Promise<{ ws: WebSocket; frames: any[] }>((resolveOpen, reject) => {
			const ws = new WebSocket(`${wsBase}/api/room/${run}/ws?name=${name}`);
			const frames: any[] = [];
			ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
			ws.onopen = () => resolveOpen({ ws, frames });
			ws.onerror = () => reject(new Error(`${name} could not connect`));
			setTimeout(() => reject(new Error(`${name} connect timeout`)), 10_000);
		});
	const a = await open('alice');
	const b = await open('bob');
	a.ws.send(`hi from alice ${run}`);
	await poll('bob to receive alice', 10_000, async () => b.frames.some((f) => f.type === 'message' && f.from === 'alice'), 100);
	const room = await get(`/api/room/${run}`);
	a.ws.close();
	b.ws.close();
	expect(room.body.connections === 2, `room reported ${room.body.connections} connections`);
	return `${room.body.connections} sockets, ${b.frames.length} frames at bob`;
});
await check('do', 'counter: 50 concurrent increments', async () => {
	const name = `load-${run}`;
	const values = await Promise.all(
		Array.from({ length: 50 }, () => get(`/api/counter/${name}`, { method: 'POST' }).then((r) => r.body.value as number)),
	);
	const final = (await get(`/api/counter/${name}`)).body.value;
	expect(final === 50, `final value ${final}`);
	expect(new Set(values).size === 50, 'two increments returned the same value (not serialized)');
	return 'serialized, no lost updates';
});

// ── Queues and events end to end ─────────────────────────────────────────────────────────────
section('Queues and events over HTTP');
await check('queues', 'POST /api/queue/send → consumer', async () => {
	const id = `${run}-http`;
	const sent = await get('/api/queue/send', { method: 'POST', body: JSON.stringify({ id, kind: 'echo' }), headers: { 'content-type': 'application/json' } });
	expect(sent.status === 202, `send → ${sent.status}`);
	const rows = await poll('the consumer', 30_000, async () => {
		const seen = await get(`/api/queue/seen/${id}`);
		return seen.body.rows?.length > 0 && seen.body.rows;
	}, 500);
	return `received after ${rows[0].received_at - rows[0].sent_at} ms`;
});
await check('events', 'PUT object → storage event → queue', async () => {
	if (local) throw new Skip('needs a Yoal event rule');
	const key = `events/${run}.txt`;
	const put = await get(`/api/r2/${key}`, { method: 'PUT', body: `event ${run}`, headers: { 'content-type': 'text/plain' } });
	expect(put.status === 201, `PUT → ${put.status}`);
	try {
		const rows = await poll('the event', 45_000, async () => {
			const seen = await get(`/api/events/seen?key=${encodeURIComponent(key)}`);
			return seen.body.rows?.length > 0 && seen.body.rows;
		}, 1000);
		return `action ${rows[0].action}`;
	} finally {
		await get(`/api/r2/${key}`, { method: 'DELETE' });
	}
});

// ── Load ─────────────────────────────────────────────────────────────────────────────────────
section('Load');
await check('load', `GET /api/health ×${flags.requests} @${flags.concurrency}`, async () => {
	const total = Number(flags.requests);
	const concurrency = Number(flags.concurrency);
	const latencies: number[] = [];
	let errors = 0;
	let next = 0;
	const started = performance.now();
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (next < total) {
				next += 1;
				const t0 = performance.now();
				try {
					const response = await fetch(`${base}/api/health`);
					await response.arrayBuffer();
					if (response.status !== 200) errors += 1;
				} catch {
					errors += 1;
				}
				latencies.push(performance.now() - t0);
			}
		}),
	);
	const seconds = (performance.now() - started) / 1000;
	latencies.sort((a, b) => a - b);
	const pct = (p: number) => Math.round(latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]!);
	const summary = `p50 ${pct(50)} · p95 ${pct(95)} · p99 ${pct(99)} ms · ${Math.round(total / seconds)} req/s · ${errors} errors`;
	expect(errors === 0, summary);
	if (pct(95) > Number(flags['p95-ms'])) throw new SoftFail(`${summary} (p95 over ${flags['p95-ms']} ms)`);
	return summary;
});

// ── Control plane ────────────────────────────────────────────────────────────────────────────
if (api) {
	section(`Control plane (${slug})`);
	const expectedTypes = ['text', 'json', 'secret', 'assets', 'kv', 'd1', 'r2', 'durable_object', 'hyperdrive', 'analytics_engine', 'queue', 'service', 'app', 'cache'];
	await check('control', 'function view lists every binding', async () => {
		const fn = await api.get(`/projects/${slug}/function`);
		const view = fn.function ?? fn;
		const types = new Set<string>((view.bindings ?? []).map((b: { type: string }) => b.type));
		const missing = expectedTypes.filter((type) => !types.has(type));
		expect(missing.length === 0, `missing: ${missing.join(', ')}`);
		expect((view.triggers?.queues ?? []).length === 3, `${(view.triggers?.queues ?? []).length} queue consumers`);
		return `${view.bindings.length} bindings · workerd ${view.workerdVersion ?? '?'} · idle stop ${view.idleStopSeconds ?? '?'} s`;
	});
	await check('control', 'test request (function/invoke)', async () => {
		const { task } = await api.post(`/projects/${slug}/function/invoke?wait=25`, { path: '/api/info' });
		expect(task.status === 'succeeded', `task ${task.status}: ${task.error ?? ''}`);
		expect(task.result.status === 200, `status ${task.result.status}`);
		return `${task.result.durationMs} ms, coldStart ${task.result.coldStart}`;
	});
	await check('control', 'run cron now (function/scheduled)', async () => {
		const before = (await get('/api/cron/last')).body.last?.ranAt ?? 0;
		const { task } = await api.post(`/projects/${slug}/function/scheduled?wait=25`, { cron: '*/5 * * * *' });
		expect(task.status === 'succeeded', `task ${task.status}: ${task.error ?? ''}`);
		expect(!task.result.error, `scheduled() failed: ${task.result.error}`);
		const after = await poll('cron:last to move', 10_000, async () => {
			const last = (await get('/api/cron/last')).body.last;
			return last && last.ranAt > before && last;
		}, 500);
		return `run #${after.count} in ${task.result.durationMs} ms`;
	});
	await check('control', 'broker test message → consumer', async () => {
		const broker = state.broker ?? 'function-suite';
		const id = `${run}-rest`;
		await api.post(`/brokers/${broker}/queues/suite-jobs/messages?wait=20`, {
			body: JSON.stringify({ id, kind: 'external', sentAt: Date.now() }),
			contentType: 'json',
		});
		await poll('the consumer', 30_000, async () => (await get(`/api/queue/seen/${id}`)).body.rows?.length > 0, 1000);
	});
	await check('control', 'broker reports the queue streams', async () => {
		const listing = await api.get(`/brokers/${state.broker ?? 'function-suite'}/queues`);
		const names = new Set<string>((listing.streams ?? []).map((s: { queue?: string; stream: string }) => s.queue ?? s.stream));
		const missing = (state.queues ?? ['suite-jobs', 'suite-jobs-dlq', 'suite-events']).filter((q) => ![...names].some((n) => n.endsWith(q)));
		if (missing.length) throw new SoftFail(`not in the last listing (sampled once a minute): ${missing.join(', ')}`);
		return `${names.size} streams`;
	});
	await check('control', 'R2 object visible in the storage browser', async () => {
		const key = `checks-ext/${run}.txt`;
		await get(`/api/r2/${key}`, { method: 'PUT', body: run });
		try {
			const listing = await api.get(`/storage/${state.storage ?? 'function-suite'}/objects?bucket=${state.bucket ?? 'suite-objects'}&prefix=checks-ext/`);
			expect(JSON.stringify(listing).includes(`${run}.txt`), 'the object is not listed');
		} finally {
			await get(`/api/r2/${key}`, { method: 'DELETE' });
		}
	});
	await check('control', 'app error reached the error tracker', async () => {
		const settings = await api.get(`/projects/${slug}/errors/settings`);
		if (!(settings.settings ?? settings).enabled) throw new Skip('app errors are disabled for the project');
		await poll('the reported error', 45_000, async () => {
			const list = await api.get(`/projects/${slug}/errors?status=all&range=24h&q=${encodeURIComponent(run)}`);
			return JSON.stringify(list).includes(run);
		}, 3000);
	});
	await check('control', 'runtime logs carry console output', async () => {
		const marker = `${run}-log`;
		await get(`/api/log?marker=${marker}`);
		try {
			await poll('the log line', 45_000, async () => JSON.stringify(await api.get(`/projects/${slug}/logs?source=runtime&limit=500`)).includes(marker), 3000);
		} catch (error) {
			throw new SoftFail(error instanceof Error ? error.message : String(error));
		}
	});
	if (state.eventRuleId)
		await check('control', 'event rule deliveries', async () => {
			const body = await api.get(`/events/${state.eventRuleId}`);
			const rule = body.rule ?? body;
			if (rule.deliveries?.failed) throw new SoftFail(`${rule.deliveries.failed} failed deliveries; last error: ${rule.lastError}`);
			expect(rule.deliveries?.delivered > 0, 'no deliveries in 24 h');
			return `${rule.deliveries.delivered} delivered in 24 h`;
		});

	if (flags['cold-start']) {
		section('Scale to zero');
		await check('cold', 'idle stop → cold start', async () => {
			const fn = await api.get(`/projects/${slug}/function`);
			const idle = Number((fn.function ?? fn).idleStopSeconds ?? state.idleStopSeconds ?? 60);
			if (idle === 0) throw new Skip('idleStopSeconds is 0 (always on)');
			// Idle is measured from the access log; the agent checks on its own tick, so leave slack.
			const wait = idle + 45;
			console.log(dim(`    waiting ${wait} s with no traffic…`));
			await sleep(wait * 1000);
			const { task } = await api.post(`/projects/${slug}/function/invoke?wait=25`, { path: '/api/info' });
			expect(task.status === 'succeeded', `task ${task.status}`);
			expect(task.result.coldStart === true, `the host was still running after ${wait} s idle`);
			return `cold start served in ${task.result.durationMs} ms`;
		});
	}
} else if (!local) {
	section('Control plane');
	console.log(dim('  skipped: set YOAL_URL and YOAL_TOKEN to check the function view, test tools, queues, errors and logs'));
}

// ── Summary ──────────────────────────────────────────────────────────────────────────────────
const count = (status: Status) => results.filter((r) => r.status === status).length;
const failed = count('fail');
console.log(
	`\n${failed ? red('FAILED') : green('OK')}  ${count('pass')} pass · ${failed} fail · ${count('warn')} warn · ${count('skip')} skip`,
);
writeFileSync(resolve(EXAMPLE_DIR, '.suite-report.json'), `${JSON.stringify({ base, run, at: new Date().toISOString(), results }, null, 2)}\n`);
process.exit(failed ? 1 : 0);
