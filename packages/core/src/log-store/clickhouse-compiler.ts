import {
	LOG_QUERY_LIMITS,
	SEVERITY_NUMBER,
	builtinLogFields,
	platformLogScopeKinds,
	severityForNumber,
	severityForText,
	type BuiltinLogField,
	type LogAggregation,
	type LogFieldRef,
	type LogGroupBy,
	type LogQueryNode,
	type LogScopeKind,
} from '@yoal/contracts';
import type { ClickHouseParams } from '../clickhouse.ts';
import { ValidationError } from '../errors.ts';
import type { LogTextIndexKind } from '../telemetry.ts';
import type { LogReadBoundary, LogStoreRead } from './types.ts';

/**
 * Log query AST → parameterised ClickHouse SQL over `yoal.logs` (docs/LOGS.md §6.3, LP3). Pure: no
 * I/O, so every statement it emits is snapshot-tested without a server.
 *
 * Rules every statement follows:
 * - **Tenancy first.** `org_id` and the boundary's `(scope_kind, scope_id)` pairs are ANDed into
 *   every WHERE, including the joined `log_patterns` read. An empty boundary compiles to `0`.
 * - **No user text in SQL.** Values, attribute keys and regexes are ClickHouse query parameters
 *   (`{p0:String}`); only catalogue column names and generated aliases reach the SQL text.
 * - **Aliases never shadow columns.** Reads run with `prefer_column_name_to_alias = 1` (D101), so
 *   computed columns are `c0, c1, …` and the display names travel separately.
 *
 * Semantics (shared with the SQLite compiler and the JS predicate, §6.1):
 * - A bare alphanumeric word is a case-insensitive token match when the body has an index
 *   (`hasToken`); phrases and other text are case-insensitive substrings (`ILIKE`, which the `text`
 *   index also serves, or `positionCaseInsensitive`).
 * - `level:x` compares by severity band; `level:=x` (op `eq`) is exactly that band.
 * - A missing field never matches, and therefore always matches under NOT: numeric compares are
 *   `ifNull(…, 0)` and wildcard/regex check presence first.
 */

export const LOGS_TABLE = 'logs';
export const LOG_PATTERNS_TABLE = 'log_patterns';

/** How a bare single-word search is matched (see the module comment). */
export type BareWordMatch = 'token' | 'substring';

export interface ClickHouseCompileOptions {
	/** The body index `yoal.logs` has (from `TelemetryStore.logsTextIndex`). */
	textIndex: LogTextIndexKind | null;
	/** Default `token` (§6.1: "token match; case-insensitive"). */
	bareWordMatch?: BareWordMatch;
}

export interface CompiledLogQuery {
	sql: string;
	params: ClickHouseParams;
}

export type LogColumnType = 'string' | 'number' | 'time';

export interface CompiledLogTableQuery extends CompiledLogQuery {
	/** Display columns, in SELECT order (the hidden sample-id column is not listed). */
	columns: Array<{ name: string; type: LogColumnType }>;
	/** Set for `| patterns`: the SELECT position of the hidden sample record id. */
	sampleIdColumn: number | null;
	/** Set for `| patterns`: the SELECT position of the hidden per-bucket counts (sparkline). */
	sparklineColumn?: number | null;
}

/** Buckets in every `| patterns` sparkline (§8.1). */
export const PATTERN_SPARKLINE_BUCKETS = 24;

/** Regexes are RE2 on the server; longer ones are refused before they get there. */
export const MAX_REGEX_LENGTH = 512;
/** Rows a table query without `| limit` returns: rows for row stages, groups after `| stats`. */
export const DEFAULT_TABLE_ROWS = 1_000;
export const DEFAULT_GROUP_ROWS = LOG_QUERY_LIMITS.maxLimit;

/** Query parameters with generated names. Strings are pre-escaped for the HTTP `param_` format. */
export class SqlParams {
	readonly values: ClickHouseParams = {};
	#next = 0;

	string(value: string): string {
		return this.#add(escapeParamString(value), 'String');
	}

	int(value: number): string {
		return this.#add(Math.trunc(value), 'Int64');
	}

	float(value: number): string {
		return this.#add(value, 'Float64');
	}

	strings(values: readonly string[]): string {
		return this.#add([...values], 'Array(String)');
	}

	#add(value: ClickHouseParams[string], type: string): string {
		const name = `p${this.#next++}`;
		this.values[name] = value;
		return `{${name}:${type}}`;
	}
}

/**
 * The HTTP interface parses `param_*` values in the escaped text format, so a literal backslash,
 * tab or newline must be escaped or the server rejects (or rewrites) the value.
 */
export function escapeParamString(value: string): string {
	return value.replace(/[\\\t\n\r\0]/g, (char) =>
		char === '\\' ? '\\\\' : char === '\t' ? '\\t' : char === '\n' ? '\\n' : char === '\r' ? '\\r' : '\\0',
	);
}

/** `*` and `?` globs → an `ILIKE` pattern, with LIKE metacharacters escaped. */
export function globToLike(glob: string): string {
	let out = '';
	for (const char of glob) {
		if (char === '*') out += '%';
		else if (char === '?') out += '_';
		else if (char === '%' || char === '_' || char === '\\') out += `\\${char}`;
		else out += char;
	}
	return out;
}

/** A literal substring as an `ILIKE` pattern (`*` and `?` are not wildcards in body text). */
function likeContains(text: string): string {
	return `%${text.replace(/[%_\\]/g, (char) => `\\${char}`)}%`;
}

// --------------------------------------------------------------------------------- tenancy

