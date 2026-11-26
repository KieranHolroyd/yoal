import type { Database, SQLQueryBindings } from 'bun:sqlite';
import {
	formatLogScope,
	logSeverities,
	type LogAggregation,
	type LogContextInput,
	type LogContextResult,
	type LogFieldRef,
	type LogFieldSummary,
	type LogFieldsInput,
	type LogFieldsResult,
	type LogGroupBy,
	type LogHistogramInput,
	type LogHistogramResult,
	type LogRecord,
	type LogScopeKind,
	type LogScopeRef,
	type LogSearchInput,
	type LogSearchResult,
	type LogSeverity,
	type LogTableResult,
	type BuiltinLogField,
} from '@yoal/contracts';
import {
	builtinGroupExpression,
	compileSourceWhere,
	compileSqliteFilter,
	GROUPABLE_BUILTINS,
	SEVERITY_TEXT_SQL,
	type SqlFragment,
	type SqlParam,
} from './sqlite-compiler.ts';
import {
	parseSqliteLogId,
	SQLITE_LOG_SOURCES,
	unifiedRowToLogRecord,
	type SqliteLogSource,
	type SqliteLogTag,
	type UnifiedLogRow,
} from './sqlite-sources.ts';
import { LogStoreUnsupported, type LogReadBoundary, type LogStore, type LogStoreRead } from './types.ts';

/**
 * Lite mode (docs/LOGS.md §0, §6.3): every read is a UNION ALL over the hot-tail adapters in
 * `sqlite-sources.ts`, with the server-chosen boundary, the time range and the compiled filter
 * ANDed into each branch. Tables that cannot hold a boundary scope are skipped entirely.
 *
 * Paging is keyset on `(ts, tag, seq)`, encoded as an opaque cursor, in both directions. Live tail
 * catch-up uses a per-table seq vector instead (`tailCatchUp`), because event time is parsed from
 * the line and a late row can carry an older `ts` than one already sent (§4.4).
 */

/** An opaque search cursor's position. */
export interface LogCursorPosition {
	ts: number;
	tag: SqliteLogTag;
	seq: number;
}

/** Highest seq per hot-tail table: the live-tail resume point (`Last-Event-ID`). */
export type LogSeqVector = Partial<Record<SqliteLogTag, number>>;

export class InvalidLogCursorError extends Error {
	constructor() {
		super('The cursor is not valid. Start again without one.');
		this.name = 'InvalidLogCursorError';
	}
}

const TAGS = new Set<string>(SQLITE_LOG_SOURCES.map((source) => source.tag));

function base64url(text: string): string {
	return Buffer.from(text, 'utf8').toString('base64url');
}

function fromBase64url(text: string): unknown {
	try {
		return JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as unknown;
	} catch {
		return null;
	}
}

export function encodeLogCursor(position: LogCursorPosition): string {
	return `p.${base64url(JSON.stringify([position.ts, position.tag, position.seq]))}`;
}

export function decodeLogCursor(cursor: string): LogCursorPosition {
	if (!cursor.startsWith('p.')) throw new InvalidLogCursorError();
	const value = fromBase64url(cursor.slice(2));
	if (!Array.isArray(value) || value.length !== 3) throw new InvalidLogCursorError();
	const [ts, tag, seq] = value as [unknown, unknown, unknown];
	if (typeof ts !== 'number' || !Number.isSafeInteger(ts)) throw new InvalidLogCursorError();
	if (typeof tag !== 'string' || !TAGS.has(tag)) throw new InvalidLogCursorError();
	if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) throw new InvalidLogCursorError();
	return { ts, tag: tag as SqliteLogTag, seq };
}

export function encodeTailCursor(vector: LogSeqVector): string {
	const compact: Record<string, number> = {};
	for (const source of SQLITE_LOG_SOURCES) {
		const seq = vector[source.tag];
		if (seq !== undefined && seq > 0) compact[source.tag] = seq;
	}
	return `t.${base64url(JSON.stringify(compact))}`;
}

