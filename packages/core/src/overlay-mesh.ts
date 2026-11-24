import { OVERLAY_NAME_SUFFIX, type OverlayHost, type WireguardStatus } from '@yoal/contracts';
import { meshPairKey, sharesPrivateNetwork, type MeshPairState, type OverlayNode } from './overlay.ts';

export { meshPairKey, type MeshPairState };

/**
 * Mesh mode for the overlay (docs/CLUSTERING.md §4.7, D240): the Tailscale-like part.
 *
 * Kernel WireGuard owns its UDP socket, so a node cannot ask a STUN server what its NAT mapped port
 * 51820 to. A hub can, though: `wg show` lists the endpoint each spoke's handshake arrived from,
 * which is exactly that mapping. The control plane reads those endpoints off the hubs' heartbeats,
 * hands each pair of nodes the other's, and both dial at once: on an endpoint-independent NAT the
 * outgoing packets open the mapping the incoming ones need.
 *
 * A pair is never cut over blind. While it is `probing`, each node holds a peer for the other with
 * no allowed IPs: keepalives drive the handshake while the hub still carries the traffic. Only a
 * handshake moves the pair's addresses onto the direct peer (`direct`); a probe that never answers
 * (a symmetric NAT, a blocked port) leaves it `relayed` and tries again later with a backoff.
 *
 * Pure: the service in `overlay-mesh-service.ts` stores the pairs and feeds the reports in.
 */

export interface MeshPair {
	/** The two node ids, `a < b`. */
	a: string;
	b: string;
	state: MeshPairState;
	/** When the pair entered its state (ms). */
	since: number;
	/** Failed probes in a row; drives the backoff. */
	attempts: number;
	/** When a `relayed` pair probes again (ms). */
	retryAt: number | null;
	/** The endpoints the pair was probed on; a change re-probes a relayed pair at once. */
	endpoints: string;
	/** Last direct handshake either side reported (ms). */
	lastHandshakeAt: number | null;
}

/** One node's latest `wg show` as its heartbeat carried it. */
export interface MeshReport {
	nodeId: string;
	/** When the control plane received it (ms, control-plane clock). */
	receivedAt: number;
	status: WireguardStatus;
}

/** A probe that has not handshaken in this long has failed. */
export const MESH_PROBE_TIMEOUT_MS = 120_000;
/** A WireGuard session rekeys every two minutes while keepalives flow, so older means the path died. */
export const MESH_HANDSHAKE_STALE_MS = 180_000;
/** Reports older than this say nothing about the path now. */
export const MESH_REPORT_FRESH_MS = 120_000;
/** Retry a failed pair after 5 minutes, then 15, then hourly. */
export const MESH_BACKOFF_MS = [300_000, 900_000, 3_600_000] as const;

/** An IPv4 or IPv6 literal that only means something on its own LAN, so no other node can dial it. */
export function isPrivateHost(host: string): boolean {
	const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		return (
			a === 10 ||
			a === 127 ||
			a === 0 ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 169 && b === 254) ||
			(a === 100 && b >= 64 && b <= 127)
		);
	}
	if (bare.includes(':')) return bare === '::1' || /^f[cd]/.test(bare) || /^fe[89ab]/.test(bare);
	return false;
}

function hostOf(endpoint: string): string {
	const v6 = /^\[([^\]]+)\]:\d+$/.exec(endpoint);
	if (v6) return v6[1]!;
	const index = endpoint.lastIndexOf(':');
	return index > 0 ? endpoint.slice(0, index) : endpoint;
}

function handshakeMs(at: string | null): number | null {
	if (!at) return null;
	const value = Date.parse(at);
	return Number.isFinite(value) ? value : null;
}

/**
 * The public endpoint each node's WireGuard socket is seen from, read off the other nodes' reports.
 * A node with its own public `wgEndpoint` needs none. Only fresh reports with a live handshake
 * count, and never a private address (that is a LAN view, which `lanEndpoint` already covers);
 * a hub's view wins over a spoke's, then the freshest handshake.
 */
