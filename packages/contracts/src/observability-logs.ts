import type { LogAggregation, LogGroupBy, LogQueryAst } from './log-query-ast.ts';
import { formatLogFieldRef, formatLogQuery, parseLogFieldName, parseLogQuery } from './log-query.ts';
import type { BuilderLogs, BuilderSpec, PanelQuery } from './observability.ts';

/**
 * The `logs` dashboards dataset (docs/LOGS.md §9.2, D101). A builder spec over `logs` is turned
 * into one log query, `<filter> | stats <measures> by bin(<interval>), <fields>`, which the server
 * runs through the Logs Explorer with the caller's boundary ANDed in (ClickHouse when it is there;
 * lite mode answers `count()` by `bin()` and built-in fields). Pure, so the dashboard, the alert
 * evaluator and tests share one translation.
 *
 * Measures: `count` (lines) and `count_distinct` (distinct values of the metric's `of` field).
 * Group by: dimensions (`level`, `source`, `scope`, `service`, …), any `@attribute` or
 * `resource.key`, and time (`bin`, when the spec is a time series).
 */

export const LOGS_DATASET = 'logs' as const;

export const logsDatasetMeasures = ['count', 'count_distinct'] as const;
export type LogsDatasetMeasure = (typeof logsDatasetMeasures)[number];

/** Built-in fields offered as group-by chips (any other field is typed as `@key`). */
export const logsDatasetDimensions = [
	{ name: 'level', label: 'Severity' },
	{ name: 'source', label: 'Source' },
	{ name: 'scope', label: 'Scope' },
	{ name: 'service', label: 'Service' },
	{ name: 'kind', label: 'Scope kind' },
	{ name: 'deployment', label: 'Deployment' },
	{ name: 'node', label: 'Node' },
	{ name: 'stream', label: 'Stream' },
	{ name: 'channel', label: 'Channel' },
	{ name: 'pattern', label: 'Pattern' },
] as const;

/** The `logs` part of a builder spec, with defaults. */
export function builderLogsOf(spec: Pick<BuilderSpec, 'logs'>): BuilderLogs {
	return { q: spec.logs?.q ?? '', scopes: spec.logs?.scopes ?? [] };
}

/** The `logs` builder spec of a panel or rule query, or null when it is anything else. */
export function logsBuilderOf(query: PanelQuery | undefined): BuilderSpec | null {
	return query?.mode === 'builder' && query.builder.dataset === LOGS_DATASET ? query.builder : null;
}

export type LogsQueryText = { ok: true; q: string; ast: LogQueryAst } | { ok: false; error: string };

/**
 * The log query a `logs` builder spec stands for. `binMs` buckets by time (a `time` column first);
 * null gives one row per group for the whole range. The filter must not have pipe stages: the
 * builder owns the aggregation.
 */
export function logsBuilderQuery(spec: BuilderSpec, binMs: number | null): LogsQueryText {
	const parsed = parseLogQuery(builderLogsOf(spec).q);
	if (!parsed.ok) return { ok: false, error: `Log query: ${parsed.error.message}` };
	if (parsed.ast.pipes.length > 0)
		return { ok: false, error: 'The log query is a filter here; the builder adds the `| stats` stage. Remove the pipe stages.' };
	if (spec.metrics.length === 0) return { ok: false, error: 'Pick a measure: count, or count_distinct of a field.' };

	const aggregations: LogAggregation[] = [];
	const aliases = new Set<string>(['time']);
	for (const metric of spec.metrics) {
		let aggregation: LogAggregation;
		if (metric.field === 'count') aggregation = { fn: 'count', alias: 'count' };
		else if (metric.field === 'count_distinct') {
			const field = metric.of ? parseLogFieldName(metric.of.trim()) : null;
			if (!field) return { ok: false, error: `count_distinct needs a field to count, e.g. @user.id (got "${metric.of ?? ''}").` };
			aggregation = { fn: 'count_distinct', field, alias: `distinct_${formatLogFieldRef(field).replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')}` };
		} else return { ok: false, error: `${metric.field} is not a measure of logs (use count or count_distinct).` };
		let alias = metric.alias ?? aggregation.alias;
		for (let n = 2; aliases.has(alias); n++) alias = `${metric.alias ?? aggregation.alias}_${n}`;
		aliases.add(alias);
		aggregations.push({ ...aggregation, alias });
	}

	const by: LogGroupBy[] = [];
	if (binMs !== null) by.push({ type: 'bin', intervalMs: Math.max(1_000, Math.round(binMs)), alias: 'time' });
	for (const name of spec.groupBy) {
		const field = parseLogFieldName(name);
		if (!field) return { ok: false, error: `${name} is not a log field.` };
		by.push({ type: 'field', field, alias: formatLogFieldRef(field) });
	}
	const ast: LogQueryAst = { filter: parsed.ast.filter, pipes: [{ type: 'stats', aggregations, by }] };
	const limit = spec.limit;
	if (limit !== undefined) ast.pipes.push({ type: 'limit', count: limit });
	return { ok: true, q: formatLogQuery(ast), ast };
}

