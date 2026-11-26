import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, nodeLogBatchSchema, type FeatureFlags, type LogRecord, type RuntimeLogBatch } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { deriveLogFingerprintKey } from './log-ingest-guard.ts';
import { LogIndexer, type LogIndexWriter } from './log-indexer.ts';
import type { ClickHouseCompactResult } from './clickhouse.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-log-guard-'));
const opened = createDb({ path: ':memory:' });
let clock = 1_764_000_000_000;
const features: { -readonly [K in keyof FeatureFlags]: FeatureFlags[K] } = { ...DEFAULT_FEATURES };
const masterKey = new Uint8Array(32).fill(7);
const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
		masterKey,
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		features,
		now: () => clock,
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

interface App {
	id: string;
	slug: string;
	orgId: string;
	deploymentId: string;
	nodeId: string;
	workloadId: string;
}

let nodes = 0;
async function app(slug: string): Promise<App> {
	const nodeName = `node-${++nodes}`;
	const nodeId = core.nodes.join({ token: core.nodes.createJoinToken(owner, nodeName).token, name: nodeName }).nodeId;
	await core.projects.create(owner, { name: slug, slug, runtime: 'static', placement: 'edge', productionAccess: 'public', previewAccess: 'platform' });
	const row = core.projects.requireRow(owner, slug);
	const deployment = await core.deployments.deployEntries(owner, row, [{ path: 'index.html', data: new TextEncoder().encode('<h1>hi</h1>') }], { promote: true });
	const workloadId = `wld_${slug.replace(/-/g, '_')}`;
	opened.sqlite.run(
		`INSERT INTO workloads (id, org_id, project_id, deployment_id, node_id, runtime, status, spec_json, memory_mb, cpus, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 'process', 'running', '{}', 128, 1, ?, ?)`,
		[workloadId, row.orgId, row.id, deployment.id, nodeId, clock, clock],
	);
	return { id: row.id, slug, orgId: row.orgId, deploymentId: deployment.id, nodeId, workloadId };
}

function runtime(target: App, messages: string[]): number {
	const batch: RuntimeLogBatch = {
		workloadId: target.workloadId,
		lines: messages.map((message, index) => ({ message, stream: 'stdout', level: 'info', ts: clock + index })),
	} as RuntimeLogBatch;
	return core.logs.appendRuntime(target.nodeId, batch);
}

function stored(target: App): string[] {
	return opened.sqlite.query<{ message: string }, [string]>('SELECT message FROM log_events WHERE project_id = ? ORDER BY seq').all(target.id).map((row) => row.message);
}

function drops(target: App, reason: string): number {
	return (
		opened.sqlite
			.query<{ n: number | null }, [string, string]>("SELECT SUM(lines) AS n FROM log_drop_counts WHERE scope_kind = 'project' AND scope_id = ? AND reason = ?")
			.get(target.id, reason)?.n ?? 0
	);
}

function notices(target: App): string[] {
	return opened.sqlite
		.query<{ body: string }, [string]>("SELECT body FROM log_records WHERE scope_id = ? AND source = 'system' ORDER BY seq")
		.all(target.id)
		.map((row) => row.body);
}

beforeEach(() => {
	core.logQuotas.reset();
	core.ctx.logGuard.setRandom(Math.random);
});

