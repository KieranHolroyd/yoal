import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, WG_MESH_CAPABILITY, type WireguardStatus } from '@yoal/contracts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';
import { buildWireguardState, meshPairKey, overlayPath, type MeshPairState, type OverlayNode } from './overlay.ts';
import {
	advanceMeshPairs,
	isPrivateHost,
	MESH_BACKOFF_MS,
	MESH_PROBE_TIMEOUT_MS,
	observedEndpoints,
	overlayHosts,
	overlayLabel,
	type MeshPair,
	type MeshReport,
} from './overlay-mesh.ts';

/** Mesh mode for the overlay (docs/CLUSTERING.md §4.7, D240). */

const key = (char: string) => `${char.repeat(43)}=`;
const node = (overrides: Partial<OverlayNode> & { id: string; privateAddress: string }): OverlayNode => ({
	name: overrides.id,
	zone: 'cloud-a',
	roles: ['compute'],
	networkMode: 'yoal',
	wgPublicKey: key('A'),
	wgEndpoint: null,
	lanEndpoint: null,
	meshCapable: true,
	...overrides,
});

const hub = node({ id: 'nod_hub', privateAddress: '10.47.1.1', roles: ['ingress', 'control'], wgEndpoint: '203.0.113.1:51820', wgPublicKey: key('H') });
const a = node({ id: 'nod_a', privateAddress: '10.47.1.2', zone: 'home', wgPublicKey: key('A') });
const b = node({ id: 'nod_b', privateAddress: '10.47.1.3', zone: 'office', wgPublicKey: key('B') });
const T0 = Date.UTC(2026, 10, 24, 12);
const iso = (ms: number) => new Date(ms).toISOString();

/** What the hub's `wg show` says about the spokes: the NAT mapping each handshake came from. */
function hubReport(at: number, endpoints: Record<string, string>): MeshReport {
	return {
		nodeId: hub.id,
		receivedAt: at,
		status: {
			interface: 'wg0',
			peers: [a, b]
				.filter((spoke) => endpoints[spoke.id])
				.map((spoke) => ({ publicKey: spoke.wgPublicKey!, endpoint: endpoints[spoke.id]!, latestHandshakeAt: iso(at - 10_000), rxBytes: 1, txBytes: 1 })),
		},
	};
}

function spokeReport(self: OverlayNode, other: OverlayNode, at: number, handshakeAt: number | null): MeshReport {
	return {
		nodeId: self.id,
		receivedAt: at,
		status: {
			interface: 'wg0',
			peers: [{ publicKey: other.wgPublicKey!, endpoint: null, latestHandshakeAt: handshakeAt === null ? null : iso(handshakeAt), rxBytes: 0, txBytes: 0 }],
		},
	};
}

const withEndpoints = (nodes: OverlayNode[], observed: Map<string, string>) =>
	nodes.map((entry) => ({ ...entry, observedEndpoint: observed.get(entry.id) ?? null }));

describe('observed endpoints', () => {
	test('the hub sees each NATed spoke on its public mapping', () => {
		const observed = observedEndpoints([hub, a, b], [hubReport(T0, { nod_a: '198.51.100.7:40211', nod_b: '192.0.2.9:51820' })], T0);
		expect(observed.get('nod_a')).toBe('198.51.100.7:40211');
		expect(observed.get('nod_b')).toBe('192.0.2.9:51820');
		expect(observed.has('nod_hub')).toBe(false);
	});

	test('ignores private addresses, stale reports and dead handshakes', () => {
		expect(observedEndpoints([hub, a], [hubReport(T0, { nod_a: '192.168.1.20:51820' })], T0).size).toBe(0);
		expect(observedEndpoints([hub, a], [hubReport(T0, { nod_a: '198.51.100.7:1' })], T0 + 10 * 60_000).size).toBe(0);
		const dead = hubReport(T0, { nod_a: '198.51.100.7:1' });
		dead.status.peers[0]!.latestHandshakeAt = iso(T0 - 10 * 60_000);
		expect(observedEndpoints([hub, a], [dead], T0).size).toBe(0);
	});

	test('private host detection covers RFC 1918, CGNAT, link-local and ULA', () => {
		for (const host of ['10.1.2.3', '172.20.0.1', '192.168.0.9', '100.100.1.1', '169.254.1.1', '127.0.0.1', '[fd00::1]', 'fe80::1'])
			expect(isPrivateHost(host)).toBe(true);
		for (const host of ['203.0.113.1', '172.32.0.1', '100.128.0.1', '[2001:db8::1]']) expect(isPrivateHost(host)).toBe(false);
	});
});

