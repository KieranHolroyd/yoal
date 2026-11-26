import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import type { LogSearchResult } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { CoreError } from './errors.ts';
import { LOG_TAIL_CATCH_UP_LIMIT } from './log-explorer.ts';
import { LogStoreUnsupported, type LogStore } from './log-store/types.ts';

/**
 * Logs Explorer service against a real core: tenancy (§15 "cross-tenant leakage"), platform
 * scopes, store selection, and the live tail over `LogService.append*`.
 */
const dir = mkdtempSync(join(tmpdir(), 'yoal-log-explorer-'));
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
const admin = buildPrincipal({ kind: 'user', userId: 'user_admin', orgId: 'org_1', role: 'owner', platformAdmin: true });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
// The guest lives in its own org: in a bare core (no Better Auth member rows) a project binding
// bumps the org's IAM version, which retires the legacy-role fallback the other principals use.
const guestOwner = buildPrincipal({ kind: 'user', userId: 'user_g', orgId: 'org_g', role: 'owner' });
const guest = buildPrincipal({ kind: 'user', userId: 'user_guest', orgId: 'org_g', role: 'guest' });
const otherOrg = buildPrincipal({ kind: 'user', userId: 'user_9', orgId: 'org_2', role: 'owner' });

const ids: Record<string, string> = {};

async function project(principal: typeof owner, slug: string): Promise<string> {
	await core.projects.create(principal, {
		name: slug,
		slug,
		runtime: 'static',
		placement: 'edge',
		productionAccess: 'public',
		previewAccess: 'platform',
	});
	return core.projects.requireRow(principal, slug).id;
}

function line(principal: typeof owner, projectId: string, message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
	clock += 10;
	core.logs.appendSystem({ orgId: principal.orgId, projectId, message, level });
}

const recent = (extra: Record<string, unknown> = {}) => ({ from: clock - 3_600_000, to: clock + 1, ...extra });
const bodies = (result: LogSearchResult): string[] => result.records.map((record) => record.body);

beforeAll(async () => {
	ids.api = await project(owner, 'shop');
	ids.web = await project(owner, 'blog');
	ids.secret = await project(otherOrg, 'vault');
	opened.sqlite.run(
		`INSERT INTO databases (id, org_id, name, version, node_id, host_port, memory_mb, owner_secret, monitor_secret, created_by, created_at, updated_at)
		 VALUES ('db_main', 'org_1', 'main-db', '17', 'node_x', 5432, 256, 'x', 'x', 'user_1', ?, ?)`,
		[clock, clock],
	);
	opened.sqlite.run(`INSERT INTO nodes (id, name, token_hash, created_at, updated_at) VALUES ('node_p', 'edge-p', 'x', ?, ?)`, [clock, clock]);
	ids.gOne = await project(guestOwner, 'g-one');
	ids.gTwo = await project(guestOwner, 'g-two');
	line(guestOwner, ids.gOne!, 'guest project line');
	line(guestOwner, ids.gTwo!, 'other guest-org project line');
	core.ctx.iam.grantGuestProject({ orgId: 'org_g', userId: 'user_guest', projectId: ids.gOne!, roleId: 'viewer', createdBy: 'user_g' });
	line(owner, ids.api!, 'api request ok');
	line(owner, ids.api!, 'api timeout talking to db', 'error');
	line(owner, ids.web!, 'web started');
	line(otherOrg, ids.secret!, 'org2 secret timeout', 'error');
	clock += 10;
	core.logs.appendServiceSystem({ kind: 'database', serviceId: 'db_main', orgId: 'org_1', message: 'checkpoint timeout', level: 'warn' });
	clock += 10;
	opened.sqlite.run(
		`INSERT INTO log_records (org_id, scope_kind, scope_id, stream, source, severity_number, body, ts, observed_ts)
		 VALUES ('platform', 'platform', 'node_p', 'unit:yoal-agent', 'platform', 17, 'agent crashed timeout', ?, ?)`,
		[clock, clock],
	);
});

