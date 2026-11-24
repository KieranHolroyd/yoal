import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, PUBLIC_DB_CAPABILITY, desiredStateSchema, type FeatureFlags } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

/** Public database access (docs/DATABASES.md §19, D241). */
const GIB = 1024 ** 3;
const dir = mkdtempSync(join(tmpdir(), 'yoal-public-db-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-24T10:00:00Z');
const features: { -readonly [K in keyof FeatureFlags]: FeatureFlags[K] } = { ...DEFAULT_FEATURES };

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
		features,
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const deployer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'deployer' });
const mcp = buildPrincipal({ kind: 'mcp', userId: 'user_1', orgId: 'org_1', role: 'owner' });

let edgeToken = '';
let edgeId = '';

function heartbeat(capabilities: string[], extra: Record<string, unknown> = {}) {
	core.nodes.heartbeat(edgeToken, {
		nodeId: edgeId,
		agentVersion: '0.1.0',
		actualStateVersion: 1,
		status: 'online',
		caddyOk: true,
		capabilities,
		stats: { cpuPercent: 5, memoryBytes: GIB, memoryTotalBytes: 8 * GIB, diskUsedBytes: GIB, diskTotalBytes: 100 * GIB, diskFreeBytes: 99 * GIB },
		releases: [],
		...extra,
	} as never);
}

function failure(fn: () => unknown): { status: number; message: string } {
	try {
		fn();
	} catch (error) {
		return error as { status: number; message: string };
	}
	throw new Error('expected the call to throw');
}

async function desired() {
	return desiredStateSchema.parse(await core.nodes.desiredState(edgeToken));
}

/** A ready named credential: created, then confirmed by the node as the real flow does. */
function readyCredential(database: string, role: 'app' | 'readonly') {
	const created = core.databases.createCredential(owner, database, { role });
	core.databases.applyCredentialResults(edgeId, [{ taskId: created.id, databaseId: created.databaseId, status: 'ok' }]);
	return created;
}