describe('mesh peer graph', () => {
	const observed = new Map([
		['nod_a', '198.51.100.7:40211'],
		['nod_b', '192.0.2.9:51820'],
	]);
	const nodes = withEndpoints([hub, a, b], observed);
	const graph = (state: MeshPairState | undefined, mode: 'hub' | 'mesh' = 'mesh') =>
		buildWireguardState('nod_a', nodes, '10.47.0.0/22', {
			mode,
			meshPairs: state ? new Map([[meshPairKey('nod_a', 'nod_b'), state]]) : new Map(),
		});

	test('hub mode is unchanged: the other spoke rides the hub', () => {
		const peers = graph(undefined, 'hub').peers;
		expect(peers.map((peer) => peer.nodeId)).toEqual(['nod_hub']);
		expect(peers[0]!.allowedIps).toEqual(['10.47.1.1/32', '10.47.1.3/32']);
	});

	test('a probing pair holds an empty peer while the hub keeps the traffic', () => {
		for (const state of ['probing', undefined] as const) {
			const peers = graph(state).peers;
			const direct = peers.find((peer) => peer.nodeId === 'nod_b')!;
			expect(direct).toMatchObject({ endpoint: '192.0.2.9:51820', allowedIps: [], persistentKeepalive: 25 });
			expect(peers.find((peer) => peer.nodeId === 'nod_hub')!.allowedIps).toContain('10.47.1.3/32');
		}
		expect(overlayPath('nod_a', 'nod_b', nodes, { mode: 'mesh', meshPairs: new Map([[meshPairKey('nod_a', 'nod_b'), 'probing']]) })).toBe('relayed');
	});

	test('a direct pair moves the /32 off the hub', () => {
		const peers = graph('direct').peers;
		expect(peers.find((peer) => peer.nodeId === 'nod_b')!.allowedIps).toEqual(['10.47.1.3/32']);
		expect(peers.find((peer) => peer.nodeId === 'nod_hub')!.allowedIps).toEqual(['10.47.1.1/32']);
		expect(overlayPath('nod_a', 'nod_b', nodes, { mode: 'mesh', meshPairs: new Map([[meshPairKey('nod_a', 'nod_b'), 'direct']]) })).toBe('direct');
	});

	test('a relayed pair has no direct peer at all', () => {
		const peers = graph('relayed').peers;
		expect(peers.map((peer) => peer.nodeId)).toEqual(['nod_hub']);
	});

	test('a node without wg-mesh never gets a probe, and neither does its partner', () => {
		const old = withEndpoints([hub, a, { ...b, meshCapable: false }], observed);
		const peers = buildWireguardState('nod_a', old, '10.47.0.0/22', { mode: 'mesh' }).peers;
		expect(peers.map((peer) => peer.nodeId)).toEqual(['nod_hub']);
		expect(buildWireguardState('nod_b', old, '10.47.0.0/22', { mode: 'mesh' }).hosts).toBeUndefined();
	});

	test('capable nodes get the names in mesh mode and no field otherwise', () => {
		const hosts = overlayHosts(nodes);
		expect(buildWireguardState('nod_a', nodes, '10.47.0.0/22', { mode: 'mesh', hosts }).hosts).toEqual(hosts);
		expect(buildWireguardState('nod_a', nodes, '10.47.0.0/22', { mode: 'hub', hosts }).hosts).toBeUndefined();
	});
});

