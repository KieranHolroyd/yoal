import type { BuiltinLogField } from '@yoal/contracts';
import { ValidationError } from '../errors.ts';
import {
	FACET_BUILTINS,
	LOGS_TABLE,
	LOG_PATTERNS_TABLE,
	SqlParams,
	boundarySql,
	fieldSql,
	filterSql,
	parseFieldName,
	type ClickHouseCompileOptions,
	type CompiledLogQuery,
} from './clickhouse-compiler.ts';
import type { LogStoreRead } from './types.ts';

/**
 * SQL for Compare and Why? (docs/LOGS.md §8.2–§8.3) over `yoal.logs`. Pure, like
 * `clickhouse-compiler.ts`, and under the same rules: the boundary is ANDed into every statement
 * (including the `log_patterns` join), user text only travels as parameters, and computed
 * columns are `c0, c1, …`. Classification and ranking happen in `log-analysis.ts`.
 */

/** A closed time window, epoch ms. */
export interface LogWindow {
	from: number;
	to: number;
}

/** Patterns a compare reads at most per window pair (the busiest first). */
export const COMPARE_PATTERN_CAP = 5_000;
/** Attribute keys Why? considers when the caller names no fields (§8.3: "the top attribute keys"). */
export const WHY_ATTRIBUTE_KEYS = 20;
/** Values kept per field before ranking, so one high-cardinality key cannot flood the answer. */
export const WHY_VALUES_PER_FIELD = 20;
/** Built-ins Why? compares by default: the facet built-ins. */
export const WHY_BUILTINS: readonly BuiltinLogField[] = FACET_BUILTINS.map((facet) => facet.name);
const WHY_VALUE_CHARS = 200;

function at(ms: number, params: SqlParams): string {
	return `fromUnixTimestamp64Milli(${params.int(ms)}, 'UTC')`;
}

/** `ts` inside a window; `closed` includes the end (the current window, like every other read). */
function windowSql(window: LogWindow, params: SqlParams, closed: boolean, column = 'ts'): string {
	return `(${column} >= ${at(window.from, params)} AND ${column} ${closed ? '<=' : '<'} ${at(window.to, params)})`;
}

function filterPart(read: LogStoreRead, params: SqlParams, options: ClickHouseCompileOptions): string[] {
	return read.ast.filter ? [`(${filterSql(read.ast.filter, params, options)})`] : [];
}

// ---------------------------------------------------------------------------------- compare

/**
 * Line totals of the two windows (unmined lines included), in one scan:
 * `[current, baseline]`. The baseline window is half-open so a line on the shared edge of
 * `previous` counts once.
 */
export function compileCompareTotals(
	read: LogStoreRead,
	current: LogWindow,
	baseline: LogWindow,
	options: ClickHouseCompileOptions,
): CompiledLogQuery {
	const params = new SqlParams();
	const where = [boundarySql(read.boundary, params)];
	const cur = windowSql(current, params, true);
	const base = windowSql(baseline, params, false);
	where.push(`(${cur} OR ${base})`, ...filterPart(read, params, options));
	return {
		sql: `SELECT countIf(${cur}) AS c0, countIf(${base}) AS c1\nFROM ${LOGS_TABLE}\nWHERE ${where.join(' AND ')}`,
		params: params.values,
	};
}

/**
 * Per-pattern counts in both windows: `[pattern_id, template, current, baseline, sample_id]`,
 * busiest first, capped. Lines without a pattern id (not mined yet) are left out here and only
 * counted in the totals. The template comes from `log_patterns` under the same boundary, else a
 * sample body.
 */
export function compileCompare(
	read: LogStoreRead,
	current: LogWindow,
	baseline: LogWindow,
	options: ClickHouseCompileOptions,
	cap = COMPARE_PATTERN_CAP,
): CompiledLogQuery {
	const params = new SqlParams();
	const where = [boundarySql(read.boundary, params)];
	const inner = [windowSql(current, params, true), windowSql(baseline, params, false)];
	where.push(`(${inner[0]} OR ${inner[1]})`, "pattern_id != ''", ...filterPart(read, params, options));
	const cur = windowSql(current, params, true, 'l.ts');
	const base = windowSql(baseline, params, false, 'l.ts');
	const patterns = `SELECT pattern_id, any(template) AS template FROM ${LOG_PATTERNS_TABLE} WHERE ${boundarySql(read.boundary, params)} GROUP BY pattern_id`;
	return {
		sql: [
			`SELECT l.pattern_id AS c0, if(any(p.template) = '', any(l.body), any(p.template)) AS c1, countIf(${cur}) AS c2, countIf(${base}) AS c3, argMax(l.id, l.ts) AS c4`,
			`FROM (SELECT pattern_id, ts, id, body FROM ${LOGS_TABLE} WHERE ${where.join(' AND ')}) AS l`,
			`LEFT JOIN (${patterns}) AS p ON p.pattern_id = l.pattern_id`,
			'GROUP BY c0',
			'ORDER BY greatest(c2, c3) DESC, c0',
			`LIMIT ${params.int(Math.max(1, Math.min(COMPARE_PATTERN_CAP, cap)))}`,
		].join('\n'),
		params: params.values,
	};
}

