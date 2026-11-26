import {
	severityForNumber,
	type BuiltinLogField,
	type LogContextInput,
	type LogContextResult,
	type LogFieldSummary,
	type LogFieldsInput,
	type LogFieldsResult,
	type LogHistogramInput,
	type LogHistogramResult,
	type LogRecord,
	type LogRecordSource,
	type LogScopeKind,
	type LogSearchInput,
	type LogSearchResult,
	type LogSeverity,
	type LogTableResult,
	type LogWarning,
} from '@yoal/contracts';
import { ClickHouseError, type ClickHouseCompactResult } from '../clickhouse.ts';
import { ValidationError } from '../errors.ts';
import type { AdHocQueryOptions, LogTextIndexKind } from '../telemetry.ts';
import {
	FACET_BUILTINS,
	compileBuiltinFacets,
	compileBuiltinSparklines,
	compileContext,
	compileCount,
	compileGet,
	compileHistogram,
	compileMapFacets,
	compileMapKeys,
	compileMapSparklines,
	compileSearch,
	compileTable,
	encodeSearchCursor,
	parseFieldName,
	pickHistogramInterval,
	type BareWordMatch,
	type ClickHouseCompileOptions,
	type CompiledLogQuery,
} from './clickhouse-compiler.ts';
import type { LogReadBoundary, LogStore, LogStoreRead } from './types.ts';

/**
 * `LogStore` over the ClickHouse search index `yoal.logs` (docs/LOGS.md §4.2, §6.3, LP2). Every
 * read is compiled by `clickhouse-compiler.ts` with the boundary ANDed in and runs as the
 * read-only `yoal_reader` with the D101 ad-hoc limits. The store never decides tenancy: the
 * boundary comes from `LogExplorerService`, and an empty one answers nothing without a query.
 */

/** What the store needs from the telemetry store (a `TelemetryStore` satisfies it). */
export interface ClickHouseLogRunner {
	runQuery(sql: string, options: AdHocQueryOptions & { asReader: boolean }): Promise<ClickHouseCompactResult>;
	/** Telemetry is reachable and `yoal.logs` exists. */
	logsReady(): Promise<boolean>;
	readonly logsTextIndex: LogTextIndexKind | null;
}

export interface ClickHouseLogStoreOptions {
	/** Kill switch (`LOG_INDEX`): when false the store reports unhealthy and the Explorer uses lite mode. */
	enabled?: () => boolean;
	bareWordMatch?: BareWordMatch;
	/** The indexer's lag (`LogIndexer.lagMs`); past `INDEX_BEHIND_WARN_MS` reads carry `index_behind`. */
	indexLagMs?: () => number | null;
	now?: () => number;
}

/** Lag beyond which a read that reaches the recent past warns that lines may be missing. */
export const INDEX_BEHIND_WARN_MS = 60_000;

/** Attribute keys the facet sidebar discovers by default (§7.2). */
export const FACET_ATTRIBUTE_KEYS = 30;
/** Buckets in every facet sparkline. */
export const FACET_SPARKLINE_BUCKETS = 20;
const DEFAULT_FACETS: readonly BuiltinLogField[] = ['level', 'service', 'kind', 'source', 'channel', 'deployment', 'node', 'replica'];

type Row = unknown[];

export class ClickHouseLogStore implements LogStore {
	readonly engine = 'clickhouse' as const;
	readonly #runner: ClickHouseLogRunner;
	readonly #options: ClickHouseLogStoreOptions;

	constructor(runner: ClickHouseLogRunner, options: ClickHouseLogStoreOptions = {}) {
		this.#runner = runner;
		this.#options = options;
	}

