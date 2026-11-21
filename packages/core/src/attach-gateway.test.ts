import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import {
	CONTAINER_GATEWAY_ADDRESS,
	DATABASE_REPLICAS_CAPABILITY,
	DEFAULT_FEATURES,
	databaseAlias,
	nodeCapabilities,
	type DatabaseReplicationSlotStatus,
	type Heartbeat,
	type FeatureFlags,
} from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

/**
 * W4 exit (HA-PLAN H24, docs/build-plan/HA-WAVE-1.md lane B): a container app in copies on several
 * nodes reaches one Postgres on another through stable endpoints, a promotion changes no app's
 * environment, the pool and read URLs cross nodes, and nothing listens publicly by default.
 */
const dir = mkdtempSync(join(tmpdir(), 'yoal-attach-gateway-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.parse('2026-11-20T10:00:00Z');
const features: Partial<FeatureFlags> = {
	ENDPOINTS_GATEWAY: true,
	SERVICE_ENDPOINTS: true,
	MULTI_NODE_REPLICAS: true,
};
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
		features: { ...DEFAULT_FEATURES, ...features },
	},
});
const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
type JoinedNode = { nodeId: string; token: string; name: string; address: string };
let nodeIndex = 1;
const joinNode = (name: string): JoinedNode => {
	const node = core.nodes.join({ token: core.nodes.createJoinToken(owner, name).token, name });
	const roles = name === 'data' ? (['data'] as const) : name === 'edge' ? null : (['compute'] as const);
	core.nodes.update(owner, node.nodeId, { sliceMemoryMb: 16_384, ...(roles ? { roles: [...roles] } : {}) });
	const address = `10.47.1.${nodeIndex++}`;
	opened.sqlite.run('UPDATE nodes SET private_address = ? WHERE id = ?', [address, node.nodeId]);
	return { ...node, name, address };
};
const edge = joinNode('edge');
const workerA = joinNode('worker-a');
const workerB = joinNode('worker-b');
const workerC = joinNode('worker-c');
const data = joinNode('data');
const allNodes = [edge, workerA, workerB, workerC, data];

function beat(node: JoinedNode, extra: Partial<Heartbeat> = {}): void {
	core.nodes.heartbeat(node.token, {
		nodeId: node.nodeId,
		agentVersion: '0.1.0',
		actualStateVersion: core.nodes.stateVersion(),
		status: 'online',
		caddyOk: true,
		releases: [],
		capabilities: [...nodeCapabilities, 'endpoints-gateway', DATABASE_REPLICAS_CAPABILITY],
		nodeCertificate: {
			certPem: 'pem',
			fingerprint: node.nodeId.replace(/[^a-f0-9]/g, '').padEnd(64, 'a').slice(0, 64),
			expiresAt: new Date(clock + 86_400_000).toISOString(),
		},
		...extra,
	});
}
for (const node of allNodes) beat(node);

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const endpointRows = (nodeId: string, databaseId: string) =>
	opened.sqlite
		.query<{ role: string; localPort: number; upstreamNodeId: string; upstreamPort: number; version: number }, [string, string]>(
			`SELECT role, local_port AS localPort, upstream_node_id AS upstreamNodeId, upstream_port AS upstreamPort, version
			 FROM service_endpoints WHERE consumer_node_id = ? AND service_kind = 'database' AND service_id = ? ORDER BY local_port`,
		)
		.all(nodeId, databaseId);

const dbOf = (name: string) => core.databases.get(owner, name);

/** A deployment row a placed workload can point at, without releasing real content. */
let specPort = 3_100;
let deploymentCounter = 1;
function activate(projectSlug: string, replicas: number): { copyNodes: string[] } {
	const row = core.projects.requireRow(owner, projectSlug);
	core.workloads.setSpec(owner, row, {
		runtime: 'container',
		image: 'localhost/app:1',
		port: specPort++,
		memoryMb: 128,
		cpus: 1,
		healthPath: '/',
		env: {},
		secrets: [],
	} as never);
	const current = core.projects.requireRow(owner, projectSlug);
	const resolved = core.workloads.plan(owner, current, { replicas });
	const deploymentId = `dep_${projectSlug}`;
	opened.sqlite.run(
		`INSERT INTO deployments (id, org_id, project_id, release_id, config_snapshot_id, short_id, runtime, runtime_name, status, preview_host, created_by, created_at)
		 VALUES (?, 'org_1', ?, 'rel_none', 'cfg_none', ?, ?, ?, 'active', ?, 'user_1', ?)`,
		[
			deploymentId,
			row.id,
			`d${deploymentCounter++}`,
			resolved.spec.runtime,
			resolved.spec.runtime,
			`${projectSlug}.preview.test`,
			clock,
		],
	);
	core.workloads.record(row, deploymentId, resolved);
	return { copyNodes: (resolved.replicas ?? [{ nodeId: resolved.nodeId }]).map((copy) => copy.nodeId) };
}

