import {
	formatLogScope,
	type LogCapabilities,
	type LogContextInput,
	type LogContextResult,
	type LogFieldsInput,
	type LogFieldsResult,
	type LogHistogramInput,
	type LogHistogramResult,
	type LogReadInput,
	type LogSavedQuery,
	type LogSavedQueryInput,
	type LogScopeRef,
	type LogSearchInput,
	type LogSearchResult,
	type LogTableResult
} from '@yoal/contracts';
import { fetchJson, HttpError } from '#lib/query.js';

/**
 * The Logs Explorer's API client: every path the UI calls is here, so integration can move a
 * route in one place. Reads are POSTs with the contract input schemas as the JSON body
 * (`logSearchInputSchema`, `logHistogramInputSchema`…); the live tail is an `EventSource` over
 * GET with repeated `scope=kind:id`. All calls ride the session cookie (same-origin, so the
 * `Origin` header satisfies the CSRF check).
 */
export const LOGS_API = {
	base: '/api/v1/logs',
	search: '/api/v1/logs/search',
	table: '/api/v1/logs/table',
	histogram: '/api/v1/logs/histogram',
	fields: '/api/v1/logs/fields',
	context: '/api/v1/logs/context',
	capabilities: '/api/v1/logs/capabilities',
	stream: '/api/v1/logs/stream',
	saved: '/api/v1/logs/saved'
} as const;

/** Query keys, so pages can invalidate the explorer's caches. */
export const logKeys = {
	all: ['logs'] as const,
	capabilities: ['logs', 'capabilities'] as const,
	saved: ['logs', 'saved'] as const,
	histogram: (input: unknown) => ['logs', 'histogram', input] as const,
	fields: (input: unknown) => ['logs', 'fields', input] as const,
	table: (input: unknown) => ['logs', 'table', input] as const,
	context: (id: string, before: number, after: number) =>
		['logs', 'context', id, before, after] as const
};

const post = (body: unknown): RequestInit => ({
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body)
});

/** Request bodies omit empty fields so the server's schema defaults apply. */
function readBody<T extends Partial<LogReadInput>>(input: T): T {
	const body = { ...input };
	if (body.from === undefined) delete body.from;
	if (body.to === undefined) delete body.to;
	return body;
}

export function getCapabilities(signal?: AbortSignal): Promise<LogCapabilities> {
	return fetchJson(LOGS_API.capabilities, { signal, fallback: 'Could not read log capabilities' });
}

export function searchLogs(
	input: Partial<LogSearchInput>,
	signal?: AbortSignal
): Promise<LogSearchResult> {
	return fetchJson(LOGS_API.search, {
		...post(readBody(input)),
		signal,
		fallback: 'The log search failed'
	});
}

export function tableLogs(
	input: Partial<LogReadInput>,
	signal?: AbortSignal
): Promise<LogTableResult> {
	return fetchJson(LOGS_API.table, {
		...post(readBody(input)),
		signal,
		fallback: 'The log query failed'
	});
}

export function histogramLogs(
	input: Partial<LogHistogramInput>,
	signal?: AbortSignal
): Promise<LogHistogramResult> {
	return fetchJson(LOGS_API.histogram, {
		...post(readBody(input)),
		signal,
		fallback: 'Could not draw the histogram'
	});
}

export function fieldsLogs(
	input: Partial<LogFieldsInput>,
	signal?: AbortSignal
): Promise<LogFieldsResult> {
	return fetchJson(LOGS_API.fields, {
		...post(readBody(input)),
		signal,
		fallback: 'Could not read fields'
	});
}

export function contextLogs(
	input: Partial<LogContextInput> & { id: string },
	signal?: AbortSignal
): Promise<LogContextResult> {
	return fetchJson(LOGS_API.context, {
		...post(input),
		signal,
		fallback: 'Could not read the surrounding lines'
	});
}

/** `GET /saved` answers `{ queries }` (personal ones plus the org's shared ones). */
export async function listSavedQueries(signal?: AbortSignal): Promise<LogSavedQuery[]> {
	const body = await fetchJson<{ queries?: unknown }>(LOGS_API.saved, {
		signal,
		fallback: 'Could not load saved queries'
	});
	return Array.isArray(body?.queries) ? (body.queries as LogSavedQuery[]) : [];
}

/** Single-query routes (POST, PATCH, GET by id) answer `{ query }`. */
function unwrapSaved(body: { query: LogSavedQuery }): LogSavedQuery {
	return body.query;
}

export async function createSavedQuery(input: LogSavedQueryInput): Promise<LogSavedQuery> {
	return unwrapSaved(
		await fetchJson<{ query: LogSavedQuery }>(LOGS_API.saved, {
			...post(input),
			fallback: 'Could not save the query'
		})
	);
}

export async function updateSavedQuery(
	id: string,
	patch: Partial<LogSavedQueryInput>
): Promise<LogSavedQuery> {
	return unwrapSaved(
		await fetchJson<{ query: LogSavedQuery }>(`${LOGS_API.saved}/${encodeURIComponent(id)}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(patch),
			fallback: 'Could not update the saved query'
		})
	);
}

/** DELETE answers `{ ok: true }`; a bodiless 204 is accepted too, so it skips `fetchJson`. */
export async function deleteSavedQuery(id: string): Promise<void> {
	const response = await fetch(`${LOGS_API.saved}/${encodeURIComponent(id)}`, {
		method: 'DELETE',
		headers: { accept: 'application/json' }
	});
	if (response.ok) return;
	let message = `Could not delete the saved query (${response.status}).`;
	try {
		const body = (await response.json()) as { message?: unknown };
		if (typeof body?.message === 'string' && body.message) message = body.message;
	} catch {
		// Not JSON; keep the status message.
	}
	throw new HttpError(response.status, message);
}

/**
 * The live tail URL. `cursor` is a tail cursor (`t.…`, a manual reconnect) or the newest search
 * page's `newer` cursor (the server catches up from that page's time). An `EventSource` that drops
 * and retries by itself sends the last event id as `Last-Event-ID`, which the server prefers.
 */
export function streamUrl(input: {
	scopes: readonly LogScopeRef[];
	q: string;
	cursor?: string | null;
}): string {
	const params = new URLSearchParams();
	for (const scope of input.scopes) params.append('scope', formatLogScope(scope));
	if (input.q.trim()) params.set('q', input.q);
	if (input.cursor) params.set('cursor', input.cursor);
	const query = params.toString();
	return query ? `${LOGS_API.stream}?${query}` : LOGS_API.stream;
}

/** The GET form of a read, for share links and the CLI hint (`scope` repeated). */
export function searchUrl(input: {
	scopes: readonly LogScopeRef[];
	q: string;
	from?: number;
	to?: number;
}): string {
	const params = new URLSearchParams();
	for (const scope of input.scopes) params.append('scope', formatLogScope(scope));
	if (input.q.trim()) params.set('q', input.q);
	if (input.from !== undefined) params.set('from', String(input.from));
	if (input.to !== undefined) params.set('to', String(input.to));
	return `${LOGS_API.search}?${params.toString()}`;
}
