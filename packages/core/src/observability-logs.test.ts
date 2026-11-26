import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	builderSpecSchema,
	dashboardSpecSchema,
	logsBuilderQuery,
	parseLogQuery,
	type BuilderSpec,
	type LogTableResult,
	type Principal,
} from '@yoal/contracts';
import { createDb } from '@yoal/db';
import { createCore, type Core } from './index.ts';
import { compileTable } from './log-store/clickhouse-compiler.ts';
import type { LogStore, LogStoreRead } from './log-store/types.ts';
import { LocalObjectStore } from './object-store.ts';
import { logTableToQueryResult, logsDatasetQueryText, logsIntervalSeconds } from './observability-logs.ts';
import { compileBuilder, datasetCatalog } from './observability-query.ts';
import { buildPrincipal } from './orgs.ts';

/** The `logs` dashboards dataset (docs/LOGS.md §9.2): translation, tenancy and both engines. */

const spec = (input: Record<string, unknown>): BuilderSpec => builderSpecSchema.parse({ dataset: 'logs', ...input });

describe('builder → log query', () => {
	test('measures, group-by fields and time buckets become one stats stage that parses back', () => {
		const counted = logsBuilderQuery(
			spec({ metrics: [{ field: 'count', agg: 'count' }], groupBy: ['level', '@http.route'], logs: { q: 'source:access @http.status:>=500' } }),
			300_000,
		);
		expect(counted).toMatchObject({ ok: true, q: 'source:access @http.status:>=500 | stats count() by bin(5m) as time, level, @http.route' });
		const distinct = logsBuilderQuery(spec({ metrics: [{ field: 'count_distinct', agg: 'count', of: '@user.id' }], timeSeries: false }), null);
		expect(distinct).toMatchObject({ ok: true, q: '| stats count_distinct(@user.id) as distinct_user_id' });
		for (const result of [counted, distinct]) {
			if (!result.ok) throw new Error(result.error);
			const parsed = parseLogQuery(result.q);
			expect(parsed.ok && parsed.ast).toEqual(result.ast);
		}
	});

	test('bad input is a readable error', () => {
		const error = (input: Record<string, unknown>) => {
			const result = logsBuilderQuery(spec({ metrics: [{ field: 'count' }], ...input }), null);
			return result.ok ? null : result.error;
		};
		expect(error({ logs: { q: 'level:error | patterns' } })).toContain('pipe');
		expect(error({ logs: { q: '(' } })).toContain('Log query');
		expect(error({ metrics: [{ field: 'count_distinct' }] })).toContain('needs a field');
		expect(error({ metrics: [{ field: 'requests' }] })).toContain('not a measure');
		expect(error({ groupBy: ['nonsense'] })).toContain('not a log field');
		expect(error({ metrics: [] })).toContain('measure');
	});

	test('the catalogue lists logs, which never reaches the metrics compiler; a logs panel is a valid dashboard', () => {
		const logs = datasetCatalog().find((dataset) => dataset.name === 'logs');
		expect(logs?.measures.map((measure) => measure.name)).toEqual(['count', 'count_distinct']);
		expect(logs?.dimensions.map((dimension) => dimension.name)).toContain('level');
		expect(() =>
			compileBuilder(spec({ metrics: [{ field: 'count' }] }), {
				database: 'yoal',
				fromMs: 0,
				toMs: 1,
				maxDataPoints: 10,
				variables: {},
				scope: null,
				minuteRetentionHours: 48,
				nowMs: 1,
			}),
		).toThrow('Logs Explorer');
		const dashboard = dashboardSpecSchema.parse({
			panels: [{ id: 'p1', viz: 'logs', gridPos: { x: 0, y: 0, w: 24, h: 10 }, query: { mode: 'builder', builder: spec({ metrics: [{ field: 'count' }], logs: { q: 'level:error' } }) } }],
		});
		expect(dashboard.panels[0]!.viz).toBe('logs');
	});

	test('intervals: fixed ones as given, auto from the range and point budget', () => {
		expect(logsIntervalSeconds({ interval: '5m' }, 86_400_000, 500)).toBe(300);
		expect(logsIntervalSeconds({ interval: 'auto' }, 3_600_000, 500)).toBe(60);
		expect(logsIntervalSeconds({ interval: 'auto' }, 7 * 86_400_000, 100)).toBe(7_200);
	});

	test('the ClickHouse compiler ANDs the caller boundary into the dataset query', () => {
		const q = logsDatasetQueryText(spec({ metrics: [{ field: 'count' }], groupBy: ['level'], logs: { q: 'level:error' } }), 60);
		const parsed = parseLogQuery(q);
		if (!parsed.ok) throw new Error(parsed.error.message);
		const compiled = compileTable(
			{ boundary: { orgId: 'org_1', scopes: [{ kind: 'project', id: 'prj_1' }], crossOrg: false }, ast: parsed.ast, from: 1_000, to: 2_000 },
			{ textIndex: 'text' },
		);
		expect(compiled.sql).toMatch(/org_id = \{p\d+:String\}/);
		expect(Object.values(compiled.params)).toContain('org_1');
		expect(Object.values(compiled.params)).toContainEqual(['prj_1']);
		expect(compiled.columns.map((column) => column.name)).toEqual(['time', 'level', 'count']);
	});

	test('a log table becomes a query result: time first and sorted, numbers as numbers, warnings as the notice', () => {
		const table: LogTableResult = {
			columns: [
				{ name: 'time', type: 'time' },
				{ name: 'level', type: 'string' },
				{ name: 'count', type: 'number' },
			],
			rows: [
				[120_000, 'error', 3],
				[60_000, 'info', '7' as unknown as number],
			],
			engine: 'sqlite',
			warnings: [{ code: 'needs_clickhouse', message: 'Lite mode.' }],
			elapsedMs: 4.2,
		};
		const result = logTableToQueryResult(table, { sql: 'q', intervalSeconds: 60, timeSeries: true });
		expect(result.columns.map((column) => column.kind)).toEqual(['time', 'string', 'number']);
		expect(result.rows).toEqual([
			[60_000, 'info', 7],
			[120_000, 'error', 3],
		]);
		expect(result).toMatchObject({ sql: 'q', resolution: null, notice: 'Lite mode.', stats: { elapsedMs: 4 } });
		const ordered = logTableToQueryResult(table, { sql: 'q', intervalSeconds: 60, timeSeries: false, orderBy: { field: 'count', dir: 'asc' } });
		expect(ordered.rows.map((row) => row[2])).toEqual([3, 7]);
	});
});

