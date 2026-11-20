import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

/**
 * HA-PLAN F4: copies of a process app spread across nodes while it is attached to a database on
 * another node, reaching it through service endpoints (D218, CLUSTERING §4.3). This is the base
 * of H24; `replicas-multinode.test.ts` runs with endpoints off and never covered it.
 */
const dir = mkdtempSync(join(tmpdir(), 'yoal-replicas-endpoints-'));
const opened = createDb({ path: ':memory:' });
const clock = Date.now();
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
		features: { ...DEFAULT_FEATURES, MULTI_NODE_REPLICAS: true, SERVICE_ENDPOINTS: true },
	},
});
const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const join_ = (name: string) => core.nodes.join({ token: core.nodes.createJoinToken(principal, name).token, name });
join_('edge');
const workers = ['worker-a', 'worker-b', 'worker-c'].map(join_);
const dataNode = join_('data');
for (const [index, node] of [...workers, dataNode].entries())
	opened.sqlite.run('UPDATE nodes SET private_address = ? WHERE id = ?', [`10.47.1.${index + 2}`, node.nodeId]);

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const endpointsOn = (nodeId: string) =>
	opened.sqlite
		.query<{ localPort: number; upstreamNodeId: string }, [string]>(
			'SELECT local_port AS localPort, upstream_node_id AS upstreamNodeId FROM service_endpoints WHERE consumer_node_id = ?',
		)
		.all(nodeId);

describe('process app copies spread over service endpoints (HA-PLAN F4)', () => {
	test('three copies on three nodes each reach one remote database on a stable loopback port', async () => {
		const project = await core.projects.create(principal, {
			name: 'Spread app',
			slug: 'spread-app',
			runtime: 'process',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		core.databases.create(principal, { name: 'main', placement: dataNode.nodeId });
		core.databases.attach(principal, core.projects.requireRow(principal, project.slug), { database: 'main', envPrefix: 'DATABASE' });

		const row = core.projects.requireRow(principal, project.slug);
		expect(core.workloads.scalingMode(row, { runtime: 'process', ingress: 'http' } as never, null)).toEqual({ mode: 'spread', blocker: null });
		const resolved = core.workloads.plan(principal, row, { replicas: 3, ingress: 'http' });
		const copyNodes = resolved.replicas!.map((replica) => replica.nodeId);
		expect(new Set(copyNodes).size).toBe(3);
		core.workloads.record(core.projects.requireRow(principal, project.slug), 'dep_spread', resolved);
		expect(copyNodes.filter((nodeId) => nodeId !== dataNode.nodeId).length).toBeGreaterThanOrEqual(2);

		for (const nodeId of copyNodes) {
			const env = core.databases.consumerEnv(project.id, nodeId, 'process');
			expect(env.DATABASE_URL).toBeDefined();
			if (nodeId === dataNode.nodeId) continue;
			// A copy off the database's node reaches it through its own node's endpoint.
			const endpoints = endpointsOn(nodeId);
			expect(endpoints).toHaveLength(1);
			expect(endpoints[0]!.upstreamNodeId).toBe(dataNode.nodeId);
			expect(endpoints[0]!.localPort).toBeGreaterThanOrEqual(21_000);
			expect(endpoints[0]!.localPort).toBeLessThanOrEqual(21_999);
			expect(env.DATABASE_HOST).toBe('127.0.0.1');
			expect(env.DATABASE_URL).toContain(`127.0.0.1:${endpoints[0]!.localPort}`);
		}

		// The provider side is rendered on the database's node.
		const providerState = await core.nodes.desiredState(dataNode.token);
		expect(providerState.serviceProviders?.length ?? 0).toBeGreaterThan(0);
	});

	test('a container app attached to a remote database still stays on one node (G9, until H24)', async () => {
		const project = await core.projects.create(principal, {
			name: 'Container app',
			slug: 'container-app',
			runtime: 'container',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		core.databases.create(principal, { name: 'second', placement: dataNode.nodeId });
		core.databases.attach(principal, core.projects.requireRow(principal, project.slug), { database: 'second', envPrefix: 'DATABASE' });
		const row = core.projects.requireRow(principal, project.slug);
		const mode = core.workloads.scalingMode(row, { runtime: 'container', ingress: 'http' } as never, null);
		expect(mode.mode).toBe('single');
		expect(mode.blocker).toContain('attached database');
	});
});
