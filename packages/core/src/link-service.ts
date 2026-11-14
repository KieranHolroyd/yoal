import { and, eq, gte, inArray, lt, or } from 'drizzle-orm';
import { nodeLinkHistory, nodeLinks, nodes, serviceEndpoints } from '@yoal/db';
import {
	LINK_TESTS_CAPABILITY,
	linkTestLimits,
	linkTestRequestSchema,
	type LinkMapView,
	type LinkPath,
	type LinkProbeTarget,
	type LinkSample,
	type LinkTestResult,
	type LinkTestStartResult,
	type LinkTestStatus,
	type LinkTestTask,
	type NodeLinkView,
	type Principal,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError } from './errors.ts';
import { overlayPath, type OverlayNode } from './overlay.ts';
import { newId, parseJson, randomToken } from './util.ts';

type NodeRow = typeof nodes.$inferSelect;
type LinkRow = typeof nodeLinks.$inferSelect;

/** Port every overlay firewall opens (the node's Caddy); a reset from it is still a round trip. */
const SAMPLE_PORT = 8080;
const ACTIVE: LinkTestStatus[] = ['pending', 'running'];
/** A link silent this long, between two nodes that are themselves reporting, raises an alert. */
export const LINK_DOWN_ALERT_MS = 3 * 60_000;
const HISTORY_KEEP_MS = 24 * 60 * 60_000;
const HISTORY_VIEW_MINUTES = 60;

export interface LinkAlert {
	key: string;
	title: string;
	detail: string;
	severity: 'warning' | 'info';
	status?: 'firing' | 'resolved';
}

/**
 * Links between nodes (docs/CLUSTERING.md §4.6, D216).
 *
 * Agents sample a round trip to every other overlay node on each cycle and report it in the
 * heartbeat; this service keeps the latest sample per ordered pair and the path the traffic takes.
 * A link test is queued here, handed to the two nodes in their desired state (one listens, the
 * other probes) and its result stored on the pair. A node takes part in one test at a time, so a
 * whole-fleet run measures links, not the tests competing with each other.
 */
export class NodeLinkService {
	constructor(private readonly ctx: CoreContext) {}

	// ------------------------------------------------------------------ desired state

	/** The other overlay nodes this node samples. Empty off the overlay or on an older agent. */
	probesForNode(nodeId: string): LinkProbeTarget[] {
		const rows = this.#overlayRows();
		const self = rows.find((row) => row.id === nodeId);
		if (!self || !capable(self)) return [];
		return rows
			.filter((row) => row.id !== nodeId && row.status !== 'offline')
			.map((row) => ({ nodeId: row.id, address: row.privateAddress!, port: SAMPLE_PORT }));
	}