export function observedEndpoints(nodes: OverlayNode[], reports: MeshReport[], now: number): Map<string, string> {
	const byKey = new Map(nodes.filter((node) => node.wgPublicKey).map((node) => [node.wgPublicKey!, node]));
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const best = new Map<string, { endpoint: string; hub: boolean; at: number }>();
	for (const report of reports) {
		if (now - report.receivedAt > MESH_REPORT_FRESH_MS) continue;
		const reporter = byId.get(report.nodeId);
		if (!reporter) continue;
		const hub = reporter.roles.includes('ingress') && Boolean(reporter.wgEndpoint);
		for (const peer of report.status.peers) {
			const owner = byKey.get(peer.publicKey);
			if (!owner || owner.id === reporter.id || owner.wgEndpoint || !peer.endpoint) continue;
			if (isPrivateHost(hostOf(peer.endpoint)) || sharesPrivateNetwork(reporter, owner)) continue;
			const at = handshakeMs(peer.latestHandshakeAt);
			if (at === null || report.receivedAt - at > MESH_HANDSHAKE_STALE_MS) continue;
			const current = best.get(owner.id);
			if (!current || (hub && !current.hub) || (hub === current.hub && at > current.at))
				best.set(owner.id, { endpoint: peer.endpoint, hub, at });
		}
	}
	return new Map([...best].map(([id, value]) => [id, value.endpoint]));
}

/** Where `node` can be dialled from outside its LAN, if anywhere. */
export function dialableEndpoint(node: OverlayNode): string | null {
	return node.wgEndpoint ?? node.observedEndpoint ?? null;
}

/**
 * Pairs mesh mode tries directly: both nodes managed, keyed, addressed and `wg-mesh` capable,
 * neither an ingress (a hub already dials every node), no shared private network (already direct), and
 * at least one side dialable. Sorted for a stable result.
 */
export function meshCandidatePairs(nodes: OverlayNode[]): Array<[OverlayNode, OverlayNode]> {
	// An ingress node already peers with every node itself (the hub side of §4.1).
	const eligible = nodes
		.filter(
			(node) =>
				node.networkMode !== 'external' &&
				node.privateAddress &&
				node.wgPublicKey &&
				node.meshCapable &&
				!node.roles.includes('ingress'),
		)
		.sort((x, y) => x.id.localeCompare(y.id));
	const pairs: Array<[OverlayNode, OverlayNode]> = [];
	for (let i = 0; i < eligible.length; i++)
		for (let j = i + 1; j < eligible.length; j++) {
			const [a, b] = [eligible[i]!, eligible[j]!];
			if (sharesPrivateNetwork(a, b) || sharesPrivateNetwork(b, a)) continue;
			if (!dialableEndpoint(a) && !dialableEndpoint(b)) continue;
			pairs.push([a, b]);
		}
	return pairs;
}

/** The newest handshake either node reports for the other, with whether any fresh report saw the pair. */
function pairHandshake(
	a: OverlayNode,
	b: OverlayNode,
	reports: Map<string, MeshReport>,
	now: number,
	after: number,
): { latest: number | null; observed: boolean } {
	let latest: number | null = null;
	let observed = false;
	for (const [self, other] of [
		[a, b],
		[b, a],
	] as const) {
		const report = reports.get(self.id);
		// A report collected before the pair entered its state cannot speak for it.
		if (!report || now - report.receivedAt > MESH_REPORT_FRESH_MS || report.receivedAt < after) continue;
		const peer = report.status.peers.find((candidate) => candidate.publicKey === other.wgPublicKey);
		if (!peer) continue;
		observed = true;
		const at = handshakeMs(peer.latestHandshakeAt);
		// Node clocks are close but not ours: judge freshness against when the report arrived.
		if (at !== null && report.receivedAt - at <= MESH_HANDSHAKE_STALE_MS && (latest === null || at > latest)) latest = at;
	}
	return { latest, observed };
}

/**
 * One step of every pair's state machine. Returns the pairs to keep (rows not returned are dropped:
 * the pair is no longer a candidate) and whether any node's peer graph changed.
 *
 * - new → `probing`
 * - `probing` → `direct` on a fresh handshake reported after the probe began
 * - `probing` → `relayed` after `MESH_PROBE_TIMEOUT_MS`, retrying on the backoff
 * - `direct` → `probing` when a fresh report sees no live handshake (the hub takes the traffic back)
 * - `relayed` → `probing` at `retryAt`, or at once when either endpoint changes
 */
