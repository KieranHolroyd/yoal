import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, desiredStateSchema, kubernetesVersion, workloadDesiredSchema } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';
import { kubernetesNodeName } from './kubernetes.ts';

/** Managed Kubernetes K5 (snapshots, restore, rollouts, shipper) and K6 (multi-node, HA). */
const dir = mkdtempSync(join(tmpdir(), 'yoal-k8s-k6-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-18T03:30:00Z');

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
const GIB = 1024 ** 3;
const stats = {
	cpuPercent: 5,
	memoryBytes: GIB,
	memoryTotalBytes: 32 * GIB,
	diskUsedBytes: 10 * GIB,
	diskTotalBytes: 200 * GIB,
	diskFreeBytes: 190 * GIB,
	uptimeSeconds: 100,
	load1: 0.1,
	certs: [],
};
const CAPS = ['functions', 'kubernetes', 'kubernetes-userns', 'wg-subnets'];
const COMPONENT = { minors: ['1.37', '1.36', '1.35'], tiers: ['userns' as const], error: null };

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

let keySeed = 0;
function joinNode(name: string, zone = 'default') {
	keySeed += 1;
	const joined = core.nodes.join({
		token: core.nodes.createJoinToken(owner, name).token,
		name,
		networkMode: 'yoal',
		wireguardPublicKey: `${String.fromCharCode(65 + keySeed).repeat(43)}=`,
	});
	core.nodes.update(owner, joined.nodeId, { sliceMemoryMb: 16_384, zone });
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
		capabilities: CAPS,
		kubernetes: COMPONENT,
		...extra,
	});
}

async function machinesOn(node: { token: string }) {
	return desiredStateSchema.parse(await core.nodes.desiredState(node.token)).workloads.filter((workload) => workload.kubernetes);
}

function running(node: { nodeId: string; token: string }, ids: string[]) {
	beat(node, { workloads: ids.map((id) => ({ id, status: 'running', restarts: 0 })) });
}

