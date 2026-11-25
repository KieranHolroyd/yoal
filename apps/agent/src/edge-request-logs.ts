import { SEVERITY_NUMBER, type DesiredState, type NodeLogRecord } from '@yoal/contracts';
import { productionRouteFor } from './caddy-config.ts';
import { logsHmac, type NodeLogBatcher } from './log-records.ts';
import { headerValue, type AccessLogEntry } from './telemetry.ts';
import { normalizeHost } from './verify.ts';

/**
 * Edge request records (docs/LOGS.md §5 "Edge requests", LP6).
 *
 * The agent already tails Caddy's JSON access log for the 1-minute traffic aggregates. Every line
 * the aggregator has counted is also offered here, and becomes an `access` log record when:
 *
 * - the status is not 2xx/3xx (errors, client errors, aborted requests): always shipped; or
 * - it is 2xx/3xx and wins the site's sample (default 10%, decided 2026-11-25; `sampleRate` hook).
 *
 * Aggregates still see 100% of lines, so traffic charts stay exact; the sampled-out count rides
 * each batch as `dropped`. Records are batched per host to `POST /api/agent/log-records` with
 * `target: { kind: 'site', host }`; the control plane resolves the host to its project.
 *
 * What a record never carries: the query string (tokens live there), cookies, authorization, or
 * the client address. The address is an HMAC under a node-local secret and the UTC day, so a client
 * can be followed through one day's lines on one node and not beyond.
 */

/** Share of 2xx/3xx lines shipped when the route does not say (docs/LOGS.md §15, decision 3). */
export const DEFAULT_EDGE_SAMPLE_RATE = 0.1;

const MAX_PATH_CHARS = 2_048;
const MAX_REQUEST_ID_CHARS = 128;
const REQUEST_ID_SHAPE = /^[A-Za-z0-9._:\-]{1,128}$/;

/** `request_id` comes from the echoed response header first, then the request (a trusted proxy's). */
export function accessRequestId(entry: AccessLogEntry): string | null {
	const value = headerValue(entry.resp_headers, 'x-request-id') ?? headerValue(entry.request?.headers, 'x-request-id');
	const trimmed = value?.trim().slice(0, MAX_REQUEST_ID_CHARS);
	return trimmed && REQUEST_ID_SHAPE.test(trimmed) ? trimmed : null;
}

/** A cheap user-agent family for faceting; not a parser. Order matters (Edge says Chrome, Chrome says Safari). */
export function userAgentFamily(userAgent: string | null): string {
	const ua = userAgent?.trim() ?? '';
	if (!ua) return 'none';
	const lower = ua.toLowerCase();
	if (/bot|crawler|spider|slurp|bingpreview|facebookexternalhit|headless|lighthouse|monitor|uptime|pingdom/.test(lower)) return 'bot';
	if (lower.startsWith('curl/')) return 'curl';
	if (lower.startsWith('wget/')) return 'wget';
	if (/^(python-requests|python-urllib|aiohttp|httpx)/.test(lower)) return 'python';
	if (/^(go-http-client|okhttp|java\/|apache-httpclient|node-fetch|undici|axios|bun\/|deno\/)/.test(lower)) return 'library';
	if (lower.includes('edg/') || lower.includes('edge/')) return 'edge';
	if (lower.includes('opr/') || lower.includes('opera')) return 'opera';
	if (lower.includes('firefox/') || lower.includes('fxios/')) return 'firefox';
	if (lower.includes('chrome/') || lower.includes('crios/') || lower.includes('chromium/')) return 'chrome';
	if (lower.includes('safari/') && lower.includes('version/')) return 'safari';
	if (lower.startsWith('mozilla/')) return 'browser';
	return 'other';
}

/** Severity by status (docs/LOGS.md LP6): 5xx error, 4xx warn, anything else info. */
export function accessSeverityNumber(status: number): number {
	if (status >= 500) return SEVERITY_NUMBER.error;
	if (status >= 400) return SEVERITY_NUMBER.warn;
	return SEVERITY_NUMBER.info;
}

/** Only 2xx and 3xx lines are sampled; everything else (including status 0, an aborted request) ships. */
export function isSampledStatus(status: number): boolean {
	return status >= 200 && status < 400;
}

/**
 * The sampling decision. With a request id it is deterministic (a hash of the id against the
 * rate), so a replayed line and every node that sees the same request agree; without one it is a
 * plain random draw.
 */
export function shouldShipAccess(
	status: number,
	rate: number,
	requestId: string | null,
	random: () => number = Math.random,
): boolean {
	if (!isSampledStatus(status)) return true;
	const share = Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : DEFAULT_EDGE_SAMPLE_RATE;
	if (share >= 1) return true;
	if (share <= 0) return false;
	return (requestId ? fraction(requestId) : random()) < share;
}

/** FNV-1a over the id, mapped to [0, 1). Uniform enough for sampling and stable everywhere. */
function fraction(value: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash / 0x1_0000_0000;
}

export type ClientIpHasher = (ip: string, tsMs: number) => string;

/**
 * `client.ip_hash`: HMAC-SHA256 of the address under the node's logs secret and the UTC day,
 * truncated to 16 hex characters. The aggregator ships no addresses at all; this is the only form
 * an address takes off the node.
 */
export function createClientIpHasher(secret: Buffer): ClientIpHasher {
	return (ip, tsMs) => {
		const day = new Date(Number.isFinite(tsMs) ? tsMs : Date.now()).toISOString().slice(0, 10);
		return logsHmac(secret, `client-ip:${day}`, ip.trim().toLowerCase()).slice(0, 16);
	};
}

export interface AccessRecord {
	host: string;
	status: number;
	requestId: string | null;
	record: NodeLogRecord;
}

