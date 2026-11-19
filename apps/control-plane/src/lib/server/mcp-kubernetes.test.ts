import { afterAll, describe, expect, mock, test } from 'bun:test';
import { principalStub } from './principal-stub.test-support';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES } from '@yoal/contracts';
import { LocalObjectStore, buildPrincipal, createCore, type Core } from '@yoal/core';
import { createDb } from '@yoal/db';

/**
 * The managed Kubernetes lifecycle tools (docs/KUBERNETES.md §11) against a real core. No tool may
 * hand out a cluster token, an access-key kubeconfig or the admin certificate (D58).
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-mcp-k8s-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(
	join(dir, 'objects'),
	'https://control.test',
	'object-secret-123'
);
const realCore: Core = createCore({
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
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });

const TOOLS = [
	'list_k8s_clusters',
	'get_k8s_cluster',
	'create_k8s_cluster',
	'update_k8s_cluster',
	'delete_k8s_cluster',
	'add_k8s_route',
	'attach_to_k8s_cluster',
	'list_k8s_backups',
	'backup_k8s_cluster',
	'restore_k8s_backup',
	'k8s_pod_logs'
];

async function call(principal: typeof owner, name: string, args: Record<string, unknown>) {
	const tool = assistantTools(principal).find((entry) => entry.name === name);
	if (!tool) throw new Error(`no tool ${name}`);
	const result = await tool.run(args);
	return {
		ok: result.ok,
		text: result.text,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool JSON, read loosely
		body: result.ok ? (JSON.parse(result.text) as Record<string, any>) : null
	};
}

describe('Kubernetes MCP tools', () => {
	test('are registered with kubernetes:* permissions; viewers only see the reads', () => {
		const names = new Set(yoalToolDefinitions(owner).map((entry) => entry.name));
		for (const name of TOOLS) expect(names.has(name)).toBe(true);
		expect(TOOL_PERMISSIONS.create_k8s_cluster).toBe('kubernetes:create');
		expect(TOOL_PERMISSIONS.delete_k8s_cluster).toBe('kubernetes:delete');
		const viewerTools = new Set(assistantTools(viewer).map((entry) => entry.name));
		expect(viewerTools.has('list_k8s_clusters')).toBe(true);
		expect(viewerTools.has('create_k8s_cluster')).toBe(false);
		expect(viewerTools.has('delete_k8s_cluster')).toBe(false);
	});

	test('no tool mints a token or hands out a kubeconfig (D58)', () => {
		const names = yoalToolDefinitions(owner).map((entry) => entry.name);
		expect(
			names.filter(
				(name) => /k8s|kubernetes/.test(name) && /token|kubeconfig|credential|access_key/.test(name)
			)
		).toEqual([]);
	});

	test('create, get, update, route and delete a cluster', async () => {
		const joined = realCore.nodes.join({
			token: realCore.nodes.createJoinToken(owner, 'edge').token,
			name: 'edge'
		});
		realCore.nodes.update(owner, joined.nodeId, { sliceMemoryMb: 16_384 });
		realCore.nodes.heartbeat(joined.token, {
			nodeId: joined.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 0,
			status: 'online',
			caddyOk: true,
			capabilities: ['kubernetes', 'kubernetes-userns'],
			releases: []
		} as never);

		// The only node is the edge, which `auto` never picks (K25): name it.
		const created = await call(owner, 'create_k8s_cluster', {
			name: 'lab',
			memoryMb: 2048,
			placement: joined.nodeId
		});
		expect(created.text).not.toContain('k8s_groups');
		expect({ ok: created.ok, text: created.ok ? '' : created.text }).toEqual({
			ok: true,
			text: ''
		});
		expect(created.body?.cluster.name).toBe('lab');
		expect(created.body?.cluster.tier).toBe('userns');

		const got = await call(viewer, 'get_k8s_cluster', { cluster: 'lab' });
		expect(got.ok).toBe(true);
		expect(got.text).not.toMatch(/"token"|kubeconfig/);

		const scaled = await call(owner, 'update_k8s_cluster', { cluster: 'lab', agents: 1 });
		expect(scaled.ok).toBe(true);
		expect(scaled.body?.cluster.agents).toBe(1);

		const route = await call(owner, 'add_k8s_route', { cluster: 'lab', name: 'shop' });
		expect(route.ok).toBe(true);
		expect(route.body?.route.host).toBe('shop.sites.test');

		const backups = await call(owner, 'list_k8s_backups', { cluster: 'lab' });
		expect(backups.ok).toBe(true);
		const logs = await call(viewer, 'k8s_pod_logs', { cluster: 'lab' });
		expect(logs.ok).toBe(true);
		expect(Object.keys(logs.body ?? {})).toEqual(['lines']);

		const listed = await call(owner, 'list_k8s_clusters', {});
		expect(listed.body?.clusters.map((item: { name: string }) => item.name)).toEqual(['lab']);

		const deleted = await call(owner, 'delete_k8s_cluster', { cluster: 'lab' });
		expect(deleted.ok).toBe(true);
		expect(deleted.body?.restorable).toBe(true);
	});
});
