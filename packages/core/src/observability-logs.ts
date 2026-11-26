import {
	logsBuilderQuery,
	builderLogsOf,
	type BuilderSpec,
	type LogTableResult,
	type Principal,
	type QueryColumn,
	type QueryResult,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { ValidationError } from './errors.ts';
import { autoInterval } from './observability-query.ts';

/**
 * The `logs` dashboards dataset (docs/LOGS.md §9.2, D101). A builder spec over `logs` becomes one
 * log query (`observability-logs.ts` in contracts) that runs through the Logs Explorer as the
 * caller: the explorer resolves the caller's log boundary, intersects the spec's scopes with it,
 * and compiles the query with the ClickHouse compiler (or the SQLite one in lite mode, which
 * answers `count()` by `bin()` and built-in fields). Tenancy never comes from the spec.
 */

const FIXED_INTERVALS: Record<string, number> = {
	'1m': 60,
	'5m': 300,
	'15m': 900,
	'30m': 1_800,
	'1h': 3_600,
	'6h': 21_600,
	'12h': 43_200,
	'1d': 86_400,
};

/** Bucket width for a logs time series, seconds (logs have no minute/hour tables: any width works). */
export function logsIntervalSeconds(spec: Pick<BuilderSpec, 'interval'>, rangeMs: number, maxDataPoints: number): number {
	const fixed = spec.interval === 'auto' ? undefined : FIXED_INTERVALS[spec.interval];
	return fixed ?? autoInterval(Math.max(1, Math.floor(rangeMs / 1000)), maxDataPoints, 60);
}

/** The log query text a `logs` spec runs as (also what Inspect shows). Throws ValidationError. */
export function logsDatasetQueryText(spec: BuilderSpec, intervalSeconds: number | null): string {
	const compiled = logsBuilderQuery(spec, intervalSeconds === null ? null : intervalSeconds * 1000);
	if (!compiled.ok) throw new ValidationError(compiled.error);
	return compiled.q;
}

const COLUMN_TYPES: Record<LogTableResult['columns'][number]['type'], { type: string; kind: QueryColumn['kind'] }> = {
	time: { type: "DateTime64(3, 'UTC')", kind: 'time' },
	number: { type: 'Float64', kind: 'number' },
	string: { type: 'String', kind: 'string' },
};

/** A Logs Explorer table as a dashboard query result (time columns are epoch ms in both). */
export function logTableToQueryResult(
	table: LogTableResult,
	extra: { sql: string; intervalSeconds: number; orderBy?: BuilderSpec['orderBy']; timeSeries: boolean },
): QueryResult {
	const columns: QueryColumn[] = table.columns.map((column) => ({ name: column.name, ...COLUMN_TYPES[column.type] }));
	let rows = table.rows.map((row) => row.map((cell, index) => (columns[index]?.kind === 'number' && typeof cell === 'string' ? Number(cell) : cell)));
	const timeIndex = columns.findIndex((column) => column.kind === 'time');
	if (extra.timeSeries && timeIndex >= 0) rows = [...rows].sort((a, b) => Number(a[timeIndex] ?? 0) - Number(b[timeIndex] ?? 0));
	else if (extra.orderBy) {
		const index = columns.findIndex((column) => column.name === extra.orderBy!.field);
		if (index >= 0) {
			const sign = extra.orderBy.dir === 'asc' ? 1 : -1;
			rows = [...rows].sort((a, b) => {
				const x = a[index];
				const y = b[index];
				if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
				return String(x ?? '').localeCompare(String(y ?? '')) * sign;
			});
		}
	}
	const notice = table.warnings.map((warning) => warning.message).join(' ');
	return {
		columns,
		rows,
		sql: extra.sql,
		intervalSeconds: extra.intervalSeconds,
		resolution: null,
		stats: { elapsedMs: Math.round(table.elapsedMs), rowsRead: 0, bytesRead: 0 },
		truncated: false,
		...(notice ? { notice } : {}),
	};
}

/** Run a `logs` builder spec for a dashboard panel as `principal`. */
export async function runLogsDatasetQuery(
	ctx: CoreContext,
	principal: Principal,
	spec: BuilderSpec,
	range: { fromMs: number; toMs: number; maxDataPoints: number },
): Promise<QueryResult> {
	const timeSeries = spec.timeSeries && spec.metrics.length > 0;
	const intervalSeconds = timeSeries ? logsIntervalSeconds(spec, range.toMs - range.fromMs, range.maxDataPoints) : Math.max(1, Math.round((range.toMs - range.fromMs) / 1000));
	const q = logsDatasetQueryText(spec, timeSeries ? intervalSeconds : null);
	const { scopes } = builderLogsOf(spec);
	const table = await ctx.logExplorer.table(principal, { q, scopes, from: range.fromMs, to: range.toMs });
	return logTableToQueryResult(table, { sql: q, intervalSeconds, orderBy: spec.orderBy, timeSeries });
}