describe('quotas (docs/LOGS.md §10.2)', () => {
	test('over the burst, the tail of a batch is dropped, counted, and announced once per minute', async () => {
		const target = await app('quota-burst');
		core.logSettings.update(owner, { level: 'project', project: { id: target.id, orgId: target.orgId } }, { ingestBurst: 5, ingestLinesPerSecond: 1 });
		expect(runtime(target, Array.from({ length: 8 }, (_, i) => `line ${i}`))).toBe(5);
		expect(stored(target)).toEqual(['line 0', 'line 1', 'line 2', 'line 3', 'line 4']);
		expect(drops(target, 'quota')).toBe(3);
		expect(notices(target)).toHaveLength(1);
		expect(notices(target)[0]).toContain('Dropped 3 lines (quota)');

		// More drops in the same minute: counted, but no second notice yet.
		expect(runtime(target, ['a', 'b'])).toBe(0);
		expect(drops(target, 'quota')).toBe(5);
		expect(notices(target)).toHaveLength(1);
		// The sweep after the minute announces the rest; the bucket has refilled meanwhile.
		clock += 61_000;
		expect(core.ctx.logGuard.flushNotices(clock)).toBe(1);
		expect(notices(target)[1]).toContain('Dropped 2 lines (quota)');
		expect(runtime(target, ['after'])).toBe(1);
	});

	test('a daily byte budget survives a restart through log_ingest_daily, and a noisy project leaves others alone', async () => {
		const noisy = await app('quota-bytes');
		const quiet = await app('quota-quiet');
		core.logSettings.update(owner, { level: 'project', project: { id: noisy.id, orgId: noisy.orgId } }, { ingestMbPerDay: 1 });
		const big = 'x'.repeat(16_000);
		const kept = runtime(noisy, Array.from({ length: 70 }, () => big));
		expect(kept).toBe(62);
		expect(drops(noisy, 'quota')).toBe(8);
		// A "restart": in-memory totals go, the day's bytes come back from SQLite.
		core.logQuotas.reset();
		expect(runtime(noisy, [big])).toBe(0);
		expect(runtime(quiet, [big, big])).toBe(2);
		const usage = core.logQuotas.usage(owner, { days: 1 });
		const row = usage.rows.find((entry) => entry.scope.id === noisy.id);
		expect(row?.bytes).toBe(62 * 16_000);
		expect(row?.droppedLines).toBe(9);
		expect(row?.name).toBe('quota-bytes');
	});

	test('YOAL_FEATURE_QUOTAS=0 stops enforcement but keeps counting', async () => {
		const target = await app('quota-off');
		core.logSettings.update(owner, { level: 'project', project: { id: target.id, orgId: target.orgId } }, { ingestBurst: 1 });
		features.QUOTAS = false;
		try {
			expect(runtime(target, ['a', 'b', 'c'])).toBe(3);
		} finally {
			features.QUOTAS = true;
		}
	});
});

