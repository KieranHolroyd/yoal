import { describe, expect, test } from 'bun:test';
import { createDb } from '@yoal/db';
import { SQLITE_LOG_SOURCES, UNIFIED_LOG_COLUMNS, parseSqliteLogId, unifiedRowToLogRecord, type UnifiedLogRow } from './sqlite-sources.ts';

describe('sqlite log sources', () => {
	const { sqlite } = createDb({ path: ':memory:' });
	sqlite.run(
		`INSERT INTO log_events (org_id, project_id, deployment_id, node_id, source, stream, level, message, ts)
		 VALUES ('org_1', 'prj_1', 'dep_1', 'node_1', 'runtime', 'stdout', 'info', '[r1] {"level":"error","msg":"boom"}', 1000)`,
	);
	sqlite.run(`INSERT INTO pipeline_jobs (id, run_id, org_id, repository_id, key, name, status, spec_json, created_at)
		VALUES ('job_1', 'run_1', 'org_1', 'repo_1', 'build', 'Build', 'in_progress', '{}', 1)`);
	sqlite.run(`INSERT INTO pipeline_log_lines (job_id, run_id, step, stream, text, ts) VALUES ('job_1', 'run_1', 2, 'stderr', 'warning: x', 2000)`);
	sqlite.run(`INSERT INTO log_records (org_id, scope_kind, scope_id, source, severity_number, body, attributes, ts, observed_ts)
		VALUES ('org_1', 'platform', 'node_1', 'platform', 17, 'agent crashed', '{"unit":"yoal-agent"}', 3000, 3001)`);

	test('every source projects the unified columns and unions cleanly', () => {
		for (const source of SQLITE_LOG_SOURCES) {
			const stmt = sqlite.prepare(`${source.select} LIMIT 0`);
			expect(stmt.columnNames).toEqual([...UNIFIED_LOG_COLUMNS]);
		}
		const union = SQLITE_LOG_SOURCES.map((source) => source.select).join('\nUNION ALL\n');
		const rows = sqlite.query<UnifiedLogRow, []>(`SELECT * FROM (${union}) ORDER BY ts`).all();
		expect(rows.length).toBe(3);
		const records = rows.map(unifiedRowToLogRecord);
		expect(records[0]).toMatchObject({ id: 'le:1', replica: 1, severity: 'error', body: 'boom', stream: 'deployment:dep_1' });
		expect(records[1]).toMatchObject({ id: 'pll:1', scope: { kind: 'pipeline', id: 'repo_1' }, severity: 'warn' });
		expect(records[1]!.attributes['pipeline.step']).toBe('2');
		expect(records[2]).toMatchObject({ id: 'lr:1', severity: 'error', attributes: { unit: 'yoal-agent' } });
	});

	test('ids round-trip', () => {
		expect(parseSqliteLogId('kpl:42')).toEqual({ tag: 'kpl', seq: 42 });
		expect(parseSqliteLogId('ch:1')).toBeNull();
	});
});
