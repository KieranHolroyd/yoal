import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { createDb } from '@yoal/db';
import { classifyCompareRows, compareWindows, rankWhyRows } from './log-analysis.ts';
import { LogIndexer } from './log-indexer.ts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { TelemetryStore } from './telemetry.ts';
import { disposeTelemetryStore, hasClickHouse, testTelemetryStore } from './test-clickhouse.ts';
import {
	compileCompare,
	compileCompareTotals,
	compileWhy,
	compileWhyTotals,
	whyFields,
} from './log-store/clickhouse-analysis.ts';
import { SqlParams, compileTable, type ClickHouseCompileOptions, type CompiledLogQuery } from './log-store/clickhouse-compiler.ts';
import { ClickHouseLogStore } from './log-store/clickhouse-store.ts';
import type { LogReadBoundary, LogStoreRead } from './log-store/types.ts';

const MIN = 60_000;
const HOUR = 3_600_000;
const TEXT: ClickHouseCompileOptions = { textIndex: 'text' };
const boundary: LogReadBoundary = { orgId: 'org_1', scopes: [{ kind: 'project', id: 'prj_1' }], crossOrg: false };
const read = (overrides: Partial<LogStoreRead> = {}): LogStoreRead => ({
	boundary,
	ast: { filter: { type: 'text', value: 'timeout', phrase: false }, pipes: [] },
	from: 10 * HOUR,
	to: 11 * HOUR,
	...overrides,
});

/** Tenancy (org + scope) is in the SQL as parameters, and no user text reaches the SQL. */
function expectTenancy(compiled: CompiledLogQuery, times = 1): void {
	const orgParams = Object.entries(compiled.params).filter(([, value]) => value === 'org_1');
	expect(orgParams.length).toBeGreaterThanOrEqual(times);
	for (const [name] of orgParams) expect(compiled.sql).toContain(`org_id = {${name}:String}`);
	expect(Object.values(compiled.params)).toContainEqual(['prj_1']);
	expect(compiled.sql).not.toContain('org_1');
	expect(compiled.sql).not.toContain('prj_1');
	expect(compiled.sql).not.toContain('timeout');
}

// ------------------------------------------------------------------------------------- pure

describe('compare windows', () => {
	const window = { from: 10 * HOUR, to: 11 * HOUR };

	test('previous, offset and range keep the current window', () => {
		expect(compareWindows(window, { kind: 'previous' }, 0)).toEqual({ current: window, baseline: { from: 9 * HOUR, to: 10 * HOUR } });
		expect(compareWindows(window, { kind: 'offset', offsetMs: 24 * HOUR }, 0).baseline).toEqual({ from: -14 * HOUR, to: -13 * HOUR });
		expect(compareWindows(window, { kind: 'range', from: 1, to: 5 }, 0).baseline).toEqual({ from: 1, to: 5 });
	});

	test('a deploy compares the same length either side of its live time, cut at now', () => {
		const deploy = { id: 'dep_1', projectId: 'prj_1', at: 20 * HOUR };
		expect(compareWindows(window, { kind: 'deploy', deploymentId: 'dep_1' }, 30 * HOUR, deploy)).toEqual({
			current: { from: 20 * HOUR, to: 21 * HOUR },
			baseline: { from: 19 * HOUR, to: 20 * HOUR },
		});
		// Deployed 10 minutes ago: 10 minutes either side.
		expect(compareWindows(window, { kind: 'deploy', deploymentId: 'dep_1' }, 20 * HOUR + 10 * MIN, deploy)).toEqual({
			current: { from: 20 * HOUR, to: 20 * HOUR + 10 * MIN },
			baseline: { from: 20 * HOUR - 10 * MIN, to: 20 * HOUR },
		});
	});

	test('an unknown deploy is 404 and an empty window 422', () => {
		expect(() => compareWindows(window, { kind: 'deploy', deploymentId: 'x' }, 0, null)).toThrow(expect.objectContaining({ status: 404 }));
		expect(() => compareWindows({ from: 5, to: 5 }, { kind: 'previous' }, 0)).toThrow(expect.objectContaining({ status: 422 }));
	});
});