/**
 * The boundary as SQL. Scopes are grouped by kind so the primary key `(org_id, scope_kind,
 * scope_id, ts)` prunes. Platform and edge scopes drop the org condition only for a cross-org
 * (platform admin) read; every other kind keeps it.
 */
export function boundarySql(boundary: LogReadBoundary, params: SqlParams, alias = ''): string {
	if (boundary.scopes.length === 0) return '0';
	const col = (name: string) => (alias ? `${alias}.${name}` : name);
	const byKind = new Map<LogScopeKind, Set<string>>();
	for (const scope of boundary.scopes) {
		const ids = byKind.get(scope.kind) ?? new Set<string>();
		ids.add(scope.id);
		byKind.set(scope.kind, ids);
	}
	const acrossOrgs = (kind: LogScopeKind) => boundary.crossOrg && (platformLogScopeKinds.includes(kind) || kind === 'edge');
	const kinds = [...byKind.keys()];
	const part = (kind: LogScopeKind) =>
		`(${col('scope_kind')} = ${params.string(kind)} AND ${col('scope_id')} IN ${params.strings([...byKind.get(kind)!])})`;
	const clauses: string[] = [];
	const tenantKinds = kinds.filter((kind) => !acrossOrgs(kind));
	if (tenantKinds.length) {
		const org = params.string(boundary.orgId);
		clauses.push(`(${col('org_id')} = ${org} AND (${tenantKinds.map(part).join(' OR ')}))`);
	}
	const crossKinds = kinds.filter(acrossOrgs);
	if (crossKinds.length) clauses.push(`(${crossKinds.map(part).join(' OR ')})`);
	return clauses.length === 1 ? clauses[0]! : `(${clauses.join(' OR ')})`;
}

export function timeSql(from: number, to: number, params: SqlParams): string {
	return `ts >= fromUnixTimestamp64Milli(${params.int(from)}, 'UTC') AND ts <= fromUnixTimestamp64Milli(${params.int(to)}, 'UTC')`;
}

/** Tenancy, time range and the query's filter: the WHERE every read of `logs` starts from. */
export function readWhere(read: LogStoreRead, params: SqlParams, options: ClickHouseCompileOptions): string {
	const parts = [boundarySql(read.boundary, params), timeSql(read.from, read.to, params)];
	if (read.ast.filter) parts.push(`(${filterSql(read.ast.filter, params, options)})`);
	return parts.join(' AND ');
}

// ---------------------------------------------------------------------------------- fields

type Normalize = 'none' | 'lower-value' | 'lower-both';

interface FieldSql {
	expr: string;
	/** True when the record carries the field. */
	present: string;
	kind: 'string' | 'number' | 'severity';
	normalize: Normalize;
	/** Numeric view for aggregations (`sum`, `avg`, quantiles). */
	numeric: string;
	/** Display/group expression (severity shows its band name). */
	display: string;
	type: LogColumnType;
}

const BUILTIN_COLUMNS: Record<Exclude<BuiltinLogField, 'level' | 'replica'>, { expr: string; normalize: Normalize }> = {
	body: { expr: 'body', normalize: 'lower-both' },
	service: { expr: "resource['service.name']", normalize: 'lower-both' },
	scope: { expr: "concat(scope_kind, ':', scope_id)", normalize: 'none' },
	kind: { expr: 'scope_kind', normalize: 'lower-value' },
	project: { expr: 'project_id', normalize: 'none' },
	deployment: { expr: 'deployment_id', normalize: 'none' },
	build: { expr: 'build_id', normalize: 'none' },
	job: { expr: 'job_run_id', normalize: 'none' },
	node: { expr: 'node_id', normalize: 'none' },
	source: { expr: 'source', normalize: 'lower-value' },
	stream: { expr: 'stream', normalize: 'none' },
	channel: { expr: 'channel', normalize: 'lower-value' },
	pattern: { expr: 'pattern_id', normalize: 'lower-value' },
	trace: { expr: 'trace_id', normalize: 'lower-value' },
	span: { expr: 'span_id', normalize: 'lower-value' },
	request: { expr: 'request_id', normalize: 'none' },
};

function stringField(expr: string, present: string, normalize: Normalize): FieldSql {
	return { expr, present, kind: 'string', normalize, numeric: `toFloat64OrNull(${expr})`, display: expr, type: 'string' };
}

export function fieldSql(ref: LogFieldRef, params: SqlParams): FieldSql {
	if (ref.kind === 'attribute' || ref.kind === 'resource') {
		const map = ref.kind === 'attribute' ? 'attributes' : 'resource';
		const key = params.string(ref.key);
		return stringField(`${map}[${key}]`, `mapContains(${map}, ${key})`, 'lower-both');
	}
	if (ref.name === 'level')
		return {
			expr: 'severity_number',
			present: '1',
			kind: 'severity',
			normalize: 'none',
			numeric: 'toFloat64(severity_number)',
			display: 'severity_text',
			type: 'string',
		};
	if (ref.name === 'replica')
		return {
			expr: 'replica',
			present: 'replica >= 0',
			kind: 'number',
			normalize: 'none',
			numeric: 'if(replica >= 0, toFloat64(replica), NULL)',
			display: 'replica',
			type: 'number',
		};
	const column = BUILTIN_COLUMNS[ref.name];
	if (!column) throw new ValidationError(`Unknown field "${String(ref.name)}"`);
	return stringField(column.expr, `${column.expr} != ''`, column.normalize);
}

/**
 * A field name as written in `| fields`, `| sort` and `| stats … by`: a built-in, `@attr.key`,
 * `resource.key` / `@resource.key`, or `ts`/`id`. Case-insensitive for built-ins; `message` is `body`.
 */
