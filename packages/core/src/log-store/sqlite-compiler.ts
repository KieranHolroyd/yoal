import {
	LOG_TOKEN_SEPARATOR_CODES,
	SEVERITY_NUMBER,
	foldLogCase,
	isLogTokenSearch,
	severityForNumber,
	severityForText,
	type BuiltinLogField,
	type LogFieldOp,
	type LogFieldRef,
	type LogQueryNode,
	type LogScopeKind,
	type LogSeverity,
} from '@yoal/contracts';
import type { SqliteLogSource } from './sqlite-sources.ts';
import { LogStoreUnsupported, type LogReadBoundary } from './types.ts';

/**
 * The lite-mode compiler (docs/LOGS.md §6.3): a log-query AST → a SQLite boolean expression over
 * the unified columns of `sqlite-sources.ts`, read through the alias `u`. Values are always bound
 * parameters; the only text inlined is fixed SQL and attribute JSON paths that pass a strict
 * character check. Anything lite mode cannot answer throws `LogStoreUnsupported`.
 *
 * Every leaf is wrapped in `COALESCE(…, 0)`, so a missing field is false and `NOT` of it is true,
 * the same rule as the JS predicate.
 */

export type SqlParam = string | number | null;

export interface SqlFragment {
	sql: string;
	params: SqlParam[];
}

/** OTel band ranges (inclusive) for `level` comparisons. */
const BAND_RANGE: Readonly<Record<LogSeverity, readonly [number, number]>> = {
	trace: [1, 4],
	debug: [5, 8],
	info: [9, 12],
	warn: [13, 16],
	error: [17, 20],
	fatal: [21, 24],
};

/** The severity band of a unified row as text (`error`, `warn`…), for grouping and wildcards. */
export const SEVERITY_TEXT_SQL = `(CASE WHEN u.severity_number >= ${SEVERITY_NUMBER.fatal} THEN 'fatal' WHEN u.severity_number >= ${SEVERITY_NUMBER.error} THEN 'error' WHEN u.severity_number >= ${SEVERITY_NUMBER.warn} THEN 'warn' WHEN u.severity_number >= ${SEVERITY_NUMBER.info} OR u.severity_number <= 0 THEN 'info' WHEN u.severity_number >= ${SEVERITY_NUMBER.debug} THEN 'debug' ELSE 'trace' END)`;

/**
 * Replica index. `log_events` stores it as a `[rN] ` body prefix (and 0 for a deployment's first
 * copy, as `unifiedRowToLogRecord` reads it); `log_records` carries it in `resource.replica`.
 */
export const REPLICA_SQL = `(CASE
  WHEN u.tag = 'le' AND u.body GLOB '[[]r[0-9]*] *' THEN CAST(substr(u.body, 3, instr(u.body, ']') - 3) AS INTEGER)
  WHEN u.tag = 'le' AND u.deployment_id IS NOT NULL THEN 0
  WHEN u.tag = 'lr' THEN CAST(json_extract(u.resource, '$.replica') AS INTEGER)
  ELSE NULL END)`;

/** Display names for every scope kind that has one, for `service:` (matches `scopeName`). */
export const SCOPE_NAMES_SQL = `SELECT 'project' AS kind, id, slug AS name FROM projects
  UNION ALL SELECT 'function', id, slug FROM projects
  UNION ALL SELECT 'database', id, name FROM databases
  UNION ALL SELECT 'storage', id, name FROM storage_instances
  UNION ALL SELECT 'broker', id, name FROM brokers
  UNION ALL SELECT 'k8s', id, name FROM k8s_clusters
  UNION ALL SELECT 'pipeline', id, name FROM pipeline_repositories
  UNION ALL SELECT 'platform', id, name FROM nodes`;

/** Plain column expressions for built-ins (the rest need lookups or are ClickHouse-only). */
const BUILTIN_COLUMN: Partial<Record<BuiltinLogField, string>> = {
	body: 'u.body',
	kind: 'u.scope_kind',
	scope: `(u.scope_kind || ':' || u.scope_id)`,
	deployment: 'u.deployment_id',
	build: 'u.build_id',
	job: 'u.job_run_id',
	node: 'u.node_id',
	source: 'u.source',
	stream: 'u.stream',
	channel: 'u.channel',
	trace: 'u.trace_id',
	span: 'u.span_id',
	request: 'u.request_id',
	replica: REPLICA_SQL,
};