describe('multi-node clusters and HA (K6)', () => {
	const edge = joinNode('edge');
	const a = joinNode('a', 'zone-1');
	const b = joinNode('b', 'zone-2');
	const c = joinNode('c', 'zone-3');
	for (const node of [edge, a, b, c]) beat(node);

	test('nodes with the component carry a machine subnet in the overlay', async () => {
		const state = await core.nodes.desiredState(a.token);
		expect(state.wireguard?.machineSubnet).toMatch(/^10\.48\.\d+\.0\/24$/);
		expect(state.wireguard?.routes).toEqual(['10.48.0.0/16']);
		const peerSubnets = (state.wireguard?.peers ?? []).flatMap((peer) => peer.allowedIps).filter((ip) => ip.endsWith('/24'));
		expect(peerSubnets.length).toBeGreaterThanOrEqual(2);
	});

	test('three servers land on three nodes in different zones, each with a routed address', async () => {
		const cluster = core.kubernetes.create(owner, { name: 'ha-cluster', servers: 3, agents: 2 });
		expect(cluster).toMatchObject({ servers: 3, datastore: 'etcd', multiNode: true });
		const servers = cluster.machines.filter((machine) => machine.role === 'server');
		expect(new Set(servers.map((machine) => machine.nodeId)).size).toBe(3);
		expect(servers.map((machine) => machine.nodeId)).not.toContain(edge.nodeId);
		for (const machine of cluster.machines) expect(machine.overlayIp).toMatch(/^10\.48\.\d+\.\d+$/);
		const first = servers.find((machine) => machine.ordinal === 0)!;
		const onFirst = (await machinesOn({ token: [a, b, c].find((node) => node.nodeId === first.nodeId)!.token })).find(
			(workload) => workload.id === first.id,
		)!;
		expect(workloadDesiredSchema.safeParse(onFirst).success).toBe(true);
		expect(onFirst.kubernetes).toMatchObject({ datastore: 'etcd', clusterInit: true, overlayIp: first.overlayIp });
		const second = servers.find((machine) => machine.ordinal === 1)!;
		const onSecond = (await machinesOn({ token: [a, b, c].find((node) => node.nodeId === second.nodeId)!.token })).find(
			(workload) => workload.id === second.id,
		)!;
		expect(onSecond.kubernetes).toMatchObject({ clusterInit: false, serverAddress: first.overlayIp });
	});

	test('the edge spreads the HA API over every server node', async () => {
		const route = (await core.nodes.desiredState(edge.token)).kubernetesRoutes.find((item) => item.kind === 'api' && item.clusterId === core.kubernetes.get(owner, 'ha-cluster').id)!;
		expect(route.upstreams).toHaveLength(3);
		expect(route.bearerOnly).toBe(true);
	});

	test('machine memory is admitted on the node each machine runs on', () => {
		const reserved = core.kubernetes.reservedByNode();
		const total = [a, b, c].reduce((sum, node) => sum + (reserved.get(node.nodeId) ?? 0), 0);
		expect(total).toBe(5 * 2048);
	});

	test('a node without wg-subnets cannot take a multi-node machine', () => {
		const d = joinNode('d');
		beat(d, { capabilities: ['functions', 'kubernetes', 'kubernetes-userns'] });
		expect(() => core.kubernetes.create(owner, { name: 'spread', nodes: [d.nodeId, a.nodeId] })).toThrow(/machine subnet|routes machine subnets/);
	});

	test('making a production cluster HA converts it, then adds two servers as each comes up', async () => {
		const solo = core.kubernetes.create(owner, { name: 'solo', purpose: 'production', placement: a.nodeId });
		expect(() => core.kubernetes.create(owner, { name: 'labby', placement: a.nodeId })).not.toThrow();
		expect(() => core.kubernetes.update(owner, 'labby', { servers: 3 })).toThrow(/production/);
		const converted = core.kubernetes.update(owner, 'solo', { servers: 3 });
		expect(converted).toMatchObject({ servers: 3, datastore: 'etcd' });
		const server = converted.machines[0]!;
		expect(server.overlayIp).not.toBeNull();
		const onA = (await machinesOn(a)).find((workload) => workload.id === server.id)!;
		expect(onA.kubernetes).toMatchObject({ clusterInit: true, datastore: 'etcd' });
		// Nothing is added until the converted server runs again.
		core.kubernetes.rolloutTick();
		expect(core.kubernetes.get(owner, 'solo').machines).toHaveLength(1);
		running(a, [server.id]);
		core.kubernetes.rolloutTick();
		let machines = core.kubernetes.get(owner, 'solo').machines;
		expect(machines).toHaveLength(2);
		expect(machines[1]!.nodeId).not.toBe(a.nodeId);
		const nodeOf = (id: string) => [a, b, c].find((node) => node.nodeId === id)!;
		running(nodeOf(machines[1]!.nodeId), [machines[1]!.id]);
		core.kubernetes.rolloutTick();
		machines = core.kubernetes.get(owner, 'solo').machines;
		expect(machines.filter((machine) => machine.role === 'server')).toHaveLength(3);
		expect(new Set(machines.map((machine) => machine.nodeId)).size).toBe(3);
	});
});