export type NamedField = { kind: 'ts' } | { kind: 'id' } | { kind: 'ref'; ref: LogFieldRef };

export function parseFieldName(name: string): NamedField | null {
	const trimmed = name.trim();
	if (!trimmed) return null;
	const lower = trimmed.toLowerCase();
	if (lower === 'ts' || lower === 'timestamp' || lower === 'time') return { kind: 'ts' };
	if (lower === 'id') return { kind: 'id' };
	if (lower.startsWith('@resource.') && trimmed.length > 10) return { kind: 'ref', ref: { kind: 'resource', key: trimmed.slice(10) } };
	if (lower.startsWith('resource.') && trimmed.length > 9) return { kind: 'ref', ref: { kind: 'resource', key: trimmed.slice(9) } };
	if (trimmed.startsWith('@') && trimmed.length > 1) return { kind: 'ref', ref: { kind: 'attribute', key: trimmed.slice(1) } };
	const builtin = lower === 'message' ? 'body' : lower === 'severity' ? 'level' : lower;
	if (builtin in builtinLogFields) return { kind: 'ref', ref: { kind: 'builtin', name: builtin as BuiltinLogField } };
	return null;
}

/** The display name of a field reference, as a query writes it. */
export function fieldRefName(ref: LogFieldRef): string {
	if (ref.kind === 'builtin') return ref.name;
	return ref.kind === 'attribute' ? `@${ref.key}` : `resource.${ref.key}`;
}

function namedFieldSql(field: NamedField, params: SqlParams): { expr: string; display: string; type: LogColumnType; numeric: string } {
	if (field.kind === 'ts') return { expr: 'ts', display: 'toUnixTimestamp64Milli(ts)', type: 'time', numeric: 'toFloat64(toUnixTimestamp64Milli(ts))' };
	if (field.kind === 'id') return { expr: 'id', display: 'id', type: 'string', numeric: 'toFloat64OrNull(id)' };
	const sql = fieldSql(field.ref, params);
	return { expr: sql.kind === 'severity' ? 'severity_number' : sql.expr, display: sql.display, type: sql.type, numeric: sql.numeric };
}

function requireNamedField(name: string): NamedField {
	const field = parseFieldName(name);
	if (!field) throw new ValidationError(`Unknown field "${name}"`);
	return field;
}

// --------------------------------------------------------------------------------- filters

export function filterSql(node: LogQueryNode, params: SqlParams, options: ClickHouseCompileOptions): string {
	switch (node.type) {
		case 'and':
			return node.children.length ? node.children.map((child) => `(${filterSql(child, params, options)})`).join(' AND ') : '1';
		case 'or':
			return node.children.length ? node.children.map((child) => `(${filterSql(child, params, options)})`).join(' OR ') : '0';
		case 'not':
			return `NOT (${filterSql(node.child, params, options)})`;
		case 'text':
			return textSql(node.value, node.phrase, params, options);
		case 'exists':
			return fieldSql(node.field, params).present;
		case 'field':
			return fieldNodeSql(node.field, node.op, node.value, params);
	}
}

const ASCII_WORD = /^[A-Za-z0-9]+$/;

/**
 * Body search. A bare word with an index is a token match; anything else is a case-insensitive
 * substring. With a `tokenbf_v1` index, the whole words strictly inside a phrase are a cheap
 * pre-filter the bloom filter can answer.
 */
export function textSql(value: string, phrase: boolean, params: SqlParams, options: ClickHouseCompileOptions): string {
	if (!value) return '1';
	const bare = !phrase && ASCII_WORD.test(value);
	if (bare && (options.bareWordMatch ?? 'token') === 'token' && options.textIndex) {
		const token = params.string(value.toLowerCase());
		// `text` has a lower() preprocessor, so hasToken is case-insensitive and index-backed;
		// the tokenbf index is over lower(body), which hasTokenCaseInsensitive uses.
		return options.textIndex === 'text' ? `hasToken(body, ${token})` : `hasTokenCaseInsensitive(body, ${token})`;
	}
	if (options.textIndex === 'text') return `body ILIKE ${params.string(likeContains(value))}`;
	const substring = `positionCaseInsensitive(body, ${params.string(value)}) > 0`;
	if (options.textIndex !== 'tokenbf') return substring;
	const inner = innerTokens(value);
	if (!inner.length) return substring;
	return `${inner.map((token) => `hasTokenCaseInsensitive(body, ${params.string(token)})`).join(' AND ')} AND ${substring}`;
}

/** Tokens bounded by separators on both sides inside the text (so they are whole tokens in any match). */
export function innerTokens(text: string): string[] {
	const tokens: string[] = [];
	const re = /[A-Za-z0-9]+/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text))) {
		const start = match.index;
		const end = start + match[0].length;
		if (start === 0 || end === text.length) continue;
		tokens.push(match[0].toLowerCase());
	}
	return [...new Set(tokens)].slice(0, 8);
}

function severityValue(value: string | number): number {
	if (typeof value === 'number') {
		if (Number.isInteger(value) && value >= 1 && value <= 24) return value;
		throw new ValidationError(`Unknown level ${value}`);
	}
	const trimmed = value.trim();
	if (/^\d{1,2}$/.test(trimmed)) return severityValue(Number(trimmed));
	const band = severityForText(trimmed);
	if (!band) throw new ValidationError(`Unknown level "${value}" (use trace, debug, info, warn, error or fatal)`);
	return SEVERITY_NUMBER[band];
}

