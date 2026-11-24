import { afterAll, describe, expect, mock, test } from 'bun:test';
import { principalStub } from './principal-stub.test-support';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES, nodeCapabilities } from '@yoal/contracts';
import { LocalObjectStore, buildPrincipal, createCore, type Core } from '@yoal/core';
import { createDb } from '@yoal/db';

/** Public database access over MCP (D241): one read-only tool; enabling is never offered. */

const dir = mkdtempSync(join(tmpdir(), 'yoal-mcp-db-public-'));
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

const { yoalToolDefinitions } = await import('./mcp');
const { assistantTools } = await import('./assistant/tools');

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const owner = buildPrincipal({
	kind: 'user',
	userId: 'user_1',
	orgId: 'org_1',
	role: 'owner',
	platformAdmin: true
});

describe('database public access tool', () => {
	test('only the read tool exists, and it returns the view without secrets', async () => {
		const edge = realCore.nodes.join({
			token: realCore.nodes.createJoinToken(owner, 'edge').token,
			name: 'edge'
		});
		realCore.nodes.update(owner, edge.nodeId, { sliceMemoryMb: 4096 });
		realCore.nodes.heartbeat(edge.token, {
			nodeId: edge.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 0,
			status: 'online',
			caddyOk: true,
			releases: [],
			capabilities: [...nodeCapabilities]
		});
		realCore.databases.create(owner, { name: 'main-db', memoryMb: 512 });
		realCore.databasePublicAccess.enable(owner, 'main-db', {
			rules: [{ cidr: '203.0.113.0/24', label: 'office' }],
			credentials: ['owner']
		});

		const names = yoalToolDefinitions(owner).map((entry) => entry.name);
		expect(names).toContain('get_database_public_access');
		expect(names.filter((name) => name.includes('public_access'))).toEqual([
			'get_database_public_access'
		]);
		const definition = yoalToolDefinitions(owner).find(
			(entry) => entry.name === 'get_database_public_access'
		);
		expect(definition?.config.annotations).toMatchObject({ readOnlyHint: true });

		const tool = assistantTools(owner).find(
			(entry) => entry.name === 'get_database_public_access'
		)!;
		const result = await tool.run({ database: 'main-db' });
		expect(result.ok).toBe(true);
		const body = JSON.parse(result.text) as Record<string, unknown>;
		expect(body).toMatchObject({
			enabled: true,
			host: 'main-db-org1.db.sites.test',
			port: 24000,
			rules: [{ cidr: '203.0.113.0/24', label: 'office' }]
		});
		expect(result.text).not.toContain('password":');
	});
});
