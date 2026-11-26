import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, parseLogQuery, type FeatureFlags, type LogSearchResult } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { archiveKey, LogArchiveService, LOG_ARCHIVE_SCAN_BUDGET_BYTES, type LogArchiveWriter } from './log-archive.ts';
import type { ClickHouseCompactResult, ClickHouseParams } from './clickhouse.ts';
import type { LogStoreRead } from './log-store/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-log-archive-'));
const opened = createDb({ path: ':memory:' });
const DAY = 86_400_000;
let clock = Date.parse('2026-11-26T06:00:00Z');
const features: { -readonly [K in keyof FeatureFlags]: FeatureFlags[K] } = { ...DEFAULT_FEATURES };
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: store,
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		features,
		now: () => clock,
	},
});
const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

/** A ClickHouse stand-in for the archive: hourly counts, Parquet bytes, and the last SELECT. */
class FakeArchiveWriter implements LogArchiveWriter {
	installed = true;
	queries: Array<{ sql: string; params?: ClickHouseParams; settings?: unknown }> = [];
	exports: Array<{ sql: string; params?: ClickHouseParams }> = [];
	searchRows: unknown[][] = [];

	async logsReady(): Promise<boolean> {
		return true;
	}

	async queryLogsParquet(sql: string, params?: ClickHouseParams): Promise<Uint8Array> {
		this.exports.push({ sql, params });
		return new TextEncoder().encode(`PAR1-${String(params?.from)}`);
	}

	async runQuery(sql: string, options: { params?: ClickHouseParams; settings?: unknown }): Promise<ClickHouseCompactResult> {
		this.queries.push({ sql, params: options.params, settings: options.settings });
		if (sql.includes('toHour(ts)')) return { meta: [], data: [[3, 10], [14, 5]], rows: 2 };
		return { meta: [], data: this.searchRows, rows: this.searchRows.length };
	}
}

const writer = new FakeArchiveWriter();
const archive = new LogArchiveService(core.ctx, () => writer, () => store);

function read(from: number, to: number, q = 'level:error'): LogStoreRead {
	const parsed = parseLogQuery(q);
	if (!parsed.ok) throw new Error('bad query');
	return { boundary: { orgId: 'org_1', scopes: [{ kind: 'project', id: 'prj_1' }], crossOrg: false }, ast: parsed.ast, from, to };
}

function empty(): LogSearchResult {
	return { records: [], cursor: { older: null, newer: null }, engine: 'clickhouse', warnings: [], elapsedMs: 0 };
}

describe('LogArchiveService (docs/LOGS.md §10.1)', () => {
	test('off by default: no org is archived until an owner opts in', () => {
		expect(archive.archiveOrgs()).toEqual([]);
		core.logSettings.update(owner, { level: 'org' }, { archiveEnabled: true, archiveDays: 30 });
		expect(archive.archiveOrgs()).toEqual(['org_1']);
	});

	test('exports a day as one Parquet file per hour with rows, and records it', async () => {
		const result = await archive.exportDay('org_1', '2026-11-25');
		expect(result.files.map((file) => file.key)).toEqual([archiveKey('org_1', '2026-11-25', 3), archiveKey('org_1', '2026-11-25', 14)]);
		expect(result.rows).toBe(15);
		expect(writer.exports[0]!.sql).toContain('FORMAT Parquet');
		expect(writer.exports[0]!.params).toMatchObject({ org: 'org_1', from: '2026-11-25 03:00:00.000', to: '2026-11-25 04:00:00.000' });
		expect(await store.exists('logs-archive/org_1/2026-11-25/03.parquet')).toBe(true);
		const row = opened.sqlite.query<{ rows: number; bytes: number }, []>("SELECT rows, bytes FROM log_archive_days WHERE day = '2026-11-25'").get();
		expect(row).toEqual({ rows: 15, bytes: result.bytes });
	});

	test('the daily tick exports missing days once and prunes past archiveDays', async () => {
		opened.sqlite.run(
			"INSERT INTO log_archive_days (org_id, day, files, rows, bytes, exported_at) VALUES ('org_1', '2026-09-01', ?, 1, 4, 0)",
			[JSON.stringify([{ hour: 0, key: 'logs-archive/org_1/2026-09-01/00.parquet', rows: 1, bytes: 4 }])],
		);
		await store.put('logs-archive/org_1/2026-09-01/00.parquet', new Uint8Array([1, 2, 3, 4]));
		const first = await archive.tick(clock);
		// Yesterday was exported above; the two days before it are caught up.
		expect(first).toEqual({ exported: 2, pruned: 1 });
		expect(await store.exists('logs-archive/org_1/2026-09-01/00.parquet')).toBe(false);
		expect(await archive.tick(clock)).toBeNull();
	});

	test('estimate: only days older than the search window, with bytes, files and seconds', () => {
		opened.sqlite.run(
			"INSERT INTO log_archive_days (org_id, day, files, rows, bytes, exported_at) VALUES ('org_1', '2026-11-01', ?, 3, 3000000, 0)",
			[JSON.stringify([0, 1, 2].map((hour) => ({ hour, key: archiveKey('org_1', '2026-11-01', hour), rows: 1, bytes: 1_000_000 })))],
		);
		const boundary = read(0, 0).boundary;
		// Inside the 14-day window: nothing to rehydrate.
		expect(archive.estimateFor(boundary, clock - DAY, clock).range).toBeNull();
		const estimate = archive.estimateFor(boundary, Date.parse('2026-11-01T00:00:00Z'), clock);
		expect(estimate.range).toEqual({ from: Date.parse('2026-11-01T00:00:00Z'), to: clock - 14 * DAY });
		expect(estimate).toMatchObject({ bytes: 3_000_000, files: 3, days: ['2026-11-01'], available: true, budgetBytes: LOG_ARCHIVE_SCAN_BUDGET_BYTES });
		expect(estimate.seconds).toBeGreaterThan(0);
		// A project that keeps fewer search days moves the horizon closer.
		expect(archive.searchHorizon(boundary, clock)).toBe(clock - 14 * DAY);
	});

	test('a search past the window warns with the estimate, and runs the archive only when confirmed', async () => {
		const from = Date.parse('2026-11-01T00:00:00Z');
		const warned = await archive.applyToSearch(read(from, clock), { limit: 10, order: 'desc' }, empty());
		expect(warned.warnings[0]?.code).toBe('archive');
		expect(warned.warnings[0]?.message).toMatch(/2\.9 MB in 3 files/);
		expect(writer.queries.some((query) => query.sql.includes('url('))).toBe(false);

		writer.searchRows = [
			['le:9', Date.parse('2026-11-01T01:00:00Z'), null, 'org_1', 'project', 'prj_1', '', 'runtime', 'stderr', 17, 'boom', {}, {}, '', '', '', '', 'prj_1', '', '', '', '', -1],
		];
		const confirmed = await archive.applyToSearch(read(from, clock), { limit: 10, order: 'desc', archive: true }, empty());
		expect(confirmed.records.map((record) => record.body)).toEqual(['boom']);
		const query = writer.queries.at(-1)!;
		expect(query.sql).toContain("FROM (SELECT * FROM url('");
		expect(query.sql).toContain('UNION ALL');
		expect(query.sql).not.toContain('FROM logs');
		// Tenancy and the filter are still ANDed in, as parameters.
		expect(Object.values(query.params ?? {})).toContain('org_1');
		expect(query.settings).toMatchObject({ read_overflow_mode: 'throw' });
	});
});