/** [lowest number of the band, lowest number of the next band). */
function severityBand(n: number): [number, number] {
	const low = SEVERITY_NUMBER[severityForNumber(n)];
	const high = low === SEVERITY_NUMBER.fatal ? 25 : low === SEVERITY_NUMBER.trace ? SEVERITY_NUMBER.debug : low + 4;
	return [low, high];
}

function numberValue(value: string | number): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	const trimmed = value.trim();
	if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return null;
	const n = Number(trimmed);
	return Number.isFinite(n) ? n : null;
}

const COMPARE: Record<'gt' | 'gte' | 'lt' | 'lte', string> = { gt: '>', gte: '>=', lt: '<', lte: '<=' };

function regexParam(value: string, params: SqlParams): string | null {
	if (value.length > MAX_REGEX_LENGTH) throw new ValidationError(`Regular expressions are limited to ${MAX_REGEX_LENGTH} characters`);
	try {
		new RegExp(value);
	} catch {
		// Same as the JS predicate: an invalid regex never matches.
		return null;
	}
	return params.string(value);
}

export function fieldNodeSql(ref: LogFieldRef, op: 'eq' | 'wildcard' | 'regex' | 'gt' | 'gte' | 'lt' | 'lte', value: string | number, params: SqlParams): string {
	const field = fieldSql(ref, params);
	const text = String(value);

	if (op === 'wildcard') {
		if (field.kind === 'number') return `(${field.present} AND toString(${field.expr}) LIKE ${params.string(globToLike(text))})`;
		const expr = field.kind === 'severity' ? 'severity_text' : field.expr;
		return `(${field.present} AND ${expr} ILIKE ${params.string(globToLike(text))})`;
	}
	if (op === 'regex') {
		const pattern = regexParam(text, params);
		if (!pattern) return '0';
		const expr = field.kind === 'severity' ? 'severity_text' : field.kind === 'number' ? `toString(${field.expr})` : field.expr;
		return `(${field.present} AND match(${expr}, ${pattern}))`;
	}

	if (field.kind === 'severity') {
		const [low, high] = severityBand(severityValue(value));
		if (op === 'eq') return `(severity_number >= ${params.int(low)} AND severity_number < ${params.int(high)})`;
		if (op === 'gte') return `severity_number >= ${params.int(low)}`;
		if (op === 'gt') return `severity_number >= ${params.int(high)}`;
		if (op === 'lt') return `severity_number < ${params.int(low)}`;
		return `severity_number < ${params.int(high)}`;
	}

	if (field.kind === 'number') {
		const n = numberValue(value);
		if (n === null) return '0';
		if (op === 'eq') return `${field.expr} = ${params.float(n)}`;
		return `(${field.present} AND ${field.expr} ${COMPARE[op]} ${params.float(n)})`;
	}

	if (op === 'eq') {
		if (ref.kind === 'builtin') {
			if (ref.name === 'project') {
				// A project id, or the slug of a project (or function) scope.
				return `(project_id = ${params.string(text)} OR (scope_kind IN ('project', 'function') AND lower(resource['service.name']) = ${params.string(text.toLowerCase())}))`;
			}
			if (ref.name === 'node')
				return `(node_id = ${params.string(text)} OR lower(resource['host.name']) = ${params.string(text.toLowerCase())})`;
			if (ref.name === 'scope') {
				const index = text.indexOf(':');
				if (index > 0)
					return `(scope_kind = ${params.string(text.slice(0, index).toLowerCase())} AND scope_id = ${params.string(text.slice(index + 1))})`;
				return `scope_id = ${params.string(text)}`;
			}
		}
		if (field.normalize === 'lower-both') return `lower(${field.expr}) = ${params.string(text.toLowerCase())}`;
		if (field.normalize === 'lower-value') return `${field.expr} = ${params.string(text.toLowerCase())}`;
		return `${field.expr} = ${params.string(text)}`;
	}

	// Ordered compares on a string field: numeric when the value is a number, else lexicographic.
	const n = numberValue(value);
	if (n !== null) return `ifNull(${field.numeric} ${COMPARE[op]} ${params.float(n)}, 0)`;
	return `(${field.present} AND ${field.expr} ${COMPARE[op]} ${params.string(text)})`;
}

// --------------------------------------------------------------------------------- records

/** The columns a record read selects, in the order `recordFromRow` expects. */
export const RECORD_SELECT = [
	'id',
	'toUnixTimestamp64Milli(ts) AS ts_ms',
	'toUnixTimestamp64Milli(observed_ts) AS observed_ms',
	'org_id',
	'scope_kind',
	'scope_id',
	'stream',
	'source',
	'channel',
	'severity_number',
	'body',
	'attributes',
	'resource',
	'trace_id',
	'span_id',
	'request_id',
	'pattern_id',
	'project_id',
	'deployment_id',
	'build_id',
	'job_run_id',
	'node_id',
	'replica',
].join(', ');

export interface LogSearchCursor {
	ts: number;
	id: string;
}

const CURSOR_PREFIX = 'ch1.';

export function encodeSearchCursor(cursor: LogSearchCursor): string {
	return CURSOR_PREFIX + Buffer.from(JSON.stringify([cursor.ts, cursor.id])).toString('base64url');
}

