import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, workloadReplicaId } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

/**
 * HA-PLAN Wave 1 F8: a copy the failover controller re-places must get exactly the environment a
 * freshly deployed copy on that node gets. With SERVICE_ENDPOINTS on, a process app's copy off the
 * database's node reaches it through a loopback endpoint on its own node; a re-placed copy used to
 * land on a node with no endpoint, got no DATABASE_URL and crash-looped.
 */
const T0 = Date.parse('2026-11-20T12:00:00Z');
const dir = mkdtempSync(join(tmpdir(), 'yoal-failover-endpoints-'));
const opened = createDb({ path: ':memory:' });
const clock = { now: T0 };
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
		now: () => clock.now,
		features: { ...DEFAULT_FEATURES, MULTI_NODE_REPLICAS: true, SERVICE_ENDPOINTS: true },
	},
});
const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
type NodeName = 'edge' | 'data' | 'w1' | 'w2' | 'w3';
const joined = {} as Record<NodeName, { nodeId: string; token: string }>;
for (const name of ['edge', 'data', 'w1', 'w2', 'w3'] as const)
	joined[name] = core.nodes.join({ token: core.nodes.createJoinToken(principal, name).token, name });
const id = (name: keyof typeof joined) => joined[name].nodeId;
for (const [index, name] of (['data', 'w1', 'w2', 'w3'] as const).entries())
	opened.sqlite.run('UPDATE nodes SET private_address = ? WHERE id = ?', [`10.47.1.${index + 2}`, id(name)]);
// Copies go to the three workers only, so both copies sit off the database's node.
opened.sqlite.run('UPDATE nodes SET roles_json = ? WHERE id = ?', [JSON.stringify(['ingress', 'control']), id('edge')]);
opened.sqlite.run('UPDATE nodes SET roles_json = ? WHERE id = ?', [JSON.stringify(['data']), id('data')]);
core.cluster.update(principal, { failover: { enabled: true } });

const heartbeat = (...silent: string[]) => {
	for (const name of Object.keys(joined) as Array<keyof typeof joined>)
		if (!silent.includes(name))
			opened.sqlite.run("UPDATE nodes SET last_heartbeat_at = ?, status = 'online' WHERE id = ?", [clock.now, id(name)]);
};
const endpointsOn = (nodeId: string) =>
	opened.sqlite
		.query<{ localPort: number; serviceId: string }, [string]>(
			'SELECT local_port AS localPort, service_id AS serviceId FROM service_endpoints WHERE consumer_node_id = ?',
		)
		.all(nodeId);

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('a copy re-placed by failover gets its attachment env (F8)', () => {
	test('the moved copy reaches the remote database through a new endpoint on its new node', async () => {
		heartbeat();
		const project = await core.projects.create(principal, {
			name: 'Checker',
			slug: 'checker',
			runtime: 'process',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const database = core.databases.create(principal, { name: 'main', placement: id('data') });
		core.databases.attach(principal, core.projects.requireRow(principal, project.slug), { database: 'main', envPrefix: 'DATABASE' });
		const row = core.projects.requireRow(principal, project.slug);
		core.workloads.record(row, 'dep_checker', core.workloads.plan(principal, row, { replicas: 2, ingress: 'http' }));
		opened.sqlite.run("UPDATE workload_replicas SET status = 'running'");
		const copies = () =>
			opened.sqlite
				.query<{ id: string; nodeId: string; index: number; workloadId: string }, []>(
					'SELECT id, node_id AS nodeId, replica_index AS "index", workload_id AS workloadId FROM workload_replicas ORDER BY replica_index',
				)
				.all();
		const before = copies();
		expect(new Set(before.map((copy) => copy.nodeId)).size).toBe(2);
		expect(before.every((copy) => copy.nodeId !== id('data'))).toBe(true);
		const nameOf = (nodeId: string) => (Object.keys(joined) as Array<keyof typeof joined>).find((name) => id(name) === nodeId)!;
		const [lost, kept] = before;
		const spare = (['w1', 'w2', 'w3'] as const).find((name) => !before.some((copy) => copy.nodeId === id(name)))!;
		const envOf = (copy: { workloadId: string; index: number }, nodeId: string) =>
			core.workloads.activation(nodeId, workloadReplicaId(copy.workloadId, copy.index)).env;

		// The surviving copy is what a freshly deployed copy off the database's node gets.
		const fresh = envOf(kept!, kept!.nodeId);
		expect(fresh.DATABASE_URL).toContain(`127.0.0.1:${endpointsOn(kept!.nodeId)[0]!.localPort}`);
		expect(endpointsOn(lost!.nodeId)).toHaveLength(1);
		await core.failover.tick();

		// The lost copy's node goes silent past the grace; the controller re-places its copy.
		const silent = nameOf(lost!.nodeId);
		clock.now += 120_000;
		heartbeat(silent);
		opened.sqlite.run("UPDATE nodes SET status = 'offline' WHERE id = ?", [lost!.nodeId]);
		expect((await core.failover.tick()).moved).toBe(1);
		const moved = copies().find((copy) => copy.id === lost!.id)!;
		expect(moved.nodeId).toBe(id(spare));

		// Its new node has an endpoint for the database, and the copy's env names it.
		const endpoints = endpointsOn(moved.nodeId);
		expect(endpoints).toEqual([{ localPort: expect.any(Number), serviceId: database.id }]);
		const env = envOf(moved, moved.nodeId);
		expect(env.DATABASE_URL).toContain(`127.0.0.1:${endpoints[0]!.localPort}`);
		// Exactly what a freshly deployed copy off the database's node gets.
		expect(env).toEqual(fresh);
		// The node's desired state carries the endpoint its forwarder must open.
		const state = await core.nodes.desiredState(joined[spare].token);
		expect(state.serviceEndpoints.map((endpoint) => endpoint.serviceId)).toContain(database.id);
		// The lost node no longer holds a copy, so its endpoint is freed.
		expect(endpointsOn(lost!.nodeId)).toEqual([]);
	});
});