	/** The link tests this node takes part in right now. */
	testsForNode(nodeId: string): LinkTestTask[] {
		const now = this.ctx.now();
		const rows = this.ctx.db
			.select()
			.from(nodeLinks)
			.where(and(inArray(nodeLinks.testStatus, ACTIVE), or(eq(nodeLinks.fromNodeId, nodeId), eq(nodeLinks.toNodeId, nodeId))))
			.all();
		const addresses = new Map(this.#overlayRows().map((row) => [row.id, row.privateAddress!]));
		const tasks: LinkTestTask[] = [];
		for (const row of rows) {
			const listen = addresses.get(row.toNodeId);
			if (!row.testId || !row.testToken || !row.testPort || !listen || (row.testExpiresAt ?? 0) <= now) continue;
			const serve = row.toNodeId === nodeId;
			tasks.push({
				id: row.testId,
				role: serve ? 'serve' : 'probe',
				peerNodeId: serve ? row.fromNodeId : row.toNodeId,
				address: listen,
				port: row.testPort,
				token: row.testToken,
				seconds: row.testRequestedSeconds ?? linkTestLimits.defaultSeconds,
				streams: row.testStreams ?? linkTestLimits.defaultStreams,
				expiresAt: row.testExpiresAt!,
			});
		}
		return tasks;
	}

	// ------------------------------------------------------------------ heartbeat

	applySamples(nodeId: string, samples: readonly LinkSample[]): void {
		const now = this.ctx.now();
		const overlay = this.#overlayNodes();
		const known = new Set(overlay.map((node) => node.id));
		const minute = Math.floor(now / 60_000) * 60_000;
		const since = new Map(
			this.ctx.db
				.select({ to: nodeLinks.toNodeId, downSince: nodeLinks.downSince })
				.from(nodeLinks)
				.where(eq(nodeLinks.fromNodeId, nodeId))
				.all()
				.map((row) => [row.to, row.downSince]),
		);
		for (const sample of samples) {
			if (sample.nodeId === nodeId || !known.has(sample.nodeId)) continue;
			// One point a minute is plenty for a day's shape; the newest sample of the minute wins.
			const point = { rttMs: sample.rttMs, lossPercent: sample.lossPercent };
			this.ctx.db
				.insert(nodeLinkHistory)
				.values({ fromNodeId: nodeId, toNodeId: sample.nodeId, at: minute, ...point })
				.onConflictDoUpdate({ target: [nodeLinkHistory.fromNodeId, nodeLinkHistory.toNodeId, nodeLinkHistory.at], set: point })
				.run();
			this.ctx.db
				.delete(nodeLinkHistory)
				.where(and(eq(nodeLinkHistory.fromNodeId, nodeId), eq(nodeLinkHistory.toNodeId, sample.nodeId), lt(nodeLinkHistory.at, now - HISTORY_KEEP_MS)))
				.run();
			const values = {
				// Silence starts a clock; any answer stops it.
				downSince: sample.rttMs === null ? (since.get(sample.nodeId) ?? now) : null,
				path: overlayPath(nodeId, sample.nodeId, overlay),
				rttMs: sample.rttMs,
				rttMinMs: sample.minMs,
				rttMaxMs: sample.maxMs,
				lossPercent: sample.lossPercent,
				sampledAt: now,
				updatedAt: now,
			};
			this.ctx.db
				.insert(nodeLinks)
				.values({ fromNodeId: nodeId, toNodeId: sample.nodeId, ...values })
				.onConflictDoUpdate({ target: [nodeLinks.fromNodeId, nodeLinks.toNodeId], set: values })
				.run();
		}
	}

	/** Results come from the probing node only; the listener has nothing to report. */
	applyTestResults(nodeId: string, results: readonly LinkTestResult[]): void {
		const now = this.ctx.now();
		let finished = false;
		for (const result of results) {
			const row = this.ctx.db
				.select()
				.from(nodeLinks)
				.where(and(eq(nodeLinks.fromNodeId, nodeId), eq(nodeLinks.testId, result.taskId)))
				.get();
			if (!row || !row.testStatus || !ACTIVE.includes(row.testStatus as LinkTestStatus)) continue;
			if (result.status === 'running') {
				if (row.testStatus !== 'running')
					this.ctx.db
						.update(nodeLinks)
						.set({ testStatus: 'running', updatedAt: now })
						.where(and(eq(nodeLinks.fromNodeId, row.fromNodeId), eq(nodeLinks.toNodeId, row.toNodeId)))
						.run();
				continue;
			}
			this.#finish(row, result.status === 'ok' ? 'ok' : 'failed', now, {
				testError: result.status === 'ok' ? null : (result.error ?? 'The test failed.'),
				...(result.status === 'ok'
					? {
							uploadBps: result.uploadBps ?? null,
							downloadBps: result.downloadBps ?? null,
							testRttMs: result.rttMs ?? null,
							testJitterMs: result.jitterMs ?? null,
							testBytes: result.bytes ?? null,
							testSeconds: result.seconds ?? null,
						}
					: {}),
			});
			finished = true;
		}
		if (finished || this.#expire(now)) this.#advance(now);
	}

	// ------------------------------------------------------------------ surfaces

