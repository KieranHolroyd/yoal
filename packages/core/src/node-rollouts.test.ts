import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-rollouts-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const admin = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const member = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'owner' });

interface Node {
	nodeId: string;
	token: string;
	name: string;
}

function fleet() {
	const opened = createDb({ path: ':memory:' });
	let clock = Date.UTC(2026, 10, 14, 12, 0, 0);
	const core: Core = createCore({
		db: opened.db,
		sqlite: opened.sqlite,
		version: '0.9.0',
		config: {
			dataDir: dir,
			platformOrigin: 'https://control.test',
			contentDomain: 'sites.test',
			objectStore: new LocalObjectStore(join(dir, `objects-${clock}-${Math.random()}`), 'https://control.test', 'object-secret-123'),
			masterKey: new Uint8Array(32).fill(7),
			siteCookieSecret: 'site-cookie-secret-123',
			objectStoreSecret: 'object-secret-123',
			desiredAgentVersion: '0.9.0',
			releaseRepo: 'owner/yoal',
			now: () => clock,
		},
	});
	const versions = new Map<string, string>();
	const capabilities = ['node-update', 'node-update-guard'];
	const beat = (node: Node, extra: { version?: string; failure?: { generation: number; error: string } } = {}) => {
		if (extra.version) versions.set(node.nodeId, extra.version);
		core.nodes.heartbeat(node.token, {
			nodeId: node.nodeId,
			agentVersion: versions.get(node.nodeId) ?? '0.8.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			releases: [],
			capabilities,
			...(extra.failure ? { nodeUpdateResult: extra.failure } : {}),
		});
	};
	const enrol = (name: string): Node => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(admin, name).token, name });
		const node = { ...joined, name };
		beat(node);
		return node;
	};
	/** Let time pass with every listed node heartbeating, then drive due flow runs. */
	const advance = (ms: number, alive: Node[]) => {
		const step = 10_000;
		for (let passed = 0; passed < ms; passed += step) {
			clock += Math.min(step, ms - passed);
			for (const node of alive) beat(node);
			core.ctx.flows.drive();
		}
	};
	const task = async (node: Node) => (await core.nodes.desiredState(node.token)).nodeUpdate;
	const rollout = () => core.nodeRollouts.active(admin) ?? core.nodeRollouts.list(admin)[0]!;
	/** The enrolled nodes in the order the rollout planned them (the edge, an ingress node, goes last). */
	const planned = (all: Node[]): Node[] =>
		[...rollout().nodes]
			.filter((entry) => entry.wave >= 0)
			.sort((x, y) => x.wave - y.wave)
			.map((entry) => all.find((node) => node.nodeId === entry.nodeId)!);
	const state = (node: Node) => rollout().nodes.find((entry) => entry.nodeId === node.nodeId);
	return { core, opened, beat, enrol, advance, task, rollout, planned, state, now: () => clock };
}

