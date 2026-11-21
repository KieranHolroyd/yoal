import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, failoverEvents } from '@yoal/db';
import { DEFAULT_FEATURES, OFFLINE_DRILL_CAPABILITY, nodeDrillLimits } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-node-drills-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-21T10:00:00Z');
const GIB = 1024 ** 3;

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
		features: DEFAULT_FEATURES,
	},
});

const admin = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const member = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'owner' });

const fleet: Record<string, { id: string; token: string }> = {};

function heartbeat(name: string, capabilities: string[] = [OFFLINE_DRILL_CAPABILITY]) {
	const node = fleet[name]!;
	core.nodes.heartbeat(node.token, {
		nodeId: node.id,
		agentVersion: '0.1.0',
		actualStateVersion: 1,
		status: 'online',
		caddyOk: true,
		capabilities,
		stats: {
			cpuPercent: 5,
			memoryBytes: GIB,
			memoryTotalBytes: 8 * GIB,
			diskUsedBytes: 10 * GIB,
			diskTotalBytes: 100 * GIB,
			diskFreeBytes: 90 * GIB,
		},
		releases: [],
	} as never);
}

function heartbeatAll(except: string[] = []) {
	for (const name of Object.keys(fleet)) if (!except.includes(name)) heartbeat(name);
}

function failure(fn: () => unknown): { status: number; message: string } {
	try {
		fn();
	} catch (error) {
		return error as { status: number; message: string };
	}
	throw new Error('expected the call to throw');
}

/** Advance the clock in heartbeat-sized steps, with `dark` nodes silent, as the failover tick would see it. */
function advance(ms: number, dark: string[] = []) {
	const end = clock + ms;
	while (clock < end) {
		clock = Math.min(end, clock + 10_000);
		heartbeatAll(dark);
		core.nodes.markStale();
		core.nodeDrills.tick();
	}
}

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
	for (const name of ['edge', 'worker-a', 'worker-b']) {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(admin, name).token, name });
		fleet[name] = { id: joined.nodeId, token: joined.token };
	}
	heartbeatAll();
});