afterAll(() => {
	core.logExplorer.tailBus.closeAll();
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('boundary and tenancy', () => {
	test('capabilities list the scopes the caller may read, in lite mode', async () => {
		const capabilities = await core.logExplorer.capabilities(owner);
		expect(capabilities.engine).toBe('sqlite');
		expect(capabilities.features.stats).toBe(false);
		expect(capabilities.platformAdmin).toBe(false);
		expect(capabilities.scopes.map((scope) => `${scope.kind}:${scope.name}`).sort()).toEqual(['database:main-db', 'project:blog', 'project:shop']);
		const adminScopes = (await core.logExplorer.capabilities(admin)).scopes.map((scope) => `${scope.kind}:${scope.name}`);
		expect(adminScopes).toContain('platform:edge-p');
	});

	test('the default read is everything the org can see, newest first, with scope names', async () => {
		const result = await core.logExplorer.search(owner, recent({ q: 'timeout' }));
		expect(bodies(result)).toEqual(['checkpoint timeout', 'api timeout talking to db']);
		expect(result.records.map((record) => record.scopeName)).toEqual(['main-db', 'shop']);
	});

	test('org A never sees org B, even when it names B’s scope', async () => {
		const named = await core.logExplorer.search(owner, recent({ scopes: [{ kind: 'project', id: ids.secret }] }));
		expect(named.records).toEqual([]);
		const mine = await core.logExplorer.search(otherOrg, recent());
		expect(bodies(mine)).toEqual(['org2 secret timeout']);
		const reverse = await core.logExplorer.search(otherOrg, recent({ scopes: [{ kind: 'project', id: ids.api }] }));
		expect(reverse.records).toEqual([]);
		expect(await core.logExplorer.get(otherOrg, mine.records[0]!.id)).not.toBeNull();
		const ownerRecord = (await core.logExplorer.search(owner, recent({ q: 'api request' }))).records[0]!;
		expect(await core.logExplorer.get(otherOrg, ownerRecord.id)).toBeNull();
		expect((await core.logExplorer.context(otherOrg, { id: ownerRecord.id })).anchor).toBeNull();
	});

	test('a project-only principal sees only its project', async () => {
		const result = await core.logExplorer.search(guest, recent());
		expect(bodies(result)).toEqual(['guest project line']);
		const other = await core.logExplorer.search(guest, recent({ scopes: [{ kind: 'project', id: ids.gTwo }] }));
		expect(other.records).toEqual([]);
		const capabilities = await core.logExplorer.capabilities(guest);
		expect(capabilities.scopes.map((scope) => scope.id)).toEqual([ids.gOne!]);
	});

	test('only platform admins read platform records, and those reads are audited', async () => {
		const platform = [{ kind: 'platform' as const, id: 'node_p' }];
		expect((await core.logExplorer.search(owner, recent({ scopes: platform }))).records).toEqual([]);
		expect((await core.logExplorer.search(otherOrg, recent({ scopes: platform }))).records).toEqual([]);
		const auditCount = (): number =>
			opened.sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'logs.read_platform'`).get()!.n;
		expect(auditCount()).toBe(0);
		// The default read never includes platform scopes, even for an admin.
		expect(bodies(await core.logExplorer.search(admin, recent({ q: 'crashed' })))).toEqual([]);
		expect(auditCount()).toBe(0);
		const read = await core.logExplorer.search(admin, recent({ scopes: platform }));
		expect(bodies(read)).toEqual(['agent crashed timeout']);
		expect(read.records[0]!.scopeName).toBe('edge-p');
		expect(auditCount()).toBe(1);
		const record = await core.logExplorer.get(admin, read.records[0]!.id);
		expect(record?.body).toBe('agent crashed timeout');
		expect(auditCount()).toBe(2);
		expect(await core.logExplorer.get(owner, read.records[0]!.id)).toBeNull();
	});

	test('a principal without logs:read is refused outright', async () => {
		const nobody = buildPrincipal({ kind: 'user', userId: 'user_nobody', orgId: 'org_3', role: 'guest' });
		await expect(core.logExplorer.search(nobody, recent())).rejects.toMatchObject({ status: 403 });
		await expect(core.logExplorer.capabilities(nobody)).rejects.toMatchObject({ status: 403 });
	});

	test('invalid input and cursors are 4xx, not 500', async () => {
		await expect(core.logExplorer.search(owner, { limit: 0 } as never)).rejects.toMatchObject({ status: 422 });
		await expect(core.logExplorer.search(owner, recent({ cursor: 'p.nope' }))).rejects.toMatchObject({ code: 'invalid_cursor', status: 400 });
		await expect(core.logExplorer.table(owner, recent({ q: 'x' }))).rejects.toMatchObject({ code: 'pipes_required' });
	});
});

describe('histogram, fields and context', () => {
	test('histogram counts by severity with deploy markers when there are deploys', async () => {
		const result = await core.logExplorer.histogram(viewer, { ...recent(), buckets: 10 });
		expect(result.total).toBe(4);
		expect(result.buckets.reduce((sum, bucket) => sum + (bucket.counts.error ?? 0), 0)).toBe(1);
		expect(Array.isArray(result.markers)).toBe(true);
	});

	test('fields summarise built-ins for the boundary only', async () => {
		const result = await core.logExplorer.fields(owner, recent({ fields: ['service', 'level'] }));
		const service = result.fields.find((field) => field.name === 'service')!;
		expect(service.topValues.map((value) => value.value).sort()).toEqual(['blog', 'main-db', 'shop']);
	});

	test('context stays in the anchor’s stream and scope', async () => {
		const anchor = (await core.logExplorer.search(owner, recent({ q: 'api timeout' }))).records[0]!;
		const result = await core.logExplorer.context(owner, { id: anchor.id, before: 10, after: 10 });
		expect(result.anchor?.id).toBe(anchor.id);
		expect(result.before.map((record) => record.body)).toEqual(['api request ok']);
		expect(result.after).toEqual([]);
	});
});

describe('store selection', () => {
	const hooks = core.ctx as unknown as { logStoreClickhouse?: unknown };
	afterAll(() => {
		delete hooks.logStoreClickhouse;
	});

	function fakeStore(search: LogStore['search'], healthy = true): LogStore & { healthy(): boolean } {
		const unsupported = async (): Promise<never> => {
			throw new Error('not in this fake');
		};
		return {
			engine: 'clickhouse',
			healthy: () => healthy,
			search,
			table: unsupported,
			histogram: unsupported,
			fields: unsupported,
			context: unsupported,
			get: unsupported,
		};
	}

	test('a healthy ClickHouse store answers, with the server boundary', async () => {
		let seen: string[] = [];
		hooks.logStoreClickhouse = fakeStore(async (read) => {
			seen = read.boundary.scopes.map((scope) => scope.id);
			return { records: [], cursor: { older: null, newer: null }, engine: 'clickhouse', warnings: [], elapsedMs: 0 };
		});
		const result = await core.logExplorer.search(otherOrg, recent());
		expect(result.engine).toBe('clickhouse');
		expect(seen).toEqual([ids.secret!]);
		expect((await core.logExplorer.capabilities(otherOrg)).engine).toBe('clickhouse');
	});

	test('an unhealthy store is skipped; a failing one falls back to SQLite with a warning', async () => {
		hooks.logStoreClickhouse = fakeStore(async () => {
			throw new Error('should not be called');
		}, false);
		expect((await core.logExplorer.search(otherOrg, recent())).engine).toBe('sqlite');
		hooks.logStoreClickhouse = fakeStore(async () => {
			throw new Error('ClickHouse down');
		});
		const fallback = await core.logExplorer.search(otherOrg, recent());
		expect(fallback.engine).toBe('sqlite');
		expect(bodies(fallback)).toEqual(['org2 secret timeout']);
		expect(fallback.warnings.map((warning) => warning.code)).toContain('partial');
	});

	test('what a store cannot answer is a 422 needs_clickhouse', async () => {
		hooks.logStoreClickhouse = fakeStore(async () => {
			throw new LogStoreUnsupported('Regular expressions need the search index.', 'regex');
		});
		const failure = await core.logExplorer.search(otherOrg, recent()).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(CoreError);
		expect(failure).toMatchObject({ code: 'needs_clickhouse', status: 422 });
	});
});

describe('live tail', () => {
	test('appends reach a matching subscriber in its boundary only, with names', async () => {
		const session = core.logExplorer.openTail(owner, { q: 'tail-check' });
		try {
			expect(session.initial.records).toEqual([]);
			line(owner, ids.api!, 'tail-check one');
			line(owner, ids.api!, 'unrelated');
			line(otherOrg, ids.secret!, 'tail-check other org');
			const batch = await session.next(1_000);
			expect(batch.records.map((record) => record.body)).toEqual(['tail-check one']);
			expect(batch.records[0]!.scopeName).toBe('shop');
			expect(batch.cursor.startsWith('t.')).toBe(true);
		} finally {
			session.close();
		}
		expect(core.logExplorer.tailBus.size).toBe(0);
	});

	test('managed-service appends publish too', async () => {
		const session = core.logExplorer.openTail(viewer, { scopes: [{ kind: 'database', id: 'db_main' }] });
		try {
			core.logs.appendServiceSystem({ kind: 'database', serviceId: 'db_main', orgId: 'org_1', message: 'restarted' });
			const batch = await session.next(1_000);
			expect(batch.records.map((record) => [record.id.split(':')[0], record.body])).toEqual([['sle', 'restarted']]);
		} finally {
			session.close();
		}
	});

	test('a reconnect with Last-Event-ID replays exactly what it missed', async () => {
		const first = core.logExplorer.openTail(owner, { q: 'resume' });
		line(owner, ids.api!, 'resume 1');
		const batch = await first.next(1_000);
		first.close();
		line(owner, ids.api!, 'resume 2');
		line(owner, ids.web!, 'resume 3');
		const second = core.logExplorer.openTail(owner, { q: 'resume', lastEventId: batch.cursor });
		try {
			expect(second.initial.records.map((record) => record.body)).toEqual(['resume 2', 'resume 3']);
			expect(second.initial.dropped).toBe(0);
			line(owner, ids.api!, 'resume 4');
			expect((await second.next(1_000)).records.map((record) => record.body)).toEqual(['resume 4']);
		} finally {
			second.close();
		}
	});

	test('a reconnect too far behind gets the newest lines and a dropped count', async () => {
		const first = core.logExplorer.openTail(owner, { q: 'flood' });
		const cursor = first.cursor;
		first.close();
		const insert = opened.sqlite.prepare(
			`INSERT INTO log_events (org_id, project_id, source, stream, level, message, ts) VALUES ('org_1', ?, 'system', 'system', 'info', ?, ?)`,
		);
		opened.sqlite.transaction(() => {
			for (let index = 0; index < LOG_TAIL_CATCH_UP_LIMIT + 3; index += 1) insert.run(ids.api!, `flood ${index}`, clock + index);
		})();
		const second = core.logExplorer.openTail(owner, { q: 'flood', lastEventId: cursor });
		try {
			expect(second.initial.records.length).toBe(LOG_TAIL_CATCH_UP_LIMIT);
			expect(second.initial.dropped).toBe(3);
			expect(second.initial.records.at(-1)!.body).toBe(`flood ${LOG_TAIL_CATCH_UP_LIMIT + 2}`);
		} finally {
			second.close();
		}
	});

	test('backfill sends the newest matching lines first; platform tails are audited', async () => {
		const session = core.logExplorer.openTail(owner, { q: 'api', backfill: 2 });
		expect(session.initial.records.map((record) => record.body)).toEqual(['api request ok', 'api timeout talking to db']);
		session.close();
		const before = opened.sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'logs.read_platform'`).get()!.n;
		core.logExplorer.openTail(admin, { scopes: [{ kind: 'platform', id: 'node_p' }] }).close();
		const after = opened.sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'logs.read_platform'`).get()!.n;
		expect(after).toBe(before + 1);
	});

	test('with no tail open, appends skip the publish read', () => {
		expect(core.logExplorer.tailBus.size).toBe(0);
		expect(core.logs.appendWanted()).toBe(false);
		const session = core.logExplorer.openTail(owner);
		expect(core.logs.appendWanted()).toBe(true);
		session.close();
	});
});
