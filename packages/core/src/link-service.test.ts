import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, LINK_TESTS_CAPABILITY } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

/** Links between nodes (docs/CLUSTERING.md §4.6, D216). */

const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const key = (char: string) => `${char.repeat(43)}=`;

function fleet(names: string[], capabilities: string[] = [LINK_TESTS_CAPABILITY]) {
	const dir = mkdtempSync(join(tmpdir(), 'yoal-links-'));
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
			features: DEFAULT_FEATURES,
		},
	});
	const node: Record<string, { id: string; token: string }> = {};
	names.forEach((name, index) => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(principal, name).token, name });
		node[name] = { id: joined.nodeId, token: joined.token };
		opened.sqlite.run(
			"UPDATE nodes SET network_mode = 'yoal', private_address = ?, wg_public_key = ?, wg_endpoint = ?, status = 'online', capabilities_json = ? WHERE id = ?",
			[`10.47.1.${index + 1}`, key(String.fromCharCode(65 + index)), index === 0 ? '203.0.113.1:51820' : null, JSON.stringify(capabilities), joined.nodeId],
		);
	});
	const link = (from: string, to: string) =>
		core.links.view(principal).links.find((entry) => entry.fromNodeId === node[from]!.id && entry.toNodeId === node[to]!.id)!;
	return { core, sqlite: opened.sqlite, clock, node, link };
}

describe('passive link samples', () => {
	test('each node is told to sample the others, and its samples land on the pair with their path', () => {
		const f = fleet(['edge', 'a', 'b']);
		const probes = f.core.links.probesForNode(f.node.a!.id);
		expect(probes.map((probe) => probe.address).sort()).toEqual(['10.47.1.1', '10.47.1.3']);
		expect(probes.every((probe) => probe.port === 8080)).toBe(true);

		f.core.links.applySamples(f.node.a!.id, [
			{ nodeId: f.node.edge!.id, rttMs: 12.5, minMs: 11, maxMs: 14, lossPercent: 0 },
			{ nodeId: f.node.b!.id, rttMs: null, minMs: null, maxMs: null, lossPercent: 100 },
			{ nodeId: 'nod_unknown', rttMs: 1, minMs: 1, maxMs: 1, lossPercent: 0 },
		]);
		expect(f.link('a', 'edge')).toMatchObject({ rttMs: 12.5, path: 'direct', lossPercent: 0 });
		// Two spokes with no shared network talk through the hub.
		expect(f.link('a', 'b')).toMatchObject({ rttMs: null, lossPercent: 100, path: 'relayed' });
		expect(f.core.links.view(principal).links).toHaveLength(6);
	});

	test('a shared private network changes the path as soon as it is set', () => {
		const f = fleet(['edge', 'a', 'b']);
		for (const [name, address] of [['a', '10.0.0.2:51820'], ['b', '10.0.0.3:51820']] as const)
			f.core.nodes.update(principal, f.node[name]!.id, { privateNetwork: 'vpc', lanEndpoint: address });
		expect(f.link('a', 'b').path).toBe('private');
		expect(f.link('a', 'edge').path).toBe('direct');
	});

	test('an agent that predates link tests is told nothing', () => {
		const f = fleet(['edge', 'a'], []);
		expect(f.core.links.probesForNode(f.node.a!.id)).toEqual([]);
		expect(f.core.links.start(principal, {})).toMatchObject({ queued: [], skipped: [{ reason: expect.stringContaining('predates') }] });
	});
});

describe('link history and alerts', () => {
	test('keeps a point a minute and reports the last hour', () => {
		const f = fleet(['edge', 'a']);
		for (const rtt of [10, 12, null, 11]) {
			f.core.links.applySamples(f.node.a!.id, [{ nodeId: f.node.edge!.id, rttMs: rtt, minMs: rtt, maxMs: rtt, lossPercent: rtt === null ? 100 : 0 }]);
			f.clock.now += 60_000;
		}
		// Two samples in one minute: the later one stands.
		f.core.links.applySamples(f.node.a!.id, [{ nodeId: f.node.edge!.id, rttMs: 20, minMs: 20, maxMs: 20, lossPercent: 0 }]);
		f.core.links.applySamples(f.node.a!.id, [{ nodeId: f.node.edge!.id, rttMs: 21, minMs: 21, maxMs: 21, lossPercent: 0 }]);
		expect(f.link('a', 'edge').history).toEqual([10, 12, null, 11, 21]);
	});

	test('a link silent for three minutes between two live nodes alerts once it stays down, and resolves', () => {
		const f = fleet(['edge', 'a']);
		const lost = { nodeId: f.node.edge!.id, rttMs: null, minMs: null, maxMs: null, lossPercent: 100 };
		f.core.links.applySamples(f.node.a!.id, [lost]);
		expect(f.core.links.alerts()).toEqual([]);
		f.clock.now += 200_000;
		f.core.links.applySamples(f.node.a!.id, [lost]);
		expect(f.core.links.alerts()).toMatchObject([{ key: `link:${f.node.a!.id}:${f.node.edge!.id}`, severity: 'warning', title: 'a cannot reach edge' }]);
		expect(f.link('a', 'edge').downSince).not.toBeNull();

		// The other node going offline is that node's alert, not the link's.
		f.sqlite.run("UPDATE nodes SET status = 'offline' WHERE id = ?", [f.node.edge!.id]);
		expect(f.core.links.alerts()).toEqual([]);
		f.sqlite.run("UPDATE nodes SET status = 'online' WHERE id = ?", [f.node.edge!.id]);

		f.core.links.applySamples(f.node.a!.id, [{ ...lost, rttMs: 9, lossPercent: 0 }]);
		expect(f.core.links.alerts()).toMatchObject([{ status: 'resolved', title: 'a reaches edge again' }]);
		expect(f.link('a', 'edge').downSince).toBeNull();
	});
});

