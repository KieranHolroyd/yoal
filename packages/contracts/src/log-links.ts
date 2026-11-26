import { formatLogScope, type LogScopeRef } from './log-record.ts';
import { formatLogQueryValue } from './log-query.ts';

/**
 * Links into the Logs Explorer (docs/LOGS.md §9.3 pivots, §7.2 URL state). Every surface that
 * points at logs (alert notifications, the traffic chart, app error events, alert instances, the
 * deployment and node pages) builds its link here, so the query string always matches what
 * `/logs` decodes (`apps/control-plane/src/lib/logs/url-state.ts`): `q`, repeated `scope`,
 * `range` or `from`/`to` (ISO, or `to=now`), `mode`, and Compare's `baseline`.
 *
 * Pure and dependency-free, so the core (absolute links in notifications) and the dashboard
 * (relative links) share it.
 */

export const LOG_EXPLORER_PATH = '/logs';

/** Compare baselines (Lane A's URL contract): `previous`, `offset:<ms>`, `deploy:<id>`, `range:<from>-<to>`. */
export type LogExplorerBaseline =
	| { kind: 'previous' }
	| { kind: 'offset'; offsetMs: number }
	| { kind: 'deploy'; deploymentId: string }
	| { kind: 'range'; from: number; to: number };

export interface LogExplorerLink {
	q?: string;
	scopes?: readonly LogScopeRef[];
	/** A relative window (`15m`, `1h`, `24h`); ignored when `from` is set. */
	range?: string;
	/** Absolute window, epoch ms. A null `to` reads "until now" (the Explorer can tail it). */
	from?: number;
	to?: number | null;
	mode?: 'stream' | 'patterns' | 'analytics' | 'compare';
	baseline?: LogExplorerBaseline;
	/** Open this record's flyout. */
	row?: string;
}

export function formatLogBaseline(baseline: LogExplorerBaseline): string {
	switch (baseline.kind) {
		case 'previous':
			return 'previous';
		case 'offset':
			return `offset:${Math.round(baseline.offsetMs)}`;
		case 'deploy':
			return `deploy:${baseline.deploymentId}`;
		case 'range':
			return `range:${Math.round(baseline.from)}-${Math.round(baseline.to)}`;
	}
}

/** The query string (no `?`) for an Explorer link. */
export function logExplorerParams(link: LogExplorerLink): URLSearchParams {
	const params = new URLSearchParams();
	const q = link.q?.trim() ?? '';
	if (q) params.set('q', q);
	const seen = new Set<string>();
	for (const scope of link.scopes ?? []) {
		const text = formatLogScope(scope);
		if (seen.has(text)) continue;
		seen.add(text);
		params.append('scope', text);
	}
	if (link.from !== undefined && Number.isFinite(link.from)) {
		params.set('from', new Date(link.from).toISOString());
		params.set('to', link.to === null || link.to === undefined ? 'now' : new Date(link.to).toISOString());
	} else if (link.range) params.set('range', link.range);
	if (link.mode && link.mode !== 'stream') params.set('mode', link.mode);
	if (link.baseline) params.set('baseline', formatLogBaseline(link.baseline));
	if (link.row) params.set('row', link.row);
	return params;
}

/** `/logs?q=…&scope=…` (or absolute, with `origin`). */
export function logExplorerHref(link: LogExplorerLink, origin = ''): string {
	const query = logExplorerParams(link).toString();
	const base = `${origin.replace(/\/$/, '')}${LOG_EXPLORER_PATH}`;
	return query ? `${base}?${query}` : base;
}

/** `a b` and `(x OR y)` joined so neither side's OR leaks into the other. */
export function andLogQueries(...parts: Array<string | null | undefined>): string {
	const kept = parts.map((part) => part?.trim() ?? '').filter(Boolean);
	if (kept.length <= 1) return kept[0] ?? '';
	return kept.map((part) => (/\bOR\b/.test(part) && !/^\(.*\)$/.test(part) ? `(${part})` : part)).join(' ');
}

// --- pivots (§9.3) ------------------------------------------------------------------------------

const MINUTE = 60_000;

/** Traffic chart 5xx → the edge access lines that were server errors, over the chart's window. */
export function trafficErrorsLogLink(input: { scopes?: readonly LogScopeRef[]; from: number; to: number }): LogExplorerLink {
	return { q: 'source:access @http.status:>=500', scopes: input.scopes ?? [], from: input.from, to: input.to };
}

/**
 * App error event → the same project's lines ±60 s around it; with a request id, that request's
 * lines across edge and app instead (`request:<id>`).
 */
export function appErrorLogLink(input: { projectId: string; at: number; requestId?: string | null }): LogExplorerLink {
	const requestId = input.requestId?.trim();
	return {
		q: requestId ? `request:${formatLogQueryValue(requestId)}` : '',
		scopes: [{ kind: 'project', id: input.projectId }],
		from: input.at - MINUTE,
		to: input.at + MINUTE,
	};
}

/** A deployment's own lines, from when it was created until it was replaced (or now). */
export function deploymentLogLink(input: { projectId: string; deploymentId: string; from: number; to?: number | null }): LogExplorerLink {
	return {
		q: `deployment:${formatLogQueryValue(input.deploymentId)}`,
		scopes: [{ kind: 'project', id: input.projectId }],
		from: input.from,
		to: input.to ?? null,
	};
}

/**
 * "What did this deploy change in my logs?" (§8.2): Compare, baseline = the same length before the
 * deploy went live. The current window starts at the go-live time and runs for an hour (or to now).
 */
export function deploymentCompareLogLink(input: { projectId: string; deploymentId: string; liveAt: number; now: number }): LogExplorerLink {
	const end = input.liveAt + 60 * MINUTE;
	return {
		scopes: [{ kind: 'project', id: input.projectId }],
		from: input.liveAt,
		to: end >= input.now ? null : end,
		mode: 'compare',
		baseline: { kind: 'deploy', deploymentId: input.deploymentId },
	};
}

/** A node's own services (agent, helper, Caddy…): the `platform` scope, platform admins only. */
export function nodeLogLink(input: { nodeId: string; range?: string }): LogExplorerLink {
	return { scopes: [{ kind: 'platform', id: input.nodeId }], range: input.range ?? '1h' };
}
