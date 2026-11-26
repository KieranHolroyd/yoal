import { afterAll, describe, expect, mock, test } from 'bun:test';
import { principalStub } from './principal-stub.test-support';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES, type LogCompareInput, type LogWhyInput } from '@yoal/contracts';
import { LocalObjectStore, buildPrincipal, createCore, type Core } from '@yoal/core';
import { createDb } from '@yoal/db';

/** The Logs Explorer MCP tools and the per-resource wrappers (docs/LOGS.md §6, §8, §11 L7). */

const dir = mkdtempSync(join(tmpdir(), 'yoal-mcp-logs-'));
const opened = createDb({ path: ':memory:' });
const realCore: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: new LocalObjectStore(
			join(dir, 'objects'),
			'https://control.test',
			'object-secret-123'
		),
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		features: { ...DEFAULT_FEATURES }
	}
});

mock.module('./core', () => ({ core: realCore }));
mock.module('./config', () => ({
	platformOrigin: 'https://control.test',
	authSecret: 'test-secret'
}));
mock.module('./principal', () => principalStub({ principalFromMcp: () => null }));

const { yoalToolDefinitions, TOOL_PERMISSIONS } = await import('./mcp');
const { assistantTools } = await import('./assistant/tools');
const { CONFIRM_TOOLS } = await import('./assistant/confirm-policy');
const { legacyLogQuery, parseLogBaseline, resolveLogWindow, spikeWindow } =
	await import('./mcp-logs');

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner' });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
const stranger = buildPrincipal({ kind: 'user', userId: 'user_9', orgId: 'org_2', role: 'owner' });

// --- fixtures: project `api` (org_1) with runtime, build and job lines; project `other` (org_2);
// database `main` (org_1) with two journal lines. Times are relative to now so default windows
// (1h for query_logs) see them.
const NOW = Date.now();
const sql = opened.sqlite;
for (const [id, org, slug] of [
	['prj_api', 'org_1', 'api'],
	['prj_other', 'org_2', 'other']
] as const)
	sql.run(
		`INSERT INTO projects (id, org_id, slug, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'user_1', ?, ?)`,
		[id, org, slug, slug, NOW, NOW]
	);
sql.run(
	`INSERT INTO nodes (id, name, token_hash, created_at, updated_at) VALUES ('node_1', 'edge-a', 'x', ?, ?)`,
	[NOW, NOW]
);
sql.run(
	`INSERT INTO databases (id, org_id, name, version, node_id, host_port, memory_mb, owner_secret, monitor_secret, created_by, created_at, updated_at)
	 VALUES ('db_1', 'org_1', 'main', '17', 'node_1', 5432, 256, 'x', 'x', 'user_1', ?, ?)`,
	[NOW, NOW]
);
const logEvent = (
	project: string,
	org: string,
	level: string,
	message: string,
	ts: number,
	extra: { source?: string; build?: string; job?: string; stream?: string } = {}
) =>
	sql.run(
		`INSERT INTO log_events (org_id, project_id, deployment_id, build_id, job_run_id, node_id, source, stream, level, message, ts)
		 VALUES (?, ?, ?, ?, ?, 'node_1', ?, ?, ?, ?, ?)`,
		[
			org,
			project,
			extra.build ? null : 'dep_1',
			extra.build ?? null,
			extra.job ?? null,
			extra.source ?? 'runtime',
			extra.stream ?? 'stdout',
			level,
			message,
			ts
		]
	);
