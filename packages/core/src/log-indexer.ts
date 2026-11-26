import type { LogRecord } from '@yoal/contracts';
import { ClickHouseError, ClickHouseUnavailableError, type ClickHouseCompactResult, type ClickHouseSettings } from './clickhouse.ts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { enrichRecord } from './log-enrich.ts';
import { SqlParams } from './log-store/clickhouse-compiler.ts';
import { SQLITE_LOG_SOURCES, unifiedRowToLogRecord, type SqliteLogSource, type UnifiedLogRow } from './log-store/sqlite-sources.ts';
import { chDateTime64, type AdHocQueryOptions } from './telemetry.ts';

/**
 * The search-index indexer (docs/LOGS.md §4.2, LP2). A control-plane loop built like the drain
 * worker (`log-drains.ts`): one cursor per hot-tail table in `log_index_cursors` (migration 0142),
 * batches of up to 5,000 rows after it, mapped to `LogRecord`, enriched (§4.3), optionally given a
 * Drain template id (§8.1), and inserted into ClickHouse `yoal.logs`.
 *
 * - **At least once, idempotent.** Each insert carries `insert_deduplication_token =
 *   <table>:<from>-<to>`, and a failed batch is retried over exactly the same seq range (kept in
 *   memory), so a replay after a lost acknowledgement is dropped by ClickHouse. A crash between the
 *   acknowledgement and the cursor write can re-read a longer range under a new token; that is the
 *   one window where a line can be indexed twice, never lost.
 * - **The cursor moves only after ClickHouse acknowledges.** The move is conditional on the old
 *   value, so a second process never rewinds or skips it.
 * - **Fail-open.** An unreachable ClickHouse stalls the cursors (with `last_error` set and an
 *   exponential backoff) and `lagMs()` grows; ingest, live tail and drains never notice. A batch
 *   the server keeps rejecting as malformed is skipped after a few attempts and counted in
 *   `last_error`, so one bad row cannot stall a table forever.
 * - **Never reindexes history.** A table seen for the first time starts `startBacklogRows` behind
 *   its newest row.
 * - Off when telemetry is not installed, and behind the `LOG_INDEX` kill switch.
 */

/** Injected by integration from the pattern miner lane (docs/LOGS.md §8.1). */
export interface PatternMiner {
	patternFor(scopeKey: string, body: string): { id: string; template: string };
}

/** What the indexer needs from the telemetry store (a `TelemetryStore` satisfies it). */
export interface LogIndexWriter {
	/** The optional telemetry store is installed on this host. */
	readonly installed: boolean;
	/** Reachable, and `yoal.logs` exists. */
	logsReady(): Promise<boolean>;
	insertLogRows(table: 'logs' | 'log_patterns', rows: ReadonlyArray<Record<string, unknown>>, settings?: ClickHouseSettings): Promise<void>;
	runQuery(sql: string, options: AdHocQueryOptions & { asReader: boolean }): Promise<ClickHouseCompactResult>;
}

export interface LogIndexerOptions {
	miner?: PatternMiner | null;
	/** Rows per insert (default 5,000, §4.2). */
	batchRows?: number;
	/** Batches per table per tick, so a lagging index catches up (default 20). */
	batchesPerTick?: number;
	/** Where a table's first cursor starts: this many rows behind its newest (default 50,000). */
	startBacklogRows?: number;
	/** Kill switch; defaults to the `LOG_INDEX` feature flag. */
	enabled?: () => boolean;
	sources?: readonly SqliteLogSource[];
	/**
	 * False keeps an (enriched) record out of ClickHouse: `index_only` rules (docs/LOGS.md §10.3,
	 * Lane C). Defaults to `ctx.logRules.keepInIndex` when the context has it.
	 */
	filter?: (record: LogRecord) => boolean;
}

export interface LogIndexTableStatus {
	table: string;
	cursor: number;
	head: number;
	indexedTs: number | null;
	lastError: string | null;
}

