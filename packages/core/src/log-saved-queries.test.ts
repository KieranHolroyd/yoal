import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-log-saved-'));
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

const admin = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'admin' });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
const deployer = buildPrincipal({ kind: 'user', userId: 'user_3', orgId: 'org_1', role: 'deployer' });
const otherOrg = buildPrincipal({ kind: 'user', userId: 'user_9', orgId: 'org_2', role: 'owner' });
const guest = buildPrincipal({ kind: 'user', userId: 'user_g', orgId: 'org_1', role: 'guest' });
const saved = core.logExplorer.saved;

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('saved log queries', () => {
	const created: Record<string, string> = {};

	test('create fills defaults and records an audit entry', () => {
		const personal = saved.create(admin, { name: 'My errors', q: 'level:error' });
		expect(personal).toMatchObject({
			name: 'My errors',
			q: 'level:error',
			scopes: [],
			range: { relative: '1h' },
			columns: [],
			visibility: 'personal',
			ownerId: 'user_1',
		});
		created.personal = personal.id;
		created.shared = saved.create(admin, {
			name: 'API 5xx',
			q: 'service:api',
			scopes: [{ kind: 'project', id: 'prj_1' }],
			range: { relative: '24h' },
			visibility: 'org',
		}).id;
		clock += 1;
		created.viewerOwn = saved.create(viewer, { name: 'Viewer org view', q: 'timeout', visibility: 'org' }).id;
		const audits = opened.sqlite
			.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'log_query.create'`)
			.get()!.n;
		expect(audits).toBe(3);
	});

	test('personal queries are visible to their owner only; org queries to the org', () => {
		expect(saved.list(admin).map((query) => query.name)).toEqual(['API 5xx', 'My errors', 'Viewer org view']);
		expect(saved.list(viewer).map((query) => query.name)).toEqual(['API 5xx', 'Viewer org view']);
		expect(() => saved.get(viewer, created.personal!)).toThrow(/not found/);
		expect(saved.get(viewer, created.shared!).scopes).toEqual([{ kind: 'project', id: 'prj_1' }]);
	});

	test('another org sees nothing and cannot touch anything', () => {
		expect(saved.list(otherOrg)).toEqual([]);
		expect(() => saved.get(otherOrg, created.shared!)).toThrow(/not found/);
		expect(() => saved.update(otherOrg, created.shared!, { name: 'x' })).toThrow(/not found/);
		expect(() => saved.delete(otherOrg, created.shared!)).toThrow(/not found/);
	});

	test('owners edit their own; someone else’s org query needs logQuery:manage', () => {
		expect(saved.update(viewer, created.viewerOwn!, { name: 'Renamed' }).name).toBe('Renamed');
		expect(() => saved.update(viewer, created.shared!, { name: 'Hijack' })).toThrow(/logQuery:manage/);
		expect(() => saved.delete(deployer, created.shared!)).toThrow(/logQuery:manage/);
		const patched = saved.update(admin, created.viewerOwn!, { columns: ['level', 'body'] });
		expect(patched).toMatchObject({ name: 'Renamed', columns: ['level', 'body'], visibility: 'org', ownerId: 'user_2' });
	});

	test('a patch leaves omitted fields alone and validates the rest', () => {
		const before = saved.get(admin, created.shared!);
		const after = saved.update(admin, created.shared!, { visibility: 'personal' });
		expect(after).toMatchObject({ name: before.name, q: before.q, scopes: before.scopes, range: before.range, visibility: 'personal' });
		expect(() => saved.update(admin, created.shared!, { name: '' })).toThrow(/Invalid saved query/);
		expect(() => saved.create(admin, { name: 'x', q: 'y', range: { relative: 'forever' } })).toThrow(/Invalid saved query/);
		expect(saved.list(viewer).map((query) => query.name)).toEqual(['Renamed']);
	});

	test('delete removes it; a principal without logQuery permissions is refused', () => {
		saved.delete(admin, created.personal!);
		expect(() => saved.get(admin, created.personal!)).toThrow(/not found/);
		expect(() => saved.list(guest)).toThrow(/logQuery:read/);
		expect(() => saved.create(guest, { name: 'x', q: '' })).toThrow(/logQuery:create/);
	});
});
