import { parseLogScope, resolveLogTimeRange, type LogScopeRef } from '@yoal/contracts';
import { CoreError, ValidationError } from '@yoal/core';

/**
 * Request decoding for `/api/v1/logs/*` (docs/LOGS.md §6, LOGS-WAVES lane S). GET reads the query
 * string (`scope` repeated as `kind:id`), POST a JSON body with the contract's shape. Both accept
 * `range` (`15m`, `24h`, `7d`) as a shorthand for `from`/`to`. The service validates the result
 * with the contract schemas, so this only reshapes; it never decides tenancy.
 */

export type LogRequestKind = 'read' | 'search' | 'histogram' | 'fields' | 'context';

const RELATIVE = /^\d{1,4}(s|m|h|d|w)$/;

/** A number, or the original text so the schema rejects it with a 422 instead of a silent NaN. */
function numeric(value: string | null): number | string | undefined {
	if (value === null || value.trim() === '') return undefined;
	const number = Number(value);
	return Number.isFinite(number) ? number : value;
}

/** Epoch ms, or an ISO 8601 time. */
function time(value: string | null): number | string | undefined {
	if (value === null || value.trim() === '') return undefined;
	const number = Number(value);
	if (Number.isFinite(number)) return number;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : value;
}

function scopesFrom(values: readonly unknown[]): LogScopeRef[] {
	return values.map((value, index) => {
		if (value && typeof value === 'object') return value as LogScopeRef;
		const scope = typeof value === 'string' ? parseLogScope(value.trim()) : null;
		if (!scope)
			throw new ValidationError('Invalid scope; use kind:id, e.g. project:prj_123.', [
				{ path: ['scopes', index], message: `"${String(value)}" is not kind:id` },
			]);
		return scope;
	});
}

function applyRange(input: Record<string, unknown>, range: unknown, now: number): void {
	if (range === undefined || range === null || range === '') return;
	const relative = typeof range === 'string' ? range : (range as { relative?: unknown }).relative;
	if (typeof relative !== 'string' || !RELATIVE.test(relative))
		throw new ValidationError('Invalid range; use e.g. 15m, 1h, 24h or 7d.', [{ path: ['range'], message: 'not a relative range' }]);
	if (input.from !== undefined || input.to !== undefined) return;
	const bounds = resolveLogTimeRange({ relative }, now);
	input.from = bounds.from;
	input.to = bounds.to;
}

/** Query string → service input. */
export function logInputFromQuery(params: URLSearchParams, kind: LogRequestKind, now: number): Record<string, unknown> {
	if (kind === 'context') {
		const input: Record<string, unknown> = { id: params.get('id') ?? '' };
		const before = numeric(params.get('before'));
		const after = numeric(params.get('after'));
		if (before !== undefined) input.before = before;
		if (after !== undefined) input.after = after;
		return input;
	}
	const input: Record<string, unknown> = {
		q: params.get('q') ?? '',
		scopes: scopesFrom(params.getAll('scope').filter((value) => value.trim() !== '')),
	};
	const from = time(params.get('from'));
	const to = time(params.get('to'));
	if (from !== undefined) input.from = from;
	if (to !== undefined) input.to = to;
	applyRange(input, params.get('range'), now);
	if (kind === 'search') {
		const limit = numeric(params.get('limit'));
		if (limit !== undefined) input.limit = limit;
		const cursor = params.get('cursor');
		if (cursor) input.cursor = cursor;
		const order = params.get('order');
		if (order) input.order = order;
	}
	if (kind === 'histogram') {
		const buckets = numeric(params.get('buckets'));
		if (buckets !== undefined) input.buckets = buckets;
	}
	if (kind === 'fields') {
		const fields = params.getAll('field').filter((value) => value.trim() !== '');
		if (fields.length > 0) input.fields = fields;
		const topValues = numeric(params.get('topValues'));
		if (topValues !== undefined) input.topValues = topValues;
	}
	return input;
}

/** JSON body → service input (scopes may also be `kind:id` strings; `range` resolves to bounds). */
export function logInputFromBody(body: unknown, kind: LogRequestKind, now: number): Record<string, unknown> {
	if (!body || typeof body !== 'object' || Array.isArray(body))
		throw new ValidationError('The request body must be a JSON object.');
	const input: Record<string, unknown> = { ...(body as Record<string, unknown>) };
	if (kind === 'context') return input;
	if (Array.isArray(input.scopes)) input.scopes = scopesFrom(input.scopes);
	const range = input.range;
	delete input.range;
	applyRange(input, range, now);
	return input;
}

/** A JSON body, or a 400 for anything that does not parse. */
export async function readBody(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new CoreError('invalid_json', 'Request body must be valid JSON', 400);
	}
}

/** GET → query string; POST → JSON body. */
export async function logInput(request: Request, url: URL, kind: LogRequestKind, now = Date.now()): Promise<Record<string, unknown>> {
	if (request.method === 'GET' || request.method === 'HEAD') return logInputFromQuery(url.searchParams, kind, now);
	return logInputFromBody(await readBody(request), kind, now);
}
