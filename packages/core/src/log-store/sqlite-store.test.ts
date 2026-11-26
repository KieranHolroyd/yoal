import { describe, expect, test } from 'bun:test';
import type { LogQueryAst, LogQueryNode } from '@yoal/contracts';
import { seedLogFixtures, T0 } from './sqlite-fixtures.test-support.ts';
import {
	decodeLogCursor,
	decodeTailCursor,
	encodeLogCursor,
	encodeTailCursor,
	boundedTailResume,
	InvalidLogCursorError,
	lookupLogScopeNames,
	pickHistogramInterval,
	SqliteLogStore,
} from './sqlite-store.ts';
import { LogStoreUnsupported, type LogReadBoundary, type LogStoreRead } from './types.ts';

const sqlite = seedLogFixtures();
const store = new SqliteLogStore(sqlite);

/** Everything org_1 has: both projects, the database, the pipeline repo. */
const org1: LogReadBoundary = {
	orgId: 'org_1',
	scopes: [
		{ kind: 'project', id: 'prj_a' },
		{ kind: 'project', id: 'prj_b' },
		{ kind: 'database', id: 'db_1' },
		{ kind: 'pipeline', id: 'repo_1' },
	],
	crossOrg: false,
};
const org2: LogReadBoundary = { orgId: 'org_2', scopes: [{ kind: 'project', id: 'prj_x' }], crossOrg: false };

function read(boundary: LogReadBoundary, filter: LogQueryNode | null = null, pipes: LogQueryAst['pipes'] = []): LogStoreRead {
	return { boundary, ast: { filter, pipes }, from: T0, to: T0 + 10_000 };
}

describe('SqliteLogStore.search', () => {
	test('newest first, inside the boundary and time range only', async () => {
		const result = await store.search(read(org1), { limit: 50, order: 'desc' });
		expect(result.engine).toBe('sqlite');
		expect(result.records.map((record) => record.id)).toEqual(['le:5', 'lr:2', 'le:4', 'pll:1', 'le:3', 'sle:1', 'le:2', 'le:1']);
		expect(result.records.every((record) => record.orgId === 'org_1')).toBe(true);
		const narrow = await store.search({ ...read(org1), from: T0 + 2_000, to: T0 + 3_000 }, { limit: 50, order: 'desc' });
		expect(narrow.records.map((record) => record.id)).toEqual(['le:3', 'sle:1', 'le:2']);
	});

	test('maps rows onto LogRecord (replica prefix, parsed fields, attributes)', async () => {
		const result = await store.search(read(org1, { type: 'text', value: 'upstream', phrase: false }), { limit: 5, order: 'desc' });
		expect(result.records[0]).toMatchObject({
			id: 'le:2',
			body: 'upstream timeout after 30000ms',
			replica: 1,
			severity: 'error',
			scope: { kind: 'project', id: 'prj_a' },
			stream: 'deployment:dep_1',
		});
	});

	test('pages back with `older` and forward with `newer`, without gaps or repeats', async () => {
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 10; page += 1) {
			const result = await store.search(read(org1), { limit: 3, order: 'desc', cursor });
			seen.push(...result.records.map((record) => record.id));
			if (!result.cursor.older) break;
			cursor = result.cursor.older;
		}
		expect(seen).toEqual(['le:5', 'lr:2', 'le:4', 'pll:1', 'le:3', 'sle:1', 'le:2', 'le:1']);

		const oldest = await store.search(read(org1), { limit: 2, order: 'asc' });
		expect(oldest.records.map((record) => record.id)).toEqual(['le:1', 'le:2']);
		const forward = await store.search(read(org1), { limit: 2, order: 'asc', cursor: oldest.cursor.newer! });
		expect(forward.records.map((record) => record.id)).toEqual(['sle:1', 'le:3']);
		const tail = await store.search(read(org1), { limit: 50, order: 'asc', cursor: encodeLogCursor({ ts: T0 + 5_000, tag: 'le', seq: 5 }) });
		expect(tail.records).toEqual([]);
		// An empty forward page keeps the caller's cursor so it can poll again.
		expect(tail.cursor.newer).toBe(encodeLogCursor({ ts: T0 + 5_000, tag: 'le', seq: 5 }));
	});

	test('org isolation: another org never sees org_1 rows, even naming its scopes', async () => {
		const result = await store.search(
			read({ orgId: 'org_2', scopes: [...org2.scopes, ...org1.scopes], crossOrg: false }),
			{ limit: 50, order: 'desc' },
		);
		expect(result.records.map((record) => record.id)).toEqual(['le:6']);
	});

	test('platform rows need a cross-org boundary', async () => {
		const platform = { kind: 'platform' as const, id: 'node_1' };
		const tenant = await store.search(read({ orgId: 'org_1', scopes: [platform], crossOrg: false }), { limit: 5, order: 'desc' });
		expect(tenant.records).toEqual([]);
		const admin = await store.search(read({ orgId: 'org_1', scopes: [platform], crossOrg: true }), { limit: 5, order: 'desc' });
		expect(admin.records.map((record) => record.id)).toEqual(['lr:1']);
	});

	test('cursors are opaque and validated', () => {
		const cursor = encodeLogCursor({ ts: 5, tag: 'sle', seq: 9 });
		expect(decodeLogCursor(cursor)).toEqual({ ts: 5, tag: 'sle', seq: 9 });
		expect(() => decodeLogCursor('p.bm9wZQ')).toThrow(InvalidLogCursorError);
		expect(() => decodeLogCursor(`p.${Buffer.from('[1,"zz",1]').toString('base64url')}`)).toThrow(InvalidLogCursorError);
		expect(() => decodeLogCursor('garbage')).toThrow(InvalidLogCursorError);
		expect(decodeTailCursor(encodeTailCursor({ le: 4, sle: 0, lr: 2 }))).toEqual({ le: 4, lr: 2 });
		expect(decodeTailCursor('t.bm9wZQ')).toBeNull();
		expect(decodeTailCursor(cursor)).toBeNull();
	});
});

