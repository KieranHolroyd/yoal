import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import {
	DEFAULT_FEATURES,
	KUBERNETES_API_PORT_MAX,
	KUBERNETES_API_PORT_MIN,
	KUBERNETES_INGRESS_PORT_MIN,
	desiredStateSchema,
	workloadDesiredSchema,
} from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';
import { renderAccessKeyManifest, renderRbacManifest, renderSecretManifest } from './kubernetes.ts';

/** Managed Kubernetes clusters (docs/KUBERNETES.md). */
const dir = mkdtempSync(join(tmpdir(), 'yoal-k8s-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-18T10:00:00Z');

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
		features: { ...DEFAULT_FEATURES },
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const deployer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'deployer' });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_3', orgId: 'org_1', role: 'viewer' });
const other = buildPrincipal({ kind: 'user', userId: 'user_9', orgId: 'org_2', role: 'owner' });
const GIB = 1024 ** 3;
const stats = {
	cpuPercent: 5,
	memoryBytes: GIB,
	memoryTotalBytes: 16 * GIB,
	diskUsedBytes: 10 * GIB,
	diskTotalBytes: 200 * GIB,
	diskFreeBytes: 190 * GIB,
	uptimeSeconds: 100,
	load1: 0.1,
	certs: [],
};
const USERNS = ['kubernetes', 'kubernetes-userns'];

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

function joinNode(name: string) {
	const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, name).token, name });
	core.nodes.update(owner, joined.nodeId, { sliceMemoryMb: 12_288 });
	return joined;
}

function beat(node: { nodeId: string; token: string }, extra: Record<string, unknown> = {}) {
	return core.nodes.heartbeat(node.token, {
		nodeId: node.nodeId,
		agentVersion: '0.1.0',
		actualStateVersion: 1,
		status: 'online',
		caddyOk: true,
		stats,
		releases: [],
		...extra,
	});
}

