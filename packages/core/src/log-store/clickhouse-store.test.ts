import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { LogPipeStage, LogQueryNode } from '@yoal/contracts';
import { createDb } from '@yoal/db';
import { ClickHouseError, type ClickHouseCompactResult } from '../clickhouse.ts';
import { ValidationError } from '../errors.ts';
import { LogIndexer } from '../log-indexer.ts';
import type { TelemetryStore } from '../telemetry.ts';
import { disposeTelemetryStore, hasClickHouse, testTelemetryStore } from '../test-clickhouse.ts';
import { decodeSearchCursor } from './clickhouse-compiler.ts';
import { ClickHouseLogStore, recordFromRow, type ClickHouseLogRunner } from './clickhouse-store.ts';
import type { LogReadBoundary, LogStoreRead } from './types.ts';

const boundary: LogReadBoundary = { orgId: 'org_1', scopes: [{ kind: 'project', id: 'prj_1' }], crossOrg: false };

function row(id: string, ts: number, overrides: Partial<Record<number, unknown>> = {}): unknown[] {
	const base: unknown[] = [
		id,
		ts,
		0,
		'org_1',
		'project',
		'prj_1',
		'deployment:dep_1',
		'runtime',
		'stdout',
		17,
		'boom',
		{ 'http.status': '500' },
		{ 'service.name': 'api' },
		'',
		'',
		'req_1',
		'',
		'prj_1',
		'dep_1',
		'',
		'',
		'node_1',
		-1,
	];
	for (const [index, value] of Object.entries(overrides)) base[Number(index)] = value;
	return base;
}

class FakeRunner implements ClickHouseLogRunner {
	logsTextIndex = 'text' as const;
	ready = true;
	calls: Array<{ sql: string; params: unknown }> = [];
	results: unknown[][][] = [];
	error: Error | null = null;

	async logsReady(): Promise<boolean> {
		return this.ready;
	}

	async runQuery(sql: string, options: { params?: unknown }): Promise<ClickHouseCompactResult> {
		this.calls.push({ sql, params: options.params });
		if (this.error) throw this.error;
		const data = this.results.shift() ?? [];
		return { meta: [], data, rows: data.length };
	}
}

const read = (filter: LogQueryNode | null = null, pipes: LogPipeStage[] = [], scope = boundary): LogStoreRead => ({
	boundary: scope,
	ast: { filter, pipes },
	from: 0,
	to: 600_000,
});