describe('node offline drills', () => {
	test('needs a platform operator', () => {
		expect(failure(() => core.nodeDrills.start(member, {})).status).toBe(403);
		expect(failure(() => core.nodeDrills.view(member)).status).toBe(403);
	});

	test('lists the edge as the control-plane host, not drillable by default', () => {
		const { candidates } = core.nodeDrills.view(admin);
		const edge = candidates.find((candidate) => candidate.nodeName === 'edge')!;
		expect(edge).toMatchObject({ controlNode: true, eligible: false, needsControlOptIn: true });
		expect(edge.reason).toMatch(/control plane/);
		expect(candidates.filter((candidate) => candidate.eligible).map((candidate) => candidate.nodeName).sort()).toEqual(['worker-a', 'worker-b']);
	});

	test('picks a worker at random, takes it dark, and closes with measured times', async () => {
		const drill = core.nodeDrills.start(admin, { durationSeconds: 120 });
		expect(drill).toMatchObject({ status: 'running', random: true, durationSeconds: 120 });
		expect(['worker-a', 'worker-b']).toContain(drill.nodeName);
		const name = drill.nodeName;
		const other = name === 'worker-a' ? 'worker-b' : 'worker-a';

		// Only the drilled node's desired state carries it; the agent's poll answers the same.
		expect((await core.nodes.desiredState(fleet[name]!.token)).offlineDrill).toEqual({ id: drill.id, endsAt: drill.endsAt });
		expect((await core.nodes.desiredState(fleet[other]!.token)).offlineDrill).toBeUndefined();
		expect(core.nodeDrills.poll(fleet[name]!.token)).toEqual({ drill: { id: drill.id, endsAt: drill.endsAt } });

		// One drill at a time.
		expect(failure(() => core.nodeDrills.start(admin, {})).status).toBe(409);

		// A heartbeat already in flight at the start does not fail it.
		clock += 2_000;
		heartbeat(name);
		expect(core.nodeDrills.view(admin).running?.id).toBe(drill.id);

		// The failover controller writes an event while the node is dark.
		opened.db
			.insert(failoverEvents)
			.values({
				id: 'fev_drill_1',
				kind: 'replica',
				status: 'completed',
				stage: 'complete',
				subjectId: 'cpy_1',
				subjectName: 'shop',
				fromNodeId: fleet[name]!.id,
				toNodeId: fleet[other]!.id,
				reason: 'node lost',
				epoch: 1,
				detectedAt: clock + 40_000,
				updatedAt: clock + 40_000,
			})
			.run();

		advance(120_000, [name]);
		const dark = core.nodeDrills.get(admin, drill.id);
		expect(dark.status).toBe('running');
		expect(dark.offlineAt).not.toBeNull();
		expect(dark.offlineAt! - dark.startedAt).toBeGreaterThanOrEqual(30_000);
		// Past `endsAt`, desired state no longer carries it, so a returning agent is not re-armed.
		expect((await core.nodes.desiredState(fleet[name]!.token)).offlineDrill).toBeUndefined();

		clock += 3_000;
		heartbeat(name);
		const done = core.nodeDrills.get(admin, drill.id);
		expect(done.status).toBe('completed');
		expect(done.restoredAt).toBe(clock);
		expect(done.observations?.offlineDetectedAfterMs).toBe(dark.offlineAt! - dark.startedAt);
		expect(done.observations?.backOnlineAfterMs).toBeGreaterThanOrEqual(0);
		expect(done.observations?.events).toEqual([
			expect.objectContaining({ kind: 'replica', subject: 'shop', fromNode: name, toNode: other }),
		]);
		expect(core.nodeDrills.view(admin).running).toBeNull();
	});

	test('a heartbeat in the middle of the drill fails it', () => {
		heartbeatAll();
		const drill = core.nodeDrills.start(admin, { node: 'worker-a', durationSeconds: 300 });
		expect(drill.random).toBe(false);
		clock += nodeDrillLimits.startGraceMs + 1_000;
		heartbeat('worker-a');
		const failed = core.nodeDrills.get(admin, drill.id);
		expect(failed.status).toBe('failed');
		expect(failed.message).toMatch(/did not go dark/);
	});

	test('cancel ends it for the agent at once', async () => {
		heartbeatAll();
		const drill = core.nodeDrills.start(admin, { node: 'worker-b', durationSeconds: 300 });
		const cancelled = core.nodeDrills.cancel(admin, drill.id);
		expect(cancelled.status).toBe('cancelled');
		expect(core.nodeDrills.poll(fleet['worker-b']!.token)).toEqual({ drill: null });
		expect((await core.nodes.desiredState(fleet['worker-b']!.token)).offlineDrill).toBeUndefined();
		expect(failure(() => core.nodeDrills.cancel(admin, drill.id)).status).toBe(409);
		clock += 4_000;
		heartbeat('worker-b');
		const back = core.nodeDrills.get(admin, drill.id);
		expect(back.status).toBe('cancelled');
		expect(back.restoredAt).toBe(clock);
		expect(back.observations?.backOnlineAfterMs).toBe(4_000);
	});

	test('fails a drill whose node never comes back, and still records a late return', () => {
		heartbeatAll();
		const drill = core.nodeDrills.start(admin, { node: 'worker-a', durationSeconds: 60 });
		advance(60_000 + nodeDrillLimits.returnGraceMs + 10_000, ['worker-a']);
		const failed = core.nodeDrills.get(admin, drill.id);
		expect(failed.status).toBe('failed');
		expect(failed.restoredAt).toBeNull();
		expect(failed.message).toMatch(/did not heartbeat/);
		heartbeat('worker-a');
		expect(core.nodeDrills.get(admin, drill.id).restoredAt).toBe(clock);
	});

	test('refuses an agent without the capability, the control node unless allowed, and the last online node', () => {
		heartbeatAll();
		heartbeat('worker-b', []);
		expect(failure(() => core.nodeDrills.start(admin, { node: 'worker-b' })).message).toMatch(/predates offline drills/);
		expect(failure(() => core.nodeDrills.start(admin, { node: 'edge' })).message).toMatch(/control plane/);
		const edge = core.nodeDrills.start(admin, { node: 'edge', includeControlNode: true, durationSeconds: 60 });
		core.nodeDrills.cancel(admin, edge.id);

		// Only one node still heartbeating: nothing could take over.
		advance(40_000, ['worker-a', 'worker-b']);
		expect(failure(() => core.nodeDrills.start(admin, { includeControlNode: true })).message).toMatch(/only online node/);
	});
});