describe('pair state machine', () => {
	const nodes = withEndpoints([hub, a, b], new Map([['nod_a', '198.51.100.7:40211']]));
	const step = (previous: MeshPair[], reports: MeshReport[], now: number) =>
		advanceMeshPairs(nodes, new Map(previous.map((pair) => [meshPairKey(pair.a, pair.b), pair])), reports, now);

	test('a new pair starts probing', () => {
		const { pairs, changed } = step([], [], T0);
		expect(changed).toBe(true);
		expect(pairs).toEqual([expect.objectContaining({ a: 'nod_a', b: 'nod_b', state: 'probing', since: T0 })]);
	});

	test('a handshake reported after the probe began makes it direct', () => {
		const probing = step([], [], T0).pairs;
		// A report from before the probe cannot count, even with a recent handshake.
		expect(step(probing, [spokeReport(a, b, T0 - 1_000, T0 - 2_000)], T0 + 5_000).pairs[0]!.state).toBe('probing');
		const { pairs, changed } = step(probing, [spokeReport(b, a, T0 + 20_000, T0 + 15_000)], T0 + 20_000);
		expect(changed).toBe(true);
		expect(pairs[0]).toMatchObject({ state: 'direct', attempts: 0, lastHandshakeAt: T0 + 15_000 });
	});

	test('a probe that never answers falls back to the hub and retries on a backoff', () => {
		let pairs = step([], [], T0).pairs;
		pairs = step(pairs, [spokeReport(a, b, T0 + 60_000, null)], T0 + 60_000).pairs;
		expect(pairs[0]!.state).toBe('probing');
		const failedAt = T0 + MESH_PROBE_TIMEOUT_MS;
		pairs = step(pairs, [], failedAt).pairs;
		expect(pairs[0]).toMatchObject({ state: 'relayed', attempts: 1, retryAt: failedAt + MESH_BACKOFF_MS[0] });
		expect(step(pairs, [], failedAt + MESH_BACKOFF_MS[0] - 1).changed).toBe(false);
		const retried = step(pairs, [], failedAt + MESH_BACKOFF_MS[0]).pairs;
		expect(retried[0]).toMatchObject({ state: 'probing', attempts: 1 });
		// The second failure waits longer.
		const again = step(retried, [], failedAt + MESH_BACKOFF_MS[0] + MESH_PROBE_TIMEOUT_MS).pairs;
		expect(again[0]!.retryAt! - again[0]!.since).toBe(MESH_BACKOFF_MS[1]);
	});

	test('a direct pair whose handshake goes stale hands the traffic back to the hub', () => {
		const direct: MeshPair = { a: 'nod_a', b: 'nod_b', state: 'direct', since: T0, attempts: 0, retryAt: null, endpoints: '198.51.100.7:40211 -', lastHandshakeAt: T0 };
		// Silence from the nodes is not evidence: a pair is only demoted on a report.
		expect(step([direct], [], T0 + 10 * 60_000).pairs[0]!.state).toBe('direct');
		const now = T0 + 10 * 60_000;
		expect(step([direct], [spokeReport(a, b, now, T0)], now).pairs[0]).toMatchObject({ state: 'probing', since: now });
	});

	test('a changed endpoint re-probes a relayed pair at once', () => {
		const relayed: MeshPair = { a: 'nod_a', b: 'nod_b', state: 'relayed', since: T0, attempts: 3, retryAt: T0 + 3_600_000, endpoints: '198.51.100.7:1 -', lastHandshakeAt: null };
		expect(step([relayed], [], T0 + 1_000).pairs[0]).toMatchObject({ state: 'probing', attempts: 0, retryAt: null });
	});

	test('a pair that stops being a candidate is dropped', () => {
		const lan = withEndpoints(
			[hub, { ...a, lanEndpoint: '10.0.0.2:51820', privateNetwork: 'vpc' }, { ...b, lanEndpoint: '10.0.0.3:51820', privateNetwork: 'vpc' }],
			new Map(),
		);
		const previous = new Map([[meshPairKey('nod_a', 'nod_b'), step([], [], T0).pairs[0]!]]);
		expect(advanceMeshPairs(lan, previous, [], T0 + 1)).toEqual({ pairs: [], changed: true });
	});

	test('no pair when neither side can be dialled', () => {
		expect(step([], [], T0).pairs).toHaveLength(1);
		expect(advanceMeshPairs([hub, a, b], new Map(), [], T0).pairs).toEqual([]);
	});
});

describe('overlay names', () => {
	test('labels are DNS-safe and collisions get the id tail', () => {
		expect(overlayLabel('Edge B (hel1)')).toBe('edge-b-hel1');
		expect(overlayLabel('—')).toBeNull();
		const hosts = overlayHosts([
			node({ id: 'nod_first', name: 'worker', privateAddress: '10.47.1.2', joinedAt: 1 }),
			node({ id: 'nod_second9', name: 'Worker', privateAddress: '10.47.1.3', joinedAt: 2 }),
			node({ id: 'nod_byo', name: 'byo', privateAddress: '10.9.0.1', networkMode: 'external' }),
		]);
		expect(hosts).toEqual([
			{ name: 'worker-econd9.yoal.internal', address: '10.47.1.3' },
			{ name: 'worker.yoal.internal', address: '10.47.1.2' },
		]);
	});
});