export function decodeSearchCursor(value: string): LogSearchCursor {
	if (!value.startsWith(CURSOR_PREFIX)) throw new ValidationError('Invalid log cursor');
	try {
		const parsed = JSON.parse(Buffer.from(value.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8')) as unknown;
		if (Array.isArray(parsed) && typeof parsed[0] === 'number' && Number.isFinite(parsed[0]) && typeof parsed[1] === 'string' && parsed[1].length <= 200)
			return { ts: parsed[0], id: parsed[1] };
	} catch {
		// fall through
	}
	throw new ValidationError('Invalid log cursor');
}

/**
 * Keyset page over `(ts, id)`. Fetches one row more than asked so the store knows whether another
 * page exists. `desc` reads older than the cursor, `asc` newer.
 */
export function compileSearch(
	read: LogStoreRead,
	page: { limit: number; cursor?: string; order: 'asc' | 'desc' },
	options: ClickHouseCompileOptions,
): CompiledLogQuery & { limit: number } {
	const params = new SqlParams();
	const limit = Math.max(1, Math.min(1_000, Math.trunc(page.limit)));
	const where = [readWhere(read, params, options)];
	if (page.cursor) {
		const cursor = decodeSearchCursor(page.cursor);
		const key = `(fromUnixTimestamp64Milli(${params.int(cursor.ts)}, 'UTC'), ${params.string(cursor.id)})`;
		where.push(`(ts, id) ${page.order === 'desc' ? '<' : '>'} ${key}`);
	}
	const direction = page.order === 'desc' ? 'DESC' : 'ASC';
	return {
		sql: `SELECT ${RECORD_SELECT}\nFROM ${LOGS_TABLE}\nWHERE ${where.join(' AND ')}\nORDER BY ts ${direction}, id ${direction}\nLIMIT ${params.int(limit + 1)}`,
		params: params.values,
		limit,
	};
}

export function compileGet(boundary: LogReadBoundary, id: string): CompiledLogQuery {
	const params = new SqlParams();
	return {
		sql: `SELECT ${RECORD_SELECT}\nFROM ${LOGS_TABLE}\nWHERE ${boundarySql(boundary, params)} AND id = ${params.string(id)}\nLIMIT 1`,
		params: params.values,
	};
}

/** How far context reads look either side of the anchor (keeps them to a few partitions). */
export const CONTEXT_WINDOW_MS = 86_400_000;

/**
 * Lines before or after an anchor in the same stream (or the same scope when the anchor has no
 * stream), like `grep -C`. The boundary is ANDed in again: context never leaves it.
 */
export function compileContext(
	boundary: LogReadBoundary,
	anchor: { ts: number; id: string; scopeKind: string; scopeId: string; stream: string | null },
	direction: 'before' | 'after',
	count: number,
): CompiledLogQuery {
	const params = new SqlParams();
	const where = [
		boundarySql(boundary, params),
		`scope_kind = ${params.string(anchor.scopeKind)}`,
		`scope_id = ${params.string(anchor.scopeId)}`,
	];
	if (anchor.stream) where.push(`stream = ${params.string(anchor.stream)}`);
	where.push(timeSql(anchor.ts - CONTEXT_WINDOW_MS, anchor.ts + CONTEXT_WINDOW_MS, params));
	const key = `(fromUnixTimestamp64Milli(${params.int(anchor.ts)}, 'UTC'), ${params.string(anchor.id)})`;
	const before = direction === 'before';
	where.push(`(ts, id) ${before ? '<' : '>'} ${key}`);
	const order = before ? 'DESC' : 'ASC';
	return {
		sql: `SELECT ${RECORD_SELECT}\nFROM ${LOGS_TABLE}\nWHERE ${where.join(' AND ')}\nORDER BY ts ${order}, id ${order}\nLIMIT ${params.int(Math.max(0, Math.min(500, count)))}`,
		params: params.values,
	};
}

// ------------------------------------------------------------------------------- histogram

const NICE_INTERVALS_MS = [
	1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000,
	10_800_000, 21_600_000, 43_200_000, 86_400_000, 172_800_000, 604_800_000,
];

/** The smallest round interval that draws the range in at most `buckets` bars. */
export function pickHistogramInterval(from: number, to: number, buckets: number): number {
	const span = Math.max(1, to - from);
	const target = span / Math.max(1, buckets);
	return NICE_INTERVALS_MS.find((interval) => interval >= target) ?? NICE_INTERVALS_MS.at(-1)!;
}

/** Counts per (bucket start, severity band). Pipe stages are ignored: the histogram is the filter's. */
export function compileHistogram(read: LogStoreRead, intervalMs: number, options: ClickHouseCompileOptions): CompiledLogQuery {
	const params = new SqlParams();
	const where = readWhere({ ...read, ast: { filter: read.ast.filter, pipes: [] } }, params, options);
	const interval = params.int(intervalMs);
	return {
		sql: `SELECT intDiv(toUnixTimestamp64Milli(ts), ${interval}) * ${interval} AS c0, severity_text AS c1, count() AS c2\nFROM ${LOGS_TABLE}\nWHERE ${where}\nGROUP BY c0, c1\nORDER BY c0`,
		params: params.values,
	};
}

// ---------------------------------------------------------------------------------- facets

/** Built-ins the facet sidebar summarises, with their display expression. */
export const FACET_BUILTINS: ReadonlyArray<{ name: BuiltinLogField; expr: string; type: 'string' | 'number' }> = [
	{ name: 'level', expr: 'severity_text', type: 'string' },
	{ name: 'service', expr: "resource['service.name']", type: 'string' },
	{ name: 'kind', expr: 'scope_kind', type: 'string' },
	{ name: 'source', expr: 'source', type: 'string' },
	{ name: 'channel', expr: 'channel', type: 'string' },
	{ name: 'deployment', expr: 'deployment_id', type: 'string' },
	{ name: 'node', expr: 'node_id', type: 'string' },
	{ name: 'replica', expr: "if(replica >= 0, toString(replica), '')", type: 'number' },
	{ name: 'stream', expr: 'stream', type: 'string' },
	{ name: 'pattern', expr: 'pattern_id', type: 'string' },
];

/** Facet values are cut so one huge attribute value cannot blow the group-by. */
const FACET_VALUE_CHARS = 200;

export function compileCount(read: LogStoreRead, options: ClickHouseCompileOptions): CompiledLogQuery {
	const params = new SqlParams();
	const where = readWhere({ ...read, ast: { filter: read.ast.filter, pipes: [] } }, params, options);
	return { sql: `SELECT count() AS c0\nFROM ${LOGS_TABLE}\nWHERE ${where}`, params: params.values };
}

/**
 * Top values for a list of built-ins in one scan: each row is exploded into (field, value) pairs
 * for the fields it carries, grouped, and cut to `top` values per field. A second column set gives
 * each field's presence per bucket, for the sparkline.
 */
export function compileBuiltinFacets(
	read: LogStoreRead,
	names: readonly BuiltinLogField[],
	top: number,
	options: ClickHouseCompileOptions,
): CompiledLogQuery {
	const params = new SqlParams();
	const where = readWhere({ ...read, ast: { filter: read.ast.filter, pipes: [] } }, params, options);
	const facets = FACET_BUILTINS.filter((facet) => names.includes(facet.name));
	const pairs = facets.map((facet) => `(${params.string(facet.name)}, substring(${facet.expr}, 1, ${FACET_VALUE_CHARS}))`).join(', ');
	return {
		sql: `SELECT kv.1 AS c0, kv.2 AS c1, count() AS c2\nFROM ${LOGS_TABLE}\nARRAY JOIN arrayFilter(x -> x.2 != '', [${pairs || "('', '')"}]) AS kv\nWHERE ${where}\nGROUP BY c0, c1\nORDER BY c0, c2 DESC\nLIMIT ${params.int(Math.max(1, Math.min(50, top)))} BY c0`,
		params: params.values,
	};
}

export function compileBuiltinSparklines(
	read: LogStoreRead,
	names: readonly BuiltinLogField[],
	intervalMs: number,
	options: ClickHouseCompileOptions,
): CompiledLogQuery {
	const params = new SqlParams();
	const where = readWhere({ ...read, ast: { filter: read.ast.filter, pipes: [] } }, params, options);
	const facets = FACET_BUILTINS.filter((facet) => names.includes(facet.name));
	const present = facets.map((facet) => `(${params.string(facet.name)}, ${facet.expr} != '')`).join(', ');
	const interval = params.int(intervalMs);
	return {
		sql: `SELECT kv.1 AS c0, intDiv(toUnixTimestamp64Milli(ts), ${interval}) * ${interval} AS c1, count() AS c2\nFROM ${LOGS_TABLE}\nARRAY JOIN arrayFilter(x -> x.2, [${present || "('', 0)"}]) AS kv\nWHERE ${where}\nGROUP BY c0, c1`,
		params: params.values,
	};
}

/** The most common attribute (or resource) keys in the window. */
export function compileMapKeys(read: LogStoreRead, map: 'attributes' | 'resource', limit: number, options: ClickHouseCompileOptions): CompiledLogQuery {
	const params = new SqlParams();
	const where = readWhere({ ...read, ast: { filter: read.ast.filter, pipes: [] } }, params, options);
	return {
		sql: `SELECT k AS c0, count() AS c1\nFROM ${LOGS_TABLE}\nARRAY JOIN mapKeys(${map}) AS k\nWHERE ${where}\nGROUP BY c0\nORDER BY c1 DESC, c0\nLIMIT ${params.int(Math.max(1, Math.min(100, limit)))}`,
		params: params.values,
	};
}

/** Top values (and presence counts) for the given map keys. */
export function compileMapFacets(
	read: LogStoreRead,
	map: 'attributes' | 'resource',
	keys: readonly string[],
	top: number,
	options: ClickHouseCompileOptions,
): CompiledLogQuery {
	const params = new SqlParams();
	const where = readWhere({ ...read, ast: { filter: read.ast.filter, pipes: [] } }, params, options);
	return {
		sql: `SELECT k AS c0, substring(${map}[k], 1, ${FACET_VALUE_CHARS}) AS c1, count() AS c2\nFROM ${LOGS_TABLE}\nARRAY JOIN mapKeys(${map}) AS k\nWHERE ${where} AND k IN ${params.strings(keys)}\nGROUP BY c0, c1\nORDER BY c0, c2 DESC\nLIMIT ${params.int(Math.max(1, Math.min(50, top)))} BY c0`,
		params: params.values,
	};
}

export function compileMapSparklines(
	read: LogStoreRead,
	map: 'attributes' | 'resource',
	keys: readonly string[],
	intervalMs: number,
	options: ClickHouseCompileOptions,
): CompiledLogQuery {
	const params = new SqlParams();
	const where = readWhere({ ...read, ast: { filter: read.ast.filter, pipes: [] } }, params, options);
	const interval = params.int(intervalMs);
	return {
		sql: `SELECT k AS c0, intDiv(toUnixTimestamp64Milli(ts), ${interval}) * ${interval} AS c1, count() AS c2\nFROM ${LOGS_TABLE}\nARRAY JOIN mapKeys(${map}) AS k\nWHERE ${where} AND k IN ${params.strings(keys)}\nGROUP BY c0, c1`,
		params: params.values,
	};
}

// ------------------------------------------------------------------------------ pipe stages

const DEFAULT_ROW_ORDER = 'ts DESC, id DESC';

function aggregationSql(aggregation: LogAggregation, params: SqlParams): string {
	if (aggregation.fn === 'count') {
		if (!aggregation.field) return 'count()';
		const field = fieldSql(aggregation.field, params);
		return `countIf(${field.present})`;
	}
	if (!aggregation.field) throw new ValidationError(`${aggregation.fn}() needs a field`);
	const field = fieldSql(aggregation.field, params);
	switch (aggregation.fn) {
		case 'count_distinct':
			return field.kind === 'severity' ? 'uniq(severity_text)' : `uniqIf(${field.expr}, ${field.present})`;
		case 'sum':
			return `sum(${field.numeric})`;
		case 'avg':
			return `avg(${field.numeric})`;
		case 'min':
			return `min(${field.numeric})`;
		case 'max':
			return `max(${field.numeric})`;
		case 'p50':
			return `quantile(0.5)(${field.numeric})`;
		case 'p90':
			return `quantile(0.9)(${field.numeric})`;
		case 'p95':
			return `quantile(0.95)(${field.numeric})`;
		case 'p99':
			return `quantile(0.99)(${field.numeric})`;
	}
}

function clampBin(intervalMs: number): number {
	return Math.max(LOG_QUERY_LIMITS.minBinMs, Math.min(LOG_QUERY_LIMITS.maxBinMs, Math.trunc(intervalMs)));
}

function groupBySql(group: LogGroupBy, params: SqlParams): { expr: string; type: LogColumnType } {
	if (group.type === 'bin') {
		const interval = params.int(clampBin(group.intervalMs));
		return { expr: `intDiv(toUnixTimestamp64Milli(ts), ${interval}) * ${interval}`, type: 'time' };
	}
	const field = fieldSql(group.field, params);
	return { expr: field.display, type: field.type };
}

interface OutputColumn {
	alias: string;
	name: string;
	type: LogColumnType;
}

function rowProjection(fields: LogFieldRef[] | null, params: SqlParams): Array<OutputColumn & { expr: string }> {
	if (!fields || fields.length === 0) {
		return [
			{ alias: 'c0', name: 'ts', type: 'time', expr: 'toUnixTimestamp64Milli(ts)' },
			{ alias: 'c1', name: 'level', type: 'string', expr: 'severity_text' },
			{ alias: 'c2', name: 'service', type: 'string', expr: "resource['service.name']" },
			{ alias: 'c3', name: 'body', type: 'string', expr: 'body' },
		];
	}
	return fields.map((ref, index) => {
		const field = fieldSql(ref, params);
		return { alias: `c${index}`, name: fieldRefName(ref), type: field.type, expr: field.display };
	});
}

/**
 * Pipe stages → one statement (§6.2). Row stages (`fields`, `dedup`, `sort`, `limit`) wrap the
 * filtered rows in subqueries in the order written; the first `stats` or `patterns` aggregates
 * them; after it only `sort`, `limit` and `fields` (choosing output columns) may follow.
 *
 * `fields` names in `| fields` and `| sort` may also be `ts` and `id`, which are not filter fields.
 */
export function compileTable(read: LogStoreRead, options: ClickHouseCompileOptions): CompiledLogTableQuery {
	const params = new SqlParams();
	const where = readWhere(read, params, options);
	let relation = `SELECT * FROM ${LOGS_TABLE} WHERE ${where}`;
	let order = DEFAULT_ROW_ORDER;
	let fields: LogFieldRef[] | null = null;
	let dedup = false;
	const pipes = read.ast.pipes;
	let index = 0;

	for (; index < pipes.length; index += 1) {
		const stage = pipes[index]!;
		if (stage.type === 'stats' || stage.type === 'patterns') break;
		if (stage.type === 'fields') {
			fields = stage.fields;
		} else if (stage.type === 'sort') {
			const field = namedFieldSql(requireNamedField(stage.key), params);
			order = `${field.expr} ${stage.direction === 'asc' ? 'ASC' : 'DESC'}, id ${stage.direction === 'asc' ? 'ASC' : 'DESC'}`;
		} else if (stage.type === 'limit') {
			const limit = params.int(Math.max(0, Math.min(LOG_QUERY_LIMITS.maxLimit, stage.count)));
			relation = `SELECT * FROM (${relation}) ORDER BY ${order} LIMIT ${limit}`;
		} else if (stage.type === 'dedup') {
			const field = fieldSql(stage.field, params);
			const key = field.kind === 'severity' ? 'severity_text' : field.expr;
			// Collapse repeats, newest first, keeping how many each one stood for.
			relation = `SELECT *, count() OVER (PARTITION BY ${key}) AS dedup_count FROM (${relation}) ORDER BY ${order} LIMIT 1 BY ${key}`;
			dedup = true;
		}
	}

	if (index >= pipes.length) {
		const columns = rowProjection(fields, params);
		if (dedup) columns.push({ alias: `c${columns.length}`, name: 'count', type: 'number', expr: 'dedup_count' });
		const select = columns.map((column) => `${column.expr} AS ${column.alias}`).join(', ');
		return {
			sql: `SELECT ${select}\nFROM (${relation})\nORDER BY ${order}\nLIMIT ${params.int(DEFAULT_TABLE_ROWS)}`,
			params: params.values,
			columns: columns.map(({ name, type }) => ({ name, type })),
			sampleIdColumn: null,
		};
	}

	const aggregate = pipes[index]!;
	let outputs: OutputColumn[];
	let select: string[];
	let groupBy: string[];
	let defaultOrder: string;
	let sampleAlias: string | null = null;
	let sparkAlias: string | null = null;
	let from = `(${relation})`;

	if (aggregate.type === 'stats') {
		if (aggregate.aggregations.length === 0) throw new ValidationError('stats needs at least one aggregation');
		if (aggregate.aggregations.length > LOG_QUERY_LIMITS.maxAggregations) throw new ValidationError('Too many aggregations');
		if (aggregate.by.length > LOG_QUERY_LIMITS.maxGroupBy) throw new ValidationError('Too many group-by fields');
		outputs = [];
		select = [];
		groupBy = [];
		let binAlias: string | null = null;
		for (const group of aggregate.by) {
			const alias = `c${outputs.length}`;
			const sql = groupBySql(group, params);
			outputs.push({ alias, name: group.alias, type: sql.type });
			select.push(`${sql.expr} AS ${alias}`);
			groupBy.push(alias);
			if (group.type === 'bin' && !binAlias) binAlias = alias;
		}
		const firstAggregation = `c${outputs.length}`;
		for (const aggregation of aggregate.aggregations) {
			const alias = `c${outputs.length}`;
			outputs.push({ alias, name: aggregation.alias, type: 'number' });
			select.push(`${aggregationSql(aggregation, params)} AS ${alias}`);
		}
		defaultOrder = binAlias ? `${binAlias} ASC` : `${firstAggregation} DESC`;
	} else {
		// | patterns: group by template id, with the template from log_patterns (same boundary).
		// `first_seen` is the template's first sighting in the scope (from log_patterns), not just in
		// this window; the sparkline splits the window into PATTERN_SPARKLINE_BUCKETS slots.
		const patterns = `SELECT pattern_id, any(template) AS template, min(first_seen) AS first_seen FROM ${LOG_PATTERNS_TABLE} WHERE ${boundarySql(read.boundary, params)} GROUP BY pattern_id`;
		const bucketMs = Math.max(1, Math.ceil((read.to - read.from + 1) / PATTERN_SPARKLINE_BUCKETS));
		from = `(${relation}) AS l LEFT JOIN (${patterns}) AS p ON p.pattern_id = l.pattern_id`;
		outputs = [
			{ alias: 'c0', name: 'pattern', type: 'string' },
			{ alias: 'c1', name: 'template', type: 'string' },
			{ alias: 'c2', name: 'count', type: 'number' },
			{ alias: 'c3', name: 'first_seen', type: 'time' },
			{ alias: 'c4', name: 'last_seen', type: 'time' },
		];
		select = [
			'l.pattern_id AS c0',
			"if(any(p.template) = '', any(l.body), any(p.template)) AS c1",
			'count() AS c2',
			"toUnixTimestamp64Milli(if(any(p.pattern_id) = '', min(l.ts), least(min(l.ts), any(p.first_seen)))) AS c3",
			'toUnixTimestamp64Milli(max(l.ts)) AS c4',
			'argMax(l.id, l.ts) AS c5',
			`countResample(0, ${PATTERN_SPARKLINE_BUCKETS}, 1)(intDiv(toUnixTimestamp64Milli(l.ts) - ${params.int(read.from)}, ${params.int(bucketMs)})) AS c6`,
		];
		sampleAlias = 'c5';
		sparkAlias = 'c6';
		groupBy = ['c0'];
		defaultOrder = 'c2 DESC';
	}

	let postOrder: string | null = null;
	let postLimit: number | null = null;
	let chosen: OutputColumn[] | null = null;
	for (index += 1; index < pipes.length; index += 1) {
		const stage = pipes[index]!;
		if (stage.type === 'sort') {
			const column = outputs.find((output) => output.name.toLowerCase() === stage.key.trim().toLowerCase());
			if (!column) throw new ValidationError(`Cannot sort by "${stage.key}": it is not a column of the result (${outputs.map((o) => o.name).join(', ')})`);
			postOrder = `${column.alias} ${stage.direction === 'asc' ? 'ASC' : 'DESC'}`;
		} else if (stage.type === 'limit') {
			postLimit = Math.max(0, Math.min(LOG_QUERY_LIMITS.maxLimit, stage.count));
		} else if (stage.type === 'fields') {
			chosen = stage.fields.map((ref) => {
				const name = fieldRefName(ref);
				const column = outputs.find((output) => output.name.toLowerCase() === name.toLowerCase());
				if (!column) throw new ValidationError(`"${name}" is not a column of the result`);
				return column;
			});
		} else {
			throw new ValidationError(`| ${stage.type} cannot follow | ${aggregate.type}; a query has one aggregation`);
		}
	}

	const limit = params.int(postLimit ?? DEFAULT_GROUP_ROWS);
	let sql = `SELECT ${select.join(', ')}\nFROM ${from}\nGROUP BY ${groupBy.length ? groupBy.join(', ') : 'tuple()'}\nORDER BY ${postOrder ?? defaultOrder}\nLIMIT ${limit}`;
	let columns = outputs;
	let sampleIdColumn: number | null = sampleAlias ? outputs.length : null;
	let sparklineColumn: number | null = sparkAlias ? outputs.length + (sampleAlias ? 1 : 0) : null;
	if (chosen) {
		const keep = [...chosen.map((column) => column.alias), ...(sampleAlias ? [sampleAlias] : []), ...(sparkAlias ? [sparkAlias] : [])];
		sql = `SELECT ${keep.join(', ')} FROM (${sql})`;
		columns = chosen;
		sampleIdColumn = sampleAlias ? chosen.length : null;
		sparklineColumn = sparkAlias ? chosen.length + (sampleAlias ? 1 : 0) : null;
	}
	return { sql, params: params.values, columns: columns.map(({ name, type }) => ({ name, type })), sampleIdColumn, sparklineColumn };
}