/** Built-ins lite mode can group by in `| stats … by` and summarise in `/fields`. */
export const GROUPABLE_BUILTINS: readonly BuiltinLogField[] = [
	'level',
	'source',
	'kind',
	'scope',
	'stream',
	'channel',
	'deployment',
	'build',
	'job',
	'node',
	'replica',
	'trace',
	'request',
];

/** A SQL expression for a groupable built-in (level reads as its band name). */
export function builtinGroupExpression(name: BuiltinLogField): string | null {
	if (name === 'level') return SEVERITY_TEXT_SQL;
	return BUILTIN_COLUMN[name] ?? null;
}

/** Attribute keys are inlined as JSON paths, so they must be plain. Anything else never matches. */
const SAFE_KEY = /^[A-Za-z0-9_.:@/-]{1,200}$/;

function jsonPath(key: string): string | null {
	if (!SAFE_KEY.test(key)) return null;
	return `'$."${key}"'`;
}

/** Resource keys that the hot-tail tables keep as columns rather than JSON. */
function resourceExpression(key: string): string | null {
	if (key === 'deployment.id') return 'u.deployment_id';
	if (key === 'host.id') return 'u.node_id';
	if (key === 'replica') return REPLICA_SQL;
	const path = jsonPath(key);
	return path ? `json_extract(u.resource, ${path})` : null;
}

function attributeExpression(key: string): string | null {
	const path = jsonPath(key);
	return path ? `json_extract(u.attributes, ${path})` : null;
}

/** A value as a number when it is one (`typeof` number or numeric text), else NULL. */
function numericOf(expression: string): string {
	return `(CASE WHEN typeof(${expression}) IN ('integer','real') THEN ${expression} WHEN typeof(${expression}) = 'text' AND trim(${expression}) <> '' AND trim(${expression}) NOT GLOB '*[^0-9.eE+-]*' THEN CAST(trim(${expression}) AS REAL) ELSE NULL END)`;
}

/** `*` and `?` globs → a LIKE pattern with `\` escaping. LIKE is ASCII case-insensitive. */
export function globToLike(value: string): string {
	let out = '';
	for (const char of value) {
		if (char === '*') out += '%';
		else if (char === '?') out += '_';
		else if (char === '%' || char === '_' || char === '\\') out += `\\${char}`;
		else out += char;
	}
	return out;
}

function toNumber(value: string | number): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const number = Number(trimmed);
	return Number.isFinite(number) ? number : null;
}

const NEVER: SqlFragment = { sql: '0', params: [] };

function orderedOp(op: LogFieldOp): '>' | '>=' | '<' | '<=' | null {
	switch (op) {
		case 'gt':
			return '>';
		case 'gte':
			return '>=';
		case 'lt':
			return '<';
		case 'lte':
			return '<=';
		default:
			return null;
	}
}

/** Compare a column expression with a value, by the AST's operator semantics. */
function compare(expression: string, op: LogFieldOp, value: string | number): SqlFragment {
	if (op === 'regex') throw new LogStoreUnsupported('Regular expressions need the search index (ClickHouse).', 'regex');
	if (op === 'eq') return { sql: `lower(CAST(${expression} AS TEXT)) = lower(?)`, params: [String(value)] };
	if (op === 'wildcard')
		return { sql: `CAST(${expression} AS TEXT) LIKE ? ESCAPE '\\'`, params: [globToLike(String(value))] };
	const sqlOp = orderedOp(op);
	const number = toNumber(value);
	if (!sqlOp || number === null) return NEVER;
	return { sql: `${numericOf(expression)} ${sqlOp} ?`, params: [number] };
}

function levelBand(value: string | number): LogSeverity | null {
	if (typeof value === 'number') return severityForNumber(value);
	const numeric = toNumber(value);
	if (numeric !== null) return severityForNumber(numeric);
	return severityForText(value);
}