describe('SqliteLogStore.get and context', () => {
	test('get answers inside the boundary only', async () => {
		expect((await store.get(org1, 'le:2'))?.id).toBe('le:2');
		expect(await store.get(org1, 'le:6')).toBeNull();
		expect(await store.get(org2, 'le:2')).toBeNull();
		expect(await store.get(org1, 'ch:1')).toBeNull();
	});

	test('context reads the same stream around the anchor', async () => {
		const result = await store.context(org1, { id: 'le:2', before: 5, after: 5 });
		expect(result.anchor?.id).toBe('le:2');
		expect(result.before.map((record) => record.id)).toEqual(['le:1']);
		expect(result.after.map((record) => record.id)).toEqual(['le:3']);
		const outside = await store.context(org2, { id: 'le:2', before: 5, after: 5 });
		expect(outside).toMatchObject({ anchor: null, before: [], after: [] });
	});
});

describe('SqliteLogStore aggregates', () => {
	test('histogram buckets by severity with empty buckets included', async () => {
		const result = await store.histogram(read(org1), { buckets: 10 });
		expect(result.intervalMs).toBe(1_000);
		expect(result.total).toBe(8);
		expect(result.buckets.length).toBe(11);
		const second = result.buckets.find((bucket) => bucket.ts === T0 + 2_000)!;
		expect(second.counts).toEqual({ error: 1, warn: 1 });
		expect(second.total).toBe(2);
		expect(result.buckets.find((bucket) => bucket.ts === T0 + 9_000)!.total).toBe(0);
		expect(pickHistogramInterval(0, 3_600_000, 60)).toBe(60_000);
	});

	test('fields gives top values for built-ins and flags the rest', async () => {
		const result = await store.fields(read(org1), { fields: ['level', 'service', 'node', '@http.status'], topValues: 3 });
		expect(result.total).toBe(8);
		const level = result.fields.find((field) => field.name === 'level')!;
		expect(level.topValues[0]).toEqual({ value: 'info', count: 3 });
		const service = result.fields.find((field) => field.name === 'service')!;
		expect(service.topValues[0]).toEqual({ value: 'api', count: 5 });
		const node = result.fields.find((field) => field.name === 'node')!;
		expect(node.present).toBe(6);
		expect(result.warnings[0]?.code).toBe('needs_clickhouse');
	});

	test('table answers `stats count() by bin(), level` with sort and limit', async () => {
		const result = await store.table(
			read(org1, null, [
				{
					type: 'stats',
					aggregations: [{ fn: 'count', alias: 'count' }],
					by: [
						{ type: 'bin', intervalMs: 5_000, alias: 't' },
						{ type: 'field', field: { kind: 'builtin', name: 'level' }, alias: 'level' },
					],
				},
				{ type: 'sort', key: 'count', direction: 'desc' },
				{ type: 'limit', count: 2 },
			]),
		);
		expect(result.columns).toEqual([
			{ name: 't', type: 'time' },
			{ name: 'level', type: 'string' },
			{ name: 'count', type: 'number' },
		]);
		expect(result.rows).toEqual([
			[T0, 'warn', 3],
			// Ties fall back to the group columns, so the answer is stable.
			[T0, 'error', 2],
		]);
	});

	test('everything else in a table query needs ClickHouse', async () => {
		const cases: LogQueryAst['pipes'][] = [
			[{ type: 'patterns' }],
			[{ type: 'dedup', field: { kind: 'builtin', name: 'body' } }],
			[{ type: 'fields', fields: [{ kind: 'builtin', name: 'level' }] }],
			[{ type: 'stats', aggregations: [{ fn: 'p95', field: { kind: 'attribute', key: 'duration_ms' }, alias: 'p95' }], by: [] }],
			[{ type: 'stats', aggregations: [{ fn: 'count', alias: 'count' }], by: [{ type: 'field', field: { kind: 'attribute', key: 'x' }, alias: 'x' }] }],
			[{ type: 'limit', count: 5 }],
		];
		for (const pipes of cases) await expect(store.table(read(org1, null, pipes))).rejects.toBeInstanceOf(LogStoreUnsupported);
	});
});