describe('a container app in three copies on three nodes, one Postgres on a fourth', () => {
	test('each copy reaches the database through its own gateway endpoint', async () => {
		const project = await core.projects.create(owner, {
			name: 'Gateway web',
			slug: 'gateway-web',
			runtime: 'container',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		core.databases.create(owner, { name: 'gateway-db', placement: data.nodeId });
		const db = dbOf('gateway-db');
		core.databases.attach(owner, core.projects.requireRow(owner, project.slug), { database: 'gateway-db', envPrefix: 'DATABASE' });

		const row = core.projects.requireRow(owner, project.slug);
		// The gate is gone for containers: copies may leave the database's node.
		expect(core.workloads.scalingMode(row, { runtime: 'container', ingress: 'http' } as never, null)).toEqual({
			mode: 'spread',
			blocker: null,
		});
		const { copyNodes } = activate(project.slug, 3);
		expect(new Set(copyNodes).size).toBe(3);
		expect(copyNodes.filter((nodeId) => nodeId !== data.nodeId)).toHaveLength(3);
		const byNode = new Map(allNodes.map((node) => [node.nodeId, node]));

		for (const nodeId of copyNodes) {
			const env = core.databases.consumerEnv(project.id, nodeId, 'container');
			const rows = endpointRows(nodeId, db.id);
			const primary = rows.find((item) => item.role === 'primary')!;
			const pool = rows.find((item) => item.role === 'pool')!;
			expect(primary).toBeDefined();
			expect(pool).toBeDefined();
			expect(primary.localPort).toBeGreaterThanOrEqual(21_000);
			expect(primary.localPort).toBeLessThanOrEqual(21_999);
			expect(primary.upstreamNodeId).toBe(data.nodeId);
			// The container dials db-<id> resolved by AddHost to the node's gateway, not a provider IP.
			expect(env.DATABASE_HOST).toBe(databaseAlias(db.id));
			expect(env.DATABASE_PORT).toBe(String(primary.localPort));
			expect(env.DATABASE_POOL_HOST).toBe(databaseAlias(db.id));
			expect(env.DATABASE_POOL_PORT).toBe(String(pool.localPort));
			expect(env.DATABASE_POOL_URL).toContain(`@${databaseAlias(db.id)}:${pool.localPort}/`);
			expect(env.DATABASE_URL).toContain(`@${databaseAlias(db.id)}:${primary.localPort}/`);
			expect(pool.localPort).not.toBe(primary.localPort);

			const node = byNode.get(nodeId)!;
			const state = await core.nodes.desiredState(node.token);
			const workload = state.workloads.find((item) => item.projectId === project.id)!;
			// H24: the helper writes AddHost=db-<id>:<container gateway> for the unit.
			expect(workload.addHosts).toEqual([{ host: databaseAlias(db.id), address: CONTAINER_GATEWAY_ADDRESS }]);
			expect(state.serviceEndpoints.filter((item) => item.serviceId === db.id)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ role: 'primary', gatewayAddress: CONTAINER_GATEWAY_ADDRESS, localPort: primary.localPort }),
					expect.objectContaining({ role: 'pool', gatewayAddress: CONTAINER_GATEWAY_ADDRESS, localPort: pool.localPort }),
				]),
			);
			// Nothing renders a public listener: the overlay address only, on the provider side.
			for (const provider of state.serviceProviders) expect(provider.listenAddress).toBe(node.address);
			for (const endpoint of state.serviceEndpoints)
				expect(endpoint.gatewayAddress === CONTAINER_GATEWAY_ADDRESS || endpoint.gatewayAddress === undefined).toBe(true);
		}

		const providerState = await core.nodes.desiredState(data.token);
		const primaryListener = providerState.serviceProviders.find((item) => item.listenPort === db.internalHost.process.split(':').map(Number)[1])!;
		expect(primaryListener).toMatchObject({
			listenAddress: data.address,
			targetPort: db.internalHost.process.split(':').map(Number)[1],
			clientAuth: 'install-ca',
		});
		expect(primaryListener.allowedClientNodeIds).toEqual(expect.arrayContaining(copyNodes));
		expect(primaryListener.allowedClientFingerprints.length).toBe(copyNodes.length);
		// A port scan from outside the overlay finds no public bind: every provider listens on the
		// node's overlay address, never 0.0.0.0 or the public address.
		for (const node of allNodes) {
			const state = await core.nodes.desiredState(node.token);
			for (const provider of state.serviceProviders) {
				expect(provider.listenAddress).toBe(node.address);
				expect(provider.listenAddress).not.toBe('0.0.0.0');
			}
			for (const endpoint of state.serviceEndpoints)
				expect([CONTAINER_GATEWAY_ADDRESS, undefined]).toContain(endpoint.gatewayAddress);
		}
	});
});