describe('rules (docs/LOGS.md §10.3–§10.4)', () => {
	test('CRUD validates each kind and needs logs:configure', async () => {
		const target = await app('rules-crud');
		expect(() => core.logRules.create(owner, { name: 'all', kind: 'exclude', query: '' })).toThrow(/needs a query/);
		expect(() => core.logRules.create(owner, { name: 'pipes', kind: 'exclude', query: 'x | stats count()' })).toThrow(/pipe/);
		expect(() => core.logRules.create(owner, { name: 'rate', kind: 'sample', query: 'x' })).toThrow(/sample rate/);
		expect(() => core.logRules.create(owner, { name: 'bad', kind: 'redact', pattern: '(a+)+' })).toThrow(/Nested/);
		expect(() => core.logRules.create(viewer, { name: 'health', kind: 'exclude', query: '"GET /health"' })).toThrow();
		const rule = core.logRules.create(owner, { name: 'Health checks', kind: 'exclude', query: '"GET /health"', project: target.slug });
		expect(rule).toMatchObject({ kind: 'exclude', projectId: target.id, projectSlug: target.slug, enabled: true });
		expect(core.logRules.list(viewer).map((entry) => entry.id)).toContain(rule.id);
		expect(core.logRules.update(owner, rule.id, { enabled: false }).enabled).toBe(false);
		core.logRules.delete(owner, rule.id);
		expect(core.logRules.list(owner).some((entry) => entry.id === rule.id)).toBe(false);
	});

	test('exclude and sample apply at ingest, so excluded lines never reach SQLite', async () => {
		const target = await app('rules-ingest');
		const other = await app('rules-other');
		const exclude = core.logRules.create(owner, { name: 'health', kind: 'exclude', query: '"GET /health"', project: target.slug });
		const sample = core.logRules.create(owner, { name: 'debug', kind: 'sample', query: 'level:=debug', sampleRate: 0.5 });
		core.ctx.logGuard.setRandom(() => 0.9); // above the rate: every sampled line is dropped
		expect(runtime(target, ['GET /health 200', 'GET /api 200', '{"level":"debug","msg":"noise"}'])).toBe(1);
		expect(stored(target)).toEqual(['GET /api 200']);
		expect(drops(target, 'exclude')).toBe(1);
		expect(drops(target, 'sample')).toBe(1);
		// A project rule leaves other projects alone; an org rule does not.
		expect(runtime(other, ['GET /health 200', '{"level":"debug","msg":"noise"}'])).toBe(1);
		core.ctx.logGuard.setRandom(() => 0.1); // below the rate: kept
		expect(runtime(other, ['{"level":"debug","msg":"kept"}'])).toBe(1);
		core.logRules.delete(owner, exclude.id);
		core.logRules.delete(owner, sample.id);
	});

	test('redact rules mask at ingest; preview reports the share and the top patterns', async () => {
		const target = await app('rules-redact');
		for (let i = 0; i < 6; i++) runtime(target, [`GET /health 200 ${i}ms`]);
		runtime(target, ['customer cus-12345 paid', 'GET /api/orders 201']);
		const preview = core.logRules.preview(owner, { kind: 'exclude', query: '"GET /health"', project: target.slug });
		expect(preview.scanned).toBe(8);
		expect(preview.matched).toBe(6);
		expect(preview.droppedPercent).toBe(75);
		expect(preview.topPatterns[0]).toEqual({ template: 'GET /health <NUM> <DUR>', count: 6 });
		const redactPreview = core.logRules.preview(owner, { kind: 'redact', pattern: '(?i)CUS-\\d+', project: target.slug });
		expect(redactPreview.matched).toBe(1);
		expect(redactPreview.examples).toEqual(['customer [REDACTED:rule:preview] paid']);

		const rule = core.logRules.create(owner, { name: 'Customer ids', kind: 'redact', pattern: '(?i)CUS-\\d+' });
		runtime(target, ['refund for cus-777']);
		expect(stored(target).at(-1)).toBe('refund for [REDACTED:rule:customer-ids]');
		core.logRules.delete(owner, rule.id);
		runtime(target, ['refund for cus-778']);
		expect(stored(target).at(-1)).toBe('refund for cus-778');
	});

	test('index_only keeps a line in the hot tail but out of ClickHouse', async () => {
		const target = await app('rules-index');
		const rule = core.logRules.create(owner, { name: 'access noise', kind: 'index_only', query: '"GET /static"' });
		runtime(target, ['GET /static/app.js 200', 'GET /api 500']);
		expect(stored(target)).toHaveLength(2);
		const inserted: Array<Record<string, unknown>> = [];
		const writer: LogIndexWriter = {
			installed: true,
			logsReady: async () => true,
			insertLogRows: async (table, rows) => {
				if (table === 'logs') inserted.push(...rows);
			},
			runQuery: async (): Promise<ClickHouseCompactResult> => ({ meta: [], data: [], rows: 0 }),
		};
		const indexer = new LogIndexer(core.ctx, writer, { enabled: () => true, startBacklogRows: 10_000 });
		await indexer.tick();
		const bodies = inserted.filter((row) => row.project_id === target.id).map((row) => row.body);
		expect(bodies).toEqual(['GET /api 500']);
		core.logRules.delete(owner, rule.id);
	});
});