describe('compare rows', () => {
	const windows = { current: { from: 0, to: HOUR }, baseline: { from: -HOUR, to: 0 } };

	test('classified, grouped new → rising → gone → falling → steady, biggest move first', () => {
		const rows = classifyCompareRows(
			[
				['a', 'steady <NUM>', '10', '9', 'le:1'],
				['b', 'new one', 3, 0, 'le:2'],
				['c', 'gone one', 0, 7, ''],
				['d', 'rising', 40, 10, 'le:4'],
				['e', 'falling', 2, 10, 'le:5'],
				['f', 'new and big', 30, 0, 'le:6'],
				['', 'unmined', 5, 5, null],
			],
			windows,
			100,
		);
		expect(rows.map((row) => [row.patternId, row.change])).toEqual([
			['f', 'new'],
			['b', 'new'],
			['d', 'rising'],
			['c', 'gone'],
			['e', 'falling'],
			['a', 'steady'],
		]);
		expect(rows[2]).toEqual({ patternId: 'd', template: 'rising', current: 40, baseline: 10, change: 'rising', ratio: 4, sampleId: 'le:4' });
		expect(rows[3]!.sampleId).toBeNull();
		expect(classifyCompareRows([['a', 't', 1, 0, null], ['b', 't', 2, 0, null]], windows, 1)).toHaveLength(1);
	});
});

describe('why ranking', () => {
	test('lift is selection share minus baseline share; only over-represented values', () => {
		const rows = rankWhyRows(
			[
				['node', 'edge-b', 92, 31],
				['node', 'edge-a', 8, 69],
				['@http.route', '/v1/orders', 88, 12],
				['deployment', 'dep_x', 100, 0],
				['level', 'info', 0, 50],
			],
			{ selection: 100, baseline: 100 },
			10,
		);
		expect(rows.map((row) => `${row.field}=${row.value}`)).toEqual(['deployment=dep_x', '@http.route=/v1/orders', 'node=edge-b']);
		expect(rows[2]).toEqual({ field: 'node', value: 'edge-b', selectionCount: 92, baselineCount: 31, selectionShare: 0.92, baselineShare: 0.31, lift: 0.61 });
	});

	test('an empty baseline still ranks by selection share', () => {
		expect(rankWhyRows([['node', 'n1', 5, 0]], { selection: 10, baseline: 0 }, 5)[0]).toMatchObject({ lift: 0.5, baselineShare: 0 });
	});
});

// -------------------------------------------------------------------------------------- SQL

describe('analysis SQL', () => {
	test('compare totals and per-pattern counts carry the boundary, both windows and the filter', () => {
		const current = { from: 10 * HOUR, to: 11 * HOUR };
		const baseline = { from: 9 * HOUR, to: 10 * HOUR };
		const totals = compileCompareTotals(read(), current, baseline, TEXT);
		expectTenancy(totals);
		expect(totals.sql).toContain('countIf(');
		expect(totals.sql).toContain('hasToken(body');
		const compare = compileCompare(read(), current, baseline, TEXT);
		// Twice: the logs read and the joined log_patterns read.
		expectTenancy(compare, 2);
		expect(compare.sql).toContain("pattern_id != ''");
		expect(compare.sql).toContain('LEFT JOIN (SELECT pattern_id, any(template) AS template FROM log_patterns WHERE (org_id = ');
		expect(Object.values(compare.params)).toEqual(expect.arrayContaining([10 * HOUR, 11 * HOUR, 9 * HOUR]));
	});

	test('an empty boundary compiles to nothing', () => {
		const empty = read({ boundary: { orgId: 'org_1', scopes: [], crossOrg: false } });
		expect(compileCompare(empty, empty, empty, TEXT).sql).toContain('WHERE 0 AND');
		expect(compileWhyTotals(empty, empty, TEXT).sql).toContain('WHERE 0 AND');
	});

	test('why compares the named fields, with attribute keys as parameters', () => {
		const selection = { from: 10 * HOUR + 30 * MIN, to: 10 * HOUR + 40 * MIN };
		const totals = compileWhyTotals(read(), selection, TEXT);
		expectTenancy(totals);
		const why = compileWhy(read(), selection, ['node', 'level', '@http.route', 'resource.host.name', 'request'], { selection: 10, baseline: 90 }, TEXT);
		expectTenancy(why);
		expect(why.sql).toContain('ARRAY JOIN arrayFilter(x -> x.2 != \'\'');
		expect(why.sql).toContain('severity_text');
		expect(why.sql).toContain('LIMIT {');
		expect(why.sql).not.toContain('http.route');
		expect(why.sql).not.toContain('host.name');
		expect(Object.values(why.params)).toEqual(expect.arrayContaining(['http.route', 'host.name', '@http.route', 'node']));
	});

	test('why refuses fields it cannot compare', () => {
		expect(() => whyFields(['nope'], new SqlParams())).toThrow(expect.objectContaining({ status: 422 }));
		expect(whyFields(['node', 'node', 'NODE'], new SqlParams())).toHaveLength(1);
	});

	test('| patterns carries first_seen from log_patterns and a hidden sparkline', () => {
		const compiled = compileTable(read({ ast: { filter: null, pipes: [{ type: 'patterns' }] } }), TEXT);
		expect(compiled.columns.map((column) => column.name)).toEqual(['pattern', 'template', 'count', 'first_seen', 'last_seen']);
		expect(compiled.sampleIdColumn).toBe(5);
		expect(compiled.sparklineColumn).toBe(6);
		expect(compiled.sql).toContain('min(first_seen) AS first_seen');
		expect(compiled.sql).toContain('countResample(0, 24, 1)');
		const chosen = compileTable(
			read({ ast: { filter: null, pipes: [{ type: 'patterns' }, { type: 'fields', fields: [{ kind: 'builtin', name: 'pattern' }] }] } }),
			TEXT,
		);
		expect(chosen.sampleIdColumn).toBe(1);
		expect(chosen.sparklineColumn).toBe(2);
		expect(chosen.sql).toMatch(/^SELECT c0, c5, c6 FROM/);
	});
});

