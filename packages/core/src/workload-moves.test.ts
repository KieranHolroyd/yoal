import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, type WorkloadStatus } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

/**
 * Multi-node foundations (docs/CLUSTERING.md §3.10, §8.2): every copy's node serves it, each node
 * is charged for what it runs, and a single-copy workload moves on drain, failover and rebalance.
 */

const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });
const stats = { diskUsedBytes: 1, diskTotalBytes: 100_000_000_000, diskFreeBytes: 90_000_000_000, uptimeSeconds: 1, load1: 0, certs: [] };

function fleet(names: string[]) {
	const dir = mkdtempSync(join(tmpdir(), 'yoal-moves-'));
	const opened = createDb({ path: ':memory:' });
	const clock = { now: Date.UTC(2026, 10, 14) };
	const core = createCore({
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
			features: { ...DEFAULT_FEATURES, MULTI_NODE_REPLICAS: true, SERVICE_ENDPOINTS: false },
		},
	});
	const node: Record<string, { id: string; token: string }> = {};
	for (const name of names) {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(principal, name).token, name });
		node[name] = { id: joined.nodeId, token: joined.token };
		opened.sqlite.run('UPDATE nodes SET public_address = ?, slice_memory_mb = 1024 WHERE id = ?', [`${name}.internal:8080`, joined.nodeId]);
	}
	const beat = (name: string, workloads: Array<{ id: string; status: WorkloadStatus; restarts: number }> = []) =>
		core.nodes.heartbeat(node[name]!.token, {
			nodeId: node[name]!.id,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			capabilities: [],
			stats,
			releases: [],
			workloads,
		});
	for (const name of names) beat(name);
	const app = async (slug: string, spec: Record<string, unknown> = {}) => {
		await core.projects.create(principal, {
			name: slug,
			slug,
			runtime: 'process',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		core.workloads.setSpec(principal, core.projects.requireRow(principal, slug), {
			runtime: 'process',
			command: ['bun', 'run', 'start'],
			port: 3000,
			memoryMb: 256,
			cpus: 1,
			healthPath: '/',
			socketActivation: true,
			env: {},
			secrets: [],
			...spec,
		});
		await core.uploads.deployInline(principal, core.projects.requireRow(principal, slug), [file('index.js', '1')], { promote: true });
		return core.workloads.view(core.projects.requireRow(principal, slug))!;
	};
	const workloadRow = (slug: string) =>
		opened.sqlite
			.query<{ id: string; nodeId: string; movingFrom: string | null; status: string; reason: string | null }, [string]>(
				`SELECT w.id, w.node_id AS nodeId, w.moving_from_node_id AS movingFrom, w.status, w.placement_reason AS reason
				 FROM workloads w JOIN projects p ON p.id = w.project_id WHERE p.slug = ?`,
			)
			.get(slug)!;
	const nameOf = (id: string) => names.find((name) => node[name]!.id === id)!;
	const desired = (name: string) => core.nodes.desiredState(node[name]!.token);
	const routeFor = async (name: string, slug: string) =>
		(await desired(name)).routes.find((route) => route.slug === slug && route.host.startsWith(`${slug}.`));
	const events = () =>
		opened.sqlite
			.query<{ status: string; reason: string; to_node_id: string | null }, []>(
				"SELECT status, reason, to_node_id FROM failover_events WHERE kind = 'replica' ORDER BY detected_at, rowid",
			)
			.all();
	return { core, sqlite: opened.sqlite, clock, node, beat, app, workloadRow, nameOf, desired, routeFor, events };
}

describe('spread replicas on every node', () => {
	test("each copy's node gets the workload, its route and its release; the ingress balances across them", async () => {
		const f = fleet(['edge', 'a', 'b']);
		const workload = await f.app('web', { replicas: 2 });
		const copies = f.sqlite
			.query<{ nodeId: string; replicaIndex: number }, []>(
				'SELECT node_id AS nodeId, replica_index AS replicaIndex FROM workload_replicas ORDER BY replica_index',
			)
			.all();
		expect(copies.map((copy) => f.nameOf(copy.nodeId)).sort()).toEqual(['a', 'b']);

		for (const copy of copies) {
			const state = await f.desired(f.nameOf(copy.nodeId));
			expect(state.workloads.map((entry) => entry.replica?.index)).toEqual([copy.replicaIndex]);
			// The copy that is not index 0 used to get neither of these, so it could not serve.
			expect(state.routes.some((route) => route.slug === 'web' && route.upstream?.startsWith('unix/'))).toBe(true);
			expect(state.releases.length).toBe(1);
		}
		const edgeRoute = await f.routeFor('edge', 'web');
		expect(edgeRoute?.upstreams).toEqual(copies.map((copy) => `http://${f.nameOf(copy.nodeId)}.internal:8080`));
		expect(workload.memoryMb).toBe(512);
	});

	test('each node is charged for the copy it runs, not copy 0 for all of them', async () => {
		const f = fleet(['edge', 'a', 'b']);
		await f.app('web', { replicas: 2 });
		const reserved = Object.fromEntries(f.core.workloads.capacityInternal().map((row) => [row.name, row.reservedMemoryMb]));
		expect(reserved).toEqual({ edge: 0, a: 256, b: 256 });
	});

	test('a copy on a node other than copy 0 may ship its logs', async () => {
		const f = fleet(['edge', 'a', 'b']);
		const workload = await f.app('web', { replicas: 2 });
		const second = f.sqlite
			.query<{ nodeId: string }, []>('SELECT node_id AS nodeId FROM workload_replicas WHERE replica_index = 1')
			.get()!;
		expect(
			f.core.workloads.runsOnNode({ id: workload.id, nodeId: workload.nodeId, movingFromNodeId: null }, 1, second.nodeId),
		).toBe(true);
		expect(
			f.core.workloads.runsOnNode({ id: workload.id, nodeId: workload.nodeId, movingFromNodeId: null }, 1, f.node.edge!.id),
		).toBe(false);
	});
});

describe('single-copy moves', () => {
	test('a drain moves a single HTTP app with a surge: the old node serves until the new copy runs', async () => {
		const f = fleet(['edge', 'a', 'b']);
		const workload = await f.app('shop');
		const from = f.nameOf(workload.nodeId!);
		const to = from === 'a' ? 'b' : 'a';
		f.beat(from, [{ id: workload.id, status: 'running', restarts: 0 }]);
		f.core.nodes.setDraining(principal, f.node[from]!.id, true);

		expect((await f.core.failover.tick()).moved).toBe(1);
		const moving = f.workloadRow('shop');
		expect(moving).toMatchObject({ nodeId: f.node[to]!.id, movingFrom: f.node[from]!.id, status: 'pending', reason: 'drain' });

		// Both nodes run it; the ingress still dials the old one; the new one already has the release.
		expect((await f.desired(from)).workloads.map((entry) => entry.id)).toEqual([workload.id]);
		const arriving = await f.desired(to);
		expect(arriving.workloads.map((entry) => entry.id)).toEqual([workload.id]);
		expect(arriving.releases.length).toBe(1);
		expect((await f.routeFor('edge', 'shop'))?.upstream).toBe(`http://${from}.internal:8080`);

		// The old copy's reports no longer decide anything; the new copy's arrival flips the route.
		f.beat(from, [{ id: workload.id, status: 'running', restarts: 0 }]);
		expect(f.workloadRow('shop').movingFrom).toBe(f.node[from]!.id);
		f.beat(to, [{ id: workload.id, status: 'running', restarts: 0 }]);
		expect(f.workloadRow('shop')).toMatchObject({ nodeId: f.node[to]!.id, movingFrom: null, status: 'running' });
		expect((await f.routeFor('edge', 'shop'))?.upstream).toBe(`http://${to}.internal:8080`);
		expect((await f.desired(from)).workloads).toEqual([]);

		await f.core.failover.tick();
		expect(f.events().map((event) => event.status)).toEqual(['completed']);
	});

	test('a surge move that never comes up goes back to the copy that is still running', async () => {
		const f = fleet(['edge', 'a', 'b']);
		const workload = await f.app('shop');
		const from = f.nameOf(workload.nodeId!);
		const to = from === 'a' ? 'b' : 'a';
		const result = f.core.scheduling.move(principal, 'shop', { node: to });
		expect(result).toMatchObject({ mode: 'surge', to: { name: to } });
		f.beat(to, [{ id: workload.id, status: 'failed', restarts: 0 }]);
		f.clock.now += 5_000;
		for (const name of ['edge', 'a', 'b']) f.beat(name, name === to ? [{ id: workload.id, status: 'failed', restarts: 0 }] : []);
		await f.core.failover.tick();
		expect(f.workloadRow('shop')).toMatchObject({ nodeId: f.node[from]!.id, movingFrom: null, status: 'running' });
		expect(f.events().at(-1)).toMatchObject({ status: 'failed' });
		expect((await f.routeFor('edge', 'shop'))?.upstream).toBe(`http://${from}.internal:8080`);
	});

	test('a workload with data on its node is not moved, and the drain says why', async () => {
		const f = fleet(['edge', 'a', 'b']);
		const workload = await f.app('stateful', { data: { sizeMb: 64 } });
		const from = f.nameOf(workload.nodeId!);
		f.core.nodes.setDraining(principal, f.node[from]!.id, true);
		const report = await f.core.failover.tick();
		expect(report).toMatchObject({ moved: 0, blocked: 1 });
		expect(f.workloadRow('stateful').nodeId).toBe(f.node[from]!.id);
		expect(f.events()[0]!.reason).toContain('persistent data directory');
	});

	test('a lost node: a single HTTP app is re-placed, a lone worker is not', async () => {
		const f = fleet(['edge', 'a', 'b']);
		f.core.cluster.update(principal, { failover: { enabled: true } });
		const web = await f.app('web');
		const lost = f.nameOf(web.nodeId!);
		// Put the worker on the same node, so one loss covers both.
		const worker = await f.app('cron', { ingress: 'none' });
		f.sqlite.run('UPDATE workloads SET node_id = ? WHERE id = ?', [f.node[lost]!.id, worker.id]);

		f.clock.now += 130_000;
		for (const name of ['edge', 'a', 'b']) if (name !== lost) f.beat(name);
		const report = await f.core.failover.tick();
		expect(report.moved).toBe(1);
		const moved = f.workloadRow('web');
		expect(moved.nodeId).not.toBe(f.node[lost]!.id);
		// No surge: there is no copy left to keep serving.
		expect(moved).toMatchObject({ movingFrom: null, reason: 'failover' });
		expect(f.workloadRow('cron').nodeId).toBe(f.node[lost]!.id);
	});

	test('a one-node install has nothing to move and raises nothing on drain', async () => {
		const f = fleet(['edge']);
		await f.app('solo');
		f.core.nodes.setDraining(principal, f.node.edge!.id, true);
		expect(await f.core.failover.tick()).toMatchObject({ moved: 0, blocked: 0, queued: 0 });
		expect(f.events()).toEqual([]);
	});

	test('a redeploy ends a move in flight', async () => {
		const f = fleet(['edge', 'a', 'b']);
		const workload = await f.app('shop');
		const to = f.nameOf(workload.nodeId!) === 'a' ? 'b' : 'a';
		f.core.scheduling.move(principal, 'shop', { node: to });
		expect(f.workloadRow('shop').movingFrom).not.toBeNull();
		await f.core.uploads.deployInline(principal, f.core.projects.requireRow(principal, 'shop'), [file('index.js', '2')], { promote: true });
		expect(f.workloadRow('shop')).toMatchObject({ movingFrom: null, reason: 'deploy' });
	});
});

describe('rebalance', () => {
	test('previews, then moves work off the full node through the tracked move path', async () => {
		const f = fleet(['edge', 'a', 'b']);
		const slugs = ['one', 'two', 'three'];
		for (const slug of slugs) {
			const workload = await f.app(slug);
			f.sqlite.run('UPDATE workloads SET node_id = ? WHERE id = ?', [f.node.a!.id, workload.id]);
		}
		const view = f.core.scheduling.view(principal);
		expect(view.nodes.find((node) => node.name === 'a')).toMatchObject({ reservedMb: 768, reservedPercent: 75, copies: 3, movable: 3 });
		expect(view.plan.moves.length).toBeGreaterThan(0);
		expect(view.plan.gapAfter).toBeLessThan(view.plan.gapBefore);

		const preview = f.core.scheduling.rebalance(principal, {});
		expect(preview.applied).toBe(false);
		expect(slugs.every((slug) => f.workloadRow(slug).nodeId === f.node.a!.id)).toBe(true);

		const applied = f.core.scheduling.rebalance(principal, { apply: true });
		expect(applied.moved.length).toBe(preview.plan.moves.length);
		expect(applied.moved.every((move) => move.fromNodeName === 'a')).toBe(true);
		expect(slugs.filter((slug) => f.workloadRow(slug).reason === 'rebalance').length).toBe(applied.moved.length);
		expect(f.events().every((event) => event.status === 'in-progress')).toBe(true);

		// What is moving is not planned again.
		expect(f.core.scheduling.rebalance(principal, {}).plan.moves.every((move) => !applied.moved.some((done) => done.unitId === move.unitId))).toBe(true);
	});

	test('pack empties the lightest node', async () => {
		const f = fleet(['edge', 'a', 'b']);
		const first = await f.app('one');
		const second = await f.app('two');
		f.sqlite.run('UPDATE workloads SET node_id = ? WHERE id = ?', [f.node.a!.id, first.id]);
		f.sqlite.run('UPDATE workloads SET node_id = ? WHERE id = ?', [f.node.b!.id, second.id]);
		const plan = f.core.scheduling.rebalance(principal, { strategy: 'pack' }).plan;
		expect(plan.moves).toHaveLength(1);
		expect(plan.freedNodeIds).toHaveLength(1);
	});

	test('overcommit raises the admission ceiling without touching the slice', async () => {
		const f = fleet(['edge']);
		await f.app('one', { memoryMb: 768 });
		await f.core.projects.create(principal, {
			name: 'two',
			slug: 'two',
			runtime: 'process',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const second = () => f.core.workloads.plan(principal, f.core.projects.requireRow(principal, 'two'), { memoryMb: 512 });
		expect(second).toThrow();
		f.core.cluster.update(principal, { scheduling: { memoryOvercommitPercent: 150 } });
		expect(second).not.toThrow();
		expect(f.core.scheduling.view(principal).nodes[0]).toMatchObject({ sliceMemoryMb: 1024, capacityMb: 1536 });
	});

	test('automatic rebalance makes one move per interval, and only on a settled fleet', async () => {
		const f = fleet(['edge', 'a', 'b']);
		for (const slug of ['one', 'two', 'three']) {
			const workload = await f.app(slug);
			f.sqlite.run('UPDATE workloads SET node_id = ? WHERE id = ?', [f.node.a!.id, workload.id]);
		}
		await f.core.failover.tick();
		expect(f.events()).toEqual([]);
		f.core.cluster.update(principal, { scheduling: { autoRebalance: true } });
		await f.core.failover.tick();
		expect(f.events()).toHaveLength(1);
		f.clock.now += 5_000;
		for (const name of ['edge', 'a', 'b']) f.beat(name);
		await f.core.failover.tick();
		expect(f.events()).toHaveLength(1);
	});
});
