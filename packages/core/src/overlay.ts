import {
	DEFAULT_K8S_MACHINE_CIDR,
	DEFAULT_OVERLAY_CIDR,
	DEFAULT_WG_MTU,
	DEFAULT_WG_PORT,
	WG_KEEPALIVE_SECONDS,
	type NodeNetworkMode,
	type NodeRole,
	type WireguardPeer,
	type WireguardState,
} from '@yoal/contracts';

/**
 * Overlay address allocation and peer graph (docs/CLUSTERING.md §4.1, phase C1).
 *
 * Pure so the allocation and routing rules are testable without root, a kernel module or a
 * network. The control plane stores only public keys and addresses; the helper applies the
 * resulting state on the node.
 */

export interface OverlayNode {
	id: string;
	name: string;
	zone: string;
	roles: NodeRole[];
	networkMode: NodeNetworkMode;
	privateAddress: string | null;
	wgPublicKey: string | null;
	/** Underlay endpoint the hub dials (`host:port`), or null for a NATed node. */
	wgEndpoint: string | null;
	lanEndpoint: string | null;
	/** A named private network (D215); optional so callers that predate it keep the zone rule. */
	privateNetwork?: string | null;
	/** The node runs multi-node Kubernetes machines on its routed /24 (docs/KUBERNETES.md §10). */
	machineSubnet?: string | null;
	/** Its helper accepts /24 entries (`wg-subnets`); older nodes only ever get /32s. */
	acceptsSubnets?: boolean;
}

/** How traffic between two overlay nodes travels underneath WireGuard. */
export type OverlayPath = 'private' | 'direct' | 'relayed' | 'none';

/**
 * Can `self` dial `peer` on its LAN endpoint? Two nodes that name the same private network can,
 * whatever their zone: a provider's private network often spans its regions, and it is usually
 * faster and unmetered. Nodes that name no network keep the older rule: one zone is one LAN.
 * A node that names a network is not assumed to reach a same-zone node that names another.
 */
export function sharesPrivateNetwork(self: OverlayNode, peer: OverlayNode): boolean {
	if (!peer.lanEndpoint) return false;
	if (self.privateNetwork || peer.privateNetwork) return Boolean(self.privateNetwork) && self.privateNetwork === peer.privateNetwork;
	return self.zone === peer.zone;
}

/** `10.47.1.1` and up by default: the first /24 of a /22 is reserved for gateways. */
export function allocateOverlayAddress(cidr: string, used: ReadonlySet<string>): string | null {
	const parsed = parseCidr(cidr);
	if (!parsed) return null;
	const first = parsed.network + (parsed.prefix <= 24 ? 256 : 1);
	const last = parsed.network + parsed.size - 1;
	for (let value = first; value < last; value++) {
		const lastOctet = value & 255;
		if (lastOctet === 0 || lastOctet === 255) continue;
		const address = intToIpv4(value);
		if (!used.has(address)) return address;
	}
	return null;
}