describe('ClickHouseLogStore', () => {
	test('maps rows to records and pages by keyset cursor', async () => {
		const runner = new FakeRunner();
		runner.results.push([row('le:3', 3_000), row('le:2', 2_000), row('le:1', 1_000)]);
		const store = new ClickHouseLogStore(runner, { now: () => 0 });
		const result = await store.search(read(), { limit: 2, order: 'desc' });
		expect(result.records.map((record) => record.id)).toEqual(['le:3', 'le:2']);
		expect(decodeSearchCursor(result.cursor.older!)).toEqual({ ts: 2_000, id: 'le:2' });
		expect(decodeSearchCursor(result.cursor.newer!)).toEqual({ ts: 3_000, id: 'le:3' });
		expect(result.records[0]).toMatchObject({
			orgId: 'org_1',
			scope: { kind: 'project', id: 'prj_1' },
			scopeName: 'api',
			severity: 'error',
			attributes: { 'http.status': '500' },
			requestId: 'req_1',
			traceId: null,
			patternId: null,
			observedTs: null,
			replica: null,
			channel: 'stdout',
		});
		// The last page has no older cursor.
		runner.results.push([row('le:1', 1_000)]);
		const last = await store.search(read(), { limit: 2, order: 'desc', cursor: result.cursor.older! });
		expect(last.cursor.older).toBeNull();
		expect(runner.calls[1]!.sql).toContain('(ts, id) <');
	});

	test('an empty boundary answers nothing without asking ClickHouse', async () => {
		const runner = new FakeRunner();
		const store = new ClickHouseLogStore(runner);
		const none = { orgId: 'org_1', scopes: [], crossOrg: false };
		expect((await store.search(read(null, [], none), { limit: 10, order: 'desc' })).records).toEqual([]);
		expect((await store.table(read(null, [{ type: 'patterns' }], none))).rows).toEqual([]);
		expect((await store.histogram(read(null, [], none), { buckets: 10 })).total).toBe(0);
		expect((await store.fields(read(null, [], none), { topValues: 5 })).fields).toEqual([]);
		expect(await store.get(none, 'le:1')).toBeNull();
		expect(runner.calls).toHaveLength(0);
	});

	test('a query the server rejects is a validation error; an outage is not', async () => {
		const runner = new FakeRunner();
		const store = new ClickHouseLogStore(runner);
		runner.error = new ClickHouseError('Cannot compile regex', 427, 400);
		await expect(store.search(read(), { limit: 1, order: 'desc' })).rejects.toBeInstanceOf(ValidationError);
		runner.error = new ClickHouseError('Server overloaded', 202, 503);
		await expect(store.search(read(), { limit: 1, order: 'desc' })).rejects.toBeInstanceOf(ClickHouseError);
	});

	test('healthy follows the kill switch and the index', async () => {
		const runner = new FakeRunner();
		let enabled = true;
		const store = new ClickHouseLogStore(runner, { enabled: () => enabled });
		expect(await store.healthy()).toBe(true);
		enabled = false;
		expect(await store.healthy()).toBe(false);
		enabled = true;
		runner.ready = false;
		expect(await store.healthy()).toBe(false);
	});

	test('histogram fills empty buckets and splits by severity', async () => {
		const runner = new FakeRunner();
		runner.results.push([
			[60_000, 'error', 2],
			[60_000, 'info', 5],
			[180_000, 'warn', 1],
		]);
		const store = new ClickHouseLogStore(runner);
		const histogram = await store.histogram(read(), { buckets: 10 });
		expect(histogram.intervalMs).toBe(60_000);
		expect(histogram.buckets).toHaveLength(11);
		expect(histogram.buckets[1]).toEqual({ ts: 60_000, counts: { error: 2, info: 5 }, total: 7 });
		expect(histogram.buckets[2]).toEqual({ ts: 120_000, counts: {}, total: 0 });
		expect(histogram.total).toBe(8);
	});

	test('table drops the hidden sample id and sparkline into sampleIds and sparklines', async () => {
		const runner = new FakeRunner();
		runner.results.push([['a1', 'GET <PATH>', 9, 1, 2, 'le:7', ['4', '0', '5']]]);
		const table = await new ClickHouseLogStore(runner).table(read(null, [{ type: 'patterns' }]));
		expect(table.rows).toEqual([['a1', 'GET <PATH>', 9, 1, 2]]);
		expect(table.sampleIds).toEqual(['le:7']);
		expect(table.sparklines).toEqual([[4, 0, 5]]);
	});

	test('context returns lines around the anchor in time order', async () => {
		const runner = new FakeRunner();
		runner.results.push([row('le:5', 5_000)], [row('le:4', 4_000), row('le:3', 3_000)], [row('le:6', 6_000)]);
		const context = await new ClickHouseLogStore(runner).context(boundary, { id: 'le:5', before: 2, after: 2 });
		expect(context.anchor?.id).toBe('le:5');
		expect(context.before.map((record) => record.id)).toEqual(['le:3', 'le:4']);
		expect(context.after.map((record) => record.id)).toEqual(['le:6']);
		expect(runner.calls[1]!.sql).toContain('stream = ');
	});

	test('warns index_behind when the indexer lags and the read reaches its gap', async () => {
		const runner = new FakeRunner();
		let lag: number | null = 5 * 60_000;
		const store = new ClickHouseLogStore(runner, { now: () => 600_000, indexLagMs: () => lag });
		const result = await store.search(read(), { limit: 1, order: 'desc' });
		expect(result.warnings).toEqual([{ code: 'index_behind', message: 'The search index is 5 minutes behind; the newest lines may be missing.' }]);
		// A window that ends before the gap is complete.
		expect((await store.search({ ...read(), to: 200_000 }, { limit: 1, order: 'desc' })).warnings).toEqual([]);
		lag = 10_000;
		expect((await store.search(read(), { limit: 1, order: 'desc' })).warnings).toEqual([]);
		lag = null;
		expect((await store.histogram(read(), { buckets: 10 })).warnings).toEqual([]);
	});

	test('recordFromRow maps empty strings and sentinels to null', () => {
		const record = recordFromRow(row('lr:1', 10, { 6: '', 8: '', 22: 2, 2: 11 }));
		expect(record).toMatchObject({ stream: null, channel: null, replica: 2, observedTs: 11 });
	});
});

