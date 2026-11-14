import * as z from 'zod';

/**
 * Links between nodes (docs/CLUSTERING.md §4.6, D216).
 *
 * Two measurements, both taken by the agents over the overlay. A **passive sample** is a TCP
 * round trip to each other node on every cycle: cheap, always on, and enough to see a slow or
 * lossy link. A **link test** is asked for by an operator: one node listens, the other measures
 * latency and jitter and then pushes and pulls data for a few seconds, so the numbers are what an
 * app talking to a database on the other node would get.
 */

/** The agent capability that says a build probes links and runs link tests. */
export const LINK_TESTS_CAPABILITY = 'link-tests';

export const linkTestLimits = {
	/** Seconds per direction. A test loads the link, so it is short by default and capped. */
	defaultSeconds: 5,
	maxSeconds: 30,
	defaultStreams: 4,
	maxStreams: 8,
	/** Round trips measured before any load is applied. */
	echoCount: 20,
	/** A test nobody finished within this long after it was handed out fails as timed out. */
	graceSeconds: 45,
	/** The listener's port is taken from the top of this range, away from allocated endpoints. */
	portMax: 19_999,
	portMin: 19_900,
} as const;

/** Another node to sample, by its overlay address. Port 8080 is open on every overlay firewall. */
export const linkProbeTargetSchema = z.object({
	nodeId: z.string().min(1).max(100),
	address: z.string().min(1).max(64),
	port: z.number().int().min(1).max(65_535),
});
export type LinkProbeTarget = z.infer<typeof linkProbeTargetSchema>;

/** One side of a link test. `serve` listens on `address:port`; `probe` dials it. */
export const linkTestTaskSchema = z.object({
	id: z.string().min(1).max(100),
	role: z.enum(['serve', 'probe']),
	peerNodeId: z.string().min(1).max(100),
	/** `serve`: this node's own overlay address to bind. `probe`: the peer's overlay address. */
	address: z.string().min(1).max(64),
	port: z.number().int().min(1).max(65_535),
	/** Shared by the two ends for this one test; the listener drops a connection without it. */
	token: z.string().min(16).max(128),
	seconds: z.number().int().min(1).max(linkTestLimits.maxSeconds),
	streams: z.number().int().min(1).max(linkTestLimits.maxStreams),
	/** Epoch milliseconds; the listener closes and the prober gives up at this time. */
	expiresAt: z.number().int().positive(),
});
export type LinkTestTask = z.infer<typeof linkTestTaskSchema>;

export const linkSampleSchema = z.object({
	nodeId: z.string().min(1).max(100),
	/** Mean round trip in milliseconds; null when every attempt timed out. */
	rttMs: z.number().nonnegative().nullable(),
	minMs: z.number().nonnegative().nullable().default(null),
	maxMs: z.number().nonnegative().nullable().default(null),
	lossPercent: z.number().min(0).max(100).default(0),
});
export type LinkSample = z.infer<typeof linkSampleSchema>;

export const linkTestResultSchema = z.object({
	taskId: z.string().min(1).max(100),
	status: z.enum(['running', 'ok', 'failed']),
	error: z.string().max(500).optional(),
	rttMs: z.number().nonnegative().optional(),
	jitterMs: z.number().nonnegative().optional(),
	/** Bits per second this node pushed to the peer, and pulled from it. */
	uploadBps: z.number().nonnegative().optional(),
	downloadBps: z.number().nonnegative().optional(),
	bytes: z.number().int().nonnegative().optional(),
	seconds: z.number().nonnegative().optional(),
});
export type LinkTestResult = z.infer<typeof linkTestResultSchema>;

export const linkPaths = ['private', 'direct', 'relayed', 'none'] as const;
export type LinkPath = (typeof linkPaths)[number];

export const linkTestStatuses = ['queued', 'pending', 'running', 'ok', 'failed'] as const;
export type LinkTestStatus = (typeof linkTestStatuses)[number];

export interface NodeLinkTestView {
	id: string;
	status: LinkTestStatus;
	error: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	uploadBps: number | null;
	downloadBps: number | null;
	rttMs: number | null;
	jitterMs: number | null;
	bytes: number | null;
	seconds: number | null;
}

/** One direction of one pair. `test` numbers are from the `from` node's point of view. */
export interface NodeLinkView {
	fromNodeId: string;
	toNodeId: string;
	/** How the traffic travels under WireGuard: a private network, a public endpoint or through a hub. */
	path: LinkPath;
	rttMs: number | null;
	rttMinMs: number | null;
	rttMaxMs: number | null;
	lossPercent: number | null;
	sampledAt: string | null;
	/** Round trip per minute over the last hour, oldest first; null where every attempt was lost. */
	history: Array<number | null>;
	/** Since when the link has not answered at all; null while it answers. */
	downSince: string | null;
	test: NodeLinkTestView | null;
}

export interface LinkMapNodeView {
	id: string;
	name: string;
	zone: string;
	status: string;
	roles: string[];
	privateAddress: string | null;
	privateNetwork: string | null;
	lanEndpoint: string | null;
	/** The agent can sample and test links; false on an older agent or a node off the overlay. */
	capable: boolean;
}

export interface LinkMapView {
	generatedAt: string;
	nodes: LinkMapNodeView[];
	links: NodeLinkView[];
	/** Tests handed to nodes and not yet finished, and tests waiting for a busy node. */
	running: number;
	queued: number;
}

export const linkTestRequestSchema = z
	.object({
		/** Both omitted tests every pair once; one given tests that node against all the others. */
		from: z.string().trim().min(1).max(100).optional(),
		to: z.string().trim().min(1).max(100).optional(),
		seconds: z.number().int().min(1).max(linkTestLimits.maxSeconds).default(linkTestLimits.defaultSeconds),
		streams: z.number().int().min(1).max(linkTestLimits.maxStreams).default(linkTestLimits.defaultStreams),
	})
	.strict();
export type LinkTestRequest = z.infer<typeof linkTestRequestSchema>;

export interface LinkTestStartResult {
	/** Pairs queued, as `[from, to]` node ids. */
	queued: Array<[string, string]>;
	skipped: Array<{ from: string; to: string; reason: string }>;
}