logEvent('prj_api', 'org_1', 'info', 'GET /health 200', NOW - 50 * 60_000); // le:1
logEvent('prj_api', 'org_1', 'error', 'upstream timeout after 30000ms', NOW - 40 * 60_000, {
	stream: 'stderr'
}); // le:2
logEvent('prj_api', 'org_1', 'warn', 'retrying payment-svc', NOW - 30 * 60_000); // le:3
logEvent('prj_api', 'org_1', 'info', 'Compiling', NOW - 20 * 60_000, {
	source: 'build',
	build: 'b_1'
}); // le:4
logEvent('prj_api', 'org_1', 'info', 'job says hi', NOW - 15 * 60_000, { job: 'jr_1' }); // le:5
logEvent('prj_other', 'org_2', 'error', 'org2 secret timeout', NOW - 10 * 60_000); // le:6
logEvent('prj_api', 'org_1', 'error', 'second timeout', NOW - 5 * 60_000); // le:7
for (const [level, message, ago] of [
	['info', 'database system is ready', 30],
	['warn', 'checkpoint timeout', 20]
] as const)
	sql.run(
		`INSERT INTO service_log_events (org_id, kind, service_id, node_id, source, stream, level, message, ts)
		 VALUES ('org_1', 'database', 'db_1', 'node_1', 'runtime', 'stdout', ?, ?, ?)`,
		[level, message, NOW - ago * 60_000]
	);

async function call(principal: typeof owner, name: string, args: Record<string, unknown>) {
	const tool = assistantTools(principal).find((entry) => entry.name === name);
	if (!tool) throw new Error(`no tool ${name}`);
	const result = await tool.run(args);
	return {
		ok: result.ok,
		text: result.text,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are untyped JSON
		body: result.ok ? (JSON.parse(result.text) as Record<string, any>) : null
	};
}

const NEW_TOOLS = [
	'query_logs',
	'get_log_patterns',
	'get_log_context',
	'compare_logs',
	'explain_log_spike'
];

describe('log tool schemas and permissions', () => {
	const definitions = new Map(yoalToolDefinitions(owner).map((entry) => [entry.name, entry]));

	test('every log tool is read-only, idempotent and never asks to confirm', () => {
		for (const name of [
			...NEW_TOOLS,
			'get_logs',
			'get_database_logs',
			'get_storage_logs',
			'get_broker_logs'
		]) {
			const definition = definitions.get(name);
			expect({ name, annotations: definition?.config.annotations }).toMatchObject({
				name,
				annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
			});
			expect(CONFIRM_TOOLS.has(name)).toBe(false);
			expect(TOOL_PERMISSIONS[name]).toBeUndefined();
		}
	});

	test('reads need logs:read; patterns, compare and Why? also need logs:query', () => {
		expect(definitions.get('query_logs')!.permissions).toEqual(['logs:read']);
		expect(definitions.get('get_log_context')!.permissions).toEqual(['logs:read']);
		expect(definitions.get('get_log_patterns')!.permissions).toEqual(['logs:read', 'logs:query']);
		expect(definitions.get('compare_logs')!.permissions).toEqual(['logs:read', 'logs:query']);
		expect(definitions.get('explain_log_spike')!.permissions).toEqual(['logs:read', 'logs:query']);
	});

	test('a pipe query in query_logs challenges for logs:query', async () => {
		const challenge = definitions.get('query_logs')!.config.scopeChallenge as (
			context: unknown
		) => Promise<unknown>;
		const context = (q: string) => ({
			authInfo: { scopes: ['logs:read'] },
			request: { params: { arguments: { q } } }
		});
		expect(await challenge(context('level:error'))).toBeUndefined();
		expect(await challenge(context('level:error | stats count() by bin(5m)'))).toMatchObject({
			scopes: ['logs:read', 'logs:query']
		});
	});

	test('input schemas accept the documented shapes and reject the rest', () => {
		const schema = (name: string) => definitions.get(name)!.config.inputSchema!;
		expect(
			schema('query_logs').safeParse({ q: 'level:error', scopes: ['api', 'db:main'], range: '24h' })
				.success
		).toBe(true);
		expect(schema('query_logs').safeParse({ range: 'forever' }).success).toBe(false);
		expect(schema('query_logs').safeParse({ limit: 5_000 }).success).toBe(false);
		expect(schema('get_log_context').safeParse({ id: 'le:1', before: 5 }).success).toBe(true);
		expect(schema('compare_logs').safeParse({ baseline: 'deploy:dep_1' }).success).toBe(true);
		expect(schema('compare_logs').safeParse({}).success).toBe(false);
		expect(
			schema('explain_log_spike').safeParse({
				selection: { from: '2026-11-26T10:00:00Z', to: 1_800_000_000_000 }
			}).success
		).toBe(true);
		// The legacy tools keep their params.
		expect(
			schema('get_logs').safeParse({
				project: 'api',
				after: 3,
				level: 'warn',
				q: 'x',
				source: 'build',
				buildId: 'b_1'
			}).success
		).toBe(true);
		expect(
			schema('get_database_logs').safeParse({ database: 'main', after: 1, limit: 2_000 }).success
		).toBe(true);
	});

	test('the tool texts never mention credentials or secrets as something they return', () => {
		for (const name of NEW_TOOLS) {
			const description = String(definitions.get(name)!.config.description);
			expect(description).not.toMatch(/password|secret|token|credential/i);
		}
	});
});