describe('managed Kubernetes', () => {
	const edge = joinNode('edge');
	const w1 = joinNode('w1');
	const w2 = joinNode('w2');
	beat(edge, { capabilities: ['functions'] });
	beat(w1, { capabilities: ['functions'] });
	beat(w2, { capabilities: ['functions'] });

	test('no node with the component: create explains how to install it', () => {
		expect(() => core.kubernetes.create(owner, { name: 'lab' })).toThrow(/Install the Kubernetes component/);
		expect(() => core.kubernetes.create(owner, { name: 'lab', placement: w1.nodeId })).toThrow(/does not have the Kubernetes component/);
	});

	test('the component report from a heartbeat shows on the components view', async () => {
		beat(w1, { capabilities: ['functions', ...USERNS], kubernetes: { minors: ['1.37', '1.36', '1.35'], tiers: ['userns'], error: null } });
		const view = core.kubernetes.components(owner).find((item) => item.nodeId === w1.nodeId)!;
		expect(view).toMatchObject({ installed: true, minors: ['1.37', '1.36', '1.35'], tiers: ['userns'], machines: 0 });
		expect(() => core.kubernetes.components(deployer)).toThrow(/Platform admins/);
	});

	test('a component install request reaches the node and its result clears it', async () => {
		const requested = core.kubernetes.requestComponent(owner, w2.nodeId, 'install');
		expect(requested.pending?.action).toBe('install');
		const state = await core.nodes.desiredState(w2.token);
		expect(state.kubernetesComponentRequest?.action).toBe('install');
		beat(w2, { capabilities: ['functions'], kubernetesComponentResult: { id: state.kubernetesComponentRequest!.id, ok: false, message: 'cgroup v2 is required' } });
		const after = core.kubernetes.components(owner).find((item) => item.nodeId === w2.nodeId)!;
		expect(after.pending).toBeNull();
		expect(after.lastResult).toMatchObject({ ok: false, message: 'cgroup v2 is required' });
		expect((await core.nodes.desiredState(w2.token)).kubernetesComponentRequest).toBeNull();
	});

	test('create places on a capable worker, never the edge, in the userns tier', () => {
		// Even an edge that has the component is skipped unless named (K25).
		beat(edge, { capabilities: ['functions', ...USERNS], kubernetes: { minors: ['1.37'], tiers: ['userns'], error: null } });
		const cluster = core.kubernetes.create(owner, { name: 'lab', agents: 1 });
		expect(cluster).toMatchObject({
			name: 'lab',
			minor: '1.37',
			displayVersion: '1.37.2',
			tier: 'userns',
			purpose: 'lab',
			status: 'pending',
			nodeId: w1.nodeId,
			agents: 1,
			apiAccess: 'public',
			upgradeTo: null,
		});
		expect(cluster.apiUrl).toMatch(/^https:\/\/lab-[a-z0-9]{1,8}\.k8s\.sites\.test$/);
		expect(cluster.machines.map((machine) => `${machine.role}:${machine.ordinal}`)).toEqual(['server:0', 'agent:1']);
	});

	test('desired state carries one machine workload per machine, with the fixed profile', async () => {
		const state = desiredStateSchema.parse(await core.nodes.desiredState(w1.token));
		const machines = state.workloads.filter((workload) => workload.kubernetes);
		expect(machines).toHaveLength(2);
		const server = machines.find((workload) => workload.kubernetes!.role === 'server')!;
		const agent = machines.find((workload) => workload.kubernetes!.role === 'agent')!;
		for (const machine of machines) expect(workloadDesiredSchema.safeParse(machine).success).toBe(true);
		expect(server.id.startsWith('km_')).toBe(true);
		expect(server.image).toContain('rancher/k3s:v1.37.2-k3s1@sha256:');
		expect(server.port).toBeGreaterThanOrEqual(KUBERNETES_API_PORT_MIN);
		expect(server.port).toBeLessThanOrEqual(KUBERNETES_API_PORT_MAX);
		expect(server.kubernetes).toMatchObject({ role: 'server', ordinal: 0, tier: 'userns', schedulable: false, traefik: true, issuer: 'https://control.test' });
		expect(server.kubernetes!.ingressPort).toBeGreaterThanOrEqual(KUBERNETES_INGRESS_PORT_MIN);
		expect(agent.kubernetes).toMatchObject({ role: 'agent', ordinal: 1, serverId: server.id, schedulable: true, ingressPort: 0 });
		expect(server.orgId).toBe('org_1');
		// The edge gets no machines.
		expect((await core.nodes.desiredState(edge.token)).workloads.some((workload) => workload.kubernetes)).toBe(false);
	});

	test('activation hands the join token to the machine node only', async () => {
		const state = await core.nodes.desiredState(w1.token);
		const server = state.workloads.find((workload) => workload.kubernetes?.role === 'server')!;
		const activation = await core.workloads.activationFor(w1.nodeId, server.id);
		expect(activation.env.YOAL_K8S_TOKEN).toMatch(/^[A-Za-z0-9_-]{40,}$/);
		expect(activation.activationVersion).toBe(server.activationVersion);
		await expect(Promise.resolve().then(() => core.workloads.activationFor(w2.nodeId, server.id))).rejects.toThrow(/another node/);
	});

	test('the API route: TLS to loopback on the machine node, bearer-only on both hops', async () => {
		const cluster = core.kubernetes.get(owner, 'lab');
		const host = new URL(cluster.apiUrl!).host;
		const local = (await core.nodes.desiredState(w1.token)).kubernetesRoutes.find((route) => route.kind === 'api')!;
		expect(local).toMatchObject({ host, upstreamTls: true, bearerOnly: true });
		expect(local.upstream).toMatch(/^127\.0\.0\.1:\d+$/);
		const atEdge = (await core.nodes.desiredState(edge.token)).kubernetesRoutes.find((route) => route.kind === 'api')!;
		expect(atEdge).toMatchObject({ host, upstreamTls: false, bearerOnly: true });
		expect(atEdge.upstream.startsWith('http://')).toBe(true);
		// A node that neither runs it nor is the edge serves nothing.
		expect((await core.nodes.desiredState(w2.token)).kubernetesRoutes).toEqual([]);
	});

	test('heartbeats drive machine and cluster status, and samples mark it degraded', async () => {
		const ids = core.kubernetes.get(owner, 'lab').machines.map((machine) => machine.id);
		beat(w1, { capabilities: ['functions', ...USERNS], workloads: ids.map((id) => ({ id, status: 'running', restarts: 0 })) });
		expect(core.kubernetes.get(owner, 'lab').status).toBe('running');
		const clusterId = core.kubernetes.get(owner, 'lab').id;
		beat(w1, {
			capabilities: ['functions', ...USERNS],
			kubernetesStatus: [{ clusterId, at: new Date(clock).toISOString(), apiReady: true, nodesReady: 1, nodesTotal: 2, deprecatedApis: [] }],
		});
		expect(core.kubernetes.get(owner, 'lab')).toMatchObject({ status: 'degraded', nodesReady: 1, nodesTotal: 2 });
		beat(w1, {
			capabilities: ['functions', ...USERNS],
			kubernetesStatus: [{ clusterId, at: new Date(clock).toISOString(), apiReady: true, nodesReady: 2, nodesTotal: 2, deprecatedApis: [] }],
		});
		expect(core.kubernetes.get(owner, 'lab').status).toBe('running');
	});

	test('tokens carry the group the caller is allowed, for this cluster only', async () => {
		const cluster = core.kubernetes.get(owner, 'lab');
		const admin = await core.kubernetes.token(owner, 'lab');
		expect(admin.groups).toEqual(['yoal:admins']);
		expect(admin.audience).toBe(`k8s:${cluster.id}`);
		const [, payload] = admin.token.split('.');
		const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
		expect(claims).toMatchObject({ iss: 'https://control.test', aud: `k8s:${cluster.id}`, sub: 'user_1', org_id: 'org_1', k8s_groups: ['yoal:admins'] });
		expect(claims.exp - claims.iat).toBe(900);
		expect((await core.kubernetes.token(deployer, 'lab')).groups).toEqual(['yoal:editors']);
		expect((await core.kubernetes.token(viewer, 'lab')).groups).toEqual(['yoal:viewers']);
		await expect(core.kubernetes.token(other, 'lab')).rejects.toThrow(/not found/i);
	});

	test('the kubeconfig runs the exec plugin and holds no credential', () => {
		const config = core.kubernetes.kubeconfig(deployer, 'lab');
		expect(config.kubeconfig).toContain('command: yoal');
		expect(config.kubeconfig).toContain('args: [k8s, token, lab, --output, exec-credential]');
		expect(config.kubeconfig).not.toMatch(/token:|client-key/);
	});

	test('access keys write a binding into the manifests and revoking removes it', async () => {
		const server = core.kubernetes.get(owner, 'lab').machines.find((machine) => machine.role === 'server')!;
		const before = core.kubernetes.manifests(w1.nodeId, server.id);
		expect(Object.keys(before.files).sort()).toEqual(['yoal-rbac.yaml', 'yoal-traefik.yaml']);
		const key = await core.kubernetes.createAccessKey(owner, 'lab', { name: 'argo', role: 'edit' });
		expect(key.kubeconfig).toContain('token: ');
		const withKey = core.kubernetes.manifests(w1.nodeId, server.id);
		expect(withKey.generation).not.toBe(before.generation);
		expect(withKey.files['yoal-access-keys.yaml']).toContain(`name: "yoal:key:${key.id}"`);
		expect(withKey.files['yoal-access-keys.yaml']).toContain('name: edit');
		// A viewer cannot mint an edit key.
		await expect(core.kubernetes.createAccessKey(viewer, 'lab', { name: 'x', role: 'edit' })).rejects.toThrow();
		core.kubernetes.revokeAccessKey(owner, 'lab', 'argo');
		expect(Object.keys(core.kubernetes.manifests(w1.nodeId, server.id).files).sort()).toEqual(['yoal-rbac.yaml', 'yoal-traefik.yaml']);
		expect(core.kubernetes.accessKeys(owner, 'lab')[0]!.revokedAt).not.toBeNull();
		// Manifests are not part of the activation: a key never restarts the machine.
		const state = await core.nodes.desiredState(w1.token);
		expect(state.kubernetesManifests.find((entry) => entry.machineId === server.id)?.generation).toBe(before.generation);
	});

	test('routes claim a single label in the project namespace', async () => {
		const route = core.kubernetes.addRoute(owner, 'lab', { name: 'shop' });
		expect(route.host).toBe('shop.sites.test');
		expect(() => core.kubernetes.addRoute(owner, 'lab', { name: 'shop' })).toThrow(/already taken/);
		await expect(core.projects.create(owner, { name: 'Shop', slug: 'shop', runtime: 'static', placement: 'edge', productionAccess: 'public', previewAccess: 'platform' })).rejects.toThrow();
		const ingress = (await core.nodes.desiredState(w1.token)).kubernetesRoutes.find((item) => item.kind === 'ingress')!;
		expect(ingress).toMatchObject({ host: 'shop.sites.test', upstreamTls: false, bearerOnly: false });
		core.kubernetes.removeRoute(owner, 'lab', 'shop');
		expect((await core.nodes.desiredState(w1.token)).kubernetesRoutes.some((item) => item.kind === 'ingress')).toBe(false);
	});

	test('upgrades move one minor at a time', () => {
		const old = core.kubernetes.create(owner, { name: 'old', version: '1.35' });
		expect(old.upgradeTo).toBe('1.36');
		expect(() => core.kubernetes.update(owner, 'old', { version: '1.37' })).toThrow(/one minor at a time/);
		expect(core.kubernetes.update(owner, 'old', { version: '1.36' })).toMatchObject({ minor: '1.36', release: 'v1.36.6+k3s1' });
		expect(() => core.kubernetes.update(owner, 'old', { version: '1.35' })).toThrow(/one minor at a time/);
		expect(() => core.kubernetes.update(owner, 'lab', { version: '1.36' })).toThrow(/newest/);
	});

	test('production clusters default to hourly snapshots and log shipping (K22)', () => {
		const prod = core.kubernetes.create(owner, { name: 'prod', purpose: 'production', placement: w1.nodeId });
		expect(prod.backup.hours).toBe(1);
		expect(prod.shipper).toBe(true);
		const server = prod.machines[0]!;
		expect(Object.keys(core.kubernetes.manifests(w1.nodeId, server.id).files)).toContain('yoal-shipper.yaml');
		core.kubernetes.delete(owner, 'prod');
	});

	test('scaling agents adds machines and purges the removed ones', async () => {
		core.kubernetes.update(owner, 'lab', { agents: 3 });
		expect(core.kubernetes.get(owner, 'lab').machines).toHaveLength(4);
		core.kubernetes.update(owner, 'lab', { agents: 0 });
		const left = core.kubernetes.get(owner, 'lab').machines;
		expect(left.map((machine) => machine.role)).toEqual(['server']);
		const state = await core.nodes.desiredState(w1.token);
		expect(state.kubernetesPurges.length).toBe(3);
		// The server becomes schedulable again once it has no agents.
		expect(state.workloads.find((workload) => workload.id === left[0]!.id)?.kubernetes?.schedulable).toBe(true);
		beat(w1, { capabilities: ['functions', ...USERNS], purgedKubernetes: state.kubernetesPurges });
		expect((await core.nodes.desiredState(w1.token)).kubernetesPurges).toEqual([]);
	});

	test('the trusted tier needs a grant and a node dedicated to the org', () => {
		beat(w2, { capabilities: ['functions', 'kubernetes', 'kubernetes-trusted'], kubernetes: { minors: ['1.37'], tiers: ['trusted'], error: null } });
		const grantee = buildPrincipal({ kind: 'user', userId: 'user_4', orgId: 'org_3', role: 'owner' });
		expect(() => core.kubernetes.create(grantee, { name: 'tr1', placement: w2.nodeId })).toThrow(/trusted tier/);
		core.kubernetes.grantTrusted(owner, 'org_3');
		// Granted, but the node is not dedicated to the org.
		expect(() => core.kubernetes.create(grantee, { name: 'tr1', placement: w2.nodeId })).toThrow(/dedicated/);
		core.nodes.update(owner, w2.nodeId, { labels: { kubernetes: 'dedicated:org_3' } });
		expect(core.kubernetes.create(grantee, { name: 'tr1', placement: w2.nodeId }).tier).toBe('trusted');
		// Another org cannot use that node at all.
		expect(() => core.kubernetes.create(other, { name: 'tr2', placement: w2.nodeId })).toThrow(/dedicated to another/);
		expect(() => core.kubernetes.revokeTrusted(owner, 'org_3')).toThrow(/still has trusted clusters/);
		expect(() => core.kubernetes.grantTrusted(deployer, 'org_9')).toThrow(/Platform admins/);
	});

	test('removing the component is refused while machines run on the node', () => {
		expect(() => core.kubernetes.requestComponent(owner, w1.nodeId, 'remove')).toThrow(/still runs/);
	});

	test('delete stops the machines, purge removes every row once the node reports it', async () => {
		core.kubernetes.delete(owner, 'old');
		const state = await core.nodes.desiredState(w1.token);
		const oldId = core.kubernetes.get(owner, 'old', { includeDeleted: true }).id;
		expect(state.workloads.some((workload) => workload.kubernetes?.clusterId === oldId)).toBe(false);
		core.kubernetes.purgeNow(owner, 'old');
		const purges = (await core.nodes.desiredState(w1.token)).kubernetesPurges;
		expect(purges.length).toBe(1);
		beat(w1, { capabilities: ['functions', ...USERNS], purgedKubernetes: purges });
		expect(() => core.kubernetes.get(owner, 'old', { includeDeleted: true })).toThrow(/not found/i);
	});

	test('machines count toward node admission', () => {
		expect(core.kubernetes.reservedByNode().get(w1.nodeId)).toBe(2048);
		expect(() => core.kubernetes.create(owner, { name: 'huge', placement: w1.nodeId, memoryMb: 12_000 })).toThrow(/reserves|budget|free/);
	});
});

describe('manifest renderers', () => {
	test('RBAC binds the three groups to the built-in roles', () => {
		const yaml = renderRbacManifest();
		expect(yaml).toContain('name: cluster-admin');
		expect(yaml).toContain('name: "yoal:admins"');
		expect(yaml).toContain('name: "yoal:viewers"');
		expect(yaml.split('---')).toHaveLength(3);
	});

	test('access keys bind a user per key', () => {
		const yaml = renderAccessKeyManifest([{ id: 'kk_abc', name: 'ci', role: 'view' }]);
		expect(yaml).toContain('name: "yoal:key:kk_abc"');
		expect(yaml).toContain('name: view');
	});

	test('attachment secrets are base64 and namespaced', () => {
		const yaml = renderSecretManifest({ namespace: 'apps', name: 'yoal-db', data: { URL: 'postgres://u:p@db:5432/x' } });
		expect(yaml).toContain('namespace: apps');
		expect(yaml).toContain(`URL: ${Buffer.from('postgres://u:p@db:5432/x').toString('base64')}`);
	});
});
