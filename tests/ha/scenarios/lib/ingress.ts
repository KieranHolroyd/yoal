/**
 * How a scenario's traffic reaches the app.
 *
 * - `edge`: lab-a's public route (`127.0.0.1:47080` with the app's Host). What a user sees.
 * - `direct`: **the edge is bypassed.** The scenario's own client-side balancer (round robin, 5 s
 *   passive mark-down, half-open probes) sends each request straight to a copy at the address the
 *   edge would dial, through a stdio relay on a relay node (lab-a by default), because the host
 *   cannot route to the overlay. It measures copy failover and re-placement, not the edge; request
 *   failures in this mode describe the harness balancer as much as the platform.
 */
import { CONTROL } from '../../../lab/lab.config.ts';
import { PUBLIC_BASE, type FleetNode } from '../../../lab/lib/api.ts';
import { LabRelay, RelayError } from '../../../lab/lib/relay.ts';

export type TargetKind = 'edge' | 'direct';

export function parseTarget(value: string | undefined): TargetKind {
	if (value === 'edge' || value === 'direct') return value;
	throw new Error(`--target is edge or direct (got ${value})`);
}

export const EDGE_BYPASSED_NOTE =
	'Edge bypassed (--target direct): requests went through the scenario’s own client-side balancer (round robin, 5 s passive mark-down, half-open probes) straight to each copy at the address lab-a’s edge would dial, not through the edge. This measures copy failover and re-placement; it says nothing about the edge’s balancing or health checks, and request failures partly describe the harness balancer.';

/** Which copy answered one request to `base` for `host`. */
export async function whoami(base: string, host: string, path = '/whoami'): Promise<{ node: string; copy: string } | null> {
	try {
		const response = await fetch(`${base}${path}`, { headers: { host }, signal: AbortSignal.timeout(3000) });
		if (!response.ok) return null;
		const node = response.headers.get('x-checker-node');
		const copy = response.headers.get('x-checker-copy');
		if (node) return { node, copy: copy ?? '' };
		if (path !== '/whoami') return null;
		const body = (await response.json()) as { node?: string; copy?: string };
		return body.node ? { node: body.node, copy: body.copy ?? '' } : null;
	} catch {
		return null;
	}
}