export function advanceMeshPairs(
	nodes: OverlayNode[],
	previous: ReadonlyMap<string, MeshPair>,
	reports: MeshReport[],
	now: number,
): { pairs: MeshPair[]; changed: boolean } {
	const byNode = new Map(reports.map((report) => [report.nodeId, report]));
	const next: MeshPair[] = [];
	let changed = false;
	const seen = new Set<string>();
	for (const [a, b] of meshCandidatePairs(nodes)) {
		const key = meshPairKey(a.id, b.id);
		seen.add(key);
		const endpoints = `${dialableEndpoint(a) ?? '-'} ${dialableEndpoint(b) ?? '-'}`;
		const prior = previous.get(key);
		if (!prior) {
			next.push({ a: a.id, b: b.id, state: 'probing', since: now, attempts: 0, retryAt: null, endpoints, lastHandshakeAt: null });
			changed = true;
			continue;
		}
		const pair: MeshPair = { ...prior, endpoints };
		const handshake = pairHandshake(a, b, byNode, now, prior.state === 'probing' ? prior.since : 0);
		if (handshake.latest !== null) pair.lastHandshakeAt = Math.max(pair.lastHandshakeAt ?? 0, handshake.latest);
		const enter = (state: MeshPairState, patch: Partial<MeshPair> = {}) => {
			Object.assign(pair, { state, since: now, ...patch });
			changed = true;
		};
		if (prior.state === 'probing') {
			if (handshake.latest !== null) enter('direct', { attempts: 0, retryAt: null });
			else if (now - prior.since >= MESH_PROBE_TIMEOUT_MS) {
				const attempts = prior.attempts + 1;
				const backoff = MESH_BACKOFF_MS[Math.min(attempts, MESH_BACKOFF_MS.length) - 1]!;
				enter('relayed', { attempts, retryAt: now + backoff });
			}
		} else if (prior.state === 'direct') {
			if (handshake.observed && handshake.latest === null) enter('probing');
			// A moved endpoint is re-rendered without a state change; the direct peer follows it.
			else if (prior.endpoints !== endpoints) changed = true;
		} else if (prior.endpoints !== endpoints) enter('probing', { attempts: 0, retryAt: null });
		else if (prior.retryAt !== null && now >= prior.retryAt) enter('probing', { retryAt: null });
		next.push(pair);
	}
	for (const key of previous.keys()) if (!seen.has(key)) changed = true;
	return { pairs: next, changed };
}

/** `Edge B (hel1)` → `edge-b-hel1`: a DNS label, or null when nothing usable is left. */
export function overlayLabel(name: string): string | null {
	const label = name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 63)
		.replace(/-$/, '');
	return label || null;
}

/**
 * `<label>.yoal.internal` for every addressed node (§4.7). Names collide only by accident; the
 * node that joined first keeps the plain name and the next gets its id's tail appended.
 */
export function overlayHosts(nodes: OverlayNode[]): OverlayHost[] {
	const hosts: OverlayHost[] = [];
	const taken = new Set<string>();
	const addressed = nodes
		.filter((node) => node.networkMode !== 'external' && node.privateAddress)
		.sort((x, y) => (x.joinedAt ?? 0) - (y.joinedAt ?? 0) || x.id.localeCompare(y.id));
	for (const node of addressed) {
		const base = overlayLabel(node.name) ?? overlayLabel(node.id) ?? 'node';
		let label = base;
		if (taken.has(label)) {
			const tail = node.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-6) || String(hosts.length);
			label = `${base.slice(0, 56).replace(/-$/, '')}-${tail}`;
		}
		if (taken.has(label)) continue;
		taken.add(label);
		hosts.push({ name: `${label}.${OVERLAY_NAME_SUFFIX}`, address: node.privateAddress! });
	}
	// Sorted by name, so the rendered block does not churn with join order.
	return hosts.sort((x, y) => x.name.localeCompare(y.name)).slice(0, 64);
}