	/** Enabled, reachable and indexed: the Explorer may route reads here. Never throws. */
	async healthy(): Promise<boolean> {
		if (this.#options.enabled && !this.#options.enabled()) return false;
		try {
			return await this.#runner.logsReady();
		} catch {
			return false;
		}
	}

	async search(read: LogStoreRead, page: Pick<LogSearchInput, 'limit' | 'cursor' | 'order'>): Promise<LogSearchResult> {
		const started = this.#now();
		if (read.boundary.scopes.length === 0)
			return { records: [], cursor: { older: null, newer: page.cursor ?? null }, engine: 'clickhouse', warnings: this.#warnings(read), elapsedMs: 0 };
		const order = page.order ?? 'desc';
		const compiled = compileSearch(read, { limit: page.limit ?? 200, cursor: page.cursor, order }, this.#compileOptions());
		const result = await this.#run(compiled);
		const rows = result.data.map(recordFromRow);
		const more = rows.length > compiled.limit;
		const records = more ? rows.slice(0, compiled.limit) : rows;
		const first = records[0];
		const last = records.at(-1);
		const cursorOf = (record: LogRecord | undefined) => (record ? encodeSearchCursor({ ts: record.ts, id: record.id }) : null);
		const cursor =
			order === 'desc'
				? { older: more ? cursorOf(last) : null, newer: cursorOf(first) ?? page.cursor ?? null }
				: { older: cursorOf(first), newer: cursorOf(last) ?? page.cursor ?? null };
		return { records, cursor, engine: 'clickhouse', warnings: this.#warnings(read), elapsedMs: this.#now() - started };
	}

	async table(read: LogStoreRead): Promise<LogTableResult> {
		const started = this.#now();
		const compiled = compileTable(read, this.#compileOptions());
		if (read.boundary.scopes.length === 0)
			return {
				columns: compiled.columns,
				rows: [],
				...(compiled.sampleIdColumn !== null ? { sampleIds: [] } : {}),
				...(compiled.sparklineColumn != null ? { sparklines: [] } : {}),
				engine: 'clickhouse',
				warnings: [],
				elapsedMs: 0,
			};
		const result = await this.#run(compiled);
		const width = compiled.columns.length;
		const rows = result.data.map((row) => row.slice(0, width).map(cell));
		const table: LogTableResult = { columns: compiled.columns, rows, engine: 'clickhouse', warnings: this.#warnings(read), elapsedMs: this.#now() - started };
		if (compiled.sampleIdColumn !== null) {
			const at = compiled.sampleIdColumn;
			table.sampleIds = result.data.map((row) => (typeof row[at] === 'string' && row[at] ? (row[at] as string) : null));
		}
		if (compiled.sparklineColumn != null) {
			const at = compiled.sparklineColumn;
			table.sparklines = result.data.map((row) => (Array.isArray(row[at]) ? (row[at] as unknown[]).map((count) => Number(count) || 0) : []));
		}
		return table;
	}

	async histogram(read: LogStoreRead, input: Pick<LogHistogramInput, 'buckets'>): Promise<Omit<LogHistogramResult, 'markers'>> {
		const intervalMs = pickHistogramInterval(read.from, read.to, input.buckets ?? 60);
		const start = Math.floor(read.from / intervalMs) * intervalMs;
		const buckets: LogHistogramResult['buckets'] = [];
		const index = new Map<number, LogHistogramResult['buckets'][number]>();
		for (let ts = start; ts <= read.to; ts += intervalMs) {
			const bucket = { ts, counts: {}, total: 0 };
			buckets.push(bucket);
			index.set(ts, bucket);
		}
		let total = 0;
		if (read.boundary.scopes.length > 0) {
			const result = await this.#run(compileHistogram(read, intervalMs, this.#compileOptions()));
			for (const [ts, severity, count] of result.data as Array<[number, string, number]>) {
				const bucket = index.get(Number(ts));
				if (!bucket) continue;
				const band = severity as LogSeverity;
				bucket.counts[band] = (bucket.counts[band] ?? 0) + Number(count);
				bucket.total += Number(count);
				total += Number(count);
			}
		}
		return { from: read.from, to: read.to, intervalMs, buckets, total, engine: 'clickhouse', warnings: this.#warnings(read) };
	}

	async fields(read: LogStoreRead, input: Pick<LogFieldsInput, 'fields' | 'topValues'>): Promise<LogFieldsResult> {
		if (read.boundary.scopes.length === 0) return { fields: [], total: 0, engine: 'clickhouse', warnings: [] };
		const options = this.#compileOptions();
		const top = input.topValues ?? 10;
		const builtins: BuiltinLogField[] = [];
		const attributeKeys: string[] = [];
		const resourceKeys: string[] = [];
		if (input.fields?.length) {
			for (const name of input.fields) {
				const field = parseFieldName(name);
				if (!field || field.kind !== 'ref') throw new ValidationError(`Unknown field "${name}"`);
				const ref = field.ref;
				if (ref.kind === 'builtin') {
					if (!FACET_BUILTINS.some((facet) => facet.name === ref.name)) throw new ValidationError(`No facet for "${name}"`);
					builtins.push(ref.name);
				} else (ref.kind === 'attribute' ? attributeKeys : resourceKeys).push(ref.key);
			}
		} else builtins.push(...DEFAULT_FACETS);

		const countResult = await this.#run(compileCount(read, options));
		const total = Number(countResult.data[0]?.[0] ?? 0);
		if (!input.fields?.length) {
			// Discovered keys keep their mapKeys order: most common first.
			const keys = await this.#run(compileMapKeys(read, 'attributes', FACET_ATTRIBUTE_KEYS, options));
			for (const [key] of keys.data as Array<[string, number]>) attributeKeys.push(key);
		}

		// The server buckets on epoch-aligned intervals; each bucket is placed by its start relative to
		// `from`, so every field's sparkline has the same FACET_SPARKLINE_BUCKETS slots.
		const intervalMs = Math.max(1_000, Math.ceil((read.to - read.from + 1) / FACET_SPARKLINE_BUCKETS));
		const bucketOf = (ts: number) => Math.min(FACET_SPARKLINE_BUCKETS - 1, Math.max(0, Math.floor((ts - read.from) / intervalMs)));
		const summaries: LogFieldSummary[] = [];

		const collect = async (
			kind: LogFieldSummary['kind'],
			names: string[],
			valuesQuery: CompiledLogQuery,
			sparkQuery: CompiledLogQuery,
			label: (name: string) => string,
			fixedType?: (name: string) => 'string' | 'number',
		) => {
			if (names.length === 0) return;
			const [values, sparks] = await Promise.all([this.#run(valuesQuery), this.#run(sparkQuery)]);
			const byName = new Map<string, LogFieldSummary>();
			for (const name of names)
				byName.set(name, { name: label(name), kind, type: 'string', present: 0, topValues: [], sparkline: new Array(FACET_SPARKLINE_BUCKETS).fill(0) });
			for (const [name, value, count] of values.data as Array<[string, string, number]>)
				byName.get(name)?.topValues.push({ value: String(value), count: Number(count) });
			for (const [name, ts, count] of sparks.data as Array<[string, number, number]>) {
				const summary = byName.get(name);
				if (!summary) continue;
				summary.present += Number(count);
				summary.sparkline![bucketOf(Number(ts))]! += Number(count);
			}
			for (const [name, summary] of byName) {
				summary.type =
					fixedType?.(name) ??
					(summary.topValues.length > 0 && summary.topValues.every((entry) => /^-?\d+(\.\d+)?$/.test(entry.value)) ? 'number' : 'string');
				summaries.push(summary);
			}
		};

		await collect(
			'builtin',
			builtins,
			compileBuiltinFacets(read, builtins, top, options),
			compileBuiltinSparklines(read, builtins, intervalMs, options),
			(name) => name,
			(name) => FACET_BUILTINS.find((facet) => facet.name === name)?.type ?? 'string',
		);
		await collect(
			'attribute',
			attributeKeys,
			compileMapFacets(read, 'attributes', attributeKeys, top, options),
			compileMapSparklines(read, 'attributes', attributeKeys, intervalMs, options),
			(key) => `@${key}`,
		);
		await collect(
			'resource',
			resourceKeys,
			compileMapFacets(read, 'resource', resourceKeys, top, options),
			compileMapSparklines(read, 'resource', resourceKeys, intervalMs, options),
			(key) => `resource.${key}`,
		);
		return { fields: summaries, total, engine: 'clickhouse', warnings: this.#warnings(read) };
	}

	async context(boundary: LogReadBoundary, input: LogContextInput): Promise<LogContextResult> {
		const anchor = await this.get(boundary, input.id);
		if (!anchor) return { anchor: null, before: [], after: [], engine: 'clickhouse' };
		const ref = { ts: anchor.ts, id: anchor.id, scopeKind: anchor.scope.kind, scopeId: anchor.scope.id, stream: anchor.stream };
		const [before, after] = await Promise.all([
			(input.before ?? 50) > 0 ? this.#run(compileContext(boundary, ref, 'before', input.before ?? 50)) : null,
			(input.after ?? 50) > 0 ? this.#run(compileContext(boundary, ref, 'after', input.after ?? 50)) : null,
		]);
		return {
			anchor,
			before: (before?.data.map(recordFromRow) ?? []).reverse(),
			after: after?.data.map(recordFromRow) ?? [],
			engine: 'clickhouse',
		};
	}

	async get(boundary: LogReadBoundary, id: string): Promise<LogRecord | null> {
		if (boundary.scopes.length === 0) return null;
		const result = await this.#run(compileGet(boundary, id));
		const row = result.data[0];
		return row ? recordFromRow(row) : null;
	}

	/**
	 * Raw reads for Compare and Why? (`log-analysis.ts` compiles them with `clickhouse-analysis.ts`
	 * and classifies the rows). Same runner, reader role and limits as every other read.
	 */
	async analysis(compile: (options: ClickHouseCompileOptions) => CompiledLogQuery): Promise<unknown[][]> {
		return (await this.#run(compile(this.#compileOptions()))).data;
	}

	/** Index-lag warnings for an analysis read over `read`'s window. */
	analysisWarnings(read: LogStoreRead): LogWarning[] {
		return this.#warnings(read);
	}

	/** `index_behind` when the indexer lags and the read reaches lines it has not copied yet (§4.2). */
	#warnings(read: LogStoreRead): LogWarning[] {
		const lag = this.#options.indexLagMs?.() ?? null;
		if (lag === null || lag < INDEX_BEHIND_WARN_MS || read.to < this.#now() - lag) return [];
		const minutes = Math.max(1, Math.round(lag / 60_000));
		return [{ code: 'index_behind', message: `The search index is ${minutes} minute${minutes === 1 ? '' : 's'} behind; the newest lines may be missing.` }];
	}

	#compileOptions(): ClickHouseCompileOptions {
		return { textIndex: this.#runner.logsTextIndex, bareWordMatch: this.#options.bareWordMatch };
	}

	#now(): number {
		return (this.#options.now ?? Date.now)();
	}

	/** Runs as the reader; a query the server rejects (bad regex, limits) is the caller's 422. */
	async #run(compiled: CompiledLogQuery): Promise<ClickHouseCompactResult> {
		try {
			return await this.#runner.runQuery(compiled.sql, { asReader: true, params: compiled.params });
		} catch (error) {
			if (error instanceof ClickHouseError && error.isQueryError) throw new ValidationError(`Log query failed: ${error.message}`);
			throw error;
		}
	}
}

function cell(value: unknown): string | number | null {
	if (value === null || value === undefined) return null;
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value === 'string') return value;
	if (typeof value === 'bigint') return Number(value);
	if (typeof value === 'boolean') return value ? 1 : 0;
	return JSON.stringify(value);
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function orNull(value: unknown): string | null {
	const s = text(value);
	return s === '' ? null : s;
}

function stringMap(value: unknown): Record<string, string> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = text(entry);
	return out;
}

/** A row in `RECORD_SELECT` order → `LogRecord`. */
export function recordFromRow(row: Row): LogRecord {
	const [
		id,
		ts,
		observed,
		orgId,
		scopeKind,
		scopeId,
		stream,
		source,
		channel,
		severityNumber,
		body,
		attributes,
		resource,
		traceId,
		spanId,
		requestId,
		patternId,
		projectId,
		deploymentId,
		buildId,
		jobRunId,
		nodeId,
		replica,
	] = row;
	const severity = Number(severityNumber) || 9;
	const resources = stringMap(resource);
	const replicaNumber = Number(replica);
	const channelText = text(channel);
	const tsMs = Number(ts);
	const observedMs = Number(observed);
	return {
		id: text(id),
		ts: tsMs,
		observedTs: Number.isFinite(observedMs) && observedMs > 0 ? observedMs : null,
		orgId: text(orgId),
		scope: { kind: text(scopeKind) as LogScopeKind, id: text(scopeId) },
		scopeName: resources['service.name'] || null,
		stream: orNull(stream),
		source: text(source) as LogRecordSource,
		channel: channelText === 'stdout' || channelText === 'stderr' || channelText === 'system' ? channelText : null,
		severityNumber: severity,
		severity: severityForNumber(severity),
		body: text(body),
		attributes: stringMap(attributes),
		resource: resources,
		traceId: orNull(traceId),
		spanId: orNull(spanId),
		requestId: orNull(requestId),
		patternId: orNull(patternId),
		projectId: orNull(projectId),
		deploymentId: orNull(deploymentId),
		buildId: orNull(buildId),
		jobRunId: orNull(jobRunId),
		nodeId: orNull(nodeId),
		replica: Number.isFinite(replicaNumber) && replicaNumber >= 0 ? replicaNumber : null,
	};
}
