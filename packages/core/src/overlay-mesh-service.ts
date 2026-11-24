import { wireguardStatusSchema, type Principal } from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { CoreError } from './errors.ts';
import { advanceMeshPairs, meshPairKey, type MeshPair, type MeshPairState, type MeshReport } from './overlay-mesh.ts';

interface PairRow {
	node_a: string;
	node_b: string;
	state: string;
	since: number;
	attempts: number;
	retry_at: number | null;
	endpoints: string;
	last_handshake_at: number | null;
}

export interface MeshSummary {
	mode: 'hub' | 'mesh';
	direct: number;
	probing: number;
	relayed: number;
	pairs: Array<{
		a: string;
		b: string;
		state: MeshPairState;
		since: string;
		retryAt: string | null;
		attempts: number;
		lastHandshakeAt: string | null;
	}>;
}

/** Evaluate at most this often: every node's heartbeat calls in, and a step reads every node. */
const EVALUATE_EVERY_MS = 5_000;

/**
 * Mesh mode's pair table (docs/CLUSTERING.md §4.7, D240). Heartbeats carry each node's `wg show`;
 * every few seconds the pairs take one step of `advanceMeshPairs`, and any change re-renders the
 * fleet's desired state. In hub mode the table is emptied and nothing else runs.
 */
export class OverlayMeshService {
	#lastEvaluatedAt = 0;
	#cache: Map<string, MeshPair> | null = null;

	constructor(private readonly ctx: CoreContext) {}

	/** Pair states by `meshPairKey` for the peer graph; empty outside mesh mode. */
	states(): Map<string, MeshPairState> {
		if (this.ctx.cluster.get().overlay.mode !== 'mesh') return new Map();
		return new Map([...this.#pairs()].map(([key, pair]) => [key, pair.state]));
	}

	/** Called after a heartbeat is stored. Throttled; `force` is for tests and mode changes. */
	evaluate(now = this.ctx.now(), force = false): boolean {
		if (!force && now - this.#lastEvaluatedAt < EVALUATE_EVERY_MS) return false;
		this.#lastEvaluatedAt = now;
		if (this.ctx.cluster.get().overlay.mode !== 'mesh') {
			const existing = this.#pairs();
			if (existing.size === 0) return false;
			this.ctx.sqlite.run('DELETE FROM overlay_mesh_pairs');
			this.#cache = new Map();
			this.ctx.nodes.bump();
			return true;
		}
		const previous = this.#pairs();
		const { pairs, changed } = advanceMeshPairs(
			// With each node's observed endpoint: a pair needs one side it can dial.
			this.ctx.nodes.overlayGraph().nodes,
			previous,
			this.reports(),
			now,
		);
		const dirty = pairs.filter((pair) => {
			const before = previous.get(meshPairKey(pair.a, pair.b));
			return !before || JSON.stringify(before) !== JSON.stringify(pair);
		});
		const kept = new Set(pairs.map((pair) => meshPairKey(pair.a, pair.b)));
		const dropped = [...previous.values()].filter((pair) => !kept.has(meshPairKey(pair.a, pair.b)));
		if (dirty.length === 0 && dropped.length === 0) return false;
		this.ctx.sqlite.transaction(() => {
			for (const pair of dropped)
				this.ctx.sqlite.run('DELETE FROM overlay_mesh_pairs WHERE node_a = ? AND node_b = ?', [pair.a, pair.b]);
			for (const pair of dirty)
				this.ctx.sqlite.run(
					`INSERT INTO overlay_mesh_pairs (node_a, node_b, state, since, attempts, retry_at, endpoints, last_handshake_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(node_a, node_b) DO UPDATE SET state = excluded.state, since = excluded.since,
					   attempts = excluded.attempts, retry_at = excluded.retry_at, endpoints = excluded.endpoints,
					   last_handshake_at = excluded.last_handshake_at, updated_at = excluded.updated_at`,
					[pair.a, pair.b, pair.state, pair.since, pair.attempts, pair.retryAt, pair.endpoints, pair.lastHandshakeAt, now],
				);
		})();
		this.#cache = new Map(pairs.map((pair) => [meshPairKey(pair.a, pair.b), pair]));
		for (const pair of dirty.filter((pair) => pair.state !== previous.get(meshPairKey(pair.a, pair.b))?.state))
			this.ctx.audit.record({
				action: 'node.mesh_pair',
				resource: 'node',
				resourceId: pair.a,
				args: { peer: pair.b, state: pair.state, attempts: pair.attempts },
				result: 'ok',
			});
		// Only a state or endpoint change moves a peer; a refreshed handshake time does not.
		if (changed) this.ctx.nodes.bump();
		return changed;
	}

	/** `GET /api/v1/cluster/mesh` and Settings → Clustering: platform admins only, as the config is. */
	view(principal: Principal): MeshSummary {
		if (!this.ctx.platformIam.canView(principal))
			throw new CoreError('forbidden', 'Only a platform admin role can read the overlay mesh.', 403);
		return this.summary();
	}

	/** Unchecked; `view` is the surface read. */
	summary(): MeshSummary {
		const mode = this.ctx.cluster.get().overlay.mode;
		const pairs = mode === 'mesh' ? [...this.#pairs().values()] : [];
		const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());
		return {
			mode,
			direct: pairs.filter((pair) => pair.state === 'direct').length,
			probing: pairs.filter((pair) => pair.state === 'probing').length,
			relayed: pairs.filter((pair) => pair.state === 'relayed').length,
			pairs: pairs.map((pair) => ({
				a: pair.a,
				b: pair.b,
				state: pair.state,
				since: new Date(pair.since).toISOString(),
				retryAt: iso(pair.retryAt),
				attempts: pair.attempts,
				lastHandshakeAt: iso(pair.lastHandshakeAt),
			})),
		};
	}

	/** Every node's last `wg show`, with when it arrived. */
	reports(): MeshReport[] {
		const rows = this.ctx.sqlite
			.query<{ id: string; wg_status_json: string | null; wg_status_at: number | null }, []>(
				"SELECT id, wg_status_json, wg_status_at FROM nodes WHERE network_mode != 'external' AND wg_status_json IS NOT NULL",
			)
			.all();
		const reports: MeshReport[] = [];
		for (const row of rows) {
			if (!row.wg_status_at) continue;
			let raw: unknown = null;
			try {
				raw = JSON.parse(row.wg_status_json!);
			} catch {
				continue;
			}
			const parsed = wireguardStatusSchema.safeParse(raw);
			if (parsed.success) reports.push({ nodeId: row.id, receivedAt: row.wg_status_at, status: parsed.data });
		}
		return reports;
	}

	#pairs(): Map<string, MeshPair> {
		if (this.#cache) return this.#cache;
		const rows = this.ctx.sqlite.query<PairRow, []>('SELECT * FROM overlay_mesh_pairs').all();
		this.#cache = new Map(
			rows.map((row) => [
				meshPairKey(row.node_a, row.node_b),
				{
					a: row.node_a,
					b: row.node_b,
					state: (['probing', 'direct', 'relayed'].includes(row.state) ? row.state : 'probing') as MeshPairState,
					since: row.since,
					attempts: row.attempts,
					retryAt: row.retry_at,
					endpoints: row.endpoints,
					lastHandshakeAt: row.last_handshake_at,
				},
			]),
		);
		return this.#cache;
	}
}
