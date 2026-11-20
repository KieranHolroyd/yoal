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
 * Horizontal scaling (docs/SCALING.md): copies change without a deploy, a deploy reaches them one
 * at a time, and an autoscaling policy holds a measured signal near its target.
 */

const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });
const stats = { diskUsedBytes: 1, diskTotalBytes: 100_000_000_000, diskFreeBytes: 90_000_000_000, uptimeSeconds: 1, load1: 0, certs: [] };
type Report = { id: string; status: WorkloadStatus; restarts: number; memoryBytes?: number; cpuNanos?: number };

function fleet(names: string[], sliceMb = 1024) {
	const dir = mkdtempSync(join(tmpdir(), 'yoal-scaling-'));
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
			// The defaults a real install runs with, service endpoints included.
			features: DEFAULT_FEATURES,
		},
	});
	const node: Record<string, { id: string; token: string }> = {};
	for (const name of names) {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(principal, name).token, name });
		node[name] = { id: joined.nodeId, token: joined.token };
		opened.sqlite.run('UPDATE nodes SET public_address = ?, slice_memory_mb = ? WHERE id = ?', [`${name}.internal:8080`, sliceMb, joined.nodeId]);
	}
	const beat = (name: string, workloads: Report[] = [], actualStateVersion = core.projects.stateVersion()) =>
		core.nodes.heartbeat(node[name]!.token, {
			nodeId: node[name]!.id,
			agentVersion: '0.1.0',
			actualStateVersion,
			status: 'online',
			caddyOk: true,
			capabilities: [],
			stats,
			releases: [],
			workloads,
		});
	for (const name of names) beat(name);
	const project = (slug: string) => core.projects.requireRow(principal, slug);
	const deploy = (slug: string, content: string) =>
		core.uploads.deployInline(principal, project(slug), [file('index.js', content)], { promote: true });
	const app = async (slug: string, spec: Record<string, unknown> = {}) => {
		await core.projects.create(principal, { name: slug, slug, runtime: 'process', placement: 'auto', productionAccess: 'public', previewAccess: 'platform' });
		core.workloads.setSpec(principal, project(slug), {
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
		await deploy(slug, '1');
		return core.workloads.view(project(slug))!;
	};
	const nameOf = (id: string) => names.find((name) => node[name]!.id === id)!;
	const copies = (slug: string) =>
		opened.sqlite
			.query<{ id: string; index: number; nodeId: string; status: string; deploymentId: string | null; appliedVersion: number | null }, [string]>(
				`SELECT r.id, r.replica_index AS "index", r.node_id AS nodeId, r.status, r.deployment_id AS deploymentId, r.applied_version AS appliedVersion
				 FROM workload_replicas r JOIN projects p ON p.id = r.project_id WHERE p.slug = ? ORDER BY r.replica_index`,
			)
			.all(slug)
			.map((row) => ({ ...row, node: nameOf(row.nodeId) }));
	/** Every node reports each copy it should run as up, having converged to the current state. */
	const settle = async (slug: string) => {
		for (const name of names) {
			const desired = (await core.nodes.desiredState(node[name]!.token)).workloads.filter((entry) => entry.projectSlug === slug);
			beat(name, desired.map((entry) => ({ id: entry.id, status: 'running' as const, restarts: 0 })));
		}
	};
	const desired = async (name: string, slug: string) =>
		(await core.nodes.desiredState(node[name]!.token)).workloads.filter((entry) => entry.projectSlug === slug);
	const rollout = (slug: string) =>
		opened.sqlite
			.query<{ status: string | null; message: string | null }, [string]>(
				'SELECT w.rollout_status AS status, w.rollout_message AS message FROM workloads w JOIN projects p ON p.id = w.project_id WHERE p.slug = ?',
			)
			.get(slug)!;
	return { core, sqlite: opened.sqlite, clock, node, names, beat, app, deploy, project, copies, settle, desired, rollout, nameOf };
}

describe('scaling without a deploy', () => {
	test('a running single copy becomes copy 0 of a set: same unit, no restart, and the rest are placed', async () => {
		const f = fleet(['edge', 'a', 'b']);
		const workload = await f.app('web');
		const home = f.nameOf(workload.nodeId!);
		const before = (await f.desired(home, 'web'))[0]!;

		const result = f.core.scaling.scale(principal, f.project('web'), { replicas: 3 });
		expect(result).toMatchObject({ from: 1, to: 3 });
		expect(result.added.map((copy) => copy.index)).toEqual([1, 2]);

		const set = f.copies('web');
		expect(set.map((copy) => copy.index)).toEqual([0, 1, 2]);
		expect(new Set(set.map((copy) => copy.node)).size).toBe(3);
		expect(set[0]!.node).toBe(home);
		// Copy 0 keeps the workload's id and its activation version, so its unit is left alone.
		const after = (await f.desired(home, 'web'))[0]!;
		expect(after.id).toBe(before.id);
		expect(after.activationVersion).toBe(before.activationVersion);
		expect(f.core.workloads.view(f.project('web'))).toMatchObject({ memoryMb: 768 });
		expect(f.core.workloads.projectSpec(f.project('web'))?.replicas).toBe(3);
	});

	test('scaling down removes the highest copies, and back to one is the plain single-copy shape', async () => {
		const f = fleet(['edge', 'a', 'b']);
		await f.app('web');
		f.core.scaling.scale(principal, f.project('web'), { replicas: 3 });
		const down = f.core.scaling.scale(principal, f.project('web'), { replicas: 2 });
		expect(down.removed.map((copy) => copy.index)).toEqual([2]);
		expect(f.copies('web').map((copy) => copy.index)).toEqual([0, 1]);

		f.core.scaling.scale(principal, f.project('web'), { replicas: 1 });
		expect(f.copies('web')).toEqual([]);
		expect(f.core.workloads.view(f.project('web'))).toMatchObject({ memoryMb: 256 });
		expect(f.core.scaling.view(principal, f.project('web')).events.map((event) => [event.from, event.to])).toEqual([[2, 1], [3, 2], [1, 3]]);
	});

	test('an HTTP app needs a node per copy and is told how many fit; nothing is written when it does not', async () => {
		const f = fleet(['edge', 'a']);
		await f.app('web');
		expect(() => f.core.scaling.scale(principal, f.project('web'), { replicas: 3 })).toThrow('already holds a copy');
		expect(f.copies('web')).toEqual([]);
		expect(f.core.scaling.view(principal, f.project('web'))).toMatchObject({ replicas: 1, mode: 'spread', capacity: 2, blocker: null });
	});

	test('a worker spreads first and then stacks, so it can run more copies than there are nodes', async () => {
		const f = fleet(['edge', 'a']);
		await f.app('queue', { ingress: 'none', memoryMb: 128 });
		f.core.scaling.scale(principal, f.project('queue'), { replicas: 5 });
		const perNode = f.copies('queue').reduce<Record<string, number>>((count, copy) => ({ ...count, [copy.node]: (count[copy.node] ?? 0) + 1 }), {});
		expect(Object.values(perNode).sort()).toEqual([2, 3]);
		expect(f.core.scaling.view(principal, f.project('queue')).mode).toBe('stack');
	});

	test('an app that must stay on its node says why it cannot scale out', async () => {
		const f = fleet(['edge', 'a', 'b']);
		await f.app('stateful', { data: { sizeMb: 64 } });
		expect(() => f.core.scaling.scale(principal, f.project('stateful'), { replicas: 2 })).toThrow();
		const view = f.core.scaling.view(principal, f.project('stateful'));
		expect(view).toMatchObject({ mode: 'single', capacity: 1 });
		expect(view.blocker).toContain('persistent data directory');
	});

	test('a deploy keeps the copies where they are instead of reshuffling them', async () => {
		const f = fleet(['edge', 'a', 'b']);
		await f.app('web');
		f.core.scaling.scale(principal, f.project('web'), { replicas: 2 });
		const before = f.copies('web').map((copy) => [copy.id, copy.node]);
		await f.deploy('web', '2');
		expect(f.copies('web').map((copy) => [copy.id, copy.node])).toEqual(before);
	});

	test('a rollback restores the release, not the old number of copies', async () => {
		const f = fleet(['edge', 'a', 'b']);
		await f.app('web');
		await f.deploy('web', '2');
		f.core.scaling.scale(principal, f.project('web'), { replicas: 3 });
		await f.core.deployments.rollback(principal, f.project('web'));
		expect(f.copies('web')).toHaveLength(3);
		expect(f.core.scaling.view(principal, f.project('web')).replicas).toBe(3);
	});
});

describe('rolling deploys', () => {
	const release = async (f: ReturnType<typeof fleet>, name: string) => (await f.desired(name, 'web'))[0]?.release;

	test('a new release reaches the copies one at a time, each confirmed before the next', async () => {
		const f = fleet(['edge', 'a', 'b']);
		await f.app('web');
		f.core.scaling.scale(principal, f.project('web'), { replicas: 3 });
		await f.settle('web');
		const old = await release(f, 'a');

		await f.deploy('web', '2');
		expect(f.rollout('web').status).toBe('rolling');
		// Nothing has restarted yet: every copy still runs the previous release.
		for (const name of f.names) expect(await release(f, name)).toBe(old);
		expect(f.core.scaling.view(principal, f.project('web')).rollout).toMatchObject({ status: 'rolling', updated: 0, total: 3 });

		await f.core.failover.tick();
		const first = f.copies('web').filter((copy) => copy.deploymentId === null);
		expect(first).toHaveLength(1);
		expect(first[0]).toMatchObject({ status: 'pending' });
		expect(await release(f, first[0]!.node)).not.toBe(old);

		// The node still reports its old unit as running: that must not let the rollout race ahead.
		const staleVersion = first[0]!.appliedVersion! - 1;
		f.beat(first[0]!.node, [{ id: (await f.desired(first[0]!.node, 'web'))[0]!.id, status: 'running', restarts: 0 }], staleVersion);
		await f.core.failover.tick();
		expect(f.copies('web').filter((copy) => copy.deploymentId === null)).toHaveLength(1);
		// And the copy being restarted is out of the ingress upstreams meanwhile.
		const edgeRoute = (await f.core.nodes.desiredState(f.node.edge!.token)).routes.find((route) => route.slug === 'web' && route.upstreams);
		expect(edgeRoute?.upstreams).toHaveLength(2);

		for (let step = 0; step < 4; step++) {
			await f.settle('web');
			await f.core.failover.tick();
		}
		expect(f.copies('web').every((copy) => copy.deploymentId === null && copy.status === 'running' && copy.appliedVersion === null)).toBe(true);
		expect(f.rollout('web').status).toBeNull();
		for (const name of f.names) expect(await release(f, name)).not.toBe(old);
	});

	test('with automatic rollback off, a copy that fails pauses the rollout; the rest keep serving the old one', async () => {
		const f = fleet(['edge', 'a', 'b']);
		f.core.cluster.update(principal, { scheduling: { autoRollback: false } });
		await f.app('web');
		f.core.scaling.scale(principal, f.project('web'), { replicas: 3 });
		await f.settle('web');
		const old = await release(f, 'a');
		await f.deploy('web', '2');
		await f.core.failover.tick();
		const rolled = f.copies('web').find((copy) => copy.deploymentId === null)!;
		f.beat(rolled.node, [{ id: (await f.desired(rolled.node, 'web'))[0]!.id, status: 'failed', restarts: 5 }]);
		await f.core.failover.tick();

		expect(f.rollout('web').status).toBe('paused');
		expect(f.rollout('web').message).toContain('2 of 3 copies still run the previous release');
		const waiting = f.copies('web').filter((copy) => copy.deploymentId !== null);
		expect(waiting).toHaveLength(2);
		for (const copy of waiting) expect(await release(f, copy.node)).toBe(old);
		// Paused means paused: further ticks touch nothing.
		await f.core.failover.tick();
		expect(f.copies('web').filter((copy) => copy.deploymentId !== null)).toHaveLength(2);

		// Rolling back puts the one updated copy back on the release the others never left.
		await f.core.deployments.rollback(principal, f.project('web'));
		for (let step = 0; step < 3; step++) {
			await f.settle('web');
			await f.core.failover.tick();
		}
		expect(f.rollout('web').status).toBeNull();
		for (const name of f.names) expect(await release(f, name)).toBe(old);
	});

	test('a copy that never becomes healthy times the rollout out', async () => {
		const f = fleet(['edge', 'a', 'b']);
		f.core.cluster.update(principal, { scheduling: { autoRollback: false } });
		await f.app('web');
		f.core.scaling.scale(principal, f.project('web'), { replicas: 2 });
		await f.settle('web');
		await f.deploy('web', '2');
		await f.core.failover.tick();
		f.clock.now += 301_000;
		for (const name of f.names) f.beat(name);
		await f.core.failover.tick();
		expect(f.rollout('web')).toMatchObject({ status: 'paused' });
		expect(f.rollout('web').message).toContain('did not become healthy within 300 s');
	});

	test('a single copy, or rolling deploys turned off, updates in place as before', async () => {
		const f = fleet(['edge', 'a', 'b']);
		await f.app('web');
		await f.deploy('web', '2');
		expect(f.rollout('web').status).toBeNull();

		f.core.scaling.scale(principal, f.project('web'), { replicas: 2 });
		f.core.cluster.update(principal, { scheduling: { rollingDeploys: false } });
		await f.deploy('web', '3');
		expect(f.rollout('web').status).toBeNull();
		expect(f.copies('web').every((copy) => copy.deploymentId === null)).toBe(true);
	});
});

describe('automatic rollback', () => {
	const release = async (f: ReturnType<typeof fleet>, name: string) => (await f.desired(name, 'web'))[0]?.release;
	const production = (f: ReturnType<typeof fleet>) => f.core.projects.requireRow(principal, 'web').productionDeploymentId;

	test('a release that fails on its first copy is put back by itself, production pointer included', async () => {
		const f = fleet(['edge', 'a', 'b']);
		await f.app('web');
		f.core.scaling.scale(principal, f.project('web'), { replicas: 3 });
		await f.settle('web');
		const good = production(f);
		const old = await release(f, 'a');

		await f.deploy('web', '2');
		expect(production(f)).not.toBe(good);
		await f.core.failover.tick();
		const rolled = f.copies('web').find((copy) => copy.deploymentId === null)!;
		f.beat(rolled.node, [{ id: (await f.desired(rolled.node, 'web'))[0]!.id, status: 'failed', restarts: 5 }]);
		await f.core.failover.tick();

		expect(production(f)).toBe(good);
		const view = f.core.scaling.view(principal, f.project('web'));
		expect(view.lastRollback?.note).toContain('rolled back to its previous release automatically');
		expect(view.lastRollback?.note).toContain('kept serving on the previous release');
		// Only the one copy that was touched has anything to undo.
		expect(view.rollout).toMatchObject({ status: 'rolling', automatic: true, updated: 2, total: 3 });
		for (let step = 0; step < 3; step++) {
			await f.settle('web');
			await f.core.failover.tick();
		}
		expect(f.rollout('web').status).toBeNull();
		for (const name of f.names) expect(await release(f, name)).toBe(old);
		expect(f.copies('web').every((copy) => copy.status === 'running')).toBe(true);
	});

	test('if the rollback fails too it pauses: the release was not the problem', async () => {
		const f = fleet(['edge', 'a', 'b']);
		await f.app('web');
		f.core.scaling.scale(principal, f.project('web'), { replicas: 2 });
		await f.settle('web');
		await f.deploy('web', '2');
		await f.core.failover.tick();
		const rolled = f.copies('web').find((copy) => copy.deploymentId === null)!;
		const fail = async () => f.beat(rolled.node, [{ id: (await f.desired(rolled.node, 'web'))[0]!.id, status: 'failed', restarts: 5 }]);
		await fail();
		await f.core.failover.tick();
		// The rollback restarts that copy on the old release...
		await f.core.failover.tick();
		await fail();
		await f.core.failover.tick();
		// ...and when that fails as well, nothing bounces: it stops and waits.
		expect(f.rollout('web').status).toBe('paused');
	});

	test('the next deploy clears the note', async () => {
		const f = fleet(['edge', 'a', 'b']);
		await f.app('web');
		f.core.scaling.scale(principal, f.project('web'), { replicas: 2 });
		await f.settle('web');
		await f.deploy('web', '2');
		await f.core.failover.tick();
		const rolled = f.copies('web').find((copy) => copy.deploymentId === null)!;
		f.beat(rolled.node, [{ id: (await f.desired(rolled.node, 'web'))[0]!.id, status: 'failed', restarts: 5 }]);
		await f.core.failover.tick();
		expect(f.core.scaling.view(principal, f.project('web')).lastRollback).not.toBeNull();
		await f.deploy('web', '3');
		expect(f.core.scaling.view(principal, f.project('web')).lastRollback).toBeNull();
	});
});

describe('deploying a single copy without a gap', () => {
	const own = async (f: ReturnType<typeof fleet>, name: string) => (await f.desired(name, 'web'))[0];

	test('a temporary second copy takes the traffic while the app\'s own copy restarts, then goes', async () => {
		const f = fleet(['edge', 'a', 'b']);
		const workload = await f.app('web');
		const home = f.nameOf(workload.nodeId!);
		await f.settle('web');
		const before = (await own(f, home))!;

		await f.deploy('web', '2');
		expect(f.core.scaling.view(principal, f.project('web')).rollout).toMatchObject({ status: 'rolling', surge: true, updated: 1, total: 2 });
		const [mine, extra] = f.copies('web');
		expect(mine).toMatchObject({ index: 0, node: home, status: 'running' });
		expect(extra!.node).not.toBe(home);
		// The app's own copy is untouched: same unit, same release.
		expect(await own(f, home)).toMatchObject({ id: before.id, release: before.release });
		expect((await own(f, extra!.node))?.release).not.toBe(before.release);
		// Both nodes account for their copy while two exist.
		expect(Object.fromEntries(f.core.workloads.capacityInternal().map((row) => [row.name, row.reservedMemoryMb]))).toMatchObject({ [home]: 256, [extra!.node]: 256 });

		// Until the new copy is up, nothing happens to the old one.
		await f.core.failover.tick();
		expect(f.copies('web')[0]!.deploymentId).not.toBeNull();
		await f.settle('web');
		await f.core.failover.tick();
		expect(f.copies('web')[0]).toMatchObject({ deploymentId: null, status: 'pending' });
		expect((await own(f, home))?.release).not.toBe(before.release);
		// The temporary copy is the only upstream while the app's own restarts.
		const route = (await f.core.nodes.desiredState(f.node.edge!.token)).routes.find((entry) => entry.slug === 'web' && entry.upstreams);
		expect(route?.upstreams).toEqual([`http://${extra!.node}.internal:8080`]);

		await f.settle('web');
		await f.core.failover.tick();
		expect(f.copies('web')).toEqual([]);
		expect(f.rollout('web').status).toBeNull();
		const after = f.core.workloads.view(f.project('web'))!;
		expect(after).toMatchObject({ nodeId: workload.nodeId, memoryMb: 256 });
		expect(await own(f, extra!.node)).toBeUndefined();
		expect((await own(f, home))?.id).toBe(before.id);
	});

	test('a release that never comes up is dropped, and the running copy was never touched', async () => {
		const f = fleet(['edge', 'a', 'b']);
		const workload = await f.app('web');
		const home = f.nameOf(workload.nodeId!);
		await f.settle('web');
		const good = f.core.projects.requireRow(principal, 'web').productionDeploymentId;
		const before = (await own(f, home))!;

		await f.deploy('web', '2');
		const extra = f.copies('web')[1]!;
		f.beat(extra.node, [{ id: (await own(f, extra.node))!.id, status: 'failed', restarts: 5 }]);
		await f.core.failover.tick();

		expect(f.copies('web')).toEqual([]);
		expect(f.core.projects.requireRow(principal, 'web').productionDeploymentId).toBe(good);
		expect(await own(f, home)).toMatchObject({ id: before.id, release: before.release, activationVersion: before.activationVersion });
		expect(f.core.scaling.view(principal, f.project('web')).lastRollback?.note).toContain('rolled back');
		expect(f.core.workloads.view(f.project('web'))).toMatchObject({ memoryMb: 256 });
	});

	test('with nowhere to put a second copy, or surge deploys off, the copy restarts in place', async () => {
		const f = fleet(['edge']);
		await f.app('web');
		await f.settle('web');
		await f.deploy('web', '2');
		expect(f.copies('web')).toEqual([]);
		expect(f.rollout('web').status).toBeNull();

		const g = fleet(['edge', 'a', 'b']);
		g.core.cluster.update(principal, { scheduling: { surgeDeploys: false } });
		await g.app('web');
		await g.settle('web');
		await g.deploy('web', '2');
		expect(g.copies('web')).toEqual([]);
	});

	test('an app that must stay on its node is not surged', async () => {
		const f = fleet(['edge', 'a', 'b']);
		await f.app('web', { data: { sizeMb: 64 } });
		await f.settle('web');
		await f.deploy('web', '2');
		expect(f.copies('web')).toEqual([]);
	});
});

describe('autoscaling', () => {
	/** Report CPU for every copy: `percent` of one core over the 10 s since the last heartbeat. */
	const load = async (f: ReturnType<typeof fleet>, slug: string, percent: number, totals: Map<string, number>) => {
		f.clock.now += 10_000;
		for (const name of f.names) {
			const entries = await f.desired(name, slug);
			f.beat(
				name,
				entries.map((entry) => {
					const total = (totals.get(entry.id) ?? 0) + percent * 1e8;
					totals.set(entry.id, total);
					return { id: entry.id, status: 'running' as const, restarts: 0, cpuNanos: total, memoryBytes: 64 * 1024 * 1024 };
				}),
			);
		}
	};

	test('CPU over target adds copies at once; CPU under target removes one only after the quiet window', async () => {
		const f = fleet(['edge', 'a', 'b', 'c']);
		await f.app('web');
		f.core.scaling.setPolicy(principal, f.project('web'), { enabled: true, min: 1, max: 4, metric: 'cpu', target: 50, scaleDownMinutes: 2 });
		const totals = new Map<string, number>();
		await load(f, 'web', 0, totals);
		await load(f, 'web', 95, totals);
		await load(f, 'web', 95, totals);

		await f.core.failover.tick();
		const view = f.core.scaling.view(principal, f.project('web'));
		expect(view.replicas).toBe(2);
		expect(view.autoscale.observed).toBeGreaterThan(55);
		expect(view.events[0]).toMatchObject({ from: 1, to: 2, reason: 'autoscale' });

		// Still hot, but inside the cooldown: the new copy gets a chance to take load first.
		f.clock.now += 30_000;
		await load(f, 'web', 95, totals);
		await f.core.failover.tick();
		expect(f.core.scaling.view(principal, f.project('web')).replicas).toBe(2);

		// Load drops. One low reading is not enough...
		for (let i = 0; i < 6; i++) await load(f, 'web', 5, totals);
		await f.core.failover.tick();
		expect(f.core.scaling.view(principal, f.project('web')).replicas).toBe(2);
		expect(f.core.scaling.view(principal, f.project('web')).autoscale.reason).toContain('Removing a copy if it stays this low');
		// ...staying low for the whole window is.
		for (let i = 0; i < 13; i++) await load(f, 'web', 5, totals);
		await f.core.failover.tick();
		expect(f.core.scaling.view(principal, f.project('web')).replicas).toBe(1);
	});

	test('the bounds apply as soon as the policy is saved, and a manual scale cannot leave them', async () => {
		const f = fleet(['edge', 'a', 'b']);
		await f.app('web');
		const view = f.core.scaling.setPolicy(principal, f.project('web'), { enabled: true, min: 2, max: 3, metric: 'memory', target: 70 });
		expect(view.replicas).toBe(2);
		expect(() => f.core.scaling.scale(principal, f.project('web'), { replicas: 1 })).toThrow('between 2 and 3');
		expect(() => f.core.scaling.setPolicy(principal, f.project('web'), { enabled: true, min: 3, max: 2 })).toThrow('minimum cannot be above');
	});

	test('wanting more copies than the fleet fits scales as far as it can and says so', async () => {
		const f = fleet(['edge', 'a']);
		await f.app('web');
		f.core.scaling.setPolicy(principal, f.project('web'), { enabled: true, min: 1, max: 6, metric: 'cpu', target: 20 });
		const totals = new Map<string, number>();
		await load(f, 'web', 0, totals);
		for (let i = 0; i < 3; i++) await load(f, 'web', 100, totals);
		await f.core.failover.tick();
		f.clock.now += 61_000;
		for (let i = 0; i < 3; i++) await load(f, 'web', 100, totals);
		await f.core.failover.tick();
		const view = f.core.scaling.view(principal, f.project('web'));
		expect(view.replicas).toBe(2);
		expect(view.autoscale.reason).toMatch(/only 2 fit|Could not add a copy/);
	});

	test('no usage yet means no decision, not a guess', async () => {
		const f = fleet(['edge', 'a', 'b']);
		await f.app('web');
		f.core.scaling.setPolicy(principal, f.project('web'), { enabled: true, min: 1, max: 3, metric: 'cpu', target: 50 });
		await f.core.failover.tick();
		const view = f.core.scaling.view(principal, f.project('web'));
		expect(view.replicas).toBe(1);
		expect(view.autoscale.reason).toContain('No CPU usage reported yet');
		expect(view.autoscale.available).toBe(false);
	});

	test('request rate without telemetry explains itself', async () => {
		const f = fleet(['edge', 'a', 'b']);
		await f.app('web');
		f.core.scaling.setPolicy(principal, f.project('web'), { enabled: true, min: 1, max: 3, metric: 'requests', target: 100 });
		await f.core.failover.tick();
		expect(f.core.scaling.view(principal, f.project('web')).autoscale.reason).toContain('needs telemetry');
	});
});

describe('measured usage', () => {
	const MB = 1024 * 1024;

	test('right-sizing waits for a whole day, then suggests a reservation a quarter above the peak', async () => {
		const f = fleet(['edge', 'a', 'b']);
		const workload = await f.app('web');
		const node = f.nameOf(workload.nodeId!);
		const sample = (memoryMb: number) => f.beat(node, [{ id: workload.id, status: 'running', restarts: 0, memoryBytes: memoryMb * MB }]);
		sample(40);
		sample(60);
		sample(50);
		let sizing = f.core.scaling.view(principal, f.project('web')).sizing;
		expect(sizing).toMatchObject({ memoryPeakMb: 60, settled: false, advice: null });

		f.clock.now += 24 * 60 * 60_000;
		sample(45);
		sizing = f.core.scaling.view(principal, f.project('web')).sizing;
		// Yesterday's 60 MB still counts; 60 × 1.25 = 75, to the next 32 MB is 96, far under 256.
		expect(sizing).toMatchObject({ memoryPeakMb: 60, settled: true, advice: 'lower', suggestedMemoryMb: 96 });
	});

	test('a copy near its limit is told to raise it, straight away', async () => {
		const f = fleet(['edge', 'a', 'b']);
		const workload = await f.app('web');
		f.beat(f.nameOf(workload.nodeId!), [{ id: workload.id, status: 'running', restarts: 0, memoryBytes: 240 * MB }]);
		expect(f.core.scaling.view(principal, f.project('web')).sizing).toMatchObject({ advice: 'raise', suggestedMemoryMb: 320 });
	});

	test('a node whose host memory is nearly full is the last choice, whatever its reservations say', async () => {
		const f = fleet(['edge', 'a', 'b']);
		const full = JSON.stringify({ memoryBytes: 95, memoryTotalBytes: 100, diskFreeBytes: 90_000_000_000, diskTotalBytes: 100_000_000_000 });
		f.sqlite.run('UPDATE nodes SET stats_json = ? WHERE id = ?', [full, f.node.a!.id]);
		const first = await f.app('one');
		expect(f.nameOf(first.nodeId!)).toBe('b');
		// It still takes work when it is the only place left.
		f.core.scaling.scale(principal, f.project('one'), { replicas: 3 });
		expect(f.copies('one').map((copy) => copy.node)).toEqual(['b', 'edge', 'a']);
		// And it gives work away without being offered any.
		expect(f.core.scheduling.view(principal).nodes.find((node) => node.name === 'a')?.eligible).toBe(false);
	});
});


describe('health probes of protected copies (F7 review)', () => {
	test('a node holding a copy of a spread app gets its health path on every route of that app', async () => {
		const f = fleet(['edge', 'a', 'b']);
		await f.app('web', { healthPath: '/healthz' });
		// One copy: no node needs it, so routes are unchanged (the single-node shape).
		for (const name of f.names)
			for (const route of (await f.core.nodes.desiredState(f.node[name]!.token)).routes.filter((entry) => entry.slug === 'web'))
				if (!route.upstreams) expect(route.healthPath).toBeUndefined();

		f.core.scaling.scale(principal, f.project('web'), { replicas: 3 });
		await f.settle('web');
		const holders = new Set(f.copies('web').map((copy) => copy.node));
		for (const name of f.names) {
			const routes = (await f.core.nodes.desiredState(f.node[name]!.token)).routes.filter((entry) => entry.slug === 'web');
			if (!holders.has(name)) continue;
			expect(routes.length).toBeGreaterThan(0);
			// The production route is public and the preview route is `platform`: both carry the
			// path, which the node's Caddy lets an overlay probe reach without a session.
			expect(routes.some((route) => route.accessMode !== 'public')).toBe(true);
			for (const route of routes) expect(route.healthPath).toBe('/healthz');
		}
	});
});