// ---------------------------------------------------------------------------------- service

const dir = mkdtempSync(join(tmpdir(), 'yoal-log-analysis-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.parse('2026-11-25T10:00:00Z');
const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		now: () => clock,
	},
});
const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner' });
const readOnlyKey = buildPrincipal({ kind: 'apiKey', userId: 'user_1', orgId: 'org_1', role: 'owner', granted: ['logs:read', 'project:read'], keyId: 'key_1' });
const otherOrg = buildPrincipal({ kind: 'user', userId: 'user_9', orgId: 'org_2', role: 'owner' });
const ids: Record<string, string> = {};

async function project(principal: typeof owner, slug: string): Promise<string> {
	await core.projects.create(principal, { name: slug, slug, runtime: 'static', placement: 'edge', productionAccess: 'public', previewAccess: 'platform' });
	return core.projects.requireRow(principal, slug).id;
}

function deployment(id: string, orgId: string, projectId: string, at: number): void {
	opened.sqlite.run(
		`INSERT INTO deployments (id, org_id, project_id, release_id, config_snapshot_id, short_id, runtime, runtime_name, status, preview_host, created_by, created_at, activated_at)
		 VALUES (?, ?, ?, 'rel_none', 'cfg_none', ?, 'static', 'static', 'active', ?, 'user_1', ?, ?)`,
		[id, orgId, projectId, `s_${id}`, `${id}.preview.test`, at - 1_000, at],
	);
}

interface Captured {
	sql: string;
	params: Record<string, unknown>;
}

/** A ClickHouse store double that records the SQL and answers canned rows in order. */
function fakeStore(answers: unknown[][][], healthy = true) {
	const calls: Captured[] = [];
	const store = {
		engine: 'clickhouse' as const,
		healthy: () => healthy,
		async analysis(compile: (options: ClickHouseCompileOptions) => CompiledLogQuery) {
			const compiled = compile(TEXT);
			calls.push({ sql: compiled.sql, params: compiled.params as Record<string, unknown> });
			return answers.shift() ?? [];
		},
	};
	return { store, calls };
}

const hooks = core.ctx as unknown as { logStoreClickhouse?: unknown };

beforeAll(async () => {
	ids.shop = await project(owner, 'shop');
	ids.blog = await project(owner, 'blog');
	ids.vault = await project(otherOrg, 'vault');
	deployment('dep_shop', 'org_1', ids.shop!, clock - 30 * MIN);
	deployment('dep_vault', 'org_2', ids.vault!, clock - 30 * MIN);
});