describe('link tests', () => {
	test('one pair: the listener and the prober get matching tasks, and the result lands on the link', () => {
		const f = fleet(['edge', 'a']);
		const started = f.core.links.start(principal, { from: 'a', to: 'edge', seconds: 3, streams: 2 });
		expect(started.queued).toEqual([[f.node.a!.id, f.node.edge!.id]]);

		const [probe] = f.core.links.testsForNode(f.node.a!.id);
		const [serve] = f.core.links.testsForNode(f.node.edge!.id);
		expect(probe).toMatchObject({ role: 'probe', address: '10.47.1.1', seconds: 3, streams: 2 });
		expect(serve).toMatchObject({ role: 'serve', address: '10.47.1.1', id: probe!.id, token: probe!.token, port: probe!.port });
		expect(f.link('a', 'edge').test).toMatchObject({ status: 'pending' });

		f.core.links.applyTestResults(f.node.a!.id, [{ taskId: probe!.id, status: 'running' }]);
		expect(f.link('a', 'edge').test?.status).toBe('running');
		// The listening node cannot report a result for a test it does not probe.
		f.core.links.applyTestResults(f.node.edge!.id, [{ taskId: probe!.id, status: 'ok', uploadBps: 1 }]);
		expect(f.link('a', 'edge').test?.status).toBe('running');

		f.core.links.applyTestResults(f.node.a!.id, [
			{ taskId: probe!.id, status: 'ok', rttMs: 41.2, jitterMs: 0.8, uploadBps: 900_000_000, downloadBps: 850_000_000, bytes: 1_000_000, seconds: 6 },
		]);
		expect(f.link('a', 'edge').test).toMatchObject({ status: 'ok', uploadBps: 900_000_000, downloadBps: 850_000_000, rttMs: 41.2 });
		expect(f.core.links.testsForNode(f.node.a!.id)).toEqual([]);
		// The token does not outlive the test.
		expect(f.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM node_links WHERE test_token IS NOT NULL').get()!.n).toBe(0);
	});

	test('a whole-fleet run tests every pair once, one test per node at a time', () => {
		const f = fleet(['edge', 'a', 'b']);
		const started = f.core.links.start(principal, {});
		expect(started.queued).toHaveLength(3);
		const active = () => [...new Set(['edge', 'a', 'b'].flatMap((name) => f.core.links.testsForNode(f.node[name]!.id).map((task) => task.id)))];
		expect(active()).toHaveLength(1);
		expect(f.core.links.view(principal)).toMatchObject({ running: 1, queued: 2 });

		// Finish them one by one; each completion hands out the next.
		for (let round = 0; round < 3; round++) {
			const prober = ['edge', 'a', 'b'].find((name) => f.core.links.testsForNode(f.node[name]!.id).some((task) => task.role === 'probe'))!;
			const task = f.core.links.testsForNode(f.node[prober]!.id).find((entry) => entry.role === 'probe')!;
			f.core.links.applyTestResults(f.node[prober]!.id, [{ taskId: task.id, status: 'ok', uploadBps: 1, downloadBps: 1 }]);
		}
		expect(f.core.links.view(principal)).toMatchObject({ running: 0, queued: 0 });
		expect(f.core.links.view(principal).links.filter((entry) => entry.test?.status === 'ok')).toHaveLength(3);
	});

	test('a test nobody finishes fails and frees the queue', () => {
		const f = fleet(['edge', 'a', 'b']);
		f.core.links.start(principal, {});
		f.clock.now += 120_000;
		const view = f.core.links.view(principal);
		expect(view.links.filter((entry) => entry.test?.status === 'failed')).toHaveLength(1);
		expect(view.links.find((entry) => entry.test?.status === 'failed')?.test?.error).toContain('did not finish');
		expect(view.running).toBe(1);
	});

	test('a pair is not queued twice, and a node cannot be tested against itself', () => {
		const f = fleet(['edge', 'a']);
		f.core.links.start(principal, { from: 'a', to: 'edge' });
		expect(f.core.links.start(principal, { from: 'a', to: 'edge' })).toMatchObject({ queued: [], skipped: [{ reason: expect.stringContaining('already') }] });
		expect(() => f.core.links.start(principal, { from: 'a', to: 'a' })).toThrow('two different nodes');
	});
});