describe('snapshots and restore (K14)', () => {
	test('a running cluster gets a scheduled snapshot task on its server node, and results record it', async () => {
		const node = joinNode('snap');
		beat(node);
		const cluster = core.kubernetes.create(owner, { name: 'snapme', placement: node.nodeId });
		running(node, [cluster.machines[0]!.id]);
		clock += 25 * 60 * 60_000;
		await core.kubernetes.backupTick();
		const state = desiredStateSchema.parse(await core.nodes.desiredState(node.token));
		const task = state.kubernetesBackupTasks.find((item) => item.action === 'backup')!;
		expect(task).toMatchObject({ machineId: cluster.machines[0]!.id, datastore: 'sqlite' });
		expect(task.url).toContain('http');
		beat(node, { kubernetesBackupResults: [{ taskId: task.id, action: 'backup', status: 'ok', sizeBytes: 1234, sha256: 'a'.repeat(64) }] });
		const backups = core.kubernetes.backups(owner, 'snapme');
		expect(backups[0]).toMatchObject({ status: 'ok', sizeBytes: 1234, kind: 'scheduled' });
		expect(core.kubernetes.get(owner, 'snapme').backup.lastStatus).toBe('ok');
		// No second snapshot task once it is done.
		expect(desiredStateSchema.parse(await core.nodes.desiredState(node.token)).kubernetesBackupTasks).toEqual([]);
	});

	test('restore makes a new cluster that waits for its snapshot, then starts with the old token', async () => {
		const node = joinNode('restore-target');
		beat(node);
		const backup = core.kubernetes.backups(owner, 'snapme')[0]!;
		const restored = core.kubernetes.restoreBackup(owner, { backup: backup.id, name: 'snapme-copy', placement: node.nodeId });
		expect(restored.restoring).toBe(true);
		// The machine is not desired until the snapshot is unpacked.
		expect(await machinesOn(node)).toEqual([]);
		const state = desiredStateSchema.parse(await core.nodes.desiredState(node.token));
		const task = state.kubernetesBackupTasks.find((item) => item.action === 'restore')!;
		expect(task.machineId).toBe(restored.machines[0]!.id);
		beat(node, { kubernetesBackupResults: [{ taskId: task.id, action: 'restore', status: 'ok' }] });
		expect(core.kubernetes.get(owner, 'snapme-copy').restoring).toBe(false);
		const machine = (await machinesOn(node))[0]!;
		const original = core.kubernetes.get(owner, 'snapme');
		const sourceNode = [...core.kubernetes.components(owner)].find((item) => item.nodeId === original.nodeId)!;
		expect(sourceNode).toBeTruthy();
		const activation = await core.workloads.activationFor(node.nodeId, machine.id);
		const snapNode = original.machines[0]!;
		const originalActivation = await core.workloads.activationFor(original.nodeId, snapNode.id);
		expect(activation.env.YOAL_K8S_TOKEN).toBe(originalActivation.env.YOAL_K8S_TOKEN);
	});

	test('expired snapshots are pruned but the newest good one is kept', async () => {
		clock += 30 * 24 * 60 * 60_000;
		await core.kubernetes.backupTick();
		const left = core.kubernetes.backups(owner, 'snapme').filter((item) => item.status === 'ok');
		expect(left).toHaveLength(1);
	});
});