describe('SqliteLogStore live-tail helpers', () => {
	test('maxSeqVector and tailCatchUp read exactly the rows between two vectors', () => {
		const vector = store.maxSeqVector();
		expect(vector).toMatchObject({ le: 6, sle: 1, pll: 1, lr: 2 });
		const all = store.tailCatchUp(read(org1), { le: 2 }, vector, 100, { count: true });
		expect(all.records.map((record) => record.id)).toEqual(['sle:1', 'le:3', 'pll:1', 'le:4', 'lr:2', 'le:5']);
		expect(all.total).toBe(6);
		const newest = store.tailCatchUp(read(org1), { le: 2 }, vector, 2, { count: true });
		expect(newest.records.map((record) => record.id)).toEqual(['lr:2', 'le:5']);
		expect(newest.total).toBe(6);
		expect(store.tailCatchUp(read(org1), vector, vector, 100).records).toEqual([]);
	});

	test('scope names are looked up per kind', () => {
		const names = lookupLogScopeNames(sqlite, [
			{ kind: 'project', id: 'prj_a' },
			{ kind: 'database', id: 'db_1' },
			{ kind: 'platform', id: 'node_2' },
			{ kind: 'edge', id: 'x' },
		]);
		expect(Object.fromEntries(names)).toEqual({ 'project:prj_a': 'api', 'database:db_1': 'main-db', 'platform:node_2': 'edge-b' });
	});
});

describe('lite-mode scan bounds', () => {
	test('reads on the hot-tail tables start no earlier than the hot window, with a warning', async () => {
		// The clock sits 5 s after the fixtures start; a 3 s window keeps T0+2 s onwards.
		const clamped = new SqliteLogStore(sqlite, undefined, { now: () => T0 + 5_000, hotWindowMs: () => 3_000 });
		const result = await clamped.search(read(org1), { limit: 50, order: 'desc' });
		// The pipeline line (own retention) is never clamped; hot-tail rows before T0+2 s are.
		expect(result.records.map((record) => record.id)).toEqual(['le:5', 'lr:2', 'le:4', 'pll:1', 'le:3', 'sle:1', 'le:2']);
		expect(result.warnings).toEqual([expect.objectContaining({ code: 'partial' })]);
		expect((await clamped.histogram(read(org1), { buckets: 10 })).total).toBe(7);
		expect((await clamped.fields(read(org1), { fields: ['level'], topValues: 10 })).total).toBe(7);
		// A read already inside the window is untouched and unwarned.
		const inside = await clamped.search({ ...read(org1), from: T0 + 3_000 }, { limit: 50, order: 'desc' });
		expect(inside.warnings).toEqual([]);
	});

	test('fields summarises every built-in in one scan', async () => {
		const prepared: string[] = [];
		const spy = new Proxy(sqlite, {
			get(target, key) {
				if (key === 'prepare')
					return (sql: string) => {
						prepared.push(sql);
						return target.prepare(sql);
					};
				const value = Reflect.get(target, key, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const counted = new SqliteLogStore(spy);
		const result = await counted.fields(read(org1), { topValues: 10 });
		expect(result.total).toBe(8);
		expect(result.fields.find((field) => field.name === 'level')?.topValues[0]).toEqual({ value: 'info', count: 3 });
		expect(result.fields.find((field) => field.name === 'service')?.topValues[0]).toEqual({ value: 'api', count: 5 });
		// One GROUP BY over the union, plus the scope-name lookups for `service`.
		expect(prepared.filter((sql) => sql.includes('UNION ALL'))).toHaveLength(1);
	});

	test('a zero, future or far-behind resume seq replays only the newest rows', () => {
		const vector = { le: 100_000, lr: 10 };
		expect(boundedTailResume({ le: 99_000, lr: 4 }, vector, 2_000)).toEqual({ le: 99_000, lr: 4 });
		expect(boundedTailResume({ le: 0, lr: 11 }, vector, 2_000)).toEqual({ le: 98_000, lr: 0 });
		expect(boundedTailResume({ le: 1 }, vector, 2_000)).toEqual({ le: 98_000, lr: 0 });
		expect(boundedTailResume({}, { le: 5 }, 2_000)).toEqual({ le: 0 });
	});
});