export interface LogIndexStatus {
	enabled: boolean;
	installed: boolean;
	lagMs: number | null;
	tables: LogIndexTableStatus[];
}

interface CursorRow {
	source_table: string;
	cursor: number;
	indexed_ts: number | null;
	last_error: string | null;
	updated_at: number;
}

const DEFAULT_BATCH_ROWS = 5_000;
const DEFAULT_BATCHES_PER_TICK = 20;
const DEFAULT_START_BACKLOG = 50_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
/** A batch the server rejects as malformed this many times in a row is skipped. */
export const LOG_INDEX_MAX_QUERY_ERRORS = 3;
const NAME_TTL_MS = 5 * 60_000;
const NAME_CACHE_MAX = 10_000;
const FIRST_SEEN_MAX = 100_000;
const REPLICA_PREFIX = /^\[r\d{1,2}\] /;

/** Where each scope kind's display name lives (`resource['service.name']`, §3). */
const SCOPE_NAME_SQL: Partial<Record<string, string>> = {
	project: 'SELECT slug AS name FROM projects WHERE id = ?',
	function: 'SELECT slug AS name FROM projects WHERE id = ?',
	edge: 'SELECT slug AS name FROM projects WHERE id = ?',
	database: 'SELECT name FROM databases WHERE id = ?',
	storage: 'SELECT name FROM storage_instances WHERE id = ?',
	broker: 'SELECT name FROM brokers WHERE id = ?',
	k8s: 'SELECT name FROM k8s_clusters WHERE id = ?',
	pipeline: 'SELECT name FROM pipeline_repositories WHERE id = ?',
	platform: 'SELECT name FROM nodes WHERE id = ?',
};

type IndexerContext = Pick<CoreContext, 'sqlite' | 'config' | 'now'> & Partial<Pick<CoreContext, 'logRules'>>;

export class LogIndexer {
	readonly #ctx: IndexerContext;
	readonly #writer: LogIndexWriter;
	readonly #sources: readonly SqliteLogSource[];
	readonly #batchRows: number;
	readonly #batchesPerTick: number;
	readonly #startBacklog: number;
	readonly #enabled: () => boolean;
	#miner: PatternMiner | null;
	readonly #filter: (record: LogRecord) => boolean;
	/** A failed batch's exact seq range, retried as-is so its dedup token is stable. */
	readonly #pending = new Map<string, { from: number; to: number }>();
	readonly #failures = new Map<string, { attempts: number; queryErrors: number; nextAt: number }>();
	readonly #names = new Map<string, { name: string | null; at: number }>();
	readonly #firstSeen = new Map<string, number>();
	#lagMs: number | null = null;
	#running = false;

	constructor(ctx: IndexerContext, writer: LogIndexWriter, options: LogIndexerOptions = {}) {
		this.#ctx = ctx;
		this.#writer = writer;
		this.#sources = options.sources ?? SQLITE_LOG_SOURCES;
		this.#batchRows = Math.max(1, options.batchRows ?? DEFAULT_BATCH_ROWS);
		this.#batchesPerTick = Math.max(1, options.batchesPerTick ?? DEFAULT_BATCHES_PER_TICK);
		this.#startBacklog = Math.max(0, options.startBacklogRows ?? DEFAULT_START_BACKLOG);
		this.#enabled = options.enabled ?? (() => featureEnabled(ctx.config, 'LOG_INDEX'));
		this.#miner = options.miner ?? null;
		this.#filter = options.filter ?? ((record) => ctx.logRules?.keepInIndex(record) ?? true);
	}

	/** Integration injects the Drain miner here (docs/LOGS.md §8.1); null turns mining off. */
	setPatternMiner(miner: PatternMiner | null): void {
		this.#miner = miner;
	}

	get enabled(): boolean {
		return this.#writer.installed && this.#enabled();
	}

	/**
	 * How far the search index is behind the hot tail: the age of the oldest row not yet indexed
	 * (0 when caught up). Null when the indexer is off or has not run yet.
	 */
	lagMs(): number | null {
		return this.enabled ? this.#lagMs : null;
	}

