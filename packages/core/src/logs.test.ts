import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-logs-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(
	join(dir, 'objects'),
	'https://control.test',
	'object-secret-123',
);
let clock = Date.now();

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
		now: () => clock,
	},
});

const principal = buildPrincipal({
	kind: 'user',
	userId: 'user_1',
	orgId: 'org_1',
	role: 'owner',
	platformAdmin: true,
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

async function projectWithBuild(): Promise<{
	project: ReturnType<typeof core.projects.requireRow>;
	buildId: string;
	nodeId: string;
	deploymentId: string;
}> {
	const slug = `logs-${Math.random().toString(36).slice(2, 8)}`;
	await core.projects.create(principal, {
		name: slug,
		slug,
		runtime: 'static',
		placement: 'edge',
		productionAccess: 'public',
		previewAccess: 'platform',
	});
	const project = core.projects.requireRow(principal, slug);
	core.builds.upsertGitSource(principal, project, {
		repoUrl: 'https://github.com/acme/logs.git',
		branch: 'main',
		rootDir: '.',
		buildCommand: 'bun run build',
		outputDir: 'dist',
		enabled: true,
	});
	const node = core.nodes.join({
		token: core.nodes.createJoinToken(principal, `builder-${slug}`).token,
		name: `builder-${slug}`,
	});
	core.nodes.setBuilder(principal, node.nodeId, true);
	const build = core.builds.enqueue(principal, project, {
		ref: 'main',
		promote: false,
	});
	expect((await core.builds.claim(node.nodeId))?.buildId).toBe(build.id);
	const deployment = await core.deployments.deployEntries(
		principal,
		project,
		[{ path: 'index.html', data: new TextEncoder().encode('<h1>hi</h1>') }],
		{ promote: true },
	);
	return {
		project: core.projects.requireRow(principal, slug),
		buildId: build.id,
		nodeId: node.nodeId,
		deploymentId: deployment.id,
	};
}

describe('log drain', () => {
	test('stores ordered build chunks and queries from a cursor', async () => {
		const { project, buildId, nodeId } = await projectWithBuild();
		expect(
			core.logs.appendBuild(nodeId, buildId, {
				stream: 'stdout',
				lines: ['bun install', 'installed 120 packages'],
			}),
		).toBe(true);
		clock += 10;
		expect(
			core.logs.appendBuild(nodeId, buildId, {
				stream: 'stderr',
				lines: ['warning: peer dependency'],
			}),
		).toBe(true);

		const all = core.logs.query(principal, project, {
			source: 'build',
			buildId,
		});
		expect(all.events.map((event) => event.message)).toEqual([
			'bun install',
			'installed 120 packages',
			'warning: peer dependency',
		]);
		expect(all.events[0]?.level).toBe('info');
		expect(all.events[2]?.level).toBe('warn');
		expect(all.events[2]?.stream).toBe('stderr');

		const after = core.logs.query(principal, project, {
			source: 'build',
			buildId,
			after: all.events[0]!.seq,
		});
		expect(after.events).toHaveLength(2);
		expect(after.cursor).toBe(all.cursor);
	});

	test('extracts structured build lines but keeps the raw text', async () => {
		const { project, buildId, nodeId } = await projectWithBuild();
		const embedded = Date.parse('2026-11-04T09:00:00Z');
		expect(
			core.logs.appendBuild(nodeId, buildId, {
				stream: 'stdout',
				lines: [`{"level":"error","time":${embedded},"msg":"build broke"}`],
			}),
		).toBe(true);

		const all = core.logs.query(principal, project, {
			source: 'build',
			buildId,
		});
		expect(all.events).toHaveLength(1);
		expect(all.events[0]?.level).toBe('error');
		expect(all.events[0]?.message).toBe('build broke');
		expect(all.events[0]?.ts).toBe(embedded);

		const row = opened.sqlite
			.query<{ log: string }, [string]>('SELECT log FROM builds WHERE id = ?')
			.get(buildId);
		expect(row?.log).toContain(`{"level":"error","time":${embedded},"msg":"build broke"}`);
	});

	test('appends runtime lines only for the workload node', async () => {
		const { project, nodeId, deploymentId } = await projectWithBuild();
		opened.sqlite.run(
			`INSERT INTO workloads (id, org_id, project_id, deployment_id, node_id, runtime, status, spec_json, memory_mb, cpus, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'process', 'running', '{}', 128, 1, ?, ?)`,
			[
				'wld_test',
				project.orgId,
				project.id,
				deploymentId,
				nodeId,
				clock,
				clock,
			],
		);

		const stored = core.logs.appendRuntime(nodeId, {
			workloadId: 'wld_test',
			lines: [
				{
					ts: clock,
					stream: 'stdout',
					level: 'info',
					message: 'listening on :3000',
				},
				{ ts: clock, stream: 'stderr', level: 'error', message: 'boom' },
			],
		});
		expect(stored).toBe(2);

		const runtime = core.logs.query(principal, project, {
			source: 'runtime',
			deploymentId,
		});
		expect(runtime.events.map((event) => event.message)).toEqual([
			'listening on :3000',
			'boom',
		]);
		expect(
			runtime.events.every((event) => event.deploymentId === deploymentId),
		).toBe(true);

		expect(() =>
			core.logs.appendRuntime('nod_other', {
				workloadId: 'wld_test',
				lines: [
					{ ts: clock, stream: 'stdout', level: 'info', message: 'nope' },
				],
			}),
		).toThrow(/another node/);
	});

	test('extracts structured levels, messages and timestamps from runtime lines', async () => {
		const { project, nodeId, deploymentId } = await projectWithBuild();
		const workloadId = `wld_structured_${Math.random().toString(36).slice(2, 8)}`;
		opened.sqlite.run(
			`INSERT INTO workloads (id, org_id, project_id, deployment_id, node_id, runtime, status, spec_json, memory_mb, cpus, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'process', 'running', '{}', 128, 1, ?, ?)`,
			[
				workloadId,
				project.orgId,
				project.id,
				deploymentId,
				nodeId,
				clock,
				clock,
			],
		);

		const embedded = Date.parse('2026-11-04T09:00:00Z');
		const stored = core.logs.appendRuntime(nodeId, {
			workloadId,
			lines: [
				{
					ts: clock,
					stream: 'stdout',
					level: 'info',
					message: `{"level":"warn","time":${embedded},"msg":"slow request"}`,
				},
				{
					stream: 'stdout',
					level: 'error',
					message: `level=debug msg="cache warm" ts=${embedded}`,
				},
			],
		});
		expect(stored).toBe(2);

		const runtime = core.logs.query(principal, project, {
			source: 'runtime',
			deploymentId,
		});
		expect(runtime.events.map((event) => event.message)).toEqual([
			'slow request',
			'cache warm',
		]);
		// The agent's own ts wins for the JSON line; logfmt without one uses the embedded time.
		expect(runtime.events[0]?.level).toBe('warn');
		expect(runtime.events[0]?.ts).toBe(clock);
		expect(runtime.events[1]?.level).toBe('debug');
		expect(runtime.events[1]?.ts).toBe(embedded);
	});

	test('parses rows stored before ingestion parsing when they are read', async () => {
		const { project, nodeId, deploymentId } = await projectWithBuild();
		const insert = (level: string, message: string) =>
			opened.sqlite.run(
				`INSERT INTO log_events (org_id, project_id, deployment_id, node_id, source, stream, level, message, ts)
				 VALUES (?, ?, ?, ?, 'runtime', 'stdout', ?, ?, ?)`,
				[project.orgId, project.id, deploymentId, nodeId, level, message, clock],
			);
		insert('info', '[r1] {"level":50,"msg":"db down"}');
		insert('info', 'error: bun is unable to write files: EROFS');
		insert('warn', 'INFO retrying');
		insert('info', 'Started the workload.');

		const events = core.logs.query(principal, project, {
			source: 'runtime',
			deploymentId,
		}).events;
		expect(events.map((event) => [event.level, event.message])).toEqual([
			['error', '[r1] db down'],
			['error', 'error: bun is unable to write files: EROFS'],
			// A level the node already chose is kept.
			['warn', 'retrying'],
			['info', 'Started the workload.'],
		]);
	});

	test('requires logs:read and prunes by age', async () => {
		const { project } = await projectWithBuild();
		const reader = buildPrincipal({
			kind: 'apiKey',
			userId: 'user_1',
			orgId: 'org_1',
			role: 'viewer',
			granted: ['project:read'],
		});
		expect(() => core.logs.query(reader, project, {})).toThrow(/logs:read/);

		const pruned = core.logs.prune(clock + 1_000, 500);
		expect(pruned).toBeGreaterThan(0);
	});
});

describe('per-scope caps and append listeners (docs/LOGS.md §4.4, §10.2)', () => {
	test('a noisy scope trims only its own history, in every hot-tail table', () => {
		const now = clock + 10_000_000;
		const insert = opened.sqlite.prepare(
			`INSERT INTO log_events (org_id, project_id, source, stream, level, message, ts) VALUES ('org_1', ?, 'runtime', 'stdout', 'info', ?, ?)`,
		);
		const record = opened.sqlite.prepare(
			`INSERT INTO log_records (org_id, scope_kind, scope_id, source, body, ts, observed_ts) VALUES ('org_1', 'platform', ?, 'platform', ?, ?, ?)`,
		);
		opened.sqlite.transaction(() => {
			for (let index = 0; index < 12; index += 1) insert.run('prj_noisy', `noisy ${index}`, now + index);
			for (let index = 0; index < 3; index += 1) insert.run('prj_quiet', `quiet ${index}`, now + index);
			for (let index = 0; index < 8; index += 1) record.run('node_a', `unit ${index}`, now + index, now + index);
		})();
		core.logs.prune(now, 86_400_000, 5);
		const count = (sql: string, value: string): number =>
			opened.sqlite.query<{ n: number }, [string]>(sql).get(value)!.n;
		expect(count('SELECT COUNT(*) AS n FROM log_events WHERE project_id = ?', 'prj_noisy')).toBe(5);
		expect(count('SELECT COUNT(*) AS n FROM log_events WHERE project_id = ?', 'prj_quiet')).toBe(3);
		expect(count('SELECT COUNT(*) AS n FROM log_records WHERE scope_id = ?', 'node_a')).toBe(5);
		const kept = opened.sqlite
			.query<{ message: string }, [string]>('SELECT message FROM log_events WHERE project_id = ? ORDER BY seq')
			.all('prj_noisy')
			.map((row) => row.message);
		expect(kept).toEqual(['noisy 7', 'noisy 8', 'noisy 9', 'noisy 10', 'noisy 11']);
	});

	test('the sweep prunes by age every time, but caps at most every 15 minutes and only counted scopes', () => {
		let now = clock + 20_000_000;
		const insert = opened.sqlite.prepare(
			`INSERT INTO log_events (org_id, project_id, source, stream, level, message, ts) VALUES ('org_1', ?, 'runtime', 'stdout', 'info', ?, ?)`,
		);
		const rows = (project: string): number =>
			opened.sqlite.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM log_events WHERE project_id = ?').get(project)!.n;
		const burst = (project: string, count: number) =>
			opened.sqlite.transaction(() => {
				for (let index = 0; index < count; index += 1) insert.run(project, `${project} ${index}`, now + index);
			})();
		// The first sweep runs the full pass.
		core.logs.prune(now, undefined, 5);
		burst('prj_capped', 12);
		burst('prj_uncounted', 12);
		// Within 15 minutes: no cap pass, but the age DELETE still runs.
		insert.run('prj_old', 'ancient', now - 400 * 86_400_000);
		now += 60_000;
		core.logs.prune(now, undefined, 5);
		expect(rows('prj_old')).toBe(0);
		expect(rows('prj_capped')).toBe(12);
		// After 15 minutes the cap pass runs for scopes whose counted lines exceed the cap only.
		opened.sqlite.run(
			`INSERT INTO log_ingest_daily (org_id, scope_kind, scope_id, project_id, day, lines, bytes) VALUES ('org_1', 'project', 'prj_capped', 'prj_capped', ?, 12, 120)`,
			[Math.floor(now / 86_400_000) * 86_400_000],
		);
		now += 15 * 60_000;
		core.logs.prune(now, undefined, 5);
		expect(rows('prj_capped')).toBe(5);
		expect(rows('prj_uncounted')).toBe(12);
		// The daily full pass catches rows written without counting.
		now += 86_400_000;
		core.logs.prune(now, undefined, 5);
		expect(rows('prj_uncounted')).toBe(5);
	});

	test('every append path hands its inserted rows to onAppend listeners, unified', async () => {
		const { project, deploymentId } = await projectWithBuild();
		const received: Array<{ tag: string; body: string; scope: string }> = [];
		const listener = (rows: Array<{ tag: string; body: string; scope_kind: string; scope_id: string }>): void => {
			for (const row of rows) received.push({ tag: row.tag, body: row.body, scope: `${row.scope_kind}:${row.scope_id}` });
		};
		core.logs.onAppend.push(listener);
		try {
			core.logs.appendSystem({ orgId: 'org_1', projectId: project.id, deploymentId, message: 'breadcrumb' });
			core.logs.appendServiceSystem({ kind: 'broker', serviceId: 'brk_1', orgId: 'org_1', message: 'broker restarted' });
			core.logs.appendServiceSystem({ kind: 'storage', serviceId: 'st_1', orgId: 'org_1', message: 'storage restarted' });
		} finally {
			core.logs.onAppend.splice(core.logs.onAppend.indexOf(listener), 1);
		}
		expect(received).toEqual([
			{ tag: 'le', body: 'breadcrumb', scope: `project:${project.id}` },
			{ tag: 'ble', body: 'broker restarted', scope: 'broker:brk_1' },
			{ tag: 'sle', body: 'storage restarted', scope: 'storage:st_1' },
		]);
	});

	test('a throwing listener never breaks an append', async () => {
		const { project } = await projectWithBuild();
		const broken = (): void => {
			throw new Error('listener bug');
		};
		core.logs.onAppend.push(broken);
		const originalError = console.error;
		console.error = () => {};
		try {
			expect(() => core.logs.appendSystem({ orgId: 'org_1', projectId: project.id, message: 'still stored' })).not.toThrow();
		} finally {
			console.error = originalError;
			core.logs.onAppend.splice(core.logs.onAppend.indexOf(broken), 1);
		}
		expect(core.logs.query(principal, project, { source: 'system' }).events.at(-1)?.message).toBe('still stored');
	});
});