describe('query_logs', () => {
	test("reads the caller's scopes by shorthand, newest first, with an Explorer link", async () => {
		const result = await call(owner, 'query_logs', { q: 'level:warn', scopes: ['api'] });
		expect(result.ok).toBe(true);
		expect(result.body!.records.map((record: { body: string }) => record.body)).toEqual([
			'second timeout',
			'retrying payment-svc',
			'upstream timeout after 30000ms'
		]);
		expect(result.body!.records[0]).toMatchObject({
			id: 'le:7',
			severity: 'error',
			scope: 'api',
			source: 'runtime'
		});
		expect(result.body!.engine).toBe('sqlite');
		expect(result.body!.explorerUrl).toStartWith(
			'https://control.test/logs?q=level%3Awarn&scope=project%3Aprj_api&from='
		);
	});

	test('no scopes means everything readable, never another org', async () => {
		const result = await call(owner, 'query_logs', { q: 'timeout', range: '24h' });
		const bodies = result.body!.records.map((record: { body: string }) => record.body);
		expect(bodies).toContain('upstream timeout after 30000ms');
		expect(bodies).toContain('checkpoint timeout');
		expect(bodies).not.toContain('org2 secret timeout');
		expect(
			result.body!.records.find((record: { body: string }) => record.body === 'checkpoint timeout')
				.scope
		).toBe('db:main');
	});

	test('a scope the caller cannot read is "not found", naming what it can read', async () => {
		const foreign = await call(owner, 'query_logs', { scopes: ['other'] });
		expect(foreign.ok).toBe(false);
		expect(foreign.text).toContain('No project "other" that you can read logs in. Readable: api.');
		const byId = await call(owner, 'query_logs', { scopes: ['project:prj_other'] });
		expect(byId.ok).toBe(false);
		const stranger404 = await call(stranger, 'query_logs', { scopes: ['api'] });
		expect(stranger404.text).toContain('No project "api"');
		expect(stranger404.text).not.toContain('Readable: api');
		const bad = await call(owner, 'query_logs', { scopes: ['galaxy:x'] });
		expect(bad.text).toContain('is not a scope');
	});

	test('a malformed query is a validation error from the shared grammar', async () => {
		const result = await call(owner, 'query_logs', { q: 'level:error | nonsense' });
		expect(result.ok).toBe(false);
	});

	test('viewers can query too', async () => {
		const result = await call(viewer, 'query_logs', { q: 'level:error', scopes: ['api'] });
		expect(result.body!.records).toHaveLength(2);
	});
});