/** `count` sequential requests through `base`: how many each node's copy answered (`none` = no answer). */
export async function share(base: string, host: string, count: number): Promise<Record<string, number>> {
	const counts: Record<string, number> = {};
	for (let i = 0; i < count; i++) {
		const who = await whoami(base, host);
		const key = who?.node ?? 'none';
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

/** Repeat `share` up to `rounds` times (5 s apart) until every node in `want` took a request. */
export async function shareUntil(base: string, host: string, count: number, want: string[], rounds = 6): Promise<Record<string, number>> {
	let counts: Record<string, number> = {};
	for (let round = 0; round < rounds; round++) {
		if (round > 0) await Bun.sleep(5000);
		counts = await share(base, host, count);
		if (want.every((node) => (counts[node] ?? 0) > 0)) break;
	}
	return counts;
}

export function formatShare(counts: Record<string, number> | null | undefined): string {
	if (!counts) return 'not measured';
	const entries = Object.entries(counts);
	const total = entries.reduce((sum, [, value]) => sum + value, 0);
	return entries.map(([node, value]) => `${node} ${value}/${total} (${Math.round((100 * value) / Math.max(1, total))} %)`).join(', ') || 'none';
}

/** A route to the app: the URL and Host the checker uses, plus copy-level probes. */
export interface Target {
	kind: TargetKind;
	base: string;
	host: string;
	describe(): string;
	/** Tell a direct target which nodes run a copy now (no-op for the edge). */
	setNodes(nodes: string[]): Promise<void>;
	/**
	 * Does `node`'s copy answer `path` with 200 (default /whoami; `/healthz?db=1` also needs its
	 * database)? Edge: the public route answered from that node. Direct: the copy itself.
	 */
	answers(node: string, path?: string): Promise<boolean>;
	served(): Record<string, number> | null;
	stop(): Promise<void>;
}

export async function openTarget(kind: TargetKind, host: string, fleet: FleetNode[], nodes: string[], relayNode: string = CONTROL.name): Promise<Target> {
	if (kind === 'edge')
		return {
			kind,
			base: PUBLIC_BASE,
			host,
			describe: () => `public route http://${host} via ${PUBLIC_BASE}`,
			setNodes: async () => {},
			answers: async (node, path) => {
				// The edge balances; a few tries before concluding the node's copy is not in rotation.
				for (let i = 0; i < 6; i++) if ((await whoami(PUBLIC_BASE, host, path))?.node === node) return true;
				return false;
			},
			served: () => null,
			stop: async () => {},
		};
	const balancer = new CopyBalancer(host, new LabRelay(relayNode), fleet, relayNode);
	await balancer.setNodes(nodes);
	return {
		kind,
		base: balancer.url,
		host,
		describe: () => `EDGE BYPASSED: client-side balancer ${balancer.url} → ${balancer.describe()} (relayed through ${relayNode}), Host ${host}`,
		setNodes: (list) => balancer.setNodes(list),
		answers: async (node, path) => (await balancer.probe(node, path))?.node === node,
		served: () => ({ ...balancer.served }),
		stop: () => balancer.stop(),
	};
}

/**
 * `--target direct`. Each request goes straight to one copy, round robin over the running copies,
 * at the address the edge itself would dial: a worker copy's node Caddy on the overlay
 * (`<privateAddress>:8080`); the relay node's own copy on its local port (from its Caddy config).
 *
 * A copy that refuses the connection or answers 502–504 is marked down for 5 s and the request goes
 * to the next one (it never reached a copy, so the retry cannot double a write); a timeout is
 * answered 504 and not retried (it may have). After the 5 s, one request at a time probes the copy
 * (half-open) until one succeeds, so a dead node costs one request per probe, not a burst.
 */
export class CopyBalancer {
	private backends = new Map<string, string>();
	private readonly downUntil = new Map<string, number>();
	private readonly probing = new Set<string>();
	private next = 0;
	readonly served: Record<string, number> = {};
	private readonly server: ReturnType<typeof Bun.serve>;
	private localDial: string | null = null;

	constructor(
		private readonly host: string,
		private readonly relay: LabRelay,
		private readonly fleet: FleetNode[],
		private readonly relayNode: string,
	) {
		this.server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 30, fetch: (request) => this.forward(request) });
	}

	get url(): string {
		return `http://127.0.0.1:${this.server.port}`;
	}

	/** The address the edge dials for `node`'s copy. */
	async address(node: string): Promise<string | null> {
		if (node === this.relayNode) {
			this.localDial ??= (await this.relay.dials(this.host)).find((dial) => /^(127\.0\.0\.1|localhost):\d+$/.test(dial)) ?? null;
			return this.localDial ? `http://${this.localDial}` : null;
		}
		const row = this.fleet.find((candidate) => candidate.name === node) as (FleetNode & { publicAddress?: string | null }) | undefined;
		return row?.publicAddress ? `http://${row.publicAddress}` : row?.privateAddress ? `http://${row.privateAddress}:8080` : null;
	}

	async setNodes(nodes: string[]): Promise<void> {
		const next = new Map<string, string>();
		for (const node of [...new Set(nodes)].sort()) {
			// The relay node's local port changes when its copy is replaced.
			if (node === this.relayNode && !this.backends.has(node)) this.localDial = null;
			const address = await this.address(node);
			if (address) next.set(node, address);
		}
		this.backends = next;
	}

	describe(): string {
		return [...this.backends].map(([node, address]) => `${node} (${address})`).join(', ') || 'no copies';
	}

	async probe(node: string, path = '/whoami'): Promise<{ node: string } | null> {
		const address = this.backends.get(node) ?? (await this.address(node));
		if (!address) return null;
		try {
			const response = await this.relay.fetch(`${address}${path}`, { method: 'GET', headers: [['host', this.host]], timeoutMs: 3000 });
			const answered = response.headers.find(([name]) => name.toLowerCase() === 'x-checker-node')?.[1];
			return response.status === 200 && answered ? { node: answered } : null;
		} catch {
			return null;
		}
	}

	async stop(): Promise<void> {
		this.server.stop(true);
		await this.relay.close();
	}

	private order(): [string, string][] {
		const now = Date.now();
		const all = [...this.backends];
		const start = this.next++ % Math.max(1, all.length);
		const rotated = all.slice(start).concat(all.slice(0, start));
		const healthy = rotated.filter(([node]) => !this.downUntil.has(node));
		const recovering = rotated.filter(([node]) => this.downUntil.has(node) && this.downUntil.get(node)! <= now && !this.probing.has(node));
		const chosen = [...recovering.slice(0, 1), ...healthy];
		return chosen.length ? chosen : rotated;
	}

	private failed(node: string): void {
		this.probing.delete(node);
		this.downUntil.set(node, Date.now() + 5000);
	}

	private succeeded(node: string): void {
		this.probing.delete(node);
		this.downUntil.delete(node);
	}

	private async forward(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
		const headers: [string, string][] = [...request.headers].filter(([name]) => !['host', 'connection', 'content-length', 'transfer-encoding'].includes(name.toLowerCase()));
		headers.push(['host', this.host]);
		let last = 'no running copy';
		for (const [node, address] of this.order()) {
			if (this.downUntil.has(node)) this.probing.add(node);
			let response: Awaited<ReturnType<LabRelay['fetch']>>;
			try {
				response = await this.relay.fetch(`${address}${url.pathname}${url.search}`, { method: request.method, headers, body, timeoutMs: 3000 });
			} catch (error) {
				this.failed(node);
				if (error instanceof RelayError && error.timeout) return new Response(`copy on ${node} timed out`, { status: 504, headers: { 'x-lab-backend': node } });
				last = `${node}: ${(error as Error).message}`;
				continue;
			}
			if ([502, 503, 504].includes(response.status)) {
				this.failed(node);
				last = `${node}: HTTP ${response.status}`;
				continue;
			}
			this.succeeded(node);
			this.served[node] = (this.served[node] ?? 0) + 1;
			const out = new Headers(response.headers.filter(([name]) => !['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(name.toLowerCase())));
			out.set('x-lab-backend', node);
			return new Response(response.body as unknown as ConstructorParameters<typeof Response>[0], { status: response.status, headers: out });
		}
		return new Response(`no copy answered (${last})`, { status: 502 });
	}
}
