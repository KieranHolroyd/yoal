import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../../../packages/db/src/index.ts';
import { releaseRuns } from './release-runs.ts';

test('reads the release-command runs of one project since a time, with the node name', () => {
	const db = new Database(':memory:', { create: true, strict: true });
	migrate(db);
	const cols = (table: string) => new Set(db.query<{ name: string; notnull: number; dflt_value: unknown }, []>(`PRAGMA table_info(${table})`).all().filter((c) => c.notnull && c.dflt_value === null).map((c) => c.name));
	// Fill only the NOT NULL columns without a default, whatever later migrations added.
	const insert = (table: string, row: Record<string, unknown>) => {
		const required = cols(table);
		const full: Record<string, unknown> = { ...row };
		for (const name of required) if (!(name in full)) full[name] = name.endsWith('_at') ? 1 : 'x';
		const keys = Object.keys(full);
		db.run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((key) => full[key]) as never);
	};
	insert('nodes', { id: 'node_c', name: 'lab-c' });
	insert('projects', { id: 'prj_1', org_id: 'org_1', slug: 'ha-rolling', name: 'ha-rolling' });
	insert('projects', { id: 'prj_2', org_id: 'org_1', slug: 'other', name: 'other' });
	const run = (id: string, project: string, created: number, extra: Record<string, unknown> = {}) =>
		insert('release_command_runs', { id, release_id: `dep_${id}`, org_id: 'org_1', project_id: project, workload_id: 'wl', status: 'failed', command_json: '[]', timeout_seconds: 60, created_at: created, updated_at: created, ...extra });
	run('rc_old', 'prj_1', 100);
	run('rc_1', 'prj_1', 1_000, { status: 'succeeded', node_id: 'node_c', started_at: 1_100, finished_at: 2_000, exit_code: 0 });
	run('rc_q', 'prj_1', 1_500, { status: 'queued' });
	run('rc_other', 'prj_2', 1_000);
	expect(releaseRuns(db, 'ha-rolling', 500)).toEqual([
		{ id: 'rc_1', releaseId: 'dep_rc_1', attempt: 1, status: 'succeeded', nodeName: 'lab-c', createdAt: 1_000, startedAt: 1_100, finishedAt: 2_000, exitCode: 0 },
		{ id: 'rc_q', releaseId: 'dep_rc_q', attempt: 1, status: 'queued', nodeName: null, createdAt: 1_500, startedAt: null, finishedAt: null, exitCode: null },
	]);
});