describe('get_log_context', () => {
	test('lines around a record, with the anchor, in its stream', async () => {
		const result = await call(owner, 'get_log_context', { id: 'le:2', before: 1, after: 1 });
		expect(result.ok).toBe(true);
		expect(result.body!.anchor).toMatchObject({
			id: 'le:2',
			body: 'upstream timeout after 30000ms'
		});
		expect(result.body!.explorerUrl).toContain('row=le%3A2');
	});

	test("another org's record reads as missing", async () => {
		const result = await call(owner, 'get_log_context', { id: 'le:6' });
		expect(result.ok).toBe(false);
		expect(result.text).toContain('No log record le:6');
	});
});

describe('compare_logs and explain_log_spike', () => {
	test("they call the explorer's compare/why with contract-shaped input", async () => {
		const service = realCore.logExplorer as unknown as {
			compare?: (principal: unknown, input: LogCompareInput) => Promise<unknown>;
			why?: (principal: unknown, input: LogWhyInput) => Promise<unknown>;
		};
		const saved = { compare: service.compare, why: service.why };
		const seen: unknown[] = [];
		service.compare = async (_principal, input) => {
			seen.push(input);
			return {
				current: { from: input.from, to: input.to, total: 3 },
				baseline: { from: 0, to: 1, total: 1 },
				rows: [
					{
						patternId: 'p1',
						template: 'boom <*>',
						current: 3,
						baseline: 0,
						change: 'new',
						ratio: null,
						sampleId: 'le:7'
					},
					{
						patternId: 'p2',
						template: 'ok',
						current: 1,
						baseline: 1,
						change: 'steady',
						ratio: 1,
						sampleId: null
					}
				],
				engine: 'clickhouse',
				warnings: []
			};
		};
		service.why = async (_principal, input) => {
			seen.push(input);
			return {
				selection: { ...input.selection, total: 2 },
				baseline: { from: input.from, to: input.to, total: 9 },
				rows: [],
				engine: 'clickhouse',
				warnings: []
			};
		};
		try {
			const compared = await call(owner, 'compare_logs', {
				scopes: ['api'],
				baseline: 'deploy:dep_1',
				range: '1h'
			});
			expect(compared.ok).toBe(true);
			expect(compared.body!.rows.map((row: { change: string }) => row.change)).toEqual(['new']);
			expect(seen[0]).toMatchObject({
				q: '',
				scopes: [{ kind: 'project', id: 'prj_api' }],
				baseline: { kind: 'deploy', deploymentId: 'dep_1' },
				limit: 50
			});
			const steady = await call(owner, 'compare_logs', { baseline: '1d', includeSteady: true });
			expect(steady.body!.rows).toHaveLength(2);
			expect(seen[1]).toMatchObject({ baseline: { kind: 'offset', offsetMs: 86_400_000 } });

			const spike = await call(owner, 'explain_log_spike', {
				q: 'level:error',
				selection: { from: NOW - 10 * 60_000, to: NOW - 5 * 60_000 }
			});
			expect(spike.ok).toBe(true);
			expect(seen[2]).toMatchObject({
				q: 'level:error',
				selection: { from: NOW - 10 * 60_000, to: NOW - 5 * 60_000 },
				from: NOW - 70 * 60_000,
				limit: 15
			});
		} finally {
			service.compare = saved.compare;
			service.why = saved.why;
		}
	});

	test('a pipe in the filter is refused', async () => {
		const result = await call(owner, 'compare_logs', { q: '| patterns', baseline: 'previous' });
		expect(result.ok).toBe(false);
		expect(result.text).toContain('only a filter');
	});
});

