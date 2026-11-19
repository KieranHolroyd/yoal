import { afterAll, describe, expect, mock, test } from 'bun:test';
import { principalStub } from './principal-stub.test-support';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES, type KubernetesGenerateResult } from '@yoal/contracts';
import { LocalObjectStore, buildPrincipal, createCore, type Core } from '@yoal/core';
import { createDb } from '@yoal/db';

/**
 * The config-from-text tools (docs/KUBERNETES.md §18): `generate_k8s_config` with the model call
 * stubbed, and `apply_k8s_config` dry runs against a fake API server. Neither returns a token.
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-mcp-k8s-write-'));
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

const generated: KubernetesGenerateResult = {
	summary: 'nginx on shop with 2 replicas.',
	yaml: 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n',
	objects: [{ kind: 'Deployment', name: 'web', namespace: 'shop' }],
	findings: [
		{
			severity: 'info',
			document: 0,
			object: 'Deployment/web',
			path: null,
			message: 'Added resources.',
			fixed: true
		}
	],
	assumptions: ['Port 80.'],
	questions: [],
	ok: true,
	rounds: 1,
	model: 'stub-model',
	dryRun: null
};
const generateCalls: unknown[][] = [];

mock.module('./core', () => ({ core: realCore }));
mock.module('./config', () => ({
	platformOrigin: 'https://control.test',
	authSecret: 'test-secret'
}));
mock.module('./principal', () => principalStub({ principalFromMcp: () => null }));
mock.module('./kubernetes-ai', () => ({
	generateKubernetesConfig: async (...args: unknown[]) => {
		generateCalls.push(args);
		return generated;
	},
	prepareKubernetesGeneration: async () => async () => generated
}));

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

/** A tiny API server: discovery for v1 and apps/v1, and server-side apply PATCHes. */
function fakeApi() {
	const seen: Array<{ method: string; url: string }> = [];
	const fetcher = async (url: string, init?: RequestInit) => {
		const parsed = new URL(url);
		seen.push({ method: init?.method ?? 'GET', url });
		if (parsed.pathname === '/api/v1')
			return Response.json({
				resources: [
					{ name: 'services', kind: 'Service', namespaced: true },
					{ name: 'namespaces', kind: 'Namespace', namespaced: false }
				]
			});
		if (parsed.pathname === '/apis/apps/v1')
			return Response.json({
				resources: [{ name: 'deployments', kind: 'Deployment', namespaced: true }]
			});
		if (init?.method === 'PATCH') return Response.json({ metadata: { resourceVersion: '1' } });
		return new Response('{"reason":"NotFound"}', { status: 404 });
	};
	return { fetcher, seen };
}

const deployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
spec:
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:1.27
---
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: shop
spec:
  selector:
    app: web
  ports:
    - port: 80
`;

describe('Kubernetes config tools', () => {
	test('are offered by permission: readers write configs, only editors apply (after a click)', () => {
		const names = new Set(yoalToolDefinitions(owner).map((entry) => entry.name));
		expect(names.has('generate_k8s_config')).toBe(true);
		expect(names.has('apply_k8s_config')).toBe(true);
		expect(TOOL_PERMISSIONS.apply_k8s_config).toBe('kubernetes:edit');

		const ownerTools = assistantTools(owner);
		const apply = ownerTools.find((entry) => entry.name === 'apply_k8s_config');
		expect(apply?.destructive).toBe(true);
		expect(ownerTools.find((entry) => entry.name === 'generate_k8s_config')?.destructive).toBe(
			false
		);

		const viewerTools = new Set(assistantTools(viewer).map((entry) => entry.name));
		expect(viewerTools.has('generate_k8s_config')).toBe(true);
		expect(viewerTools.has('apply_k8s_config')).toBe(false);
	});

	test('generate_k8s_config passes the request through and returns the result', async () => {
		const result = await call(viewer, 'generate_k8s_config', {
			cluster: 'lab',
			prompt: 'nginx serving a static site on shop, 2 replicas',
			namespace: 'shop',
			yaml: '   ',
			dryRun: true
		});
		expect(result.ok).toBe(true);
		expect(result.body).toEqual(generated as never);
		expect(generateCalls).toHaveLength(1);
		const [principal, cluster, options] = generateCalls[0]!;
		expect((principal as { userId: string }).userId).toBe('user_2');
		expect(cluster).toBe('lab');
		// Blank YAML means "start over".
		expect(options).toEqual({
			prompt: 'nginx serving a static site on shop, 2 replicas',
			namespace: 'shop',
			dryRun: true
		});
		expect(result.text).not.toMatch(/"token"|kubeconfig|k8s_groups/);
	});

	test('apply_k8s_config dry-runs against the cluster as the caller and reports per object', async () => {
		const joined = realCore.nodes.join({
			token: realCore.nodes.createJoinToken(owner, 'w1').token,
			name: 'w1'
		});
		realCore.nodes.update(owner, joined.nodeId, { sliceMemoryMb: 8192 });
		const beat = (extra: Record<string, unknown> = {}) =>
			realCore.nodes.heartbeat(joined.token, {
				nodeId: joined.nodeId,
				agentVersion: '0.1.0',
				actualStateVersion: 1,
				status: 'online',
				caddyOk: true,
				releases: [],
				capabilities: ['kubernetes', 'kubernetes-userns'],
				kubernetes: { minors: ['1.37'], tiers: ['userns'], error: null },
				...extra
			} as never);
		beat();
		const cluster = realCore.kubernetes.create(owner, { name: 'lab', placement: joined.nodeId });
		beat({ workloads: [{ id: cluster.machines[0]!.id, status: 'running', restarts: 0 }] });

		const api = fakeApi();
		realCore.kubernetes.apiFetch = api.fetcher;
		const dry = await call(owner, 'apply_k8s_config', {
			cluster: 'lab',
			yaml: deployment,
			dryRun: true
		});
		expect({ ok: dry.ok, text: dry.ok ? '' : dry.text }).toEqual({ ok: true, text: '' });
		expect(dry.body?.dryRun).toBe(true);
		expect(dry.body?.ok).toBe(true);
		expect(
			dry.body?.outcomes.map(
				(outcome: { kind: string; ok: boolean }) => `${outcome.kind}:${outcome.ok}`
			)
		).toEqual(['Service:true', 'Deployment:true']);
		const patches = api.seen.filter((entry) => entry.method === 'PATCH');
		expect(patches.length).toBe(2);
		expect(patches.every((entry) => entry.url.includes('dryRun=All'))).toBe(true);
		expect(dry.text).not.toMatch(/"token"|Bearer|kubeconfig/);

		// The assistant chat confirmed it, so a real apply runs here.
		const applied = await call(owner, 'apply_k8s_config', { cluster: 'lab', yaml: deployment });
		expect(applied.ok).toBe(true);
		expect(applied.body?.dryRun).toBe(false);
		expect(
			api.seen.filter((entry) => entry.method === 'PATCH' && !entry.url.includes('dryRun')).length
		).toBe(2);
	});

	test('bad YAML is an error, not an apply', async () => {
		const result = await call(owner, 'apply_k8s_config', {
			cluster: 'lab',
			yaml: 'kind: [unclosed',
			dryRun: true
		});
		expect(result.ok).toBe(false);
		expect(result.text).toContain('does not parse');
	});
});