describe('fleet node updates (CLUSTERING §3.11, D217)', () => {
	let f: ReturnType<typeof fleet>;
	beforeEach(() => {
		f = fleet();
	});

	test('rolling: one node at a time, each soaked before the next', async () => {
		const all = [f.enrol('edge'), f.enrol('b'), f.enrol('c')];
		const started = f.core.nodeRollouts.start(admin, { strategy: 'rolling', soakSeconds: 60 });
		const [a, b, c] = f.planned(all) as [Node, Node, Node];
		expect(c!.name).toBe('edge');
		expect(started).toMatchObject({ status: 'running', targetVersion: '0.9.0', waves: 3, currentWave: 0 });
		expect(started.options).toMatchObject({ strategy: 'rolling', canary: true, maxFailures: 0 });

		// Only the first wave is asked.
		expect(await f.task(a)).toMatchObject({ version: '0.9.0', generation: 1 });
		expect(await f.task(b)).toBeNull();
		expect(await f.task(c)).toBeNull();
		expect(() => f.core.nodeRollouts.start(admin, {})).toThrow(/finish or cancel it first/);

		// The node restarts on the new release; the heartbeat moves the wave into its soak.
		f.beat(a, { version: '0.9.0' });
		expect(f.rollout()).toMatchObject({ phase: 'soaking' });
		expect(f.state(a)?.state).toBe('verifying');
		f.advance(30_000, [a, b, c]);
		expect(await f.task(b)).toBeNull();

		f.advance(40_000, [a, b, c]);
		expect(f.state(a)?.state).toBe('done');
		expect(f.rollout().currentWave).toBe(1);
		expect(await f.task(b)).toMatchObject({ version: '0.9.0' });

		f.beat(b, { version: '0.9.0' });
		f.advance(70_000, [a, b, c]);
		f.beat(c, { version: '0.9.0' });
		f.advance(70_000, [a, b, c]);
		const done = f.rollout();
		expect(done).toMatchObject({ status: 'succeeded', phase: 'done', failures: 0 });
		expect(done.counts.done).toBe(3);
		expect(f.core.ctx.flows.get(admin, done.flowId!).status).toBe('succeeded');
	});

	test('parallel asks every node at once', async () => {
		const nodes = [f.enrol('a'), f.enrol('b'), f.enrol('c')];
		f.core.nodeRollouts.start(admin, { strategy: 'parallel', soakSeconds: 0 });
		for (const node of nodes) expect(await f.task(node)).toMatchObject({ version: '0.9.0' });
		for (const node of nodes) f.beat(node, { version: '0.9.0' });
		expect(f.rollout()).toMatchObject({ status: 'succeeded' });
	});

	test('a failed node pauses the rollout; resume retries it with a new generation', async () => {
		const all = [f.enrol('a'), f.enrol('b')];
		f.core.nodeRollouts.start(admin, { strategy: 'rolling', soakSeconds: 0 });
		const [a, b] = f.planned(all) as [Node, Node];
		f.beat(a, { failure: { generation: 1, error: 'v0.9.0 is not trusted' } });
		const paused = f.rollout();
		expect(paused).toMatchObject({ status: 'paused', phase: 'paused', failures: 1 });
		expect(paused.detail).toMatch(/not trusted/);
		expect(await f.task(b)).toBeNull();
		expect(() => f.core.nodeRollouts.resume(member, paused.id)).toThrow();

		f.core.nodeRollouts.resume(admin, paused.id, { retryFailed: true });
		expect(f.rollout()).toMatchObject({ status: 'running', waves: 3 });
		expect(await f.task(a)).toMatchObject({ generation: 2 });
		f.beat(a, { version: '0.9.0' });
		f.beat(b, { version: '0.9.0' });
		f.advance(20_000, [a, b]);
		expect(f.rollout()).toMatchObject({ status: 'succeeded', failures: 0 });
	});

	test('maxFailures lets the rollout continue past failures', async () => {
		const all = [f.enrol('a'), f.enrol('b')];
		f.core.nodeRollouts.start(admin, { strategy: 'rolling', soakSeconds: 0, maxFailures: 1 });
		const [a, b] = f.planned(all) as [Node, Node];
		f.beat(a, { failure: { generation: 1, error: 'disk full' } });
		expect(f.rollout()).toMatchObject({ status: 'running', currentWave: 1 });
		f.beat(b, { version: '0.9.0' });
		expect(f.rollout()).toMatchObject({ status: 'succeeded', failures: 1 });
	});

	test('a node that comes back on the old release after reporting the new one fails verification', () => {
		const all = [f.enrol('a'), f.enrol('b')];
		f.core.nodeRollouts.start(admin, { strategy: 'rolling', soakSeconds: 60 });
		const [a, b] = f.planned(all) as [Node, Node];
		f.beat(a, { version: '0.9.0' });
		// The guard restored the previous binaries during the soak.
		f.beat(a, { version: '0.8.0' });
		f.advance(70_000, [a, b]);
		const view = f.rollout();
		expect(view.status).toBe('paused');
		expect(f.state(a)?.error).toMatch(/rollback guard/);
	});

	test('a node that never answers fails after the node timeout', () => {
		const all = [f.enrol('a'), f.enrol('b')];
		f.core.nodeRollouts.start(admin, { strategy: 'rolling' });
		const [a, b] = f.planned(all) as [Node, Node];
		f.advance(21 * 60_000, [a, b]);
		expect(f.state(a)?.error).toMatch(/No answer within 20 minutes/);
	});

	test('drain cordons the wave and lifts the cordon afterwards', () => {
		const all = [f.enrol('a'), f.enrol('b')];
		f.core.nodeRollouts.start(admin, { strategy: 'rolling', drain: true, soakSeconds: 0 });
		const [a, b] = f.planned(all) as [Node, Node];
		// Nothing runs there, so the drain finishes at once and the update is requested.
		expect(f.core.nodes.list(admin).find((node) => node.id === a.nodeId)?.status).toBe('draining');
		f.beat(a, { version: '0.9.0' });
		expect(f.core.nodes.list(admin).find((node) => node.id === a.nodeId)?.status).toBe('online');
		expect(f.rollout().currentWave).toBe(1);
	});

	test('cancel stops further waves and skips the rest', async () => {
		const all = [f.enrol('a'), f.enrol('b')];
		const started = f.core.nodeRollouts.start(admin, { strategy: 'rolling' });
		const [a, b] = f.planned(all) as [Node, Node];
		const cancelled = f.core.nodeRollouts.cancel(admin, started.id);
		await Promise.resolve();
		const view = f.core.nodeRollouts.get(admin, cancelled.id);
		expect(view.status).toBe('cancelled');
		expect(view.nodes.find((entry) => entry.nodeId === b.nodeId)?.state).toBe('skipped');
		// The node already asked keeps its update; nothing new is asked.
		expect(await f.task(a)).not.toBeNull();
		expect(await f.task(b)).toBeNull();
		expect(() => f.core.nodeRollouts.cancel(admin, started.id)).toThrow(/already cancelled/);
	});

	test('the plan names skipped nodes and refuses when nothing can update', () => {
		const a = f.enrol('a');
		f.beat(a, { version: '0.9.0' });
		expect(f.core.nodeRollouts.plan(admin, {})).toMatchObject({ waves: [], current: 1 });
		expect(() => f.core.nodeRollouts.start(admin, {})).toThrow(/already runs 0\.9\.0/);
		expect(() => f.core.nodeRollouts.start(member, {})).toThrow();
		expect(() => f.core.nodeRollouts.plan(admin, { strategy: 'sideways' })).toThrow(/Invalid rollout/);
	});

	test('a manual rollout starts from the configured defaults', () => {
		f.enrol('a');
		f.enrol('b');
		f.core.cluster.update(admin, { updates: { strategy: 'parallel', soakSeconds: 15 } });
		expect(f.core.nodeRollouts.plan(admin, {}).options).toMatchObject({ strategy: 'parallel', soakSeconds: 15, canary: false });
		expect(f.core.nodeRollouts.plan(admin, { strategy: 'rolling' }).options).toMatchObject({
			strategy: 'rolling',
			soakSeconds: 15,
			canary: true,
		});
	});

	test('auto rollout starts once per control-plane version when enabled', () => {
		f.enrol('a');
		expect(f.core.nodeRollouts.tick().started).toBeNull();
		f.core.cluster.update(admin, { updates: { autoRollout: true, strategy: 'parallel', soakSeconds: 0 } });
		const { started } = f.core.nodeRollouts.tick();
		expect(started).not.toBeNull();
		expect(f.core.nodeRollouts.get(admin, started!)).toMatchObject({ trigger: 'auto', createdBy: 'system' });
		f.core.nodeRollouts.cancel(admin, started!);
		expect(f.core.nodeRollouts.tick().started).toBeNull();
	});
});