function compileLevel(op: LogFieldOp, value: string | number): SqlFragment {
	if (op === 'regex') throw new LogStoreUnsupported('Regular expressions need the search index (ClickHouse).', 'regex');
	if (op === 'wildcard') return compare(SEVERITY_TEXT_SQL, op, value);
	const band = levelBand(value);
	if (!band) return NEVER;
	const [low, high] = BAND_RANGE[band];
	switch (op) {
		case 'eq':
			return { sql: 'u.severity_number BETWEEN ? AND ?', params: [low, high] };
		case 'gte':
			return { sql: 'u.severity_number >= ?', params: [low] };
		case 'gt':
			return { sql: 'u.severity_number > ?', params: [high] };
		case 'lt':
			return { sql: 'u.severity_number < ?', params: [low] };
		case 'lte':
			return { sql: 'u.severity_number <= ?', params: [high] };
		default:
			return NEVER;
	}
}

/** `service:` matches a scope's display name (project slug, database name…). */
function compileService(op: LogFieldOp, value: string | number): SqlFragment {
	const inner = compare('n.name', op, value);
	if (inner === NEVER) return NEVER;
	return {
		sql: `(u.scope_kind, u.scope_id) IN (SELECT n.kind, n.id FROM (${SCOPE_NAMES_SQL}) n WHERE ${inner.sql})`,
		params: inner.params,
	};
}

/** `project:` matches the project id or its slug. */
function compileProject(op: LogFieldOp, value: string | number): SqlFragment {
	const byId = compare('p.id', op, value);
	const bySlug = compare('p.slug', op, value);
	if (byId === NEVER) return NEVER;
	return {
		sql: `u.project_id IN (SELECT p.id FROM projects p WHERE ${byId.sql} OR ${bySlug.sql})`,
		params: [...byId.params, ...bySlug.params],
	};
}

/** `node:` matches the node id or its name. */
function compileNode(op: LogFieldOp, value: string | number): SqlFragment {
	const byId = compare('u.node_id', op, value);
	const byName = compare('x.name', op, value);
	if (byId === NEVER) return NEVER;
	return {
		sql: `(${byId.sql} OR u.node_id IN (SELECT x.id FROM nodes x WHERE ${byName.sql}))`,
		params: [...byId.params, ...byName.params],
	};
}

function fieldExpression(field: LogFieldRef): string | null {
	if (field.kind === 'attribute') return attributeExpression(field.key);
	if (field.kind === 'resource') return resourceExpression(field.key);
	if (field.name === 'pattern')
		throw new LogStoreUnsupported('Patterns need the search index (ClickHouse).', 'patterns');
	if (field.name === 'project') return 'u.project_id';
	return BUILTIN_COLUMN[field.name] ?? null;
}

function compileField(field: LogFieldRef, op: LogFieldOp, value: string | number): SqlFragment {
	if (field.kind === 'builtin') {
		if (field.name === 'level') return compileLevel(op, value);
		if (field.name === 'service') return compileService(op, value);
		if (field.name === 'project') return compileProject(op, value);
		if (field.name === 'node') return compileNode(op, value);
	}
	const expression = fieldExpression(field);
	if (!expression) {
		if (op === 'regex') throw new LogStoreUnsupported('Regular expressions need the search index (ClickHouse).', 'regex');
		return NEVER;
	}
	return compare(expression, op, value);
}

function compileExists(field: LogFieldRef): SqlFragment {
	if (field.kind === 'builtin' && (field.name === 'level' || field.name === 'body' || field.name === 'service'))
		return { sql: '1', params: [] };
	const expression = fieldExpression(field);
	if (!expression) return NEVER;
	return { sql: `(${expression} IS NOT NULL AND CAST(${expression} AS TEXT) <> '')`, params: [] };
}

function leaf(fragment: SqlFragment): SqlFragment {
	if (fragment.sql === '0' || fragment.sql === '1') return fragment;
	return { sql: `COALESCE((${fragment.sql}), 0)`, params: fragment.params };
}

function join(children: SqlFragment[], operator: 'AND' | 'OR'): SqlFragment {
	if (children.length === 0) return { sql: operator === 'AND' ? '1' : '0', params: [] };
	if (children.length === 1) return children[0]!;
	return {
		sql: `(${children.map((child) => child.sql).join(` ${operator} `)})`,
		params: children.flatMap((child) => child.params),
	};
}

/**
 * `lower(u.body)` with every token separator (ASCII non-alphanumerics, `LOG_TOKEN_SEPARATOR_RE`)
 * turned into a space, so `' ' || this || ' ' LIKE '% tok %'` is a whole-token test (§6.1).
 */