// -------------------------------------------------------------------------------------- why

/** One field Why? compares: its query name and the SQL of its value (empty = absent). */
export interface WhyField {
	name: string;
	expr: string;
}

/**
 * Resolve Why? field names (`node`, `@http.route`, `resource.host.name`) to value expressions.
 * Built-ins use the facet expression when there is one (severity as its band name, replica as
 * text); attribute and resource keys read their map. Unknown names are a 422.
 */
export function whyFields(names: readonly string[], params: SqlParams): WhyField[] {
	const out: WhyField[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		const parsed = parseFieldName(name);
		if (!parsed || parsed.kind !== 'ref') throw new ValidationError(`Why? cannot compare "${name}"`, [{ path: ['fields'], message: `unknown field ${name}` }]);
		const ref = parsed.ref;
		let label: string;
		let expr: string;
		if (ref.kind === 'builtin') {
			label = ref.name;
			const facet = FACET_BUILTINS.find((item) => item.name === ref.name);
			expr = facet ? facet.expr : `toString(${fieldSql(ref, params).display})`;
		} else {
			const map = ref.kind === 'attribute' ? 'attributes' : 'resource';
			label = ref.kind === 'attribute' ? `@${ref.key}` : `resource.${ref.key}`;
			expr = `${map}[${params.string(ref.key)}]`;
		}
		if (seen.has(label)) continue;
		seen.add(label);
		out.push({ name: label, expr });
	}
	return out;
}

/** `[selection, rest]` line totals over the read's window. */
export function compileWhyTotals(read: LogStoreRead, selection: LogWindow, options: ClickHouseCompileOptions): CompiledLogQuery {
	const params = new SqlParams();
	const where = [boundarySql(read.boundary, params), windowSql(read, params, true), ...filterPart(read, params, options)];
	const sel = windowSql(selection, params, true);
	return {
		sql: `SELECT countIf(${sel}) AS c0, countIf(NOT ${sel}) AS c1\nFROM ${LOGS_TABLE}\nWHERE ${where.join(' AND ')}`,
		params: params.values,
	};
}

/**
 * Value counts inside and outside the selection for every field in one scan (§8.3: BubbleUp's
 * two counts per key): `[field, value, selection, rest]`. Each row is exploded into the
 * (field, value) pairs it carries; per field, the values most over-represented in the selection
 * (by share difference against the given totals) are kept.
 */
export function compileWhy(
	read: LogStoreRead,
	selection: LogWindow,
	fieldNames: readonly string[],
	totals: { selection: number; baseline: number },
	options: ClickHouseCompileOptions,
	perField = WHY_VALUES_PER_FIELD,
): CompiledLogQuery {
	const params = new SqlParams();
	const fields = whyFields(fieldNames, params);
	if (fields.length === 0) throw new ValidationError('Why? needs at least one field');
	const pairs = fields
		.map((field) => `(${params.string(field.name)}, substring(${field.expr}, 1, ${WHY_VALUE_CHARS}))`)
		.join(', ');
	const where = [boundarySql(read.boundary, params), windowSql(read, params, true), ...filterPart(read, params, options)];
	const sel = windowSql(selection, params, true);
	const selTotal = params.float(Math.max(1, totals.selection));
	const restTotal = params.float(Math.max(1, totals.baseline));
	return {
		sql: [
			`SELECT kv.1 AS c0, kv.2 AS c1, countIf(${sel}) AS c2, countIf(NOT ${sel}) AS c3`,
			`FROM ${LOGS_TABLE}`,
			`ARRAY JOIN arrayFilter(x -> x.2 != '', [${pairs}]) AS kv`,
			`WHERE ${where.join(' AND ')}`,
			'GROUP BY c0, c1',
			'HAVING c2 > 0',
			`ORDER BY c0, c2 / ${selTotal} - c3 / ${restTotal} DESC, c1`,
			`LIMIT ${params.int(Math.max(1, Math.min(100, perField)))} BY c0`,
		].join('\n'),
		params: params.values,
	};
}
