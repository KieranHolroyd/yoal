import { describe, expect, test } from 'bun:test';
import { allocateOverlayAddress, buildWireguardState, overlayPath, type OverlayNode } from './overlay.ts';

const key = (char: string) => `${char.repeat(43)}=`;
const node = (overrides: Partial<OverlayNode> & { id: string; privateAddress: string }): OverlayNode => ({
	name: overrides.id,
	zone: 'cloud-a',
	roles: ['compute'],
	networkMode: 'yoal',
	wgPublicKey: key('A'),
	wgEndpoint: null,
	lanEndpoint: null,
	...overrides,
});

describe('overlay allocation', () => {
	test('starts after the reserved first /24 and skips network/broadcast octets', () => {
		expect(allocateOverlayAddress('10.47.0.0/22', new Set())).toBe('10.47.1.1');
	});

	test('skips used addresses and returns null when exhausted', () => {
		expect(allocateOverlayAddress('10.47.0.0/22', new Set(['10.47.1.1', '10.47.1.2']))).toBe('10.47.1.3');
	});

	test('rejects an invalid CIDR', () => {
		expect(allocateOverlayAddress('not-a-cidr', new Set())).toBeNull();
	});
});

describe('peer graph', () => {
	const edge = node({
		id: 'nod_edge',
		privateAddress: '10.47.1.1',
		zone: 'cloud-a',
		roles: ['ingress', 'control', 'compute', 'data'],
		wgEndpoint: '203.0.113.10:51820',
	});
	const edgeB = node({
		id: 'nod_edge_b',
		privateAddress: '10.47.1.2',
		zone: 'cloud-b',
		roles: ['ingress', 'control', 'data'],
		wgEndpoint: '203.0.113.20:51820',
	});
	const homelab = node({
		id: 'nod_home',
		privateAddress: '10.47.1.3',
		zone: 'home',
		roles: ['compute', 'data'],
		lanEndpoint: '192.168.1.20:51820',
	});
	const linux = node({
		id: 'nod_linux',
		privateAddress: '10.47.1.4',
		zone: 'home',
		roles: ['compute', 'build'],
		lanEndpoint: '192.168.1.30:51820',
	});
	const all = [edge, edgeB, homelab, linux];

	test('a spoke peers with every hub and its LAN neighbour', () => {
		const state = buildWireguardState('nod_home', all);
		expect(state).toMatchObject({ mode: 'yoal', address: '10.47.1.3', cidr: '10.47.0.0/22' });
		expect(state.peers.map((peer) => peer.nodeId).sort()).toEqual(['nod_edge', 'nod_edge_b', 'nod_linux']);
		const direct = state.peers.find((peer) => peer.nodeId === 'nod_linux')!;
		expect(direct).toMatchObject({ endpoint: '192.168.1.30:51820', allowedIps: ['10.47.1.4/32'] });
	});

	test('a hub peers with every managed node', () => {
		const state = buildWireguardState('nod_edge', all);
		expect(state.peers.map((peer) => peer.nodeId).sort()).toEqual(['nod_edge_b', 'nod_home', 'nod_linux']);
	});

	test('an external node receives no managed peers', () => {
		const external = node({ id: 'nod_byo', privateAddress: '10.0.0.5', networkMode: 'external' });
		expect(buildWireguardState('nod_byo', [...all, external]).peers).toEqual([]);
	});

	test('no peer appears twice with conflicting allowed IPs', () => {
		const state = buildWireguardState('nod_home', all);
		const allowed = state.peers.flatMap((peer) => peer.allowedIps);
		expect(new Set(allowed).size).toBe(allowed.length);
	});
});

describe('private networks (D215)', () => {
	const hub = node({
		id: 'nod_hub',
		privateAddress: '10.47.1.1',
		zone: 'par1',
		roles: ['ingress', 'control', 'compute'],
		wgEndpoint: '203.0.113.10:51820',
		lanEndpoint: '10.0.0.1:51820',
		privateNetwork: 'vpc',
	});
	const sameVpc = node({
		id: 'nod_same',
		privateAddress: '10.47.1.2',
		zone: 'hel1',
		wgPublicKey: key('B'),
		lanEndpoint: '10.0.0.2:51820',
		privateNetwork: 'vpc',
	});
	const alsoVpc = node({
		id: 'nod_also',
		privateAddress: '10.47.1.3',
		zone: 'fsn1',
		wgPublicKey: key('C'),
		lanEndpoint: '10.0.0.3:51820',
		privateNetwork: 'vpc',
	});
	const outside = node({ id: 'nod_out', privateAddress: '10.47.1.4', zone: 'home', wgPublicKey: key('D') });
	const all = [hub, sameVpc, alsoVpc, outside];
	const peer = (from: OverlayNode, to: OverlayNode) =>
		buildWireguardState(from.id, all).peers.find((entry) => entry.nodeId === to.id);

	test('nodes on one private network dial each other there, across zones and roles', () => {
		expect(peer(sameVpc, hub)?.endpoint).toBe('10.0.0.1:51820');
		expect(peer(hub, sameVpc)?.endpoint).toBe('10.0.0.2:51820');
		expect(peer(sameVpc, alsoVpc)).toMatchObject({ endpoint: '10.0.0.3:51820', allowedIps: ['10.47.1.3/32'] });
	});

	test('the hub still relays the nodes that are not on the network, and only those', () => {
		expect(peer(sameVpc, hub)?.allowedIps.sort()).toEqual(['10.47.1.1/32', '10.47.1.4/32']);
		expect(peer(outside, hub)).toMatchObject({ endpoint: '203.0.113.10:51820' });
		expect(peer(outside, hub)?.allowedIps.sort()).toEqual(['10.47.1.1/32', '10.47.1.2/32', '10.47.1.3/32']);
		expect(peer(outside, sameVpc)).toBeUndefined();
	});

	test('a named network is not assumed from a shared zone', () => {
		const neighbour = node({
			id: 'nod_nb',
			privateAddress: '10.47.1.5',
			zone: 'hel1',
			wgPublicKey: key('E'),
			lanEndpoint: '192.168.1.9:51820',
		});
		const state = buildWireguardState(sameVpc.id, [...all, neighbour]);
		expect(state.peers.find((entry) => entry.nodeId === neighbour.id)).toBeUndefined();
	});

	test('unnamed nodes keep the one-zone-is-one-LAN rule', () => {
		const a = node({ id: 'nod_a', privateAddress: '10.47.1.6', zone: 'home', wgPublicKey: key('F'), lanEndpoint: '192.168.1.2:51820' });
		const b = node({ id: 'nod_b', privateAddress: '10.47.1.7', zone: 'home', wgPublicKey: key('G'), lanEndpoint: '192.168.1.3:51820' });
		const state = buildWireguardState(a.id, [hub, a, b]);
		expect(state.peers.find((entry) => entry.nodeId === b.id)?.endpoint).toBe('192.168.1.3:51820');
	});

	test('the path between two nodes is read off the same graph', () => {
		expect(overlayPath(sameVpc.id, alsoVpc.id, all)).toBe('private');
		expect(overlayPath(sameVpc.id, hub.id, all)).toBe('private');
		expect(overlayPath(outside.id, hub.id, all)).toBe('direct');
		expect(overlayPath(outside.id, sameVpc.id, all)).toBe('relayed');
		expect(overlayPath(hub.id, hub.id, all)).toBe('none');
	});
});