/**
 * Build the record for one access line. Returns null for a line without a host (Caddy always logs
 * one; anything else is not a request to a site). Pure: tested without a tail or a network.
 */
export function buildAccessRecord(
	entry: AccessLogEntry,
	options: { hashIp: ClientIpHasher; now?: () => number },
): AccessRecord | null {
	const request = entry.request;
	const host = normalizeHost(typeof request?.host === 'string' ? request.host : null);
	if (!host) return null;

	const now = options.now ?? Date.now;
	const tsSeconds = finiteNumber(entry.ts);
	const ts = tsSeconds !== null && tsSeconds > 0 ? Math.round(tsSeconds * 1000) : now();
	const status = Math.max(0, Math.trunc(finiteNumber(entry.status) ?? 0));
	const durationMs = Math.max(0, (finiteNumber(entry.duration) ?? 0) * 1000);
	const bytes = Math.max(0, Math.trunc(finiteNumber(entry.size) ?? 0));
	const method = typeof request?.method === 'string' && /^[A-Za-z]{1,16}$/.test(request.method) ? request.method.toUpperCase() : 'GET';
	const uri = typeof request?.uri === 'string' ? request.uri : '/';
	// Never the query string: tokens and personal data live there.
	const path = (uri.split('?')[0] || '/').slice(0, MAX_PATH_CHARS);
	const requestId = accessRequestId(entry);
	const userAgent = headerValue(request?.headers, 'user-agent');
	const clientIp =
		typeof request?.client_ip === 'string' && request.client_ip
			? request.client_ip
			: typeof request?.remote_ip === 'string'
				? request.remote_ip
				: null;

	const roundedMs = Math.round(durationMs);
	const attributes: Record<string, string> = {
		'http.method': method,
		'http.host': host,
		'http.path': path,
		// No route template is known at the edge; the path stands in, so `by @http.route` still groups.
		'http.route': path,
		'http.status': String(status),
		duration_ms: String(Math.round(durationMs * 100) / 100),
		bytes: String(bytes),
		'user_agent.family': userAgentFamily(userAgent),
	};
	if (typeof request?.proto === 'string' && request.proto.length <= 16) attributes['http.protocol'] = request.proto;
	if (clientIp) attributes['client.ip_hash'] = options.hashIp(clientIp, ts);
	if (requestId) attributes.request_id = requestId;

	const record: NodeLogRecord = {
		ts,
		source: 'access',
		severityNumber: accessSeverityNumber(status),
		body: `${method} ${path} ${status} ${roundedMs}ms`.slice(0, 16_384),
		attributes,
		resource: {},
		...(requestId ? { requestId } : {}),
	};
	return { host, status, requestId, record };
}

function finiteNumber(value: unknown): number | null {
	const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
	return Number.isFinite(number) ? number : null;
}

/**
 * Hosts this node serves for a project, with the route's 2xx/3xx sample rate when desired state
 * sets one (`accessLogSampleRate`). A verified custom domain serves its project's production route
 * (caddy-config.ts), so it takes that route's rate; redirect-only domains are not sites.
 */
export function accessLogHosts(state: DesiredState): Map<string, number | undefined> {
	const hosts = new Map<string, number | undefined>();
	for (const route of state.routes) hosts.set(normalizeHost(route.host), route.accessLogSampleRate);
	for (const domain of state.domains) {
		if (domain.redirectTo) continue;
		const host = normalizeHost(domain.host);
		if (!host || hosts.has(host)) continue;
		const production = productionRouteFor(state, domain.projectId);
		if (production) hosts.set(host, production.accessLogSampleRate);
	}
	return hosts;
}

export interface EdgeRequestLogsOptions {
	batcher: NodeLogBatcher;
	hashIp: ClientIpHasher;
	/** The kill switch (`YOAL_FEATURE_EDGE_REQUEST_LOGS`), read per line so a reload can flip it. */
	enabled?: () => boolean;
	/** Only hosts this node serves for a project are shipped; scanners hitting the catch-all are not. */
	knownHost?: (host: string) => boolean;
	/** The site's 2xx/3xx share (0–1); defaults to `DEFAULT_EDGE_SAMPLE_RATE`. */
	sampleRate?: (host: string) => number | undefined;
	random?: () => number;
	now?: () => number;
}

export interface EdgeRequestLogsStats {
	seen: number;
	shipped: number;
	sampledOut: number;
	skippedHosts: number;
}

/** The access-log listener: builds, samples and hands records to the batcher. Never throws. */
export class EdgeRequestLogs {
	private readonly options: EdgeRequestLogsOptions;
	private counters: EdgeRequestLogsStats = { seen: 0, shipped: 0, sampledOut: 0, skippedHosts: 0 };

	constructor(options: EdgeRequestLogsOptions) {
		this.options = options;
	}

	get stats(): EdgeRequestLogsStats {
		return { ...this.counters };
	}

	readonly consume = (entry: AccessLogEntry): void => {
		if (this.options.enabled && !this.options.enabled()) return;
		const built = buildAccessRecord(entry, {
			hashIp: this.options.hashIp,
			...(this.options.now ? { now: this.options.now } : {}),
		});
		if (!built) return;
		this.counters.seen += 1;
		if (this.options.knownHost && !this.options.knownHost(built.host)) {
			this.counters.skippedHosts += 1;
			return;
		}
		const target = { kind: 'site' as const, host: built.host };
		const rate = this.options.sampleRate?.(built.host) ?? DEFAULT_EDGE_SAMPLE_RATE;
		if (!shouldShipAccess(built.status, rate, built.requestId, this.options.random)) {
			this.counters.sampledOut += 1;
			this.options.batcher.noteDropped(target, 1);
			return;
		}
		this.counters.shipped += 1;
		this.options.batcher.add(target, built.record);
	};
}
