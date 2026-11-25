import type { Database } from 'bun:sqlite';
import { createDb } from '@yoal/db';

/**
 * A small hot tail spread over every adapter and two orgs, for the lite compiler and store tests.
 *
 * org_1: project `api` (prj_a: le:1–4, lr:2), project `web` (prj_b: le:5), database `main-db`
 * (sle:1), pipeline repo `mono` (pll:1). org_2: project `api2` (prj_x: le:6). Platform: node_1
 * `edge-a` (lr:1, stamped with the sentinel org `platform`).
 */
export const T0 = 1_700_000_000_000;

export function seedLogFixtures(): Database {
	const { sqlite } = createDb({ path: ':memory:' });
	const now = T0;
	for (const [id, org, slug] of [
		['prj_a', 'org_1', 'api'],
		['prj_b', 'org_1', 'web'],
		['prj_x', 'org_2', 'api2'],
	] as const)
		sqlite.run(
			`INSERT INTO projects (id, org_id, slug, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'user_1', ?, ?)`,
			[id, org, slug, slug, now, now],
		);
	for (const [id, name] of [
		['node_1', 'edge-a'],
		['node_2', 'edge-b'],
	] as const)
		sqlite.run(`INSERT INTO nodes (id, name, token_hash, created_at, updated_at) VALUES (?, ?, 'x', ?, ?)`, [id, name, now, now]);
	sqlite.run(
		`INSERT INTO databases (id, org_id, name, version, node_id, host_port, memory_mb, owner_secret, monitor_secret, created_by, created_at, updated_at)
		 VALUES ('db_1', 'org_1', 'main-db', '17', 'node_1', 5432, 256, 'x', 'x', 'user_1', ?, ?)`,
		[now, now],
	);
	const logEvent = (
		org: string,
		project: string,
		deployment: string | null,
		build: string | null,
		node: string | null,
		source: string,
		stream: string,
		level: string,
		message: string,
		ts: number,
	): void => {
		sqlite.run(
			`INSERT INTO log_events (org_id, project_id, deployment_id, build_id, node_id, source, stream, level, message, ts)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[org, project, deployment, build, node, source, stream, level, message, ts],
		);
	};
	logEvent('org_1', 'prj_a', 'dep_1', null, 'node_1', 'runtime', 'stdout', 'info', 'GET /health 200', T0 + 1_000);
	logEvent('org_1', 'prj_a', 'dep_1', null, 'node_1', 'runtime', 'stderr', 'error', '[r1] upstream timeout after 30000ms', T0 + 2_000);
	logEvent('org_1', 'prj_a', 'dep_1', null, 'node_1', 'runtime', 'stdout', 'warn', 'retrying payment-svc (attempt 3)', T0 + 3_000);
	logEvent('org_1', 'prj_a', null, 'b_1', 'node_1', 'build', 'stdout', 'info', 'Compiling 100%_done', T0 + 4_000);
	logEvent('org_1', 'prj_b', 'dep_2', null, 'node_2', 'runtime', 'stdout', 'info', 'web started', T0 + 5_000);
	logEvent('org_2', 'prj_x', 'dep_x', null, 'node_2', 'runtime', 'stderr', 'error', 'org2 secret timeout', T0 + 6_000);
	sqlite.run(
		`INSERT INTO service_log_events (org_id, kind, service_id, node_id, source, stream, level, message, ts)
		 VALUES ('org_1', 'database', 'db_1', 'node_1', 'runtime', 'stdout', 'warn', 'checkpoint timeout', ?)`,
		[T0 + 2_500],
	);
	sqlite.run(
		`INSERT INTO pipeline_repositories (id, org_id, name, clone_url, created_by, created_at, updated_at)
		 VALUES ('repo_1', 'org_1', 'mono', 'https://git.test/mono.git', 'user_1', ?, ?)`,
		[now, now],
	);
	sqlite.run(`INSERT INTO pipeline_jobs (id, run_id, org_id, repository_id, key, name, status, spec_json, created_at)
		VALUES ('job_1', 'run_1', 'org_1', 'repo_1', 'build', 'Build', 'in_progress', '{}', 1)`);
	sqlite.run(
		`INSERT INTO pipeline_log_lines (job_id, run_id, step, stream, text, ts) VALUES ('job_1', 'run_1', 2, 'stderr', 'warning: deprecated', ?)`,
		[T0 + 3_500],
	);
	sqlite.run(
		`INSERT INTO log_records (org_id, scope_kind, scope_id, stream, source, severity_number, body, attributes, ts, observed_ts)
		 VALUES ('platform', 'platform', 'node_1', 'unit:yoal-agent', 'platform', 17, 'agent crashed', '{"unit":"yoal-agent"}', ?, ?)`,
		[T0 + 4_500, T0 + 4_500],
	);
	sqlite.run(
		`INSERT INTO log_records (org_id, scope_kind, scope_id, stream, source, severity_number, body, attributes, resource, request_id, project_id, ts, observed_ts)
		 VALUES ('org_1', 'project', 'prj_a', 'site:api.test', 'access', 17, 'GET /v1/orders 502 1234ms',
		         '{"http.status":"502","http.route":"/v1/orders"}', '{"replica":"2"}', 'req-1', 'prj_a', ?, ?)`,
		[T0 + 4_600, T0 + 4_600],
	);
	return sqlite;
}