	/**
	 * One pass (hooks.server.ts, every few seconds on the primary). A pass still running when the
	 * next fires is skipped. Never throws for a ClickHouse problem.
	 */
	async tick(): Promise<{ indexed: number }> {
		if (this.#running || !this.enabled) return { indexed: 0 };
		this.#running = true;
		let indexed = 0;
		try {
			const ready = await this.#writer.logsReady().catch(() => false);
			for (const source of this.#sources) {
				const cursor = this.#cursorRow(source);
				if (!ready) {
					this.#setError(source.table, cursor, 'The telemetry store (ClickHouse) is unreachable; the search index is paused.');
					continue;
				}
				const failure = this.#failures.get(source.table);
				if (failure && failure.nextAt > this.#ctx.now()) continue;
				let from = cursor.cursor;
				for (let round = 0; round < this.#batchesPerTick; round += 1) {
					const result = await this.#indexBatch(source, from);
					indexed += result.count;
					if (result.next === null) break;
					from = result.next;
					if (result.done) break;
				}
			}
		} finally {
			this.#lagMs = this.#computeLag();
			this.#running = false;
		}
		return { indexed };
	}

	/** Cursors, heads and errors per table (Settings → Telemetry, the Explorer's lag banner). */
	status(): LogIndexStatus {
		const tables = this.#sources.map((source) => {
			const row = this.#ctx.sqlite
				.query<CursorRow, [string]>('SELECT * FROM log_index_cursors WHERE source_table = ?')
				.get(source.table);
			return {
				table: source.table,
				cursor: row?.cursor ?? 0,
				head: this.#head(source),
				indexedTs: row?.indexed_ts ?? null,
				lastError: row?.last_error ?? null,
			};
		});
		return { enabled: this.enabled, installed: this.#writer.installed, lagMs: this.lagMs(), tables };
	}

	// ------------------------------------------------------------------------------ batches

	/**
	 * Index the rows after `from`. Returns the new cursor (`next`, null when it did not move) and
	 * whether the table is drained for this tick.
	 */
	async #indexBatch(source: SqliteLogSource, from: number): Promise<{ count: number; next: number | null; done: boolean }> {
		const table = source.table;
		const pending = this.#pending.get(table);
		const rows = pending && pending.from === from
			? this.#ctx.sqlite
					.query<UnifiedLogRow, [number, number]>(`${source.select}\nWHERE ${source.seqColumn} > ? AND ${source.seqColumn} <= ? ORDER BY ${source.seqColumn}`)
					.all(from, pending.to)
			: this.#ctx.sqlite
					.query<UnifiedLogRow, [number, number]>(`${source.select}\nWHERE ${source.seqColumn} > ? ORDER BY ${source.seqColumn} LIMIT ?`)
					.all(from, this.#batchRows);
		if (pending && pending.from !== from) this.#pending.delete(table);
		if (rows.length === 0) {
			// The pending range was pruned from SQLite meanwhile: nothing left to send, move past it.
			if (pending && pending.from === from) {
				this.#pending.delete(table);
				this.#moveCursor(table, from, pending.to, null);
				return { count: 0, next: pending.to, done: true };
			}
			return { count: 0, next: null, done: true };
		}
		const to = Number(rows.at(-1)!.seq);
		this.#pending.set(table, { from, to });
		const token = `${table}:${from}-${to}`;
		try {
			const all = rows.map((row) => this.#record(row));
			// `index_only` rules keep a line in the hot tail and drains but out of the index (§10.3).
			const mined = all.filter((entry) => this.#keep(entry.record));
			const records = mined.map((entry) => entry.record);
			const patternRows = await this.#patternRows(mined);
			const dedup = { insert_deduplicate: 1, insert_deduplication_token: token };
			await this.#writer.insertLogRows('logs', records.map(clickhouseRow), dedup);
			if (patternRows.length)
				await this.#writer.insertLogRows('log_patterns', patternRows, { insert_deduplicate: 1, insert_deduplication_token: `${token}:patterns` });
			const newest = all.reduce((max, entry) => Math.max(max, entry.record.ts), 0);
			this.#moveCursor(table, from, to, null, newest || null);
			this.#pending.delete(table);
			this.#failures.delete(table);
			// A replayed range says nothing about what follows it; keep reading.
			const replayed = pending !== undefined && pending.from === from;
			return { count: rows.length, next: to, done: !replayed && rows.length < this.#batchRows };
		} catch (error) {
			return this.#fail(source, from, to, rows.length, error);
		}
	}

	#fail(source: SqliteLogSource, from: number, to: number, count: number, error: unknown): { count: number; next: number | null; done: boolean } {
		const table = source.table;
		const message = error instanceof Error ? error.message : String(error);
		const previous = this.#failures.get(table) ?? { attempts: 0, queryErrors: 0, nextAt: 0 };
		const malformed = error instanceof ClickHouseError && error.isQueryError && !(error instanceof ClickHouseUnavailableError);
		const failure = {
			attempts: previous.attempts + 1,
			queryErrors: malformed ? previous.queryErrors + 1 : 0,
			nextAt: this.#ctx.now() + Math.min(RETRY_BASE_MS * 2 ** previous.attempts, RETRY_MAX_MS),
		};
		if (failure.queryErrors >= LOG_INDEX_MAX_QUERY_ERRORS) {
			// Dead letter: these rows will never be accepted; skip them so the table keeps moving.
			const note = `skipped ${count} row(s) (seq ${from + 1}–${to}) after ${failure.queryErrors} rejections: ${message}`.slice(0, 500);
			console.warn(`[log-index] ${table}: ${note}`);
			this.#moveCursor(table, from, to, note);
			this.#pending.delete(table);
			this.#failures.delete(table);
			return { count: 0, next: to, done: true };
		}
		this.#failures.set(table, failure);
		this.#setError(table, null, message.slice(0, 500));
		return { count: 0, next: null, done: true };
	}

	#keep(record: LogRecord): boolean {
		try {
			return this.#filter(record);
		} catch {
			return true;
		}
	}

	/** A hot-tail row → the enriched record to index, with its template when a miner is set. */
	#record(row: UnifiedLogRow): { record: LogRecord; template: string } {
		const record = unifiedRowToLogRecord(row);
		// The adapters clean a structured line down to its message; enrichment reads the line as stored.
		const raw = row.tag === 'le' ? row.body.replace(REPLICA_PREFIX, '') : row.body;
		const enriched = enrichRecord(record, { rawBody: raw });
		const resource = { ...enriched.resource };
		const scopeName = this.#scopeName(enriched.scope.kind, enriched.scope.id);
		if (scopeName && !resource['service.name']) resource['service.name'] = scopeName;
		if (enriched.nodeId && !resource['host.name']) {
			const nodeName = this.#scopeName('platform', enriched.nodeId);
			if (nodeName) resource['host.name'] = nodeName;
		}
		let patternId: string | null = null;
		let template = '';
		if (this.#miner && enriched.body) {
			try {
				// One call per line: the miner learns from every call (docs/LOGS.md §8.1).
				const pattern = this.#miner.patternFor(`${enriched.orgId}/${enriched.scope.kind}:${enriched.scope.id}`, enriched.body);
				patternId = pattern.id || null;
				template = pattern.template;
			} catch {
				// Mining is best effort; the line is indexed without a template.
			}
		}
		return { record: { ...enriched, resource, scopeName, patternId }, template };
	}

	/**
	 * One `log_patterns` row per (scope, pattern) in the batch. `first_seen` survives restarts: keys
	 * not seen by this process are looked up once (ReplacingMergeTree keeps only the newest row).
	 */
	async #patternRows(mined: Array<{ record: LogRecord; template: string }>): Promise<Array<Record<string, unknown>>> {
		if (!this.#miner) return [];
		const groups = new Map<string, { org: string; kind: string; scope: string; pattern: string; template: string; first: number; last: number; sample: string }>();
		for (const { record, template } of mined) {
			if (!record.patternId) continue;
			const key = patternKey(record.orgId, record.scope.kind, record.scope.id, record.patternId);
			const group = groups.get(key);
			if (group) {
				group.first = Math.min(group.first, record.ts);
				if (record.ts >= group.last) {
					group.last = record.ts;
					group.sample = record.id;
				}
			} else
				groups.set(key, {
					org: record.orgId,
					kind: record.scope.kind,
					scope: record.scope.id,
					pattern: record.patternId,
					template,
					first: record.ts,
					last: record.ts,
					sample: record.id,
				});
		}
		if (groups.size === 0) return [];
		const unknown = [...groups.entries()].filter(([key]) => !this.#firstSeen.has(key)).map(([, group]) => group.pattern);
		if (unknown.length) {
			const params = new SqlParams();
			const result = await this.#writer.runQuery(
				`SELECT org_id, scope_kind, scope_id, pattern_id, toUnixTimestamp64Milli(min(first_seen)) FROM log_patterns WHERE pattern_id IN ${params.strings([...new Set(unknown)])} GROUP BY org_id, scope_kind, scope_id, pattern_id`,
				{ asReader: false, params: params.values },
			);
			for (const [org, kind, scope, pattern, first] of result.data as Array<[string, string, string, string, number]>)
				this.#rememberFirstSeen(patternKey(org, kind, scope, pattern), Number(first));
		}
		return [...groups.entries()].map(([key, group]) => {
			const known = this.#firstSeen.get(key);
			const first = known === undefined ? group.first : Math.min(known, group.first);
			this.#rememberFirstSeen(key, first);
			return {
				org_id: group.org,
				scope_kind: group.kind,
				scope_id: group.scope,
				pattern_id: group.pattern,
				template: group.template,
				first_seen: chDateTime64(first),
				last_seen: chDateTime64(group.last),
				sample_id: group.sample,
			};
		});
	}

	#rememberFirstSeen(key: string, ts: number): void {
		this.#firstSeen.delete(key);
		this.#firstSeen.set(key, ts);
		if (this.#firstSeen.size > FIRST_SEEN_MAX) {
			const oldest = this.#firstSeen.keys().next().value;
			if (oldest !== undefined) this.#firstSeen.delete(oldest);
		}
	}

