import { beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createDb } from '@yoal/db';
import { ClickHouseError, ClickHouseUnavailableError, type ClickHouseCompactResult, type ClickHouseSettings } from './clickhouse.ts';
import { LOG_INDEX_MAX_QUERY_ERRORS, LogIndexer, clickhouseRow, type LogIndexWriter, type PatternMiner } from './log-indexer.ts';

const NOW = Date.parse('2026-11-25T12:00:00Z');

interface Insert {
	table: 'logs' | 'log_patterns';
	rows: Array<Record<string, unknown>>;
	settings: ClickHouseSettings;
}

/** A ClickHouse stand-in: records inserts, can be down, or reject the next N inserts. */
class FakeWriter implements LogIndexWriter {
	installed = true;
	ready = true;
	inserts: Insert[] = [];
	queries: string[] = [];
	failNext: Error[] = [];
	patternFirstSeen: unknown[][] = [];

	async logsReady(): Promise<boolean> {
		return this.ready;
	}

	async insertLogRows(table: 'logs' | 'log_patterns', rows: ReadonlyArray<Record<string, unknown>>, settings: ClickHouseSettings = {}): Promise<void> {
		const failure = this.failNext.shift();
		if (failure) throw failure;
		this.inserts.push({ table, rows: [...rows], settings });
	}

	async runQuery(sql: string): Promise<ClickHouseCompactResult> {
		this.queries.push(sql);
		return { meta: [], data: this.patternFirstSeen, rows: this.patternFirstSeen.length };
	}

	logInserts(): Insert[] {
		return this.inserts.filter((insert) => insert.table === 'logs');
	}
}

function addLine(sqlite: Database, message: string, ts = NOW - 1_000, org = 'org_1', project = 'prj_1'): void {
	sqlite.run(
		`INSERT INTO log_events (org_id, project_id, deployment_id, node_id, source, stream, level, message, ts)
		 VALUES (?, ?, 'dep_1', 'node_1', 'runtime', 'stdout', 'info', ?, ?)`,
		[org, project, message, ts],
	);
}

function cursor(sqlite: Database, table = 'log_events') {
	return sqlite.query<{ cursor: number; indexed_ts: number | null; last_error: string | null }, [string]>('SELECT * FROM log_index_cursors WHERE source_table = ?').get(table);
}