// ------------------------------------------------------------------------------- real server

describe.skipIf(!hasClickHouse)('ClickHouseLogStore against ClickHouse', () => {
	let telemetry: TelemetryStore;
	let sqlite: Database;
	let store: ClickHouseLogStore;
	const NOW = Date.now();
	const scope = boundary;
	const r = (filter: LogQueryNode | null, pipes: LogPipeStage[] = [], b = scope): LogStoreRead => ({
		boundary: b,
		ast: { filter, pipes },
		from: NOW - 3_600_000,
		to: NOW + 1_000,
	});
	const ids = async (filter: LogQueryNode | null) =>
		(await store.search(r(filter), { limit: 100, order: 'asc' })).records.map((record) => record.id);

	beforeAll(async () => {
		telemetry = testTelemetryStore();
		expect(await telemetry.logsReady()).toBe(true);
		sqlite = createDb({ path: ':memory:' }).sqlite;
		sqlite.run('PRAGMA foreign_keys = OFF');
		sqlite.run(`INSERT INTO projects (id, org_id, slug, name, created_by, created_at, updated_at) VALUES ('prj_1', 'org_1', 'api', 'API', 'u', 1, 1)`);
		const lines: Array<[string, string, string]> = [
			['org_1', 'prj_1', '{"level":"error","msg":"upstream Timeout after 30000ms","http":{"status":502,"route":"/v1/orders"},"request_id":"r1"}'],
			['org_1', 'prj_1', 'GET /health 200 3ms'],
			['org_1', 'prj_1', 'level=warn msg="retrying payment-svc" attempt=3 duration_ms=120'],
			['org_1', 'prj_1', 'connection reset by peer'],
			['org_1', 'prj_1', 'UpstreamTimeout is one token'],
			['org_2', 'prj_2', 'upstream timeout in another org'],
		];
		lines.forEach(([org, project, message], index) =>
			sqlite.run(
				`INSERT INTO log_events (org_id, project_id, deployment_id, node_id, source, stream, level, message, ts) VALUES (?, ?, 'dep_1', 'node_1', 'runtime', 'stdout', 'info', ?, ?)`,
				[org, project, message, NOW - (lines.length - index) * 1_000],
			),
		);
		const indexer = new LogIndexer({ sqlite, config: { features: {} } as never, now: () => Date.now() }, telemetry, {
			miner: { patternFor: (_scope, body) => ({ id: body.startsWith('GET') ? 'aa' : 'bb', template: body.startsWith('GET') ? 'GET <PATH> <NUM> <DUR>' : '<*>' }) },
		});
		expect((await indexer.tick()).indexed).toBe(6);
		// A replay of the same range is dropped by its dedup token.
		sqlite.run(`UPDATE log_index_cursors SET cursor = 0 WHERE source_table = 'log_events'`);
		await indexer.tick();
		store = new ClickHouseLogStore(telemetry);
	});

	afterAll(async () => {
		await disposeTelemetryStore(telemetry);
	});

	test('the replayed batch was deduplicated', async () => {
		expect(await ids(null)).toEqual(['le:1', 'le:2', 'le:3', 'le:4', 'le:5']);
	});

	test('the body index serves token and substring search, case-insensitively', async () => {
		// `text` on 26.x with the lower() preprocessor; `tokenbf` where the server rejects it.
		expect(['text', 'tokenbf']).toContain(telemetry.logsTextIndex!);
		expect(await ids({ type: 'text', value: 'TIMEOUT', phrase: false })).toEqual(['le:1']);
		expect(await ids({ type: 'text', value: 'connection RESET', phrase: true })).toEqual(['le:4']);
		expect(await ids({ type: 'text', value: 'upstreamtimeout', phrase: true })).toEqual(['le:5']);
	});

	test('fields, attributes, level and negation', async () => {
		expect(await ids({ type: 'field', field: { kind: 'builtin', name: 'level' }, op: 'gte', value: 'warn' })).toEqual(['le:1', 'le:3']);
		expect(await ids({ type: 'field', field: { kind: 'attribute', key: 'http.status' }, op: 'gte', value: 500 })).toEqual(['le:1']);
		expect(await ids({ type: 'not', child: { type: 'field', field: { kind: 'attribute', key: 'http.status' }, op: 'gte', value: 500 } })).toEqual([
			'le:2',
			'le:3',
			'le:4',
			'le:5',
		]);
		expect(await ids({ type: 'field', field: { kind: 'attribute', key: 'http.route' }, op: 'wildcard', value: '/v1/*' })).toEqual(['le:1']);
		expect(await ids({ type: 'field', field: { kind: 'builtin', name: 'service' }, op: 'eq', value: 'API' })).toHaveLength(5);
		expect(await ids({ type: 'field', field: { kind: 'builtin', name: 'project' }, op: 'eq', value: 'api' })).toHaveLength(5);
		expect(await ids({ type: 'field', field: { kind: 'builtin', name: 'request' }, op: 'eq', value: 'r1' })).toEqual(['le:1']);
		expect(await ids({ type: 'field', field: { kind: 'builtin', name: 'body' }, op: 'regex', value: 'retry\\w+' })).toEqual(['le:3']);
	});

	test('another org is invisible, even with the same query', async () => {
		const other = { orgId: 'org_2', scopes: [{ kind: 'project' as const, id: 'prj_1' }], crossOrg: false };
		expect((await store.search(r(null, [], other), { limit: 10, order: 'desc' })).records).toEqual([]);
		expect(await store.get(other, 'le:1')).toBeNull();
		const mine = { orgId: 'org_1', scopes: [{ kind: 'project' as const, id: 'prj_2' }], crossOrg: false };
		expect((await store.search(r(null, [], mine), { limit: 10, order: 'desc' })).records).toEqual([]);
	});

	test('stats, patterns, dedup and fields run', async () => {
		const stats = await store.table(
			r(null, [
				{ type: 'stats', aggregations: [{ fn: 'count', alias: 'count' }, { fn: 'max', field: { kind: 'attribute', key: 'duration_ms' }, alias: 'max' }], by: [{ type: 'field', field: { kind: 'builtin', name: 'level' }, alias: 'level' }] },
				{ type: 'sort', key: 'level', direction: 'asc' },
			]),
		);
		expect(stats.rows).toEqual([
			['error', 1, null],
			['info', 3, null],
			['warn', 1, 120],
		]);
		const patterns = await store.table(r(null, [{ type: 'patterns' }]));
		expect(patterns.rows.map((row) => [row[0], row[1], row[2]])).toEqual([
			['bb', '<*>', 4],
			['aa', 'GET <PATH> <NUM> <DUR>', 1],
		]);
		expect(patterns.sampleIds).toEqual(['le:5', 'le:2']);
		const dedup = await store.table(r(null, [{ type: 'dedup', field: { kind: 'builtin', name: 'level' } }]));
		expect(dedup.rows.map((row) => [row[1], row[4]])).toEqual([
			['info', 3],
			['warn', 1],
			['error', 1],
		]);
		const fields = await store.table(
			r(null, [{ type: 'sort', key: 'ts', direction: 'asc' }, { type: 'limit', count: 1 }, { type: 'fields', fields: [{ kind: 'attribute', key: 'http.status' }] }]),
		);
		expect(fields.rows).toEqual([['502']]);
	});

	test('histogram, facets and context', async () => {
		const histogram = await store.histogram(r(null), { buckets: 60 });
		expect(histogram.total).toBe(5);
		const facets = await store.fields(r(null), { topValues: 3 });
		expect(facets.total).toBe(5);
		expect(facets.fields.find((field) => field.name === 'level')?.topValues[0]).toEqual({ value: 'info', count: 3 });
		expect(facets.fields.find((field) => field.name === '@http.status')).toMatchObject({ kind: 'attribute', type: 'number', present: 1 });
		const context = await store.context(scope, { id: 'le:3', before: 1, after: 1 });
		expect(context.before.map((record) => record.id)).toEqual(['le:2']);
		expect(context.after.map((record) => record.id)).toEqual(['le:4']);
	});
});