const BIN_INTERVALS: Record<number, BuilderSpec['interval']> = {
	60_000: '1m',
	300_000: '5m',
	900_000: '15m',
	1_800_000: '30m',
	3_600_000: '1h',
	21_600_000: '6h',
	43_200_000: '12h',
	86_400_000: '1d',
};

/**
 * The inverse, for "Add to dashboard" from the Explorer's Analytics tab: a `| stats` query of
 * `count()` / `count_distinct(f)` by `bin()` and fields becomes a `logs` builder spec and a fitting
 * visualisation. Anything a builder cannot express (percentiles, `| patterns`) is an error.
 */
export function logsBuilderFromQuery(
	text: string,
	scopes: BuilderLogs['scopes'],
): { ok: true; builder: BuilderSpec; viz: 'timeseries' | 'bar' | 'stat' } | { ok: false; error: string } {
	const parsed = parseLogQuery(text);
	if (!parsed.ok) return { ok: false, error: parsed.error.message };
	const [stats, ...rest] = parsed.ast.pipes;
	if (!stats || stats.type !== 'stats') return { ok: false, error: 'Only a `| stats …` query can become a dashboard chart.' };
	let limit: number | undefined;
	for (const stage of rest) {
		if (stage.type === 'limit') limit = Math.max(1, Math.min(10_000, stage.count));
		else if (stage.type !== 'sort') return { ok: false, error: `\`| ${stage.type}\` after \`| stats\` cannot be shown on a dashboard.` };
	}
	const metrics: BuilderSpec['metrics'] = [];
	for (const aggregation of stats.aggregations) {
		const alias = /^[a-z][a-z0-9_]{0,63}$/.test(aggregation.alias) ? aggregation.alias : undefined;
		if (aggregation.fn === 'count') metrics.push({ field: 'count', agg: 'count', ...(alias && alias !== 'count' ? { alias } : {}) });
		else if (aggregation.fn === 'count_distinct' && aggregation.field)
			metrics.push({ field: 'count_distinct', agg: 'count', of: formatLogFieldRef(aggregation.field), ...(alias ? { alias } : {}) });
		else return { ok: false, error: `Dashboards count log lines or distinct values; \`${aggregation.alias}\` needs the Explorer.` };
	}
	let interval: BuilderSpec['interval'] = 'auto';
	let timeSeries = false;
	const groupBy: string[] = [];
	for (const group of stats.by) {
		if (group.type === 'bin') {
			timeSeries = true;
			interval = BIN_INTERVALS[group.intervalMs] ?? 'auto';
		} else groupBy.push(formatLogFieldRef(group.field));
	}
	const filter = parsed.ast.filter ? formatLogQuery({ filter: parsed.ast.filter, pipes: [] }) : '';
	const builder: BuilderSpec = {
		dataset: LOGS_DATASET,
		metrics,
		groupBy: groupBy.slice(0, 4),
		filters: [],
		timeSeries,
		interval,
		...(limit !== undefined ? { limit } : {}),
		logs: { q: filter, scopes: [...scopes] },
	};
	return { ok: true, builder, viz: timeSeries ? 'timeseries' : groupBy.length > 0 ? 'bar' : 'stat' };
}