const SPACED_BODY = LOG_TOKEN_SEPARATOR_CODES.filter((code) => code !== 32).reduce(
	(expression, code) => `replace(${expression}, char(${code}), ' ')`,
	'lower(u.body)',
);

/**
 * Body search with the predicate's semantics (`logTextMatches`): a bare letters/digits word is a
 * whole-token match, anything else a case-insensitive substring. The token form keeps the cheap
 * `instr` test first, so only candidate rows pay for the separator rewrite.
 */
export function compileText(value: string, phrase: boolean): SqlFragment {
	const needle = foldLogCase(value);
	if (!isLogTokenSearch({ value, phrase })) return { sql: 'instr(lower(u.body), ?) > 0', params: [needle] };
	return {
		sql: `(instr(lower(u.body), ?) > 0 AND (' ' || ${SPACED_BODY} || ' ') LIKE ?)`,
		params: [needle, `% ${needle} %`],
	};
}

/** Compile a filter tree. Null (no filter) is `1`. */
export function compileSqliteFilter(node: LogQueryNode | null): SqlFragment {
	if (!node) return { sql: '1', params: [] };
	switch (node.type) {
		case 'and':
			return join(node.children.map(compileSqliteFilter), 'AND');
		case 'or':
			return join(node.children.map(compileSqliteFilter), 'OR');
		case 'not': {
			const inner = compileSqliteFilter(node.child);
			return { sql: `(NOT ${inner.sql})`, params: inner.params };
		}
		case 'text':
			if (!node.value) return { sql: '1', params: [] };
			return leaf(compileText(node.value, node.phrase));
		case 'field':
			return leaf(compileField(node.field, node.op, node.value));
		case 'exists':
			return leaf(compileExists(node.field));
	}
}

/** Scope kinds whose records are platform-wide: only a cross-org boundary skips `org_id` for them. */
const CROSS_ORG_KINDS: ReadonlySet<LogScopeKind> = new Set<LogScopeKind>(['platform', 'edge']);

/**
 * The tenancy condition for one source table, or null when no boundary scope can live in it (the
 * read skips the table). `org_id` is always ANDed in, except for platform and edge scopes on a
 * platform admin's cross-org boundary.
 */
export function compileBoundary(boundary: LogReadBoundary, source: SqliteLogSource): SqlFragment | null {
	const byKind = new Map<LogScopeKind, string[]>();
	for (const scope of boundary.scopes) {
		if (!source.scopeKinds.includes(scope.kind)) continue;
		const ids = byKind.get(scope.kind) ?? [];
		ids.push(scope.id);
		byKind.set(scope.kind, ids);
	}
	if (byKind.size === 0) return null;
	const parts: SqlFragment[] = [];
	for (const [kind, ids] of byKind) {
		const unique = [...new Set(ids)];
		const placeholders = unique.map(() => '?').join(', ');
		const skipOrg = boundary.crossOrg && CROSS_ORG_KINDS.has(kind);
		parts.push({
			sql: `(u.scope_kind = ? AND u.scope_id IN (${placeholders})${skipOrg ? '' : ' AND u.org_id = ?'})`,
			params: skipOrg ? [kind, ...unique] : [kind, ...unique, boundary.orgId],
		});
	}
	return join(parts, 'OR');
}

/**
 * One source's filtered rows as a subquery over its unified SELECT. SQLite flattens the inner
 * subquery, so the boundary and time conditions reach the base table's indexes.
 */
export function compileSourceWhere(
	source: SqliteLogSource,
	boundary: LogReadBoundary,
	filter: SqlFragment,
	range: { from: number; to: number } | null,
	extra: SqlFragment[] = [],
): SqlFragment | null {
	const tenancy = compileBoundary(boundary, source);
	if (!tenancy) return null;
	const conditions: SqlFragment[] = [tenancy];
	if (range) conditions.push({ sql: 'u.ts >= ? AND u.ts <= ?', params: [range.from, range.to] });
	if (filter.sql !== '1') conditions.push(filter);
	conditions.push(...extra);
	return {
		sql: `SELECT * FROM (${source.select}) u WHERE ${conditions.map((condition) => condition.sql).join(' AND ')}`,
		params: conditions.flatMap((condition) => condition.params),
	};
}