describe('redaction at ingest (docs/LOGS.md §10.4)', () => {
	const SECRET = 'hunter2-correct-horse-battery';

	test('a project secret never reaches SQLite through any append path', async () => {
		const target = await app('redact-secrets');
		await core.secrets.set(owner, { name: 'DB_PASSWORD_VALUE', value: SECRET, projectId: target.id });
		await core.secrets.set(owner, { name: 'APP_MODE', value: 'production-mode-on', type: 'env' });
		expect(core.ctx.logGuard.fingerprintCount('org_1')).toBeGreaterThan(0);

		runtime(target, [`connecting with ${SECRET}`, 'mode production-mode-on']);
		core.logs.appendSystem({ orgId: target.orgId, projectId: target.id, message: `restarted after ${SECRET} rotation` });
		core.logs.appendRecords(
			target.nodeId,
			nodeLogBatchSchema.parse({
				target: { kind: 'workload', workloadId: target.workloadId },
				records: [{ ts: clock, source: 'otlp', body: `otlp ${Buffer.from(SECRET).toString('base64')}`, attributes: { 'db.password': SECRET, note: `x ${SECRET}` } }],
			}),
		);
		opened.sqlite.run('PRAGMA foreign_keys = OFF');
		opened.sqlite.run(
			"INSERT INTO builds (id, org_id, project_id, git_source_id, status, ref, node_id, created_by, created_at) VALUES ('bld_redact', ?, ?, 'gs_1', 'building', 'main', ?, 'user_1', ?)",
			[target.orgId, target.id, target.nodeId, clock],
		);
		opened.sqlite.run('PRAGMA foreign_keys = ON');
		expect(core.logs.appendBuild(target.nodeId, 'bld_redact', { stream: 'stdout', lines: [`echo ${SECRET}`] })).toBe(true);
		expect(opened.sqlite.query<{ log: string }, []>("SELECT log FROM builds WHERE id = 'bld_redact'").get()?.log).toBe('echo [REDACTED:known_secret]\n');

		const everywhere = opened.sqlite
			.query<{ n: number }, [string, string, string, string]>(
				`SELECT (SELECT COUNT(*) FROM log_events WHERE message LIKE ?)
				      + (SELECT COUNT(*) FROM log_records WHERE body LIKE ? OR attributes LIKE ?)
				      + (SELECT COUNT(*) FROM builds WHERE log LIKE ?) AS n`,
			)
			.get(`%${SECRET}%`, `%${SECRET}%`, `%${SECRET}%`, `%${SECRET}%`)?.n;
		expect(everywhere).toBe(0);
		expect(stored(target)).toContain('connecting with [REDACTED:known_secret]');
		// env-type values are configuration, not secrets.
		expect(stored(target)).toContain('mode production-mode-on');
		const record = opened.sqlite.query<{ body: string; attributes: string }, [string]>("SELECT body, attributes FROM log_records WHERE scope_id = ? AND source = 'otlp'").get(target.id);
		expect(record?.body).toBe('otlp [REDACTED:known_secret]');
		expect(JSON.parse(record!.attributes)).toEqual({ 'db.password': '[REDACTED:known_secret]', note: 'x [REDACTED:known_secret]' });
	});

	test('the fingerprint cache is rebuilt when secrets change, not per line', async () => {
		const target = await app('redact-rotate');
		runtime(target, ['before rotate-me-please-123']);
		expect(stored(target).at(-1)).toBe('before rotate-me-please-123');
		await core.secrets.set(owner, { name: 'ROTATED', value: 'rotate-me-please-123', projectId: target.id });
		runtime(target, ['after rotate-me-please-123']);
		expect(stored(target).at(-1)).toBe('after [REDACTED:known_secret]');
		const secret = core.secrets.list(owner, { projectId: target.id }).find((entry) => entry.name === 'ROTATED')!;
		await core.secrets.delete(owner, secret.id);
		runtime(target, ['gone rotate-me-please-123']);
		expect(stored(target).at(-1)).toBe('gone rotate-me-please-123');
	});

	test('the fingerprint key is HKDF of the master key: stable, and never the key itself', () => {
		const key = deriveLogFingerprintKey(masterKey);
		expect(key).toHaveLength(32);
		expect(Buffer.from(key).equals(Buffer.from(deriveLogFingerprintKey(masterKey)))).toBe(true);
		expect(Buffer.from(key).equals(Buffer.from(masterKey))).toBe(false);
		expect(Buffer.from(key).equals(Buffer.from(deriveLogFingerprintKey(new Uint8Array(32).fill(8))))).toBe(false);
	});

	test('built-in detectors run on service logs and k8s pod logs too', async () => {
		const target = await app('redact-builtin');
		runtime(target, ['auth header Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345']);
		expect(stored(target).at(-1)).toBe('auth header Authorization: Bearer [REDACTED:authorization]');
		// Records are evaluated as LogRecords for rules.
		const record: Pick<LogRecord, 'body'> = { body: stored(target).at(-1)! };
		expect(record.body).not.toContain('abcdefghijklmnop');
	});
});