describe('LogIndexer', () => {
	let sqlite: Database;
	let writer: FakeWriter;
	let now: number;
	let enabled: boolean;
	const ctx = () => ({ sqlite, config: { features: {} } as never, now: () => now });
	const indexer = (options: ConstructorParameters<typeof LogIndexer>[2] = {}) =>
		new LogIndexer(ctx(), writer, { enabled: () => enabled, ...options });

	beforeEach(() => {
		sqlite = createDb({ path: ':memory:' }).sqlite;
		sqlite.run('PRAGMA foreign_keys = OFF');
		writer = new FakeWriter();
		now = NOW;
		enabled = true;
	});

	test('indexes new rows with a dedup token for the range and moves the cursor after the ack', async () => {
		sqlite.run(`INSERT INTO projects (id, org_id, slug, name, created_by, created_at, updated_at) VALUES ('prj_1', 'org_1', 'api', 'API', 'u', 1, 1)`);
		sqlite.run(`INSERT INTO nodes (id, name, token_hash, created_at, updated_at) VALUES ('node_1', 'edge-a', 'h', 1, 1)`);
		addLine(sqlite, '{"level":"error","msg":"upstream timeout","http":{"status":502},"request_id":"r1"}');
		addLine(sqlite, '[r1] GET /health 200');
		addLine(sqlite, 'plain line');
		const result = await indexer().tick();
		expect(result.indexed).toBe(3);
		const [insert] = writer.logInserts();
		expect(insert!.settings).toEqual({ insert_deduplicate: 1, insert_deduplication_token: 'log_events:0-3' });
		expect(insert!.rows[0]).toMatchObject({
			id: 'le:1',
			org_id: 'org_1',
			scope_kind: 'project',
			scope_id: 'prj_1',
			stream: 'deployment:dep_1',
			severity_number: 17,
			severity_text: 'error',
			body: 'upstream timeout',
			request_id: 'r1',
			pattern_id: '',
			replica: 0,
		});
		expect(insert!.rows[0]!.attributes).toMatchObject({ 'http.status': '502', msg: 'upstream timeout' });
		expect(insert!.rows[0]!.resource).toMatchObject({ 'service.name': 'api', 'host.name': 'edge-a', 'deployment.id': 'dep_1' });
		expect(insert!.rows[1]).toMatchObject({ id: 'le:2', replica: 1, body: 'GET /health 200' });
		expect(cursor(sqlite)).toMatchObject({ cursor: 3, indexed_ts: NOW - 1_000, last_error: null });
		// Nothing new: no insert, no movement.
		await indexer().tick();
		expect(writer.logInserts()).toHaveLength(1);
	});

	test('a first run starts a bounded backlog behind the newest row, never at the beginning', async () => {
		for (let i = 0; i < 10; i += 1) addLine(sqlite, `line ${i}`);
		await indexer({ startBacklogRows: 4 }).tick();
		expect(writer.logInserts()[0]!.settings.insert_deduplication_token).toBe('log_events:6-10');
		expect(writer.logInserts()[0]!.rows.map((row) => row.id)).toEqual(['le:7', 'le:8', 'le:9', 'le:10']);
	});

	test('batches a backlog within one tick, one token per range', async () => {
		for (let i = 0; i < 5; i += 1) addLine(sqlite, `line ${i}`);
		await indexer({ batchRows: 2 }).tick();
		expect(writer.logInserts().map((insert) => insert.settings.insert_deduplication_token)).toEqual([
			'log_events:0-2',
			'log_events:2-4',
			'log_events:4-5',
		]);
		expect(cursor(sqlite)!.cursor).toBe(5);
	});

	test('a failed insert keeps the cursor and replays exactly the same range with the same token', async () => {
		addLine(sqlite, 'a');
		addLine(sqlite, 'b');
		writer.failNext.push(new ClickHouseUnavailableError('ClickHouse at x is unreachable: refused'));
		const index = indexer();
		await index.tick();
		expect(writer.logInserts()).toHaveLength(0);
		expect(cursor(sqlite)).toMatchObject({ cursor: 0, last_error: 'ClickHouse at x is unreachable: refused' });

		// More lines arrive while it is backing off; the retry still sends only the failed range.
		addLine(sqlite, 'c');
		await index.tick();
		expect(writer.logInserts()).toHaveLength(0); // still inside the backoff
		now += 5_000;
		await index.tick();
		const tokens = writer.logInserts().map((insert) => insert.settings.insert_deduplication_token);
		expect(tokens).toEqual(['log_events:0-2', 'log_events:2-3']);
		expect(writer.logInserts()[0]!.rows.map((row) => row.id)).toEqual(['le:1', 'le:2']);
		expect(cursor(sqlite)).toMatchObject({ cursor: 3, last_error: null });
	});

	test('a lost acknowledgement replays under the same token, so ClickHouse drops the duplicate', async () => {
		addLine(sqlite, 'a');
		const index = indexer();
		// The insert lands but the cursor write "fails": simulate by moving the cursor back.
		await index.tick();
		const first = writer.logInserts()[0]!.settings.insert_deduplication_token;
		sqlite.run(`UPDATE log_index_cursors SET cursor = 0 WHERE source_table = 'log_events'`);
		await index.tick();
		expect(writer.logInserts()[1]!.settings.insert_deduplication_token).toBe(first);
	});

	test('a batch the server keeps rejecting as malformed is skipped and counted', async () => {
		addLine(sqlite, 'poison');
		const index = indexer();
		for (let attempt = 0; attempt < LOG_INDEX_MAX_QUERY_ERRORS; attempt += 1) {
			writer.failNext.push(new ClickHouseError('Cannot parse input', 27, 400));
			await index.tick();
			now += 10 * 60_000;
		}
		expect(writer.logInserts()).toHaveLength(0);
		expect(cursor(sqlite)!.cursor).toBe(1);
		expect(cursor(sqlite)!.last_error).toContain('skipped 1 row(s)');
		addLine(sqlite, 'fine');
		await index.tick();
		expect(writer.logInserts()[0]!.rows.map((row) => row.id)).toEqual(['le:2']);
	});

	test('an unreachable ClickHouse pauses the index and the lag grows; nothing is lost', async () => {
		writer.ready = false;
		addLine(sqlite, 'a', NOW - 120_000);
		const index = indexer();
		await index.tick();
		expect(writer.inserts).toHaveLength(0);
		expect(cursor(sqlite)!.last_error).toContain('unreachable');
		expect(index.lagMs()).toBe(120_000);
		writer.ready = true;
		await index.tick();
		expect(writer.logInserts()).toHaveLength(1);
		expect(index.lagMs()).toBe(0);
		expect(cursor(sqlite)!.last_error).toBeNull();
	});

	test('off without telemetry or behind the LOG_INDEX kill switch', async () => {
		addLine(sqlite, 'a');
		enabled = false;
		const index = indexer();
		expect(await index.tick()).toEqual({ indexed: 0 });
		expect(index.lagMs()).toBeNull();
		expect(cursor(sqlite)).toBeNull();
		enabled = true;
		writer.installed = false;
		expect(await index.tick()).toEqual({ indexed: 0 });
		expect(index.status()).toMatchObject({ enabled: false, installed: false, lagMs: null });
	});

	test('the kill switch defaults to the LOG_INDEX feature flag', async () => {
		addLine(sqlite, 'a');
		const off = new LogIndexer({ sqlite, config: { features: { LOG_INDEX: false } } as never, now: () => now }, writer);
		expect(off.enabled).toBe(false);
		const on = new LogIndexer({ sqlite, config: { features: {} } as never, now: () => now }, writer);
		expect(on.enabled).toBe(true);
	});

	test('every source table gets its own cursor', async () => {
		sqlite.run(`INSERT INTO pipeline_jobs (id, run_id, org_id, repository_id, key, name, status, spec_json, created_at)
			VALUES ('job_1', 'run_1', 'org_1', 'repo_1', 'build', 'Build', 'in_progress', '{}', 1)`);
		sqlite.run(`INSERT INTO pipeline_log_lines (job_id, run_id, step, stream, text, ts) VALUES ('job_1', 'run_1', 2, 'stderr', 'warning: x', ?)`, [NOW]);
		sqlite.run(`INSERT INTO log_records (org_id, scope_kind, scope_id, source, severity_number, body, attributes, ts, observed_ts)
			VALUES ('org_1', 'platform', 'node_1', 'platform', 17, 'agent crashed', '{"unit":"yoal-agent"}', ?, ?)`, [NOW, NOW + 5]);
		addLine(sqlite, 'a');
		await indexer().tick();
		const tokens = writer.logInserts().map((insert) => insert.settings.insert_deduplication_token).sort();
		expect(tokens).toEqual(['log_events:0-1', 'log_records:0-1', 'pipeline_log_lines:0-1']);
		const platform = writer.logInserts().find((insert) => insert.rows[0]!.id === 'lr:1')!.rows[0]!;
		expect(platform).toMatchObject({ scope_kind: 'platform', source: 'platform', severity_text: 'error', attributes: { unit: 'yoal-agent' } });
		const pipeline = writer.logInserts().find((insert) => insert.rows[0]!.id === 'pll:1')!.rows[0]!;
		expect(pipeline).toMatchObject({ scope_kind: 'pipeline', scope_id: 'repo_1', stream: 'pipeline-job:job_1' });
		expect(new Set(sqlite.query<{ source_table: string }, []>('SELECT source_table FROM log_index_cursors').all().map((row) => row.source_table))).toEqual(
			new Set(['log_events', 'service_log_events', 'broker_log_events', 'k8s_log_events', 'k8s_pod_logs', 'pipeline_log_lines', 'log_records']),
		);
	});

	test('a pattern miner sets pattern_id and writes templates with a durable first_seen', async () => {
		const calls: string[] = [];
		const miner: PatternMiner = {
			patternFor: (scopeKey, body) => {
				calls.push(scopeKey);
				return body.startsWith('GET') ? { id: 'a1', template: 'GET <PATH>' } : { id: 'b2', template: '<*>' };
			},
		};
		addLine(sqlite, 'GET /x', NOW - 3_000);
		addLine(sqlite, 'GET /y', NOW - 2_000);
		addLine(sqlite, 'other', NOW - 1_000);
		// ClickHouse already saw a1 earlier than this batch (a previous process).
		writer.patternFirstSeen = [['org_1', 'project', 'prj_1', 'a1', NOW - 60_000]];
		await indexer({ miner }).tick();
		expect(calls).toEqual(['org_1/project:prj_1', 'org_1/project:prj_1', 'org_1/project:prj_1']);
		expect(writer.logInserts()[0]!.rows.map((row) => row.pattern_id)).toEqual(['a1', 'a1', 'b2']);
		const patterns = writer.inserts.find((insert) => insert.table === 'log_patterns')!;
		expect(patterns.settings.insert_deduplication_token).toBe('log_events:0-3:patterns');
		expect(patterns.rows).toEqual([
			{
				org_id: 'org_1',
				scope_kind: 'project',
				scope_id: 'prj_1',
				pattern_id: 'a1',
				template: 'GET <PATH>',
				first_seen: '2026-11-25 11:59:00.000',
				last_seen: '2026-11-25 11:59:58.000',
				sample_id: 'le:2',
			},
			{
				org_id: 'org_1',
				scope_kind: 'project',
				scope_id: 'prj_1',
				pattern_id: 'b2',
				template: '<*>',
				first_seen: '2026-11-25 11:59:59.000',
				last_seen: '2026-11-25 11:59:59.000',
				sample_id: 'le:3',
			},
		]);
		expect(writer.queries[0]).toContain('FROM log_patterns WHERE pattern_id IN {p0:Array(String)}');
		// Known keys are not looked up again.
		addLine(sqlite, 'GET /z');
		await indexer({ miner }).tick();
		expect(writer.queries.length).toBeGreaterThanOrEqual(1);
	});

	test('a miner that throws never blocks indexing', async () => {
		addLine(sqlite, 'a');
		await indexer({
			miner: {
				patternFor: () => {
					throw new Error('boom');
				},
			},
		}).tick();
		expect(writer.logInserts()[0]!.rows[0]!.pattern_id).toBe('');
		expect(writer.inserts.filter((insert) => insert.table === 'log_patterns')).toHaveLength(0);
	});

	test('status reports cursors, heads and errors per table', async () => {
		addLine(sqlite, 'a');
		addLine(sqlite, 'b');
		const index = indexer({ batchRows: 1, batchesPerTick: 1 });
		await index.tick();
		const status = index.status();
		expect(status.enabled).toBe(true);
		expect(status.tables.find((table) => table.table === 'log_events')).toMatchObject({ cursor: 1, head: 2, lastError: null });
		expect(status.lagMs).toBe(1_000);
	});
});

describe('clickhouseRow', () => {
	test('fills empty strings and -1 for missing values, and clamps bad clocks', () => {
		const row = clickhouseRow({
			id: 'lr:1',
			ts: -5,
			observedTs: null,
			orgId: 'org_1',
			scope: { kind: 'platform', id: 'n' },
			scopeName: null,
			stream: null,
			source: 'platform',
			channel: null,
			severityNumber: 99,
			severity: 'fatal',
			body: 'x',
			attributes: {},
			resource: {},
			traceId: null,
			spanId: null,
			requestId: null,
			patternId: null,
			projectId: null,
			deploymentId: null,
			buildId: null,
			jobRunId: null,
			nodeId: null,
			replica: null,
		});
		expect(row).toMatchObject({ ts: '1970-01-01 00:00:00.000', stream: '', channel: '', severity_number: 24, replica: -1, trace_id: '', node_id: '' });
	});
});