afterAll(() => {
	delete hooks.logStoreClickhouse;
	core.logExplorer.tailBus.closeAll();
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('LogExplorerService.compare / why', () => {
	const window = () => ({ from: clock - HOUR, to: clock });

	test('lite mode is a 422 needs_clickhouse', async () => {
		delete hooks.logStoreClickhouse;
		await expect(core.logExplorer.compare(owner, { ...window(), baseline: { kind: 'previous' } })).rejects.toMatchObject({ code: 'needs_clickhouse', status: 422 });
		await expect(core.logExplorer.why(owner, { ...window(), selection: { from: clock - 10 * MIN, to: clock } })).rejects.toMatchObject({
			code: 'needs_clickhouse',
			status: 422,
		});
		hooks.logStoreClickhouse = fakeStore([], false).store;
		await expect(core.logExplorer.compare(owner, { ...window(), baseline: { kind: 'previous' } })).rejects.toMatchObject({ code: 'needs_clickhouse' });
	});

	test('compare needs logs:query and validates its input', async () => {
		hooks.logStoreClickhouse = fakeStore([]).store;
		await expect(core.logExplorer.compare(readOnlyKey, { ...window(), baseline: { kind: 'previous' } })).rejects.toMatchObject({ status: 403 });
		await expect(core.logExplorer.compare(owner, { ...window(), baseline: { kind: 'offset', offsetMs: -1 } })).rejects.toMatchObject({ status: 422 });
		await expect(core.logExplorer.compare(owner, { ...window(), q: 'level:', baseline: { kind: 'previous' } })).rejects.toMatchObject({ status: 422 });
	});

	test('compare reads the caller’s boundary and classifies the answer', async () => {
		const { store, calls } = fakeStore([
			[['40', '12']],
			[
				['p1', 'upstream timeout after <DUR>', '30', '2', 'le:9'],
				['p2', 'started', '10', '10', 'le:3'],
			],
		]);
		hooks.logStoreClickhouse = store;
		const result = await core.logExplorer.compare(owner, { ...window(), q: 'timeout', baseline: { kind: 'previous' } });
		expect(result.current).toEqual({ ...window(), total: 40 });
		expect(result.baseline).toEqual({ from: clock - 2 * HOUR, to: clock - HOUR, total: 12 });
		expect(result.rows.map((row) => [row.patternId, row.change, row.ratio])).toEqual([
			['p1', 'rising', 15],
			['p2', 'steady', 1],
		]);
		expect(result.warnings).toEqual([]);
		for (const call of calls) {
			expect(Object.values(call.params)).toContain('org_1');
			const scopeIds = Object.values(call.params).filter(Array.isArray) as string[][];
			expect(scopeIds.map((list) => [...list].sort())).toContainEqual([ids.blog!, ids.shop!].sort());
			expect(scopeIds.flat()).not.toContain(ids.vault!);
		}
	});

	test('a deploy baseline narrows to the deploy’s project; another org’s deploy is not found', async () => {
		const { store, calls } = fakeStore([[['5', '1']], []]);
		hooks.logStoreClickhouse = store;
		const result = await core.logExplorer.compare(owner, { ...window(), baseline: { kind: 'deploy', deploymentId: 'dep_shop' } });
		expect(result.current).toEqual({ from: clock - 30 * MIN, to: clock, total: 5 });
		expect(result.baseline).toEqual({ from: clock - HOUR, to: clock - 30 * MIN, total: 1 });
		expect(Object.values(calls[0]!.params)).toContainEqual([ids.shop]);
		expect(Object.values(calls[0]!.params)).not.toContainEqual([ids.blog]);
		// By short id too.
		hooks.logStoreClickhouse = fakeStore([[['0', '0']], []]).store;
		await expect(core.logExplorer.compare(owner, { ...window(), baseline: { kind: 'deploy', deploymentId: 's_dep_shop' } })).resolves.toMatchObject({
			current: { from: clock - 30 * MIN },
		});
		await expect(core.logExplorer.compare(owner, { ...window(), baseline: { kind: 'deploy', deploymentId: 'dep_vault' } })).rejects.toMatchObject({ status: 404 });
		await expect(core.logExplorer.compare(owner, { ...window(), baseline: { kind: 'deploy', deploymentId: 'dep_missing' } })).rejects.toMatchObject({ status: 404 });
		// A deploy outside the scopes the caller chose is not found either.
		await expect(
			core.logExplorer.compare(owner, { ...window(), scopes: [{ kind: 'project', id: ids.blog! }], baseline: { kind: 'deploy', deploymentId: 'dep_shop' } }),
		).rejects.toMatchObject({ status: 404 });
	});

	test('unmined lines are reported as a partial warning', async () => {
		hooks.logStoreClickhouse = fakeStore([[['10', '0']], [['p1', 't', '4', '0', null]]]).store;
		const result = await core.logExplorer.compare(owner, { ...window(), baseline: { kind: 'previous' } });
		expect(result.warnings.map((warning) => warning.code)).toEqual(['partial']);
		expect(result.warnings[0]!.message).toContain('6 lines have no pattern');
	});

	test('why: totals, top attribute keys, then the ranked values', async () => {
		const { store, calls } = fakeStore([
			[['20', '80']],
			[['http.route', 100]],
			[
				['node', 'edge-b', '18', '20'],
				['@http.route', '/v1/orders', '15', '8'],
			],
		]);
		hooks.logStoreClickhouse = store;
		const selection = { from: clock - 10 * MIN, to: clock };
		const result = await core.logExplorer.why(owner, { ...window(), selection });
		expect(result.selection).toEqual({ ...selection, total: 20 });
		expect(result.baseline).toEqual({ ...window(), total: 80 });
		expect(result.rows.map((row) => [row.field, row.value, row.lift])).toEqual([
			['node', 'edge-b', 0.65],
			['@http.route', '/v1/orders', 0.65],
		]);
		expect(calls).toHaveLength(3);
		expect(Object.values(calls[2]!.params)).toEqual(expect.arrayContaining(['level', 'node', '@http.route', 'http.route']));
	});

	test('why: named fields skip key discovery; a selection outside the window is 422', async () => {
		const { store, calls } = fakeStore([[['1', '1']], []]);
		hooks.logStoreClickhouse = store;
		await core.logExplorer.why(owner, { ...window(), selection: { from: clock - MIN, to: clock }, fields: ['node'] });
		expect(calls).toHaveLength(2);
		await expect(core.logExplorer.why(owner, { ...window(), selection: { from: 1, to: 2 } })).rejects.toMatchObject({ status: 422 });
	});

	test('another org sees nothing of org 1', async () => {
		const { store, calls } = fakeStore([[['0', '0']], []]);
		hooks.logStoreClickhouse = store;
		await core.logExplorer.compare(otherOrg, { ...window(), scopes: [{ kind: 'project', id: ids.shop! }], baseline: { kind: 'previous' } });
		// The foreign scope is dropped: an empty boundary never reaches the store.
		expect(calls).toHaveLength(0);
	});
});

// ------------------------------------------------------------------------- real ClickHouse

describe.skipIf(!hasClickHouse)('compare, why and pattern sparklines against ClickHouse', () => {
	let telemetry: TelemetryStore;
	let sqlite: Database;
	let store: ClickHouseLogStore;
	const NOW = Date.now();
	const scope: LogReadBoundary = { orgId: 'org_1', scopes: [{ kind: 'project', id: 'prj_1' }], crossOrg: false };
	const r = (from: number, to: number, b = scope): LogStoreRead => ({ boundary: b, ast: { filter: null, pipes: [] }, from, to });

	beforeAll(async () => {
		telemetry = testTelemetryStore();
		expect(await telemetry.logsReady()).toBe(true);
		sqlite = createDb({ path: ':memory:' }).sqlite;
		sqlite.run('PRAGMA foreign_keys = OFF');
		const insert = (org: string, project: string, node: string, message: string, ts: number) =>
			sqlite.run(
				`INSERT INTO log_events (org_id, project_id, deployment_id, node_id, source, stream, level, message, ts) VALUES (?, ?, 'dep_1', ?, 'runtime', 'stdout', 'info', ?, ?)`,
				[org, project, node, message, ts],
			);
		// Baseline hour (NOW-2h..NOW-1h): 4 "steady", 3 "gone". Current hour: 4 "steady", 12 "new" on edge-b.
		for (let i = 0; i < 4; i += 1) insert('org_1', 'prj_1', 'edge-a', `steady line ${i}`, NOW - 2 * HOUR + i * MIN);
		for (let i = 0; i < 3; i += 1) insert('org_1', 'prj_1', 'edge-a', `old failure ${i}`, NOW - 2 * HOUR + 10 * MIN + i * MIN);
		for (let i = 0; i < 4; i += 1) insert('org_1', 'prj_1', 'edge-a', `steady line ${i}`, NOW - HOUR + 5 * MIN + i * MIN);
		for (let i = 0; i < 12; i += 1) insert('org_1', 'prj_1', 'edge-b', `{"msg":"upstream timeout","route":"/v1/orders","n":${i}}`, NOW - 10 * MIN + i * 10_000);
		insert('org_2', 'prj_1', 'edge-b', 'upstream timeout in another org', NOW - 5 * MIN);
		const template = (body: string) => (body.startsWith('steady') ? ['aa', 'steady line <NUM>'] : body.startsWith('old') ? ['bb', 'old failure <NUM>'] : ['cc', 'upstream timeout']);
		const indexer = new LogIndexer({ sqlite, config: { features: {} } as never, now: () => Date.now() }, telemetry, {
			miner: { patternFor: (_scope, body) => ({ id: template(body)[0]!, template: template(body)[1]! }) },
		});
		expect((await indexer.tick()).indexed).toBe(24);
		store = new ClickHouseLogStore(telemetry);
	});

	afterAll(async () => {
		await disposeTelemetryStore(telemetry);
	});

	test('compare counts patterns per window, inside the boundary only', async () => {
		const current = { from: NOW - HOUR, to: NOW };
		const baseline = { from: NOW - 2 * HOUR, to: NOW - HOUR };
		const totals = await store.analysis((options) => compileCompareTotals(r(current.from, current.to), current, baseline, options));
		expect(totals.map((row) => row.map(Number))).toEqual([[16, 7]]);
		const data = await store.analysis((options) => compileCompare(r(current.from, current.to), current, baseline, options));
		const rows = classifyCompareRows(data, { current, baseline }, 10);
		expect(rows.map((row) => [row.patternId, row.template, row.current, row.baseline, row.change])).toEqual([
			['cc', 'upstream timeout', 12, 0, 'new'],
			['bb', 'old failure <NUM>', 0, 3, 'gone'],
			['aa', 'steady line <NUM>', 4, 4, 'steady'],
		]);
		expect(rows[0]!.sampleId).toMatch(/^le:/);
	});

	test('why ranks the selection’s node and attribute over the rest', async () => {
		const window = r(NOW - 2 * HOUR, NOW);
		const selection = { from: NOW - 15 * MIN, to: NOW };
		const totals = await store.analysis((options) => compileWhyTotals(window, selection, options));
		expect(totals.map((row) => row.map(Number))).toEqual([[12, 11]]);
		const data = await store.analysis((options) => compileWhy(window, selection, ['node', 'level', '@route'], { selection: 12, baseline: 11 }, options));
		const rows = rankWhyRows(data, { selection: 12, baseline: 11 }, 10);
		expect(rows.map((row) => [row.field, row.value, row.selectionCount, row.baselineCount, row.lift])).toEqual([
			['@route', '/v1/orders', 12, 0, 1],
			['node', 'edge-b', 12, 0, 1],
		]);
	});

	test('| patterns returns first_seen from log_patterns and per-bucket sparklines', async () => {
		const table = await store.table({ ...r(NOW - HOUR, NOW), ast: { filter: null, pipes: [{ type: 'patterns' }] } });
		expect(table.rows.map((row) => [row[0], row[2]])).toEqual([
			['cc', 12],
			['aa', 4],
		]);
		expect(table.sparklines).toHaveLength(2);
		for (const [index, line] of table.sparklines!.entries()) {
			expect(line).toHaveLength(24);
			expect(line.reduce((sum, n) => sum + n, 0)).toBe(Number(table.rows[index]![2]));
		}
		// "steady line" was first seen in the baseline hour, before this window.
		expect(Number(table.rows[1]![3])).toBe(NOW - 2 * HOUR);
	});
});