/** Null for anything that is not a tail cursor (a fresh subscriber starts at "now"). */
export function decodeTailCursor(cursor: string | null | undefined): LogSeqVector | null {
	if (!cursor || !cursor.startsWith('t.')) return null;
	const value = fromBase64url(cursor.slice(2));
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const vector: LogSeqVector = {};
	for (const [tag, seq] of Object.entries(value as Record<string, unknown>)) {
		if (!TAGS.has(tag) || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return null;
		vector[tag as SqliteLogTag] = seq;
	}
	return vector;
}

function positionOf(record: LogRecord): LogCursorPosition {
	const parsed = parseSqliteLogId(record.id);
	return { ts: record.ts, tag: parsed?.tag ?? 'lr', seq: parsed?.seq ?? 0 };
}

/** Round histogram intervals, smallest first. */
const NICE_INTERVALS_MS = [
	1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
	3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000, 172_800_000, 604_800_000,
];

export function pickHistogramInterval(from: number, to: number, buckets: number): number {
	const span = Math.max(1, to - from);
	const target = span / Math.max(1, buckets);
	return NICE_INTERVALS_MS.find((interval) => interval >= target) ?? NICE_INTERVALS_MS.at(-1)!;
}

/** Built-ins `/fields` summarises in lite mode, in display order. */
const FIELD_SUMMARY_DEFAULTS: readonly BuiltinLogField[] = [
	'level',
	'source',
	'kind',
	'service',
	'stream',
	'channel',
	'deployment',
	'node',
	'build',
	'job',
	'replica',
];

const MAX_TABLE_ROWS = 10_000;

export class SqliteLogStore implements LogStore {
	readonly engine = 'sqlite' as const;

	constructor(
		private readonly sqlite: Database,
		private readonly sources: readonly SqliteLogSource[] = SQLITE_LOG_SOURCES,
	) {}

	// ---------------------------------------------------------------- rows

	async search(
		read: LogStoreRead,
		page: Pick<LogSearchInput, 'limit' | 'cursor' | 'order'>,
	): Promise<LogSearchResult> {
		const started = performance.now();
		if (read.ast.pipes.length > 0)
			throw new Error('SqliteLogStore.search takes no pipe stages; use table().');
		const limit = Math.max(1, Math.min(Math.floor(page.limit ?? 200), MAX_TABLE_ROWS));
		const order = page.order ?? 'desc';
		const cursor = page.cursor ? decodeLogCursor(page.cursor) : null;
		const direction = order === 'desc' ? 'DESC' : 'ASC';
		const comparison = order === 'desc' ? '<' : '>';
		const filter = compileSqliteFilter(read.ast.filter);
		const extra: SqlFragment[] = cursor
			? [{ sql: `(u.ts, u.tag, u.seq) ${comparison} (?, ?, ?)`, params: [cursor.ts, cursor.tag, cursor.seq] }]
			: [];
		const branches: SqlFragment[] = [];
		for (const source of this.sources) {
			const where = compileSourceWhere(source, read.boundary, filter, read, extra);
			if (!where) continue;
			branches.push({
				sql: `SELECT * FROM (${where.sql} ORDER BY u.ts ${direction}, u.seq ${direction} LIMIT ?)`,
				params: [...where.params, limit + 1],
			});
		}
		const rows = branches.length
			? this.all<UnifiedLogRow>(
					`${branches.map((branch) => branch.sql).join('\nUNION ALL\n')}
					 ORDER BY ts ${direction}, tag ${direction}, seq ${direction} LIMIT ?`,
					[...branches.flatMap((branch) => branch.params), limit + 1],
				)
			: [];
		const hasMore = rows.length > limit;
		const records = rows.slice(0, limit).map(unifiedRowToLogRecord);
		const first = records[0];
		const last = records.at(-1);
		const cursors =
			order === 'desc'
				? {
						older: hasMore && last ? encodeLogCursor(positionOf(last)) : null,
						newer: first ? encodeLogCursor(positionOf(first)) : (page.cursor ?? null),
					}
				: {
						older: first ? encodeLogCursor(positionOf(first)) : null,
						newer: last ? encodeLogCursor(positionOf(last)) : (page.cursor ?? null),
					};
		return {
			records,
			cursor: cursors,
			engine: this.engine,
			warnings: [],
			elapsedMs: Math.round(performance.now() - started),
		};
	}

	/** One record by id, inside the boundary. */
	async get(boundary: LogReadBoundary, id: string): Promise<LogRecord | null> {
		const row = this.rowById(boundary, id);
		return row ? unifiedRowToLogRecord(row) : null;
	}

	/** Lines around a record in the same stream (or the same scope when it has no stream). */
	async context(boundary: LogReadBoundary, input: LogContextInput): Promise<LogContextResult> {
		const anchorRow = this.rowById(boundary, input.id);
		if (!anchorRow) return { anchor: null, before: [], after: [], engine: this.engine };
		const source = this.sources.find((candidate) => candidate.tag === anchorRow.tag)!;
		const same: SqlFragment = {
			sql: `u.scope_kind = ? AND u.scope_id = ? AND ${anchorRow.stream === null ? 'u.stream IS NULL' : 'u.stream = ?'}`,
			params:
				anchorRow.stream === null
					? [anchorRow.scope_kind, anchorRow.scope_id]
					: [anchorRow.scope_kind, anchorRow.scope_id, anchorRow.stream],
		};
		const read = (comparison: '<' | '>', count: number): UnifiedLogRow[] => {
			if (count <= 0) return [];
			const where = compileSourceWhere(source, boundary, { sql: '1', params: [] }, null, [
				same,
				{ sql: `u.seq ${comparison} ?`, params: [anchorRow.seq] },
			]);
			if (!where) return [];
			const direction = comparison === '<' ? 'DESC' : 'ASC';
			return this.all<UnifiedLogRow>(`${where.sql} ORDER BY u.seq ${direction} LIMIT ?`, [...where.params, count]);
		};
		const before = read('<', input.before ?? 50).reverse().map(unifiedRowToLogRecord);
		const after = read('>', input.after ?? 50).map(unifiedRowToLogRecord);
		return { anchor: unifiedRowToLogRecord(anchorRow), before, after, engine: this.engine };
	}

	// ---------------------------------------------------------------- aggregates

	async histogram(
		read: LogStoreRead,
		input: Pick<LogHistogramInput, 'buckets'>,
	): Promise<Omit<LogHistogramResult, 'markers'>> {
		const intervalMs = pickHistogramInterval(read.from, read.to, input.buckets ?? 60);
		const union = this.union(read);
		const counts = new Map<number, Partial<Record<LogSeverity, number>>>();
		let total = 0;
		if (union) {
			const rows = this.all<{ bucket: number; severity: LogSeverity; n: number }>(
				`SELECT (u.ts / ?) * ? AS bucket, ${SEVERITY_TEXT_SQL} AS severity, COUNT(*) AS n
				 FROM (${union.sql}) u GROUP BY bucket, severity`,
				[intervalMs, intervalMs, ...union.params],
			);
			for (const row of rows) {
				const bucket = counts.get(row.bucket) ?? {};
				bucket[row.severity] = (bucket[row.severity] ?? 0) + row.n;
				counts.set(row.bucket, bucket);
				total += row.n;
			}
		}
		const buckets: LogHistogramResult['buckets'] = [];
		const first = Math.floor(read.from / intervalMs) * intervalMs;
		for (let ts = first; ts <= read.to && buckets.length < 2_000; ts += intervalMs) {
			const bucket = counts.get(ts) ?? {};
			let bucketTotal = 0;
			for (const severity of logSeverities) bucketTotal += bucket[severity] ?? 0;
			buckets.push({ ts, counts: bucket, total: bucketTotal });
		}
		return { from: read.from, to: read.to, intervalMs, buckets, total, engine: this.engine, warnings: [] };
	}

	/** Top values for the built-ins (lite mode has no attribute discovery). */
	async fields(read: LogStoreRead, input: Pick<LogFieldsInput, 'fields' | 'topValues'>): Promise<LogFieldsResult> {
		const union = this.union(read);
		const topValues = Math.max(1, Math.min(input.topValues ?? 10, 50));
		const requested = input.fields?.length ? input.fields.map((name) => name.trim().toLowerCase()) : FIELD_SUMMARY_DEFAULTS;
		const names: BuiltinLogField[] = [];
		const skipped: string[] = [];
		for (const name of requested) {
			const normalised = name === 'message' ? 'body' : name;
			if ((FIELD_SUMMARY_DEFAULTS as readonly string[]).includes(normalised) || GROUPABLE_BUILTINS.includes(normalised as BuiltinLogField))
				names.push(normalised as BuiltinLogField);
			else skipped.push(name);
		}
		const total = union
			? (this.get1<{ n: number }>(`SELECT COUNT(*) AS n FROM (${union.sql}) u`, union.params)?.n ?? 0)
			: 0;
		const fields: LogFieldSummary[] = [];
		for (const name of [...new Set(names)]) {
			if (!union) {
				fields.push({ name, kind: 'builtin', type: name === 'replica' ? 'number' : 'string', present: 0, topValues: [] });
				continue;
			}
			if (name === 'service') {
				fields.push(this.serviceSummary(union, topValues));
				continue;
			}
			const expression = builtinGroupExpression(name);
			if (!expression) continue;
			const rows = this.all<{ value: string | number; n: number }>(
				`SELECT ${expression} AS value, COUNT(*) AS n FROM (${union.sql}) u
				 WHERE ${expression} IS NOT NULL GROUP BY value ORDER BY n DESC, value LIMIT ?`,
				[...union.params, topValues],
			);
			const present =
				name === 'level'
					? total
					: (this.get1<{ n: number }>(
							`SELECT COUNT(*) AS n FROM (${union.sql}) u WHERE ${expression} IS NOT NULL`,
							union.params,
						)?.n ?? 0);
			fields.push({
				name,
				kind: 'builtin',
				type: name === 'replica' ? 'number' : 'string',
				present,
				topValues: rows.map((row) => ({ value: String(row.value), count: row.n })),
			});
		}
		return {
			fields,
			total,
			engine: this.engine,
			warnings: skipped.length
				? [
						{
							code: 'needs_clickhouse',
							message: `Field summaries for ${skipped.join(', ')} need the search index (ClickHouse).`,
						},
					]
				: [],
		};
	}

	/**
	 * Lite-mode pipe stages: `| stats count() by [bin(x)][, built-in…]`, `| sort`, `| limit`. Every
	 * other stage or aggregation needs ClickHouse.
	 */
	async table(read: LogStoreRead): Promise<LogTableResult> {
		const started = performance.now();
		let stats: { aggregations: LogAggregation[]; by: LogGroupBy[] } | null = null;
		let sort: { key: string; direction: 'asc' | 'desc' } | null = null;
		let limit: number | null = null;
		for (const stage of read.ast.pipes) {
			switch (stage.type) {
				case 'stats':
					if (stats) throw new LogStoreUnsupported('Lite mode runs one `| stats` stage.', 'stats');
					stats = stage;
					break;
				case 'sort':
					sort = stage;
					break;
				case 'limit':
					limit = stage.count;
					break;
				case 'patterns':
					throw new LogStoreUnsupported('`| patterns` needs the search index (ClickHouse).', 'patterns');
				default:
					throw new LogStoreUnsupported(`\`| ${stage.type}\` needs the search index (ClickHouse).`, 'stats');
			}
		}
		if (!stats) throw new LogStoreUnsupported('Lite mode answers `| stats count() by …` only.', 'stats');
		for (const aggregation of stats.aggregations)
			if (aggregation.fn !== 'count' || aggregation.field)
				throw new LogStoreUnsupported(`\`${aggregation.alias}\` needs the search index (ClickHouse); lite mode has count().`, 'stats');

		const columns: LogTableResult['columns'] = [];
		const selects: string[] = [];
		const groupParams: SqlParam[] = [];
		const aliases: string[] = [];
		for (const [index, group] of stats.by.entries()) {
			const alias = `g${index}`;
			if (group.type === 'bin') {
				selects.push(`(u.ts / ?) * ? AS ${alias}`);
				groupParams.push(group.intervalMs, group.intervalMs);
				columns.push({ name: group.alias, type: 'time' });
			} else {
				const expression = groupExpression(group.field);
				selects.push(`${expression} AS ${alias}`);
				columns.push({ name: group.alias, type: group.field.kind === 'builtin' && group.field.name === 'replica' ? 'number' : 'string' });
			}
			aliases.push(alias);
		}
		for (const [index, aggregation] of stats.aggregations.entries()) {
			selects.push(`COUNT(*) AS a${index}`);
			columns.push({ name: aggregation.alias, type: 'number' });
		}
		const keyToColumn = new Map<string, string>();
		stats.by.forEach((group, index) => keyToColumn.set(group.alias.toLowerCase(), `g${index}`));
		stats.aggregations.forEach((aggregation, index) => keyToColumn.set(aggregation.alias.toLowerCase(), `a${index}`));
		let orderBy: string;
		if (sort) {
			const column = keyToColumn.get(sort.key.toLowerCase());
			if (!column) throw new LogStoreUnsupported(`Lite mode sorts by an output column; \`${sort.key}\` is not one.`, 'stats');
			orderBy = `${column} ${sort.direction === 'desc' ? 'DESC' : 'ASC'}`;
		} else {
			const bin = stats.by.findIndex((group) => group.type === 'bin');
			orderBy = bin >= 0 ? `g${bin} ASC` : 'a0 DESC';
		}
		const rowLimit = Math.max(1, Math.min(limit ?? MAX_TABLE_ROWS, MAX_TABLE_ROWS));
		const union = this.union({ ...read, ast: { filter: read.ast.filter, pipes: [] } });
		const rows = union
			? this.all<Record<string, string | number | null>>(
					`SELECT ${selects.join(', ')} FROM (${union.sql}) u
					 ${aliases.length ? `GROUP BY ${aliases.join(', ')}` : ''} ORDER BY ${[orderBy, ...aliases].join(', ')} LIMIT ?`,
					[...groupParams, ...union.params, rowLimit],
				)
			: [];
		const order = [...aliases, ...stats.aggregations.map((_, index) => `a${index}`)];
		return {
			columns,
			rows: rows.map((row) => order.map((key) => row[key] ?? null)),
			engine: this.engine,
			warnings: [],
			elapsedMs: Math.round(performance.now() - started),
		};
	}

	// ---------------------------------------------------------------- live tail

	/** The newest seq of every hot-tail table: where a fresh live tail starts. */
	maxSeqVector(): LogSeqVector {
		const vector: LogSeqVector = {};
		for (const source of this.sources)
			vector[source.tag] = this.get1<{ seq: number | null }>(`SELECT MAX(seq) AS seq FROM ${source.table}`, [])?.seq ?? 0;
		return vector;
	}

	/**
	 * Rows inserted after `after` and up to `upTo` (per-table seqs) that match the read, newest
	 * `limit` of them, returned oldest first. `total` counts every match, so a caller that is too
	 * far behind can emit a "sampled" marker for the difference (§4.4).
	 */
	tailCatchUp(
		read: LogStoreRead,
		after: LogSeqVector,
		upTo: LogSeqVector,
		limit: number,
		options: { count?: boolean } = {},
	): { records: LogRecord[]; total: number } {
		const filter = compileSqliteFilter(read.ast.filter);
		const branches: SqlFragment[] = [];
		for (const source of this.sources) {
			const low = after[source.tag] ?? 0;
			const high = upTo[source.tag] ?? 0;
			if (high <= low) continue;
			const where = compileSourceWhere(source, read.boundary, filter, read, [
				{ sql: 'u.seq > ? AND u.seq <= ?', params: [low, high] },
			]);
			if (where) branches.push(where);
		}
		if (branches.length === 0 || limit <= 0) return { records: [], total: 0 };
		const union = {
			sql: branches.map((branch) => branch.sql).join('\nUNION ALL\n'),
			params: branches.flatMap((branch) => branch.params),
		};
		const rows = this.all<UnifiedLogRow>(`SELECT * FROM (${union.sql}) ORDER BY ts DESC, tag DESC, seq DESC LIMIT ?`, [
			...union.params,
			limit,
		]);
		const total = options.count
			? (this.get1<{ n: number }>(`SELECT COUNT(*) AS n FROM (${union.sql})`, union.params)?.n ?? rows.length)
			: rows.length;
		return { records: rows.reverse().map(unifiedRowToLogRecord), total };
	}

	// ---------------------------------------------------------------- helpers

	private rowById(boundary: LogReadBoundary, id: string): UnifiedLogRow | null {
		const parsed = parseSqliteLogId(id);
		if (!parsed) return null;
		const source = this.sources.find((candidate) => candidate.tag === parsed.tag);
		if (!source) return null;
		const where = compileSourceWhere(source, boundary, { sql: '1', params: [] }, null, [
			{ sql: 'u.seq = ?', params: [parsed.seq] },
		]);
		if (!where) return null;
		return this.get1<UnifiedLogRow>(where.sql, where.params);
	}

	/** Every in-boundary branch, filtered and time-bounded, as one UNION ALL (or null for none). */
	private union(read: LogStoreRead): SqlFragment | null {
		const filter = compileSqliteFilter(read.ast.filter);
		const branches: SqlFragment[] = [];
		for (const source of this.sources) {
			const where = compileSourceWhere(source, read.boundary, filter, read);
			if (where) branches.push(where);
		}
		if (branches.length === 0) return null;
		return {
			sql: branches.map((branch) => branch.sql).join('\nUNION ALL\n'),
			params: branches.flatMap((branch) => branch.params),
		};
	}

	private serviceSummary(union: SqlFragment, topValues: number): LogFieldSummary {
		const rows = this.all<{ scope_kind: string; scope_id: string; n: number }>(
			`SELECT u.scope_kind, u.scope_id, COUNT(*) AS n FROM (${union.sql}) u
			 GROUP BY u.scope_kind, u.scope_id ORDER BY n DESC LIMIT ?`,
			[...union.params, topValues],
		);
		const names = lookupLogScopeNames(
			this.sqlite,
			rows.map((row) => ({ kind: row.scope_kind as LogScopeKind, id: row.scope_id })),
		);
		const counts = new Map<string, number>();
		let present = 0;
		for (const row of rows) {
			const name = names.get(`${row.scope_kind}:${row.scope_id}`) ?? row.scope_id;
			counts.set(name, (counts.get(name) ?? 0) + row.n);
			present += row.n;
		}
		return {
			name: 'service',
			kind: 'builtin',
			type: 'string',
			present,
			topValues: [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count),
		};
	}

	/**
	 * Statements here are built per read (scope lists vary), so they are prepared and finalised
	 * rather than kept in `query()`'s statement cache.
	 */
	private all<T>(sql: string, params: SqlParam[]): T[] {
		const statement = this.sqlite.prepare<T, SQLQueryBindings[]>(sql);
		try {
			return statement.all(...(params as SQLQueryBindings[]));
		} finally {
			statement.finalize();
		}
	}

	private get1<T>(sql: string, params: SqlParam[]): T | null {
		const statement = this.sqlite.prepare<T, SQLQueryBindings[]>(sql);
		try {
			return statement.get(...(params as SQLQueryBindings[])) ?? null;
		} finally {
			statement.finalize();
		}
	}
}

function groupExpression(field: LogFieldRef): string {
	if (field.kind !== 'builtin')
		throw new LogStoreUnsupported('Grouping by an attribute needs the search index (ClickHouse).', 'attributes');
	const expression = builtinGroupExpression(field.name);
	if (!expression)
		throw new LogStoreUnsupported(`Grouping by \`${field.name}\` needs the search index (ClickHouse).`, 'stats');
	return expression;
}

/** Name lookups per scope kind, batched. Key: `kind:id`. */
const NAME_LOOKUPS: Partial<Record<LogScopeKind, string>> = {
	project: 'SELECT id, slug AS name FROM projects WHERE id IN',
	function: 'SELECT id, slug AS name FROM projects WHERE id IN',
	database: 'SELECT id, name FROM databases WHERE id IN',
	storage: 'SELECT id, name FROM storage_instances WHERE id IN',
	broker: 'SELECT id, name FROM brokers WHERE id IN',
	k8s: 'SELECT id, name FROM k8s_clusters WHERE id IN',
	pipeline: 'SELECT id, name FROM pipeline_repositories WHERE id IN',
	platform: 'SELECT id, name FROM nodes WHERE id IN',
	edge: 'SELECT id, name FROM nodes WHERE id IN',
};

/** Display names for scopes (`scopeName`), one query per kind. */
export function lookupLogScopeNames(sqlite: Database, scopes: readonly LogScopeRef[]): Map<string, string> {
	const byKind = new Map<LogScopeKind, Set<string>>();
	for (const scope of scopes) {
		const ids = byKind.get(scope.kind) ?? new Set<string>();
		ids.add(scope.id);
		byKind.set(scope.kind, ids);
	}
	const names = new Map<string, string>();
	for (const [kind, ids] of byKind) {
		const lookup = NAME_LOOKUPS[kind];
		if (!lookup) continue;
		const list = [...ids];
		for (let index = 0; index < list.length; index += 500) {
			const chunk = list.slice(index, index + 500);
			const statement = sqlite.prepare<{ id: string; name: string }, string[]>(
				`${lookup} (${chunk.map(() => '?').join(', ')})`,
			);
			try {
				for (const row of statement.all(...chunk)) names.set(formatLogScope({ kind, id: row.id }), row.name);
			} finally {
				statement.finalize();
			}
		}
	}
	return names;
}