describe('the dataset through ObservabilityService', () => {
	const dir = mkdtempSync(join(tmpdir(), 'yoal-obs-logs-'));
	const opened = createDb({ path: ':memory:' });
	let clock = Date.parse('2026-11-26T12:00:00Z');
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
	const outsider = buildPrincipal({ kind: 'user', userId: 'user_9', orgId: 'org_2', role: 'owner' });
	const ids: Record<string, string> = {};
	const hooks = core.ctx as unknown as { logStoreClickhouse?: unknown };

	const project = async (principal: Principal, slug: string) => {
		await core.projects.create(principal, { name: slug, slug, runtime: 'static', placement: 'edge', productionAccess: 'public', previewAccess: 'platform' });
		return core.projects.requireRow(principal, slug).id;
	};
	const line = (orgId: string, projectId: string, message: string, level: 'info' | 'error') => {
		clock += 1_000;
		core.logs.appendSystem({ orgId, projectId, message, level });
	};
	const run = (principal: Principal, builder: Record<string, unknown>) =>
		core.observability.query(principal, {
			query: { mode: 'builder', builder: spec(builder) },
			range: { from: new Date(clock - 3_600_000).toISOString(), to: new Date(clock + 1).toISOString() },
			maxDataPoints: 60,
			variables: {},
		});

	beforeAll(async () => {
		ids.shop = await project(owner, 'shop');
		ids.vault = await project(outsider, 'vault');
		line('org_1', ids.shop!, 'one', 'error');
		line('org_1', ids.shop!, 'two', 'error');
		line('org_1', ids.shop!, 'three', 'info');
		line('org_2', ids.vault!, 'theirs', 'error');
	});

	afterAll(() => {
		core.logExplorer.tailBus.closeAll();
		opened.sqlite.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test('lite mode counts by level within the caller’s org, without the telemetry store', async () => {
		const result = await run(owner, { metrics: [{ field: 'count' }], groupBy: ['level'], timeSeries: false, orderBy: { field: 'count', dir: 'desc' } });
		expect(result.rows).toEqual([
			['error', 2],
			['info', 1],
		]);
		expect(result.sql).toBe('| stats count() by level');
		const series = await run(owner, { metrics: [{ field: 'count' }], logs: { q: 'level:error' } });
		expect(series.columns.map((column) => column.name)).toEqual(['time', 'count']);
		expect(series.rows.reduce((sum, row) => sum + Number(row[1]), 0)).toBe(2);
	});

	test('scopes are intersected with the caller’s boundary: another org’s project reads nothing', async () => {
		const result = await run(owner, { metrics: [{ field: 'count' }], timeSeries: false, logs: { scopes: [{ kind: 'project', id: ids.vault }] } });
		// An empty boundary reads nothing at all (no rows, or a zero count).
		expect(result.rows.reduce((sum, row) => sum + Number(row[0] ?? 0), 0)).toBe(0);
	});

	test('what lite mode cannot answer is needs_clickhouse; a ClickHouse store gets the server boundary', async () => {
		await expect(run(owner, { metrics: [{ field: 'count_distinct', of: '@user.id' }], timeSeries: false })).rejects.toMatchObject({ code: 'needs_clickhouse' });
		const reads: LogStoreRead[] = [];
		const unsupported = async (): Promise<never> => {
			throw new Error('not in this fake');
		};
		const store: LogStore = {
			engine: 'clickhouse',
			async table(read) {
				reads.push(read);
				return { columns: [{ name: 'distinct_user_id', type: 'number' }], rows: [[5]], engine: 'clickhouse', warnings: [], elapsedMs: 1 };
			},
			search: unsupported,
			histogram: unsupported,
			fields: unsupported,
			context: unsupported,
			get: unsupported,
		};
		hooks.logStoreClickhouse = store;
		try {
			const result = await run(owner, { metrics: [{ field: 'count_distinct', of: '@user.id' }], timeSeries: false, logs: { scopes: [{ kind: 'project', id: ids.vault }, { kind: 'project', id: ids.shop }] } });
			expect(result.rows).toEqual([[5]]);
			expect(reads[0]!.boundary).toEqual({ orgId: 'org_1', scopes: [{ kind: 'project', id: ids.shop! }], crossOrg: false });
		} finally {
			delete hooks.logStoreClickhouse;
		}
	});
});
