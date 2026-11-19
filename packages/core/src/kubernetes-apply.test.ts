import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';
import { KubernetesApiClient } from './kubernetes-api.ts';

/** Server-side apply and dry runs as the caller (docs/KUBERNETES.md §18). */
const dir = mkdtempSync(join(tmpdir(), 'yoal-k8s-apply-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
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
		now: () => Date.parse('2026-11-18T10:00:00Z'),
		features: { ...DEFAULT_FEATURES },
	},
});
const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_3', orgId: 'org_1', role: 'viewer' });
afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

/** A tiny fake API server: discovery for v1 and apps/v1, SSA that records what it saw. */
function fakeApi(options: { forbid?: string } = {}) {
	const seen: Array<{ method: string; url: string; auth: string | null; body: unknown }> = [];
	const existing = new Set<string>(['/api/v1/namespaces/apps/services/web']);
	const fetcher = async (url: string, init?: RequestInit) => {
		const parsed = new URL(url);
		const headers = new Headers(init?.headers);
		seen.push({ method: init?.method ?? 'GET', url, auth: headers.get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
		if (parsed.pathname === '/api/v1')
			return Response.json({ resources: [{ name: 'services', kind: 'Service', namespaced: true }, { name: 'configmaps', kind: 'ConfigMap', namespaced: true }, { name: 'namespaces', kind: 'Namespace', namespaced: false }] });
		if (parsed.pathname === '/apis/apps/v1') return Response.json({ resources: [{ name: 'deployments', kind: 'Deployment', namespaced: true }, { name: 'deployments/scale', kind: 'Scale', namespaced: true }] });
		if (parsed.pathname.startsWith('/apis/') || parsed.pathname.startsWith('/api/')) {
			if (init?.method === 'PATCH') {
				if (options.forbid && parsed.pathname.includes(options.forbid))
					return Response.json({ kind: 'Status', reason: 'Forbidden', message: 'deployments.apps is forbidden: User "yoal:user_3" cannot patch' }, { status: 403 });
				return Response.json({ metadata: { resourceVersion: '1' } });
			}
			return new Response(existing.has(parsed.pathname) ? '{}' : '{"reason":"NotFound"}', { status: existing.has(parsed.pathname) ? 200 : 404 });
		}
		return new Response('nope', { status: 404 });
	};
	return { fetcher, seen };
}

const manifests = [
	{ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', namespace: 'apps' }, spec: { selector: { matchLabels: { app: 'web' } }, template: { metadata: { labels: { app: 'web' } }, spec: { containers: [{ name: 'web', image: 'nginx:1.27' }] } } } },
	{ apiVersion: 'v1', kind: 'Service', metadata: { name: 'web', namespace: 'apps' }, spec: { selector: { app: 'web' }, ports: [{ port: 80 }] } },
	{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'apps' } },
];

describe('KubernetesApiClient', () => {
	test('applies in dependency order with server-side apply and the caller token', async () => {
		const api = fakeApi();
		const client = new KubernetesApiClient('https://lab.k8s.sites.test', 'tok', api.fetcher);
		const outcomes = await client.applyAll(manifests, { dryRun: true });
		expect(outcomes.map((outcome) => `${outcome.kind}:${outcome.result}`)).toEqual(['Namespace:created', 'Service:configured', 'Deployment:created']);
		const patches = api.seen.filter((call) => call.method === 'PATCH');
		expect(patches.every((call) => call.auth === 'Bearer tok')).toBe(true);
		expect(patches[0]!.url).toContain('/api/v1/namespaces/apps?');
		expect(patches[2]!.url).toContain('/apis/apps/v1/namespaces/apps/deployments/web?');
		expect(patches.every((call) => call.url.includes('dryRun=All') && call.url.includes('fieldManager=yoal'))).toBe(true);
		// Discovery is cached per group/version.
		expect(api.seen.filter((call) => call.url.endsWith('/api/v1')).length).toBe(1);
	});

	test('RBAC refusals come back per object, and unknown kinds are reported', async () => {
		const api = fakeApi({ forbid: 'deployments' });
		const client = new KubernetesApiClient('https://lab.k8s.sites.test', 'tok', api.fetcher);
		const outcomes = await client.applyAll([manifests[0]!, { apiVersion: 'example.com/v1', kind: 'Widget', metadata: { name: 'w', namespace: 'apps' } }], { dryRun: false });
		expect(outcomes[0]).toMatchObject({ ok: false, result: 'Forbidden' });
		expect(outcomes[0]!.message).toContain('cannot patch');
		expect(outcomes[1]).toMatchObject({ ok: false, result: 'NotFound' });
	});
});

describe('applyManifests', () => {
	const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'w1').token, name: 'w1' });
	core.nodes.update(owner, joined.nodeId, { sliceMemoryMb: 8192 });
	const beat = (extra: Record<string, unknown> = {}) =>
		core.nodes.heartbeat(joined.token, {
			nodeId: joined.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			stats: { cpuPercent: 1, memoryBytes: 1, memoryTotalBytes: 16 * 1024 ** 3, diskUsedBytes: 1, diskTotalBytes: 100 * 1024 ** 3, diskFreeBytes: 90 * 1024 ** 3, uptimeSeconds: 1, load1: 0, certs: [] },
			releases: [],
			capabilities: ['kubernetes', 'kubernetes-userns'],
			kubernetes: { minors: ['1.37'], tiers: ['userns'], error: null },
			...extra,
		});
	beat();

	test('refuses until the cluster runs, then applies as the caller and audits it', async () => {
		const cluster = core.kubernetes.create(owner, { name: 'lab', placement: joined.nodeId });
		const api = fakeApi();
		core.kubernetes.apiFetch = api.fetcher;
		await expect(core.kubernetes.applyManifests(owner, 'lab', { manifests, dryRun: false })).rejects.toThrow(/wait until it is running/);
		beat({ workloads: [{ id: cluster.machines[0]!.id, status: 'running', restarts: 0 }] });
		const result = await core.kubernetes.applyManifests(owner, 'lab', { manifests, dryRun: false });
		expect(result.ok).toBe(true);
		expect(result.outcomes).toHaveLength(3);
		const auth = api.seen.find((call) => call.method === 'PATCH')!.auth!;
		const claims = JSON.parse(Buffer.from(auth.split(' ')[1]!.split('.')[1]!, 'base64url').toString());
		expect(claims).toMatchObject({ sub: 'user_1', aud: `k8s:${cluster.id}`, k8s_groups: ['yoal:admins'] });
	});

	test('a viewer may dry-run but not apply; lint errors stop before the API', async () => {
		await expect(core.kubernetes.applyManifests(viewer, 'lab', { manifests, dryRun: false })).rejects.toThrow();
		const dry = await core.kubernetes.applyManifests(viewer, 'lab', { manifests, dryRun: true });
		expect(dry.dryRun).toBe(true);
		const api = fakeApi();
		core.kubernetes.apiFetch = api.fetcher;
		const bad = await core.kubernetes.applyManifests(owner, 'lab', { manifests: [{ kind: 'Deployment', metadata: { name: 'x' } }], dryRun: true });
		expect(bad.ok).toBe(false);
		expect(bad.outcomes).toEqual([]);
		expect(api.seen).toEqual([]);
	});

	test('the manifest context reflects routes, attachments and capacity', () => {
		core.kubernetes.addRoute(owner, 'lab', { name: 'shop' });
		const context = core.kubernetes.manifestContext(owner, 'lab', 'apps');
		expect(context).toMatchObject({ cluster: 'lab', minor: '1.37', namespace: 'apps', ingressClass: 'traefik', routeHosts: ['shop.sites.test'], storageClasses: ['local-path'] });
		expect(context.allocatableMemoryMi).toBe(2048 - 768);
	});
});