	view(principal: Principal): LinkMapView {
		if (!this.ctx.platformIam.canView(principal))
			throw new CoreError('forbidden', 'Platform admin permission required.', 403);
		const now = this.ctx.now();
		if (this.#expire(now)) this.#advance(now);
		const rows = this.ctx.db.select().from(nodes).all();
		const overlay = this.#overlayNodes();
		const managed = new Set(overlay.filter((node) => node.privateAddress && node.networkMode !== 'external').map((node) => node.id));
		const stored = new Map(this.ctx.db.select().from(nodeLinks).all().map((row) => [`${row.fromNodeId}>${row.toNodeId}`, row]));
		const firstMinute = Math.floor(now / 60_000) * 60_000 - (HISTORY_VIEW_MINUTES - 1) * 60_000;
		const points = new Map<string, Map<number, number | null>>();
		for (const row of this.ctx.db.select().from(nodeLinkHistory).where(gte(nodeLinkHistory.at, firstMinute)).all()) {
			const key = `${row.fromNodeId}>${row.toNodeId}`;
			const series = points.get(key) ?? new Map<number, number | null>();
			series.set(row.at, row.rttMs);
			points.set(key, series);
		}
		/** The last hour, one slot a minute; minutes before the first sample are left out. */
		const historyOf = (key: string): Array<number | null> => {
			const series = points.get(key);
			if (!series) return [];
			const first = Math.min(...series.keys());
			const out: Array<number | null> = [];
			for (let at = first; at < firstMinute + HISTORY_VIEW_MINUTES * 60_000; at += 60_000) out.push(series.get(at) ?? null);
			return out;
		};
		const links: NodeLinkView[] = [];
		for (const from of rows) {
			for (const to of rows) {
				if (from.id === to.id || !managed.has(from.id) || !managed.has(to.id)) continue;
				const row = stored.get(`${from.id}>${to.id}`);
				links.push({
					fromNodeId: from.id,
					toNodeId: to.id,
					// Recomputed, so a change of private network shows before the next sample lands.
					path: overlayPath(from.id, to.id, overlay) as LinkPath,
					rttMs: row?.rttMs ?? null,
					rttMinMs: row?.rttMinMs ?? null,
					rttMaxMs: row?.rttMaxMs ?? null,
					lossPercent: row?.lossPercent ?? null,
					sampledAt: row?.sampledAt ? new Date(row.sampledAt).toISOString() : null,
					history: historyOf(`${from.id}>${to.id}`),
					downSince: row?.downSince ? new Date(row.downSince).toISOString() : null,
					test: row?.testId
						? {
								id: row.testId,
								status: (row.testStatus ?? 'failed') as LinkTestStatus,
								error: row.testError,
								startedAt: row.testStartedAt ? new Date(row.testStartedAt).toISOString() : null,
								finishedAt: row.testFinishedAt ? new Date(row.testFinishedAt).toISOString() : null,
								uploadBps: row.uploadBps,
								downloadBps: row.downloadBps,
								rttMs: row.testRttMs,
								jitterMs: row.testJitterMs,
								bytes: row.testBytes,
								seconds: row.testSeconds,
							}
						: null,
				});
			}
		}
		const statuses = [...stored.values()].map((row) => row.testStatus);
		return {
			generatedAt: new Date(now).toISOString(),
			nodes: rows.map((row) => {
				const facts = this.ctx.nodes.view(row);
				return {
					id: row.id,
					name: row.name,
					zone: facts.zone,
					status: row.status,
					roles: facts.roles,
					privateAddress: row.privateAddress,
					privateNetwork: row.privateNetwork,
					lanEndpoint: row.lanEndpoint,
					capable: managed.has(row.id) && capable(row),
				};
			}),
			links,
			running: statuses.filter((status) => status === 'pending' || status === 'running').length,
			queued: statuses.filter((status) => status === 'queued').length,
		};
	}

	/**
	 * Queue link tests: one pair, one node against the rest, or every pair once. A test loads the
	 * link for a few seconds in each direction, so it is a fleet action: a signed-in platform admin.
	 */
	start(principal: Principal, raw: unknown): LinkTestStartResult {
		if (!this.ctx.platformIam.allows(principal, 'platform:nodes'))
			throw new CoreError(
				'forbidden',
				principal.platformAdmin
					? 'Fleet changes need a platform admin role signed in to the dashboard (not an API key or MCP token).'
					: 'Platform admin permission required.',
				403,
			);
		const input = linkTestRequestSchema.parse(raw ?? {});
		const rows = this.#overlayRows();
		const resolve = (reference: string | undefined): NodeRow | null => {
			if (!reference) return null;
			const row = rows.find((candidate) => candidate.id === reference || candidate.name === reference);
			if (!row) throw new NotFoundError('Node');
			return row;
		};
		const from = resolve(input.from);
		const to = resolve(input.to);
		if (from && to && from.id === to.id) throw new ConflictError('A link has two ends: pick two different nodes.');
		const pairs: Array<[NodeRow, NodeRow]> = [];
		if (from && to) pairs.push([from, to]);
		else if (from || to) {
			const one = (from ?? to)!;
			for (const other of rows) if (other.id !== one.id) pairs.push(from ? [one, other] : [other, one]);
		} else {
			// Every pair once: the prober measures both directions.
			for (let a = 0; a < rows.length; a++) for (let b = a + 1; b < rows.length; b++) pairs.push([rows[a]!, rows[b]!]);
		}
		if (pairs.length === 0) throw new ConflictError('A link test needs two nodes on the managed overlay.');
		const now = this.ctx.now();
		const result: LinkTestStartResult = { queued: [], skipped: [] };
		for (const [a, b] of pairs) {
			const reason =
				a.status === 'offline' || b.status === 'offline'
					? `${a.status === 'offline' ? a.name : b.name} is offline.`
					: !capable(a) || !capable(b)
						? `${!capable(a) ? a.name : b.name} runs an agent that predates link tests. Update the node first.`
						: null;
			const existing = this.ctx.db
				.select()
				.from(nodeLinks)
				.where(and(eq(nodeLinks.fromNodeId, a.id), eq(nodeLinks.toNodeId, b.id)))
				.get();
			const busy = existing?.testStatus === 'queued' || ACTIVE.includes(existing?.testStatus as LinkTestStatus);
			if (reason || busy) {
				result.skipped.push({ from: a.id, to: b.id, reason: reason ?? 'A test of this link is already queued or running.' });
				continue;
			}
			const values = {
				testId: newId('lnk_'),
				testStatus: 'queued',
				testError: null,
				testStartedAt: null,
				testFinishedAt: null,
				testToken: null,
				testPort: null,
				testStreams: input.streams,
				testRequestedSeconds: input.seconds,
				testExpiresAt: null,
				updatedAt: now,
			};
			this.ctx.db
				.insert(nodeLinks)
				.values({ fromNodeId: a.id, toNodeId: b.id, path: overlayPath(a.id, b.id, this.#overlayNodes()), ...values })
				.onConflictDoUpdate({ target: [nodeLinks.fromNodeId, nodeLinks.toNodeId], set: values })
				.run();
			result.queued.push([a.id, b.id]);
		}
		if (result.queued.length > 0) {
			this.ctx.audit.record({
				principal,
				action: 'node.link_test',
				resource: 'cluster',
				resourceId: 'links',
				args: { pairs: result.queued.length, seconds: input.seconds, streams: input.streams },
				result: 'ok',
			});
			this.#advance(now);
		}
		return result;
	}

	/**
	 * Links that have stayed silent, and links that came back. Only between two nodes that are
	 * themselves heartbeating: a node that is down has its own alert, and its links would only repeat
	 * it. A resolved entry is returned every tick while the link is up; the caller sends it once.
	 */
	alerts(now: number = this.ctx.now()): LinkAlert[] {
		const rows = this.ctx.db.select().from(nodes).all();
		const byId = new Map(rows.map((row) => [row.id, row]));
		const out: LinkAlert[] = [];
		for (const link of this.ctx.db.select().from(nodeLinks).all()) {
			const from = byId.get(link.fromNodeId);
			const to = byId.get(link.toNodeId);
			if (!from || !to || link.sampledAt === null) continue;
			const key = `link:${link.fromNodeId}:${link.toNodeId}`;
			const bothUp = from.status === 'online' && to.status === 'online';
			// A stale row (the reporting node stopped sampling) says nothing either way.
			const current = now - link.sampledAt <= LINK_DOWN_ALERT_MS;
			if (link.downSince !== null && current && bothUp && now - link.downSince >= LINK_DOWN_ALERT_MS)
				out.push({
					key,
					title: `${from.name} cannot reach ${to.name}`,
					detail: `${from.name} has had no answer from ${to.name} over the ${link.path === 'relayed' ? 'relayed' : link.path} path for ${Math.round((now - link.downSince) / 60_000)} min, though both nodes are reporting. Apps on one that use a database or copy on the other are affected.`,
					severity: 'warning',
				});
			else if (link.downSince === null && current)
				out.push({
					key,
					title: `${from.name} reaches ${to.name} again`,
					detail: `The link answered in ${link.rttMs === null ? '?' : Math.round(link.rttMs)} ms.`,
					severity: 'info',
					status: 'resolved',
				});
		}
		return out;
	}

	// ------------------------------------------------------------------ internals

	/** Hand out queued tests whose two nodes are both free. Oldest first; one test per node. */
	#advance(now: number): void {
		const rows = this.ctx.db.select().from(nodeLinks).all();
		const busy = new Set<string>();
		for (const row of rows)
			if (ACTIVE.includes(row.testStatus as LinkTestStatus)) {
				busy.add(row.fromNodeId);
				busy.add(row.toNodeId);
			}
		let started = false;
		for (const row of rows.filter((entry) => entry.testStatus === 'queued').sort((a, b) => a.updatedAt - b.updatedAt)) {
			if (busy.has(row.fromNodeId) || busy.has(row.toNodeId)) continue;
			const seconds = row.testRequestedSeconds ?? linkTestLimits.defaultSeconds;
			this.ctx.db
				.update(nodeLinks)
				.set({
					testStatus: 'pending',
					testToken: randomToken(24),
					testPort: this.#freePort(row.toNodeId),
					testStartedAt: now,
					// Both nodes pick the test up on their next pull, then echo, push and pull.
					testExpiresAt: now + (seconds * 2 + linkTestLimits.graceSeconds) * 1000,
					updatedAt: now,
				})
				.where(and(eq(nodeLinks.fromNodeId, row.fromNodeId), eq(nodeLinks.toNodeId, row.toNodeId)))
				.run();
			busy.add(row.fromNodeId);
			busy.add(row.toNodeId);
			started = true;
		}
		// Desired state for the two nodes changed (a test appeared or went away).
		if (started) this.ctx.projects.bump();
	}

	/** Fail tests no node finished in time, so a lost node never blocks the queue. */
	#expire(now: number): boolean {
		const stale = this.ctx.db
			.select()
			.from(nodeLinks)
			.where(inArray(nodeLinks.testStatus, ACTIVE))
			.all()
			.filter((row) => (row.testExpiresAt ?? 0) <= now);
		for (const row of stale)
			this.#finish(row, 'failed', now, { testError: 'The test did not finish in time. Are both nodes online and on a current agent?' });
		return stale.length > 0;
	}

	#finish(row: LinkRow, status: 'ok' | 'failed', now: number, extra: Partial<LinkRow>): void {
		this.ctx.db
			.update(nodeLinks)
			.set({ testStatus: status, testFinishedAt: now, testToken: null, testPort: null, testExpiresAt: null, updatedAt: now, ...extra })
			.where(and(eq(nodeLinks.fromNodeId, row.fromNodeId), eq(nodeLinks.toNodeId, row.toNodeId)))
			.run();
		this.ctx.projects.bump();
	}

	/** A port on the listening node's overlay address that no service provider listens on. */
	#freePort(nodeId: string): number {
		const used = new Set(
			this.ctx.db
				.select({ port: serviceEndpoints.upstreamPort })
				.from(serviceEndpoints)
				.where(eq(serviceEndpoints.upstreamNodeId, nodeId))
				.all()
				.map((row) => row.port),
		);
		for (let port = linkTestLimits.portMax; port >= linkTestLimits.portMin; port--) if (!used.has(port)) return port;
		return linkTestLimits.portMax;
	}

	/** Managed overlay nodes: an address, a key, not bring-your-own networking. */
	#overlayRows(): NodeRow[] {
		return this.ctx.db
			.select()
			.from(nodes)
			.all()
			.filter((row) => row.networkMode !== 'external' && row.privateAddress && row.wgPublicKey);
	}

	#overlayNodes(): OverlayNode[] {
		return this.ctx.db
			.select()
			.from(nodes)
			.all()
			.map((row) => ({
				id: row.id,
				name: row.name,
				zone: row.zone,
				roles: this.ctx.nodes.view(row).roles,
				networkMode: row.networkMode,
				privateAddress: row.privateAddress,
				wgPublicKey: row.wgPublicKey,
				wgEndpoint: row.wgEndpoint,
				lanEndpoint: row.lanEndpoint,
				privateNetwork: row.privateNetwork,
			}));
	}
}

function capable(row: Pick<NodeRow, 'capabilitiesJson'>): boolean {
	return parseJson<string[]>(row.capabilitiesJson, []).includes(LINK_TESTS_CAPABILITY);
}