describe('the per-resource tools, as wrappers over the explorer', () => {
	test('get_logs: newest page oldest first, job output left out, seq cursor', async () => {
		const result = await call(owner, 'get_logs', { project: 'api' });
		expect(result.ok).toBe(true);
		expect(result.body!.events.map((event: { seq: number }) => event.seq)).toEqual([1, 2, 3, 4, 7]);
		expect(result.body!.cursor).toBe(7);
		expect(result.body!.events[1]).toMatchObject({
			seq: 2,
			level: 'error',
			stream: 'stderr',
			source: 'runtime',
			message: 'upstream timeout after 30000ms',
			projectId: 'prj_api',
			deploymentId: 'dep_1'
		});
		expect(result.body!.lines[0]).toMatchObject({ level: 'info', message: 'GET /health 200' });
	});

	test('get_logs: filters and the `after` cursor keep their meaning', async () => {
		const warn = await call(owner, 'get_logs', { project: 'api', level: 'warn' });
		expect(warn.body!.events.map((event: { seq: number }) => event.seq)).toEqual([2, 3, 7]);
		const build = await call(owner, 'get_logs', {
			project: 'api',
			source: 'build',
			buildId: 'b_1'
		});
		expect(build.body!.events.map((event: { message: string }) => event.message)).toEqual([
			'Compiling'
		]);
		const after = await call(owner, 'get_logs', { project: 'api', after: 3 });
		expect(after.body!.events.map((event: { seq: number }) => event.seq)).toEqual([4, 7]);
		expect(after.body!.cursor).toBe(7);
		const none = await call(owner, 'get_logs', { project: 'api', after: 7 });
		expect(none.body!.events).toEqual([]);
		expect(none.body!.cursor).toBe(7);
		const q = await call(owner, 'get_logs', { project: 'api', q: 'TIMEOUT' });
		expect(q.body!.events.map((event: { seq: number }) => event.seq)).toEqual([2, 7]);
	});

	test('get_database_logs reads the service journal by name', async () => {
		const result = await call(owner, 'get_database_logs', { database: 'main' });
		expect(result.body!.events.map((event: { message: string }) => event.message)).toEqual([
			'database system is ready',
			'checkpoint timeout'
		]);
		expect(result.body!.events[0]).toMatchObject({
			kind: 'database',
			serviceId: 'db_1',
			level: 'info'
		});
		const after = await call(owner, 'get_database_logs', { database: 'main', after: 1 });
		expect(after.body!.events.map((event: { seq: number }) => event.seq)).toEqual([2]);
		const missing = await call(owner, 'get_database_logs', { database: 'nope' });
		expect(missing.ok).toBe(false);
	});
});

describe('helpers', () => {
	test('legacy filters become log queries', () => {
		expect(legacyLogQuery({ kind: 'project', id: 'p' }, { level: 'warn', q: 'say "hi"' })).toBe(
			'-job:* level:warn "say \\"hi\\""'
		);
		expect(legacyLogQuery({ kind: 'project', id: 'p' }, { source: 'build', buildId: 'b_1' })).toBe(
			'-job:* build:"b_1"'
		);
		expect(
			legacyLogQuery({ kind: 'project', id: 'p' }, { source: 'runtime', deploymentId: 'dep_1' })
		).toBe('-job:* source:runtime deployment:"dep_1"');
		expect(legacyLogQuery({ kind: 'database', id: 'd' }, { level: 'error' })).toBe('level:error');
	});

	test('windows and baselines', () => {
		const now = 1_800_000_000_000;
		expect(resolveLogWindow({}, now)).toEqual({ from: now - 3_600_000, to: now });
		expect(resolveLogWindow({ range: '15m', to: now - 1_000 }, now)).toEqual({
			from: now - 901_000,
			to: now - 1_000
		});
		expect(resolveLogWindow({ from: '2027-01-15T08:00:00.000Z', to: 0 }, now).from).toBe(0);
		expect(() => resolveLogWindow({ from: 'soon' }, now)).toThrow(/epoch milliseconds/);
		expect(parseLogBaseline('previous', now)).toEqual({ kind: 'previous' });
		expect(parseLogBaseline('7d', now)).toEqual({ kind: 'offset', offsetMs: 604_800_000 });
		expect(() => parseLogBaseline('last week', now)).toThrow(/baseline must be/);
		expect(spikeWindow({}, { from: now - 600_000, to: now - 300_000 }, now)).toEqual({
			from: now - 4_200_000,
			to: now
		});
	});
});