/** The overlay state a node should converge to; external/BYO nodes receive no peers. */
export function buildWireguardState(
	nodeId: string,
	nodes: OverlayNode[],
	cidr = DEFAULT_OVERLAY_CIDR,
	options: { mtu?: number; listenPort?: number; keepaliveSeconds?: number } = {},
): WireguardState {
	const self = nodes.find((node) => node.id === nodeId);
	if (!self || self.networkMode === 'external' || !self.privateAddress) {
		return {
			mode: self?.networkMode ?? 'external',
			address: self?.privateAddress ?? null,
			cidr: null,
			mtu: options.mtu ?? DEFAULT_WG_MTU,
			listenPort: options.listenPort ?? DEFAULT_WG_PORT,
			peers: [],
			routes: [],
			machineSubnet: null,
		};
	}

	const managed = nodes.filter(
		(node) =>
			node.id !== self.id &&
			node.networkMode !== 'external' &&
			node.privateAddress &&
			node.wgPublicKey,
	);
	const hubs = managed.filter((node) => node.wgEndpoint && node.roles.includes('ingress'));
	// Same-zone spokes mesh over the LAN (the older rule, which never dialled a hub that way); a
	// shared private network (D215) reaches spokes and hubs alike, in any zone.
	const direct = managed.filter(
		(node) =>
			sharesPrivateNetwork(self, node) &&
			(!node.roles.includes('ingress') || Boolean(self.privateNetwork)),
	);
	const directIds = new Set(direct.map((node) => node.id));
	const peers: WireguardPeer[] = [];

	if (hubs.length === 0 || self.roles.includes('ingress')) {
		// A hub dials every node; a spoke with no hub can still reach same-zone LAN peers.
		for (const node of managed) {
			const endpoint = sharesPrivateNetwork(self, node) ? node.lanEndpoint : node.wgEndpoint;
			peers.push({
				nodeId: node.id,
				publicKey: node.wgPublicKey!,
				endpoint: endpoint ?? null,
				allowedIps: [`${node.privateAddress}/32`],
				persistentKeepalive: endpoint ? 0 : (options.keepaliveSeconds ?? WG_KEEPALIVE_SECONDS),
			});
		}
	} else {
		const hubIds = new Set(hubs.map((hub) => hub.id));
		const relayedByHub = new Map<string, OverlayNode[]>(hubs.map((hub) => [hub.id, []]));
		for (const node of managed) {
			if (directIds.has(node.id) || hubIds.has(node.id)) continue;
			const hub = hubs.find((candidate) => candidate.zone === node.zone) ?? hubs[0];
			if (hub) relayedByHub.get(hub.id)!.push(node);
		}
		for (const hub of hubs) {
			const relayed = relayedByHub.get(hub.id) ?? [];
			peers.push({
				nodeId: hub.id,
				publicKey: hub.wgPublicKey!,
				// A hub on this node's private network is dialled there; it still relays the rest.
				endpoint: (directIds.has(hub.id) ? hub.lanEndpoint : hub.wgEndpoint) ?? null,
				allowedIps: [hub.privateAddress!, ...relayed.map((node) => node.privateAddress!)].map((ip) => `${ip}/32`),
				persistentKeepalive: options.keepaliveSeconds ?? WG_KEEPALIVE_SECONDS,
			});
		}
		for (const node of direct) {
			if (hubIds.has(node.id)) continue;
			peers.push({
				nodeId: node.id,
				publicKey: node.wgPublicKey!,
				endpoint: node.lanEndpoint,
				allowedIps: [`${node.privateAddress}/32`],
				persistentKeepalive: 0,
			});
		}
	}

	// Machine subnets ride with the /32 of the node that owns them, on nodes that understand them.
	const withSubnets = self.acceptsSubnets
		? peers.map((peer) => {
				const extra: string[] = [];
				for (const ip of peer.allowedIps) {
					const owner = managed.find((node) => `${node.privateAddress}/32` === ip);
					if (owner?.machineSubnet) extra.push(owner.machineSubnet);
				}
				return extra.length > 0 ? { ...peer, allowedIps: [...peer.allowedIps, ...extra] } : peer;
			})
		: peers;
	const anySubnets = self.acceptsSubnets && managed.some((node) => node.machineSubnet);
	return {
		mode: self.networkMode,
		address: self.privateAddress,
		cidr,
		mtu: options.mtu ?? DEFAULT_WG_MTU,
		listenPort: options.listenPort ?? DEFAULT_WG_PORT,
		peers: dedupePeers(withSubnets),
		routes: anySubnets ? [DEFAULT_K8S_MACHINE_CIDR] : [],
		machineSubnet: self.acceptsSubnets ? (self.machineSubnet ?? null) : null,
	};
}

/**
 * The underlay path between two managed nodes, as the peer graph above builds it: `private` over a
 * shared LAN or private network, `direct` to a public WireGuard endpoint, `relayed` through a hub.
 */
export function overlayPath(fromId: string, toId: string, nodes: OverlayNode[]): OverlayPath {
	const from = nodes.find((node) => node.id === fromId);
	const to = nodes.find((node) => node.id === toId);
	if (!from || !to || from.id === to.id || !to.privateAddress) return 'none';
	// Read the answer off the graph itself, so this can never disagree with what the node applies.
	const peers = buildWireguardState(from.id, nodes).peers;
	const target = `${to.privateAddress}/32`;
	const own = peers.find((peer) => peer.nodeId === to.id);
	// A LAN hop is one this node dials on the peer's LAN endpoint.
	if (own) return own.endpoint !== null && own.endpoint === to.lanEndpoint ? 'private' : 'direct';
	return peers.some((peer) => peer.allowedIps.includes(target)) ? 'relayed' : 'none';
}

function dedupePeers(peers: WireguardPeer[]): WireguardPeer[] {
	const byNode = new Map<string, WireguardPeer>();
	for (const peer of peers) {
		const existing = byNode.get(peer.nodeId);
		if (!existing) {
			byNode.set(peer.nodeId, peer);
			continue;
		}
		existing.allowedIps = [...new Set([...existing.allowedIps, ...peer.allowedIps])];
		if (!existing.endpoint) existing.endpoint = peer.endpoint;
	}
	return [...byNode.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

interface ParsedCidr {
	network: number;
	prefix: number;
	size: number;
}

function parseCidr(cidr: string): ParsedCidr | null {
	const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(cidr.trim());
	if (!match) return null;
	const address = ipv4ToInt(match[1]!);
	const prefix = Number(match[2]);
	if (address === null || prefix < 8 || prefix > 30) return null;
	const size = 2 ** (32 - prefix);
	const network = Math.floor(address / size) * size;
	return { network, prefix, size };
}

function ipv4ToInt(value: string): number | null {
	const parts = value.split('.').map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
	return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function intToIpv4(value: number): string {
	return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}
