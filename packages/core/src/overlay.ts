import {
	DEFAULT_K8S_MACHINE_CIDR,
	DEFAULT_OVERLAY_CIDR,
	DEFAULT_WG_MTU,
	DEFAULT_WG_PORT,
	WG_KEEPALIVE_SECONDS,
	type NodeNetworkMode,
	type NodeRole,
	type OverlayHost,
	type OverlayMode,
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
	/** Its helper takes mesh probes and overlay names (`wg-mesh`, §4.7); older nodes stay hub-only. */
	meshCapable?: boolean;
	/** The public endpoint other nodes see its WireGuard socket on (mesh mode, read off the hubs). */
	observedEndpoint?: string | null;
	/** Join time (ms), which orders colliding overlay names. */
	joinedAt?: number | null;
}

/** A pair's mesh state (§4.7); see `overlay-mesh.ts`. */
export type MeshPairState = 'probing' | 'direct' | 'relayed';

export function meshPairKey(a: string, b: string): string {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export interface OverlayGraphOptions {
	mtu?: number;
	listenPort?: number;
	keepaliveSeconds?: number;
	/** `hub` (default) or `mesh` (§4.7). */
	mode?: OverlayMode;
	/** Mesh pair states by `meshPairKey`; a candidate pair with no entry is treated as `probing`. */
	meshPairs?: ReadonlyMap<string, MeshPairState>;
	/** Overlay names for capable nodes in mesh mode. */
	hosts?: OverlayHost[];
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
	options: OverlayGraphOptions = {},
): WireguardState {
	const self = nodes.find((node) => node.id === nodeId);
	const mesh = options.mode === 'mesh';
	const keepalive = options.keepaliveSeconds ?? WG_KEEPALIVE_SECONDS;
	// Only in mesh mode: a helper treats a missing list as "no names" and removes its block, so hub
	// mode's desired state stays exactly what it was before mesh mode existed.
	const hostsField = mesh && self?.meshCapable && options.hosts?.length ? { hosts: options.hosts } : {};
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
			...(self?.networkMode === 'external' ? {} : hostsField),
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
		// A hub dials every node; a spoke with no hub can still reach same-zone LAN peers. With no
		// hub at all, mesh mode also dials an endpoint another node observed.
		for (const node of managed) {
			const endpoint = sharesPrivateNetwork(self, node)
				? node.lanEndpoint
				: (node.wgEndpoint ?? (mesh && hubs.length === 0 && self.meshCapable && node.meshCapable ? node.observedEndpoint : null));
			peers.push({
				nodeId: node.id,
				publicKey: node.wgPublicKey!,
				endpoint: endpoint ?? null,
				allowedIps: [`${node.privateAddress}/32`],
				persistentKeepalive: endpoint && endpoint !== node.observedEndpoint ? 0 : keepalive,
			});
		}
	} else {
		const hubIds = new Set(hubs.map((hub) => hub.id));
		const relayedByHub = new Map<string, OverlayNode[]>(hubs.map((hub) => [hub.id, []]));
		for (const node of managed) {
			if (directIds.has(node.id) || hubIds.has(node.id)) continue;
			// Mesh mode (§4.7): a spoke pair tries the direct path. A probe holds the peer with no
			// addresses, so the hub keeps carrying the pair until a handshake proves the path.
			if (
				mesh &&
				self.meshCapable &&
				node.meshCapable &&
				!node.roles.includes('ingress') &&
				(dialable(node) || dialable(self))
			) {
				const state = options.meshPairs?.get(meshPairKey(self.id, node.id)) ?? 'probing';
				if (state !== 'relayed')
					peers.push({
						nodeId: node.id,
						publicKey: node.wgPublicKey!,
						endpoint: dialable(node),
						allowedIps: state === 'direct' ? [`${node.privateAddress}/32`] : [],
						// Both sides keep sending: that is what holds each NAT mapping open.
						persistentKeepalive: keepalive || WG_KEEPALIVE_SECONDS,
					});
				if (state === 'direct') continue;
			}
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
		...hostsField,
	};
}

function dialable(node: OverlayNode): string | null {
	return node.wgEndpoint ?? node.observedEndpoint ?? null;
}

/**
 * The underlay path between two managed nodes, as the peer graph above builds it: `private` over a
 * shared LAN or private network, `direct` to a public WireGuard endpoint, `relayed` through a hub.
 */
export function overlayPath(
	fromId: string,
	toId: string,
	nodes: OverlayNode[],
	options: Pick<OverlayGraphOptions, 'mode' | 'meshPairs'> = {},
): OverlayPath {
	const from = nodes.find((node) => node.id === fromId);
	const to = nodes.find((node) => node.id === toId);
	if (!from || !to || from.id === to.id || !to.privateAddress) return 'none';
	// Read the answer off the graph itself, so this can never disagree with what the node applies.
	const peers = buildWireguardState(from.id, nodes, DEFAULT_OVERLAY_CIDR, options).peers;
	const target = `${to.privateAddress}/32`;
	// A mesh probe is a peer that carries nothing yet: the pair is still relayed.
	const own = peers.find((peer) => peer.nodeId === to.id && peer.allowedIps.includes(target));
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