beforeAll(() => {
	const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
	edgeToken = joined.token;
	edgeId = joined.nodeId;
	core.nodes.update(owner, edgeId, { sliceMemoryMb: 8192 });
	heartbeat(['node-tasks']);
	core.databases.create(owner, { name: 'main-db', memoryMb: 512 });
	core.databases.create(owner, { name: 'cache', engine: 'valkey', memoryMb: 256 });
	core.databases.create(owner, { name: 'legacy', engine: 'mysql', memoryMb: 512 });
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('database public access', () => {
	test('is off by default and refused until an ingress can serve it', () => {
		expect(core.databases.get(owner, 'main-db').publicAccess).toEqual({
			enabled: false,
			status: 'disabled',
			host: null,
			port: null,
			expiresAt: null,
		});
		const refused = failure(() =>
			core.databasePublicAccess.enable(owner, 'main-db', { rules: [{ cidr: '203.0.113.0/24' }], credentials: ['owner'] }),
		);
		expect(refused.message).toContain(PUBLIC_DB_CAPABILITY);
	});

	test('validates sources, roles, engine and permission before writing anything', () => {
		heartbeat(['node-tasks', PUBLIC_DB_CAPABILITY]);
		const enable = (principal = owner, input: Record<string, unknown>, name = 'main-db') =>
			failure(() => core.databasePublicAccess.enable(principal, name, input));
		expect(enable(owner, { rules: [], credentials: ['owner'] }).message).toContain('at least one CIDR');
		expect(enable(owner, { rules: [{ cidr: '10.0.0.0/8' }], credentials: ['owner'] }).message).toContain('private');
		expect(enable(owner, { rules: [{ cidr: '203.0.113.9/24' }], credentials: ['owner'] }).message).toContain('203.0.113.0/24');
		expect(enable(owner, { rules: [{ cidr: '0.0.0.0/0' }], credentials: ['owner'] }).message).toContain('broader');
		expect(enable(owner, { allowAnywhere: true, credentials: ['owner'] }).message).toContain('DB_PUBLIC_ANYWHERE');
		expect(enable(owner, { rules: [{ cidr: '203.0.113.0/24' }] }).message).toContain('Choose the credentials');
		expect(enable(owner, { rules: [{ cidr: '203.0.113.0/24' }], credentials: ['app'] }).status).toBe(404);
		expect(enable(owner, { rules: [{ cidr: '203.0.113.0/24' }], credentials: ['monitor'] }).status).toBe(404);
		expect(enable(owner, { rules: [{ cidr: '203.0.113.0/24' }] }, 'legacy').message).toContain('MySQL');
		expect(enable(owner, { rules: [{ cidr: '203.0.113.0/24' }], credentials: ['owner'] }, 'cache').message).toContain('Only Postgres');
		// Deployers may change a database but not open it to the internet; models never may.
		expect(enable(deployer, { rules: [{ cidr: '203.0.113.0/24' }], credentials: ['owner'] }).status).toBe(403);
		expect(enable(mcp, { rules: [{ cidr: '203.0.113.0/24' }], credentials: ['owner'] }).status).toBe(403);
		expect(core.databasePublicAccess.get(owner, 'main-db').enabled).toBe(false);
	});

	test('enabling renders a locked-down listener on the ingress and an audited view', async () => {
		const app = readyCredential('main-db', 'app');
		const view = core.databasePublicAccess.enable(owner, 'main-db', {
			rules: [
				{ cidr: '203.0.113.0/24', label: 'office' },
				{ cidr: '2a01:4f8:c0c::/48', label: 'ci' },
				{ cidr: '203.0.113.0/24', label: 'duplicate' },
			],
			credentials: ['app'],
			maxConnections: 5,
		});
		expect(view).toMatchObject({
			enabled: true,
			status: 'pending',
			protocol: 'postgres',
			host: 'main-db-org1.db.sites.test',
			port: 24_000,
			rules: [
				{ cidr: '203.0.113.0/24', label: 'office' },
				{ cidr: '2a01:4f8:c0c::/48', label: 'ci' },
			],
			credentials: [{ id: app.id, role: 'app', username: app.username, usable: true }],
			maxConnections: 5,
			connectionTemplate: 'postgres://<user>:<password>@main-db-org1.db.sites.test:24000/main_db?sslmode=require',
		});
		const db = core.databases.get(owner, 'main-db');
		expect(db.publicAccess).toMatchObject({ enabled: true, port: 24_000, host: 'main-db-org1.db.sites.test' });
		const state = await desired();
		expect(state.publicDatabases).toEqual([
			{
				id: db.id,
				port: 24_000,
				protocol: 'postgres',
				host: 'main-db-org1.db.sites.test',
				certificateNames: ['main-db-org1.db.sites.test', '*.db.sites.test'],
				allow: ['203.0.113.0/24', '2a01:4f8:c0c::/48'],
				users: [app.username],
				upstreamPort: 15_432,
				maxConnections: 5,
				expiresAt: null,
				version: 1,
			},
		]);
		const audit = core.audit.list({ orgId: 'org_1' }).find((entry) => entry.action === 'database.public-access.enable');
		expect(JSON.parse(audit?.argsJson ?? '{}')).toMatchObject({ rules: ['203.0.113.0/24 (office)', '2a01:4f8:c0c::/48 (ci)'], credentials: [app.id] });
	});

	test('the credential reveal adds the outside URL only for an allowed role', () => {
		expect(core.databases.credentials(owner, 'main-db').publicUrl).toBeNull();
		const app = core.databases.listCredentials(owner, 'main-db').find((item) => item.role === 'app')!;
		const revealed = core.databases.revealCredential(owner, 'main-db', app.id);
		expect(revealed.publicUrl).toBe(
			`postgres://${app.username}:${encodeURIComponent(revealed.password)}@main-db-org1.db.sites.test:24000/main_db?sslmode=require`,
		);
	});

	test('heartbeat reports drive the status and keep recent refusals', () => {
		const db = core.databases.get(owner, 'main-db');
		heartbeat(['node-tasks', PUBLIC_DB_CAPABILITY], {
			publicDatabases: [
				{ id: db.id, state: 'listening', error: null, open: 2, accepted: 9, refused: 3, authFailures: 1, banned: 0, version: 1 },
				{ id: 'db_unknown', state: 'listening', error: null, open: 0, accepted: 0, refused: 0, authFailures: 0, banned: 0, version: 1 },
			],
			publicDatabaseEvents: [{ id: db.id, at: new Date(clock).toISOString(), source: '198.51.100.4', reason: 'source', detail: null }],
		});
		const view = core.databasePublicAccess.get(owner, 'main-db');
		expect(view.status).toBe('active');
		expect(view.nodes).toEqual([
			expect.objectContaining({ nodeId: edgeId, state: 'listening', open: 2, accepted: 9, refused: 3, authFailures: 1 }),
		]);
		expect(view.events).toEqual([{ at: new Date(clock).toISOString(), nodeId: edgeId, source: '198.51.100.4', reason: 'source', detail: null }]);
	});

	test('an update bumps the version; a revoked role drops out of the listener', async () => {
		const readonly = readyCredential('main-db', 'readonly');
		core.databasePublicAccess.enable(owner, 'main-db', { rules: [{ cidr: '198.51.100.0/24' }], credentials: ['app', readonly.id] });
		let listener = (await desired()).publicDatabases?.[0];
		expect(listener).toMatchObject({ version: 2, allow: ['198.51.100.0/24'], port: 24_000 });
		expect(listener?.users).toHaveLength(2);
		// The old report is for version 1: the view no longer counts it as current.
		expect(core.databasePublicAccess.get(owner, 'main-db').status).toBe('pending');
		core.databases.revokeCredential(owner, 'main-db', readonly.id);
		listener = (await desired()).publicDatabases?.[0];
		expect(listener?.users).toEqual([core.databases.listCredentials(owner, 'main-db').find((item) => item.role === 'app')!.username]);
		expect(core.audit.list({ orgId: 'org_1' }).some((entry) => entry.action === 'database.public-access.update')).toBe(true);
	});

	test('disabling needs only database:update and closes the listener', async () => {
		const view = core.databasePublicAccess.disable(deployer, 'main-db');
		expect(view).toMatchObject({ enabled: false, status: 'disabled', port: 24_000, disabledReason: 'manual' });
		expect((await desired()).publicDatabases).toBeUndefined();
		// The port is kept for a re-enable; another database gets the next one.
		const cache = core.databasePublicAccess.enable(owner, 'cache', { rules: [{ cidr: '203.0.113.0/24' }] });
		expect(cache).toMatchObject({ port: 24_001, protocol: 'tls', connectionTemplate: 'rediss://cache:<password>@cache-org1.db.sites.test:24001/0' });
		expect(core.databasePublicAccess.enable(owner, 'main-db', { rules: [{ cidr: '203.0.113.0/24' }], credentials: ['owner'] }).port).toBe(24_000);
		expect(core.databases.credentials(owner, 'main-db').publicUrl).toContain('@main-db-org1.db.sites.test:24000/');
	});

	test('expiry closes the listener at once and maintenance records it', async () => {
		core.databasePublicAccess.enable(owner, 'cache', {
			rules: [{ cidr: '203.0.113.0/24' }],
			expiresAt: new Date(clock + 3_600_000).toISOString(),
		});
		expect((await desired()).publicDatabases?.map((item) => item.port)).toEqual([24_000, 24_001]);
		expect(failure(() => core.databasePublicAccess.enable(owner, 'cache', { rules: [{ cidr: '203.0.113.0/24' }], expiresAt: new Date(clock - 1).toISOString() })).status).toBe(422);
		clock += 3_600_001;
		expect((await desired()).publicDatabases?.map((item) => item.port)).toEqual([24_000]);
		expect(core.databasePublicAccess.sweep()).toEqual({ expired: 1, forgotten: 0 });
		expect(core.databasePublicAccess.get(owner, 'cache')).toMatchObject({ enabled: false, disabledReason: 'expired' });
		expect(core.audit.list({ orgId: 'org_1' }).some((entry) => entry.action === 'database.public-access.expire')).toBe(true);
	});

	test('the kill switch closes every listener and refuses enabling', async () => {
		features.DB_PUBLIC_ACCESS = false;
		try {
			expect((await desired()).publicDatabases).toBeUndefined();
			expect(core.databasePublicAccess.get(owner, 'main-db').status).toBe('disabled');
			expect(failure(() => core.databasePublicAccess.enable(owner, 'cache', { rules: [{ cidr: '203.0.113.0/24' }] })).status).toBe(403);
		} finally {
			features.DB_PUBLIC_ACCESS = true;
		}
	});

	test('a deleted database loses public access', async () => {
		core.databases.delete(owner, 'main-db');
		expect((await desired()).publicDatabases).toBeUndefined();
		expect(core.databasePublicAccess.get(owner, 'cache').enabled).toBe(false);
		core.databases.restore(owner, 'main-db');
		expect(core.databases.get(owner, 'main-db').publicAccess.enabled).toBe(false);
	});

	test('the operator-managed public URL is never revealed over MCP', () => {
		core.databases.setPublicUrl(owner, 'cache', { url: 'redis://u:p@tunnel.example.com:6379/0' });
		expect(failure(() => core.databases.revealPublicUrl(mcp, 'cache')).status).toBe(403);
	});
});