describe('mesh mode end to end in the control plane', () => {
	const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

	function fleet() {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-mesh-'));
		const opened = createDb({ path: ':memory:' });
		const clock = { now: T0 };
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
		const ids: Record<string, { id: string; token: string }> = {};
		const specs = [
			{ name: 'Edge', roles: ['ingress', 'control', 'compute'], endpoint: '203.0.113.1:51820', key: 'H' },
			{ name: 'Home Lab', roles: ['compute'], endpoint: null, key: 'A' },
			{ name: 'Office', roles: ['compute'], endpoint: null, key: 'B' },
		];
		specs.forEach((spec, index) => {
			const joined = core.nodes.join({ token: core.nodes.createJoinToken(principal, spec.name).token, name: spec.name });
			ids[spec.name] = { id: joined.nodeId, token: joined.token };
			opened.sqlite.run(
				"UPDATE nodes SET network_mode = 'yoal', private_address = ?, wg_public_key = ?, wg_endpoint = ?, status = 'online', roles_json = ?, capabilities_json = ? WHERE id = ?",
				[`10.47.1.${index + 1}`, key(spec.key), spec.endpoint, JSON.stringify(spec.roles), JSON.stringify([WG_MESH_CAPABILITY]), joined.nodeId],
			);
		});
		const report = (name: string, status: WireguardStatus) =>
			opened.sqlite.run('UPDATE nodes SET wg_status_json = ?, wg_status_at = ? WHERE id = ?', [JSON.stringify(status), clock.now, ids[name]!.id]);
		const wireguard = async (name: string) => (await core.nodes.desiredState(ids[name]!.token)).wireguard!;
		return { core, clock, ids, report, wireguard };
	}

	test('off by default; turning it on probes, a handshake goes direct, turning it off clears the pairs', async () => {
		const f = fleet();
		expect(f.core.cluster.get().overlay.mode).toBe('hub');
		expect((await f.wireguard('Home Lab')).peers.map((peer) => peer.nodeId)).toEqual([f.ids.Edge!.id]);

		f.report('Edge', {
			interface: 'wg0',
			peers: [
				{ publicKey: key('A'), endpoint: '198.51.100.7:40211', latestHandshakeAt: iso(f.clock.now - 5_000), rxBytes: 1, txBytes: 1 },
				{ publicKey: key('B'), endpoint: '192.0.2.9:61000', latestHandshakeAt: iso(f.clock.now - 5_000), rxBytes: 1, txBytes: 1 },
			],
		});
		f.core.cluster.update(principal, { overlay: { mode: 'mesh' } });
		expect(f.core.overlayMesh.summary()).toMatchObject({ mode: 'mesh', probing: 1, direct: 0 });

		const probing = await f.wireguard('Home Lab');
		expect(probing.peers.find((peer) => peer.nodeId === f.ids.Office!.id)).toMatchObject({ endpoint: '192.0.2.9:61000', allowedIps: [] });
		expect(probing.peers.find((peer) => peer.nodeId === f.ids.Edge!.id)!.allowedIps).toContain('10.47.1.3/32');
		expect(probing.hosts).toEqual([
			{ name: 'edge.yoal.internal', address: '10.47.1.1' },
			{ name: 'home-lab.yoal.internal', address: '10.47.1.2' },
			{ name: 'office.yoal.internal', address: '10.47.1.3' },
		]);

		f.clock.now += 20_000;
		f.report('Office', {
			interface: 'wg0',
			peers: [{ publicKey: key('A'), endpoint: '198.51.100.7:40211', latestHandshakeAt: iso(f.clock.now - 3_000), rxBytes: 9, txBytes: 9 }],
		});
		expect(f.core.overlayMesh.evaluate(f.clock.now, true)).toBe(true);
		expect(f.core.overlayMesh.summary()).toMatchObject({ direct: 1, probing: 0 });
		const direct = await f.wireguard('Home Lab');
		expect(direct.peers.find((peer) => peer.nodeId === f.ids.Office!.id)!.allowedIps).toEqual(['10.47.1.3/32']);
		expect(direct.peers.find((peer) => peer.nodeId === f.ids.Edge!.id)!.allowedIps).not.toContain('10.47.1.3/32');
		expect(f.core.links.view(principal).links.find((link) => link.fromNodeId === f.ids['Home Lab']!.id && link.toNodeId === f.ids.Office!.id)!.path).toBe('direct');

		f.core.cluster.update(principal, { overlay: { mode: 'hub' } });
		expect(f.core.overlayMesh.summary()).toMatchObject({ mode: 'hub', direct: 0, pairs: [] });
		const back = await f.wireguard('Home Lab');
		expect(back.peers.map((peer) => peer.nodeId)).toEqual([f.ids.Edge!.id]);
		expect(back.hosts).toBeUndefined();
	});
});