describe('same-node attachments reuse one endpoint', () => {
	test('two container apps on one node share the database endpoint and its pooled port', async () => {
		const first = await core.projects.create(owner, {
			name: 'Reuse one',
			slug: 'reuse-one',
			runtime: 'container',
			placement: workerA.nodeId,
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const second = await core.projects.create(owner, {
			name: 'Reuse two',
			slug: 'reuse-two',
			runtime: 'container',
			placement: workerA.nodeId,
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		core.databases.create(owner, { name: 'reuse-db', placement: data.nodeId });
		const db = dbOf('reuse-db');
		for (const project of [first, second])
			core.databases.attach(owner, core.projects.requireRow(owner, project.slug), { database: 'reuse-db', envPrefix: 'DATABASE' });

		activate(first.slug, 1);
		const before = endpointRows(workerA.nodeId, db.id);
		activate(second.slug, 1);
		const after = endpointRows(workerA.nodeId, db.id);
		expect(after).toEqual(before);
		expect(after.filter((row) => row.role === 'primary')).toHaveLength(1);
		expect(after.filter((row) => row.role === 'pool')).toHaveLength(1);
		const one = core.databases.consumerEnv(first.id, workerA.nodeId, 'container');
		const two = core.databases.consumerEnv(second.id, workerA.nodeId, 'container');
		expect(one.DATABASE_URL).toBe(two.DATABASE_URL);
		// Same node still goes through the endpoint: a promotion cannot change this URL.
		expect(one.DATABASE_PORT).toBe(String(after.find((row) => row.role === 'primary')!.localPort));
	});
});

describe('promotion changes no app environment and restarts none', () => {
	test('a container on the promoted node keeps its URL, port and activation version', async () => {
		const project = await core.projects.create(owner, {
			name: 'Promotion app',
			slug: 'promotion-app',
			runtime: 'container',
			placement: workerB.nodeId,
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const db = core.databases.create(owner, { name: 'promotion-db', placement: data.nodeId });
		core.databases.attach(owner, core.projects.requireRow(owner, project.slug), { database: 'promotion-db', envPrefix: 'DATABASE' });
		activate(project.slug, 1);
		const replica = core.databaseReplicas.add(owner, 'promotion-db', { node: workerB.nodeId });
		beat(data, {
			databaseReplication: [
				{
					databaseId: db.id,
					appliedVersion: core.databaseReplicas.replicationTasksForNode(data.nodeId).find((item) => item.databaseId === db.id)!.version,
					error: null,
					slots: [slotSample(replica.slot!)],
					sampledAt: new Date(clock).toISOString(),
				},
			],
		});
		// The read URL exists from the deploy on (review debt 2, item 8); everything after it — the
		// replica, the promotion — must change nothing.
		const beforeEnv = core.databases.consumerEnv(project.id, workerB.nodeId, 'container');
		const beforeVersion = core.databases.consumerVersion(project.id, workerB.nodeId, 'container');
		const beforeState = await core.nodes.desiredState(workerB.token);
		const beforeWorkload = beforeState.workloads.find((item) => item.projectId === project.id)!;
		const beforePort = Number(beforeEnv.DATABASE_PORT);
		// Assert the capture is real before comparing it: two empty envs must not pass.
		expect(beforePort).toBeGreaterThanOrEqual(21_000);
		expect(beforeEnv.DATABASE_URL).toContain(`@${databaseAlias(db.id)}:${beforePort}/`);
		expect(beforeEnv.DATABASE_HOST).toBe(databaseAlias(db.id));
		expect(beforeWorkload.activationVersion).not.toBe('');
		const beforePrimary = endpointRows(workerB.nodeId, db.id).find((row) => row.role === 'primary')!;
		const started = await core.databaseReplicas.promote(owner, 'promotion-db', replica.id, { confirm: true }, { ifMatch: 0 });
		beat(data, { workloads: [] });
		beat(workerB, {
			databaseReplicaPromotionResults: [{ failoverId: started.id, attempt: 0, status: 'ok', promoted: true, lsn: '0/4000000' }],
		});
		expect(core.databases.get(owner, 'promotion-db').nodeId).toBe(workerB.nodeId);

		const afterEnv = core.databases.consumerEnv(project.id, workerB.nodeId, 'container');
		const afterVersion = core.databases.consumerVersion(project.id, workerB.nodeId, 'container');
		const afterState = await core.nodes.desiredState(workerB.token);
		const afterWorkload = afterState.workloads.find((item) => item.projectId === project.id)!;
		expect(afterEnv).toEqual(beforeEnv);
		expect(Number(afterEnv.DATABASE_PORT)).toBe(beforePort);
		expect(afterVersion).toBe(beforeVersion);
		expect(afterWorkload.activationVersion).toBe(beforeWorkload.activationVersion);
		// The endpoint's upstream moved to the new primary; its local port and the app did not.
		const rows = endpointRows(workerB.nodeId, db.id);
		expect(rows.find((row) => row.role === 'primary')!.upstreamNodeId).toBe(workerB.nodeId);
		expect(rows.find((row) => row.role === 'primary')!.localPort).toBe(beforePort);
		// Only the upstream changed, so the version the agent reloads on is bumped.
		expect(rows.find((row) => row.role === 'primary')!.version).toBeGreaterThan(beforePrimary.version!);
	});

	test('a stable read endpoint follows a replica across nodes', async () => {
		const project = await core.projects.create(owner, {
			name: 'Read app',
			slug: 'read-app',
			runtime: 'container',
			placement: workerC.nodeId,
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const db = core.databases.create(owner, { name: 'read-db', placement: data.nodeId });
		core.databases.attach(owner, core.projects.requireRow(owner, project.slug), { database: 'read-db', envPrefix: 'DATABASE' });
		activate(project.slug, 1);
		const replica = core.databaseReplicas.add(owner, 'read-db', { node: workerA.nodeId });
		beat(data, {
			databaseReplication: [
				{
					databaseId: db.id,
					appliedVersion: core.databaseReplicas.replicationTasksForNode(data.nodeId).find((item) => item.databaseId === db.id)!.version,
					error: null,
					slots: [slotSample(replica.slot!)],
					sampledAt: new Date(clock).toISOString(),
				},
			],
		});
		const env = core.databases.consumerEnv(project.id, workerC.nodeId, 'container');
		const read = endpointRows(workerC.nodeId, db.id).find((row) => row.role === 'read')!;
		expect(read.localPort).toBeGreaterThanOrEqual(23_000);
		expect(read.localPort).toBeLessThanOrEqual(23_999);
		expect(env.DATABASE_READ_URL).toContain(`@${databaseAlias(db.id)}:${read.localPort}/`);
		expect(env.DATABASE_READ_URLS).toBe(env.DATABASE_READ_URL);
		const state = await core.nodes.desiredState(workerC.token);
		// Other apps on worker-c have their own read endpoints from their first deploy (item 8 of
		// review debt 2): look at this database's.
		const ours = (state.readEndpoints ?? []).filter((item) => item.serviceId === db.id);
		expect(ours).toHaveLength(1);
		expect(ours[0]).toMatchObject({ localPort: read.localPort, gatewayAddress: CONTAINER_GATEWAY_ADDRESS });
		expect(ours[0]!.upstreams.map((item) => item.nodeId)).toEqual(
			expect.arrayContaining([workerA.nodeId, data.nodeId]),
		);

		// Losing every readable replica keeps the same port and URL (the endpoint falls back to the
		// primary), so a failover is not a reason to restart the app or change its environment.
		const before = core.databases.consumerVersion(project.id, workerC.nodeId, 'container');
		beat(data, {
			databaseReplication: [
				{
					databaseId: db.id,
					appliedVersion: core.databaseReplicas.replicationTasksForNode(data.nodeId).find((item) => item.databaseId === db.id)!.version,
					error: null,
					slots: [slotSample(replica.slot!, { active: false, state: null })],
					sampledAt: new Date(clock).toISOString(),
				},
			],
		});
		expect(core.databaseReplicas.list(owner, 'read-db')[0]!.status).toBe('stopped');
		expect(endpointRows(workerC.nodeId, db.id).find((row) => row.role === 'read')).toMatchObject({ localPort: read.localPort });
		expect(core.databases.consumerEnv(project.id, workerC.nodeId, 'container').DATABASE_READ_URL).toBe(env.DATABASE_READ_URL);
		expect(core.databases.consumerVersion(project.id, workerC.nodeId, 'container')).toBe(before);
	});
});

function slotSample(slot: string, extra: Partial<DatabaseReplicationSlotStatus> = {}): DatabaseReplicationSlotStatus {
	return {
		slot,
		active: true,
		walStatus: 'reserved',
		state: 'streaming',
		sentLsn: '0/3000148',
		replayLsn: '0/3000148',
		lagBytes: 0,
		lagSeconds: 0,
		syncState: 'async',
		...extra,
	};
}

describe('the single-node gate: with the flag off, behaviour is today\'s', () => {
	test('a container stays on its database node and gets no gateway fields', async () => {
		const offDir = mkdtempSync(join(tmpdir(), 'yoal-attach-off-'));
		const off = createDb({ path: ':memory:' });
		const coreOff: Core = createCore({
			db: off.db,
			sqlite: off.sqlite,
			version: '0.1.0',
			config: {
				dataDir: offDir,
				platformOrigin: 'https://control.test',
				contentDomain: 'sites.test',
				objectStore: new LocalObjectStore(join(offDir, 'objects'), 'https://control.test', 'object-secret-123'),
				masterKey: new Uint8Array(32).fill(7),
				siteCookieSecret: 'site-cookie-secret-123',
				objectStoreSecret: 'object-secret-123',
				desiredAgentVersion: '0.1.0',
				now: () => clock,
				features: { ...DEFAULT_FEATURES, ENDPOINTS_GATEWAY: false, SERVICE_ENDPOINTS: true, MULTI_NODE_REPLICAS: true },
			},
		});
		try {
			const a = coreOff.nodes.join({ token: coreOff.nodes.createJoinToken(owner, 'only').token, name: 'only' });
			const b = coreOff.nodes.join({ token: coreOff.nodes.createJoinToken(owner, 'other').token, name: 'other' });
			for (const node of [a, b])
				coreOff.nodes.heartbeat(node.token, {
					nodeId: node.nodeId,
					agentVersion: '0.1.0',
					actualStateVersion: coreOff.nodes.stateVersion(),
					status: 'online',
					caddyOk: true,
					releases: [],
					capabilities: [...nodeCapabilities, 'endpoints-gateway'],
				});
			const project = await coreOff.projects.create(owner, {
				name: 'Off app',
				slug: 'off-app',
				runtime: 'container',
				placement: 'auto',
				productionAccess: 'public',
				previewAccess: 'platform',
			});
			coreOff.databases.create(owner, { name: 'off-db', placement: b.nodeId });
			const db = coreOff.databases.get(owner, 'off-db');
			coreOff.databases.attach(owner, coreOff.projects.requireRow(owner, 'off-app'), { database: 'off-db', envPrefix: 'DATABASE' });
			const row = coreOff.projects.requireRow(owner, 'off-app');
			coreOff.workloads.setSpec(owner, row, {
				runtime: 'container',
				image: 'localhost/app:1',
				port: 3_900,
				memoryMb: 128,
				cpus: 1,
				healthPath: '/',
				env: {},
				secrets: [],
			} as never);
			const current = coreOff.projects.requireRow(owner, 'off-app');
			expect(coreOff.workloads.scalingMode(current, { runtime: 'container', ingress: 'http' } as never, null).mode).toBe('single');
			const planned = coreOff.workloads.plan(owner, current);
			expect(planned.nodeId).toBe(b.nodeId);
			const env = coreOff.databases.consumerEnv(project.id, b.nodeId, 'container');
			expect(env.DATABASE_HOST).toBe(databaseAlias(db.id));
			expect(env.DATABASE_PORT).toBe('5432');
			expect(off.sqlite.query('SELECT COUNT(*) AS n FROM service_endpoints').get()).toEqual({ n: 0 });
			const state = await coreOff.nodes.desiredState(b.token);
			expect(state.readEndpoints).toBeUndefined();
			expect(state.nodeTrust).toBeUndefined();
		} finally {
			off.sqlite.close();
			rmSync(offDir, { recursive: true, force: true });
		}
	});
});