describe.skipIf(!hasClickHouse)('sentinel-org records in ClickHouse', () => {
	let telemetry: TelemetryStore;
	const NOW = Date.now();
	const scopes = [
		{ kind: 'platform' as const, id: 'node_1' },
		{ kind: 'edge' as const, id: 'node_1' },
	];
	const read = (b: LogReadBoundary): LogStoreRead => ({ boundary: b, ast: { filter: null, pipes: [] }, from: NOW - 60_000, to: NOW + 1_000 });

	beforeAll(async () => {
		telemetry = testTelemetryStore();
		expect(await telemetry.logsReady()).toBe(true);
		const { sqlite } = createDb({ path: ':memory:' });
		// What `appendRecords` writes for a platform unit and for a host no project serves.
		for (const [kind, stream, body] of [
			['platform', 'unit:yoal-agent', 'agent restarted'],
			['edge', 'site:stray.example', 'GET / 404 1ms'],
		] as const)
			sqlite.run(
				`INSERT INTO log_records (org_id, scope_kind, scope_id, stream, source, severity_number, body, ts, observed_ts)
				 VALUES ('platform', ?, 'node_1', ?, 'platform', 9, ?, ?, ?)`,
				[kind, stream, body, NOW - 1_000, NOW - 1_000],
			);
		const indexer = new LogIndexer({ sqlite, config: { features: {} } as never, now: () => Date.now() }, telemetry, {});
		expect((await indexer.tick()).indexed).toBe(2);
	});

	afterAll(async () => {
		await disposeTelemetryStore(telemetry);
	});

	test('a cross-org (platform admin) boundary reads them; a tenant boundary never does', async () => {
		const store = new ClickHouseLogStore(telemetry);
		const admin = await store.search(read({ orgId: 'org_1', scopes, crossOrg: true }), { limit: 10, order: 'asc' });
		expect(admin.records.map((record) => [record.scope.kind, record.orgId])).toEqual([
			['platform', 'platform'],
			['edge', 'platform'],
		]);
		expect(await store.get({ orgId: 'org_1', scopes, crossOrg: true }, admin.records[1]!.id)).not.toBeNull();
		const tenant = { orgId: 'org_1', scopes, crossOrg: false };
		expect((await store.search(read(tenant), { limit: 10, order: 'asc' })).records).toEqual([]);
		expect(await store.get(tenant, admin.records[0]!.id)).toBeNull();
		expect((await store.histogram(read(tenant), { buckets: 10 })).total).toBe(0);
	});
});