	// ------------------------------------------------------------------------------ cursors

	/** The table's cursor row, created on first sight `startBacklogRows` behind its newest row. */
	#cursorRow(source: SqliteLogSource): CursorRow {
		const existing = this.#ctx.sqlite
			.query<CursorRow, [string]>('SELECT * FROM log_index_cursors WHERE source_table = ?')
			.get(source.table);
		if (existing) return existing;
		const start = Math.max(0, this.#head(source) - this.#startBacklog);
		this.#ctx.sqlite.run(
			'INSERT OR IGNORE INTO log_index_cursors (source_table, cursor, indexed_ts, last_error, updated_at) VALUES (?, ?, NULL, NULL, ?)',
			[source.table, start, this.#ctx.now()],
		);
		return this.#ctx.sqlite.query<CursorRow, [string]>('SELECT * FROM log_index_cursors WHERE source_table = ?').get(source.table)!;
	}

	#head(source: SqliteLogSource): number {
		try {
			return (
				this.#ctx.sqlite.query<{ head: number | null }, []>(`SELECT MAX(seq) AS head FROM ${source.table}`).get()?.head ?? 0
			);
		} catch {
			return 0;
		}
	}

	/** Move the cursor only if nobody else moved it (a standby, or a second indexer). */
	#moveCursor(table: string, from: number, to: number, lastError: string | null, indexedTs: number | null = null): void {
		this.#ctx.sqlite.run(
			`UPDATE log_index_cursors SET cursor = ?, indexed_ts = COALESCE(?, indexed_ts), last_error = ?, updated_at = ?
			 WHERE source_table = ? AND cursor = ?`,
			[to, indexedTs, lastError, this.#ctx.now(), table, from],
		);
	}

	/** Record why the index is stalled, writing only when the message changes. */
	#setError(table: string, row: CursorRow | null, message: string): void {
		const current = row ?? this.#ctx.sqlite.query<CursorRow, [string]>('SELECT * FROM log_index_cursors WHERE source_table = ?').get(table);
		if (current?.last_error === message) return;
		this.#ctx.sqlite.run('UPDATE log_index_cursors SET last_error = ?, updated_at = ? WHERE source_table = ?', [message, this.#ctx.now(), table]);
	}

	#computeLag(): number | null {
		const now = this.#ctx.now();
		let lag = 0;
		for (const source of this.#sources) {
			const row = this.#ctx.sqlite
				.query<{ cursor: number }, [string]>('SELECT cursor FROM log_index_cursors WHERE source_table = ?')
				.get(source.table);
			if (!row) continue;
			try {
				const next = this.#ctx.sqlite
					.query<{ ts: number }, [number]>(
						`SELECT ${source.tsColumn} AS ts FROM ${source.table} t WHERE ${source.seqColumn} > ? ORDER BY ${source.seqColumn} LIMIT 1`,
					)
					.get(row.cursor);
				if (next) lag = Math.max(lag, now - Number(next.ts));
			} catch {
				// A table this build does not have yet; nothing to be behind on.
			}
		}
		return lag;
	}

	/** Display names for `resource['service.name']` and `host.name`, cached for a few minutes. */
	#scopeName(kind: string, id: string): string | null {
		const sql = SCOPE_NAME_SQL[kind];
		if (!sql || !id) return null;
		const key = `${kind}:${id}`;
		const cached = this.#names.get(key);
		const now = this.#ctx.now();
		if (cached && now - cached.at < NAME_TTL_MS) return cached.name;
		let name: string | null = null;
		try {
			name = this.#ctx.sqlite.query<{ name: string | null }, [string]>(sql).get(id)?.name ?? null;
		} catch {
			name = null;
		}
		if (this.#names.size >= NAME_CACHE_MAX) this.#names.clear();
		this.#names.set(key, { name, at: now });
		return name;
	}
}

