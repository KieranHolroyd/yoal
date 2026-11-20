import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileKubernetesRoute } from './caddy-config.ts';
import { KubernetesSync, kubernetesCapabilities, readKubernetesComponent } from './kubernetes.ts';

describe('kubernetes routes', () => {
	test('API routes refuse missing bearer tokens and enforce the allowlist before proxying', () => {
		const route = compileKubernetesRoute({
			clusterId: 'kc_1',
			kind: 'api',
			host: 'lab-org1.k8s.sites.test',
			upstream: '127.0.0.1:22000',
			upstreams: [],
			upstreamTls: true,
			bearerOnly: true,
			allowCidrs: ['203.0.113.0/24'],
		});
		const json = JSON.stringify(route);
		expect(route.match).toEqual([{ host: ['lab-org1.k8s.sites.test'] }]);
		const subroutes = (route.handle as Array<{ routes: Array<Record<string, unknown>> }>)[0]!.routes;
		expect(subroutes).toHaveLength(3);
		expect(JSON.stringify(subroutes[0])).toContain('"client_ip":{"ranges":["203.0.113.0/24"]}');
		expect(JSON.stringify(subroutes[1])).toContain('"Authorization":["Bearer *"]');
		expect(JSON.stringify(subroutes[1])).toContain('/livez');
		expect(json).toContain('"insecure_skip_verify":true');
		expect(json).toContain('"flush_interval":-1');
	});

	test('ingress routes to another node keep the host and speak plain HTTP', () => {
		const json = JSON.stringify(
			compileKubernetesRoute({
				clusterId: 'kc_1',
				kind: 'ingress',
				host: 'shop.sites.test',
				upstream: 'http://10.47.1.5:8080',
				upstreams: [],
				upstreamTls: false,
				bearerOnly: false,
				allowCidrs: [],
			}),
		);
		expect(json).not.toContain('Bearer');
		expect(json).not.toContain('insecure_skip_verify');
		expect(json).toContain('"dial":"10.47.1.5:8080"');
		expect(json).toContain('{http.request.host}');
	});
});

describe('kubernetes component marker', () => {
	test('capabilities follow the marker', () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-k8s-agent-'));
		try {
			const marker = join(dir, 'installed.json');
			expect(kubernetesCapabilities(readKubernetesComponent(marker))).toEqual([]);
			writeFileSync(marker, JSON.stringify({ minors: ['1.37'], tiers: ['userns'], error: null }));
			expect(kubernetesCapabilities(readKubernetesComponent(marker))).toEqual(['kubernetes', 'kubernetes-userns']);
			writeFileSync(marker, JSON.stringify({ minors: [], tiers: [], error: 'cgroup v2 is required' }));
			expect(kubernetesCapabilities(readKubernetesComponent(marker))).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('kubernetes sync', () => {
	test('a component request starts the helper job once and reports its outcome', async () => {
		let running = true;
		const started: string[] = [];
		const sync = new KubernetesSync({
			helper: {
				kubernetesStatus: async () => ({ apiReady: true, nodesReady: 1, nodesTotal: 1, deprecatedApis: [] }),
				kubernetesManifests: async () => undefined,
				startKubernetesComponent: async (action) => (started.push(action), { running: true, startedAt: 'x', finishedAt: null, error: null }),
				kubernetesComponentJob: async () => ({ running, startedAt: 'x', finishedAt: running ? null : 'y', error: null }),
			},
			fetchManifests: async () => ({ generation: 'g', files: {} }),
			isRunning: () => true,
			log: () => undefined,
		});
		const state = { kubernetesComponentRequest: { id: 'kcr_1', action: 'install', purge: false } } as never;
		const signal = new AbortController().signal;
		await sync.componentTick(state, signal);
		await sync.componentTick(state, signal);
		expect(started).toEqual(['install']);
		expect(sync.pendingComponentResult()).toBeNull();
		running = false;
		await sync.componentTick(state, signal);
		const result = sync.pendingComponentResult();
		expect(result).toEqual({ id: 'kcr_1', ok: true, message: null });
		sync.acknowledgeComponentResult(result);
		expect(sync.pendingComponentResult()).toBeNull();
	});

	test('manifests sync once per generation and only to running servers', async () => {
		const synced: string[] = [];
		const sync = new KubernetesSync({
			helper: {
				kubernetesStatus: async () => ({ apiReady: true, nodesReady: 1, nodesTotal: 1, deprecatedApis: [] }),
				kubernetesManifests: async (id) => void synced.push(id),
				startKubernetesComponent: async () => ({ running: false, startedAt: null, finishedAt: null, error: null }),
				kubernetesComponentJob: async () => ({ running: false, startedAt: null, finishedAt: null, error: null }),
			},
			fetchManifests: async () => ({ generation: 'g1', files: { 'yoal-rbac.yaml': 'x' } }),
			isRunning: (id) => id === 'km_a',
			log: () => undefined,
			now: () => 0,
		});
		const state = {
			workloads: [{ id: 'km_a', kubernetes: { role: 'server', clusterId: 'kc_1' } }],
			kubernetesManifests: [
				{ machineId: 'km_a', generation: 'g1' },
				{ machineId: 'km_b', generation: 'g1' },
			],
		} as never;
		const signal = new AbortController().signal;
		await sync.tick(state, signal);
		await sync.tick(state, signal);
		expect(synced).toEqual(['km_a']);
	});
});

describe('ha api route', () => {
	test('three server nodes become three upstreams with failover', () => {
		const json = JSON.stringify(
			compileKubernetesRoute({
				clusterId: 'kc_1',
				kind: 'api',
				host: 'lab-org1.k8s.sites.test',
				upstream: 'http://10.47.1.5:8080',
				upstreams: ['http://10.47.1.5:8080', 'http://10.47.1.6:8080', 'http://10.47.1.7:8080'],
				upstreamTls: false,
				bearerOnly: true,
				allowCidrs: [],
			}),
		);
		expect(json).toContain('"dial":"10.47.1.6:8080"');
		expect(json).toContain('"policy":"first"');
		expect(json).toContain('"passive"');
	});
});