describe('rollouts (K15)', () => {
	test('a minor upgrade snapshots first, then moves one machine at a time, servers first', async () => {
		const node = joinNode('roll');
		beat(node);
		const cluster = core.kubernetes.create(owner, { name: 'roller', version: '1.36', agents: 1, placement: node.nodeId });
		const ids = cluster.machines.map((machine) => machine.id);
		running(node, ids);
		core.kubernetes.update(owner, 'roller', { version: '1.37' });
		core.kubernetes.rolloutTick();
		expect(core.kubernetes.get(owner, 'roller').upgrade?.message).toMatch(/snapshot/);
		// The machines still run 1.36 while the snapshot is pending.
		core.kubernetes.rolloutTick();
		expect(core.kubernetes.get(owner, 'roller').machines.every((machine) => machine.release === 'v1.36.6+k3s1')).toBe(true);
		const snapshot = desiredStateSchema.parse(await core.nodes.desiredState(node.token)).kubernetesBackupTasks.find((task) => task.action === 'backup')!;
		beat(node, { kubernetesBackupResults: [{ taskId: snapshot.id, action: 'backup', status: 'ok', sizeBytes: 1, sha256: 'b'.repeat(64) }] });
		core.kubernetes.rolloutTick();
		let machines = core.kubernetes.get(owner, 'roller').machines;
		expect(machines.find((machine) => machine.role === 'server')!.release).toBe(kubernetesVersion('1.37')!.release);
		expect(machines.find((machine) => machine.role === 'agent')!.release).toBe('v1.36.6+k3s1');
		const serverWorkload = (await machinesOn(node)).find((workload) => workload.kubernetes!.role === 'server')!;
		expect(serverWorkload.image).toContain('v1.37.2-k3s1');
		running(node, ids);
		core.kubernetes.rolloutTick();
		machines = core.kubernetes.get(owner, 'roller').machines;
		expect(machines.every((machine) => machine.release === kubernetesVersion('1.37')!.release)).toBe(true);
		running(node, ids);
		core.kubernetes.rolloutTick();
		expect(core.kubernetes.get(owner, 'roller').upgrade).toBeNull();
	});

	test('a machine that does not come back rolls the release back and pauses patching', async () => {
		const node = joinNode('roll-bad');
		beat(node);
		const cluster = core.kubernetes.create(owner, { name: 'flaky', version: '1.35', placement: node.nodeId });
		running(node, [cluster.machines[0]!.id]);
		core.kubernetes.update(owner, 'flaky', { version: '1.36' });
		core.kubernetes.rolloutTick();
		const snapshot = desiredStateSchema.parse(await core.nodes.desiredState(node.token)).kubernetesBackupTasks.find((task) => task.action === 'backup')!;
		beat(node, { kubernetesBackupResults: [{ taskId: snapshot.id, action: 'backup', status: 'ok', sizeBytes: 1, sha256: 'c'.repeat(64) }] });
		core.kubernetes.rolloutTick();
		beat(node, { workloads: [{ id: cluster.machines[0]!.id, status: 'failed', restarts: 6 }] });
		clock += 16 * 60_000;
		core.kubernetes.rolloutTick();
		const after = core.kubernetes.get(owner, 'flaky');
		expect(after.minor).toBe('1.35');
		expect(after.autoPatch).toBe(false);
		expect(after.message).toMatch(/rolled back/);
		expect(after.machines[0]!.release).toBe('v1.35.10+k3s1');
		expect(core.kubernetes.alertCandidates().some((alert) => alert.key.startsWith('k8s_rollback:'))).toBe(true);
	});
});

describe('log shipper (K23)', () => {
	test('ingest needs the cluster token; lines are queryable and pruned by retention', () => {
		const node = joinNode('logs');
		beat(node);
		core.kubernetes.create(owner, { name: 'loggy', placement: node.nodeId });
		const updated = core.kubernetes.update(owner, 'loggy', { shipper: true, logRetentionDays: 1 });
		expect(updated.shipper).toBe(true);
		const server = updated.machines[0]!;
		const manifest = core.kubernetes.manifests(node.nodeId, server.id).files['yoal-shipper.yaml']!;
		expect(manifest).toContain('kind: DaemonSet');
		expect(manifest).toContain(`/api/v1/kubernetes-ingest/${updated.id}`);
		const token = Buffer.from(/ token: (\S+)/.exec(manifest)![1]!, 'base64').toString();
		expect(() => core.kubernetes.ingestLogs(updated.id, 'wrong', [])).toThrow(/token/);
		expect(core.kubernetes.ingestLogs(updated.id, token, [{ namespace: 'default', pod: 'web-1', container: 'web', message: 'hello', ts: clock }])).toBe(1);
		expect(core.kubernetes.podLogs(owner, 'loggy')).toMatchObject([{ namespace: 'default', pod: 'web-1', message: 'hello' }]);
		clock += 2 * 24 * 60 * 60_000;
		core.kubernetes.pruneLogs();
		expect(core.kubernetes.podLogs(owner, 'loggy')).toEqual([]);
	});

	test('the status sample prunes stale nodes using the names the control plane sends', async () => {
		const node = joinNode('prune');
		beat(node);
		const cluster = core.kubernetes.create(owner, { name: 'prunable', placement: node.nodeId });
		const entry = desiredStateSchema.parse(await core.nodes.desiredState(node.token)).kubernetesManifests.find(
			(item) => item.machineId === cluster.machines[0]!.id,
		)!;
		expect(entry.nodes).toEqual([kubernetesNodeName(cluster.machines[0]!.id)]);
	});
});