function patternKey(org: string, kind: string, scope: string, pattern: string): string {
	return `${org}\u0000${kind}\u0000${scope}\u0000${pattern}`;
}

/** A valid DateTime64 text for any record time (bad clocks are clamped, never rejected). */
function safeTime(ms: number | null | undefined, fallback: number): string {
	const value = typeof ms === 'number' && Number.isFinite(ms) ? ms : fallback;
	return chDateTime64(Math.min(Math.max(value, 0), 4_102_444_800_000));
}

/** `LogRecord` → a `yoal.logs` JSONEachRow object (column order does not matter). */
export function clickhouseRow(record: LogRecord): Record<string, unknown> {
	return {
		ts: safeTime(record.ts, Date.now()),
		observed_ts: safeTime(record.observedTs ?? record.ts, record.ts),
		id: record.id,
		org_id: record.orgId ?? '',
		scope_kind: record.scope.kind,
		scope_id: record.scope.id,
		stream: record.stream ?? '',
		source: record.source,
		channel: record.channel ?? '',
		severity_number: Math.max(0, Math.min(24, Math.trunc(record.severityNumber) || 0)),
		severity_text: record.severity,
		body: record.body,
		attributes: record.attributes,
		resource: record.resource,
		trace_id: record.traceId ?? '',
		span_id: record.spanId ?? '',
		request_id: record.requestId ?? '',
		pattern_id: record.patternId ?? '',
		project_id: record.projectId ?? '',
		deployment_id: record.deploymentId ?? '',
		build_id: record.buildId ?? '',
		job_run_id: record.jobRunId ?? '',
		node_id: record.nodeId ?? '',
		replica: record.replica ?? -1,
	};
}
