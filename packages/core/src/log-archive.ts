import {
	logArchiveEstimateInputSchema,
	LOG_SETTINGS_PLATFORM_ID,
	type LogArchiveEstimate,
	type LogRecord,
	type LogSearchResult,
	type LogWarning,
	type Principal,
} from '@yoal/contracts';
import type { ClickHouseCompactResult, ClickHouseParams, ClickHouseSettings } from './clickhouse.ts';
import type { CoreContext } from './context.ts';
import { ValidationError } from './errors.ts';
import type { LogSettingsService } from './log-settings.ts';
import { compileSearch, LOGS_TABLE } from './log-store/clickhouse-compiler.ts';
import { recordFromRow } from './log-store/clickhouse-store.ts';
import type { LogReadBoundary, LogStoreRead } from './log-store/types.ts';
import type { ObjectStore } from './object-store.ts';
import { chDateTime64, type AdHocQueryOptions } from './telemetry.ts';

/**
 * The log archive tier (docs/LOGS.md §10.1, LP9): daily Parquet per org in the object store, off by
 * default (decided §15.4), kept `archiveDays`.
 *
 * - **Export** (`tick`, from the maintenance sweep, once per UTC day): yesterday's `yoal.logs` rows
 *   of every org with the archive on, one zstd Parquet file per hour that has rows
 *   (`logs-archive/<org>/<YYYY-MM-DD>/<HH>.parquet`), written through the telemetry store's Parquet
 *   path (`queryLogsParquet`, the same `FORMAT Parquet` export the traffic archive uses). An hour
 *   at a time keeps memory bounded. The day and its files are recorded in `log_archive_days`
 *   (0143). A day that fails is retried on the next sweep; the two days before are re-checked.
 * - **Prune**: days older than the org's `archiveDays` lose their objects and row.
 * - **Rehydrate on query** (§10.1): when a search reaches past the search window, the Explorer
 *   shows `estimate()` (bytes, files, seconds) as an `archive` warning, and runs the archived part
 *   only when the request says `archive: true`. It is the same compiled search (tenancy, time and
 *   filter ANDed in) over the archived files instead of `yoal.logs`, with a scan budget
 *   (`max_bytes_to_read`, `max_execution_time`); an estimate over the budget is refused.
 *
 * Deviation from the brief's `s3()`: the files are read with ClickHouse's `url()` table function
 * over short-lived presigned GET URLs. `s3()` would need the bucket's access keys in the query text,
 * where `system.query_log` keeps them; a presigned URL carries a 15-minute signature for one object
 * and works for every object-store backend (S3, R2, MinIO, and the local store's signed URLs).
 */

export const LOG_ARCHIVE_PREFIX = 'logs-archive';
/** Bytes of Parquet one rehydrate may scan (§10.1 "a per-query scan budget"). */
export const LOG_ARCHIVE_SCAN_BUDGET_BYTES = 20 * 1024 ** 3;
/** Rough Parquet read rate for the estimate, and a fixed cost per file (open + footer). */
const THROUGHPUT_BYTES_PER_SECOND = 60 * 1024 ** 2;
const SECONDS_PER_FILE = 0.25;
/** Decompressed bytes per Parquet byte the budget allows ClickHouse to read. */
const READ_EXPANSION = 12;
/** Memory one rehydrate query may use (the ad-hoc SQL cap; the server's default cap is 768 MiB). */
const ARCHIVE_MAX_MEMORY_BYTES = 268_435_456;
const PRESIGN_SECONDS = 900;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Days before yesterday re-checked for a missing export (a sweep that failed). */
const CATCH_UP_DAYS = 2;
export const LOG_ARCHIVE_STATE_KEY = 'logs.archive_day';

export interface LogArchiveFile {
	hour: number;
	key: string;
	rows: number;
	bytes: number;
}

/** What the archive needs from the telemetry store (a `TelemetryStore` satisfies it). */
export interface LogArchiveWriter {
	readonly installed: boolean;
	logsReady(): Promise<boolean>;
	queryLogsParquet(sql: string, params?: ClickHouseParams): Promise<Uint8Array>;
	runQuery(sql: string, options: AdHocQueryOptions & { asReader: boolean }): Promise<ClickHouseCompactResult>;
	readonly logsTextIndex?: unknown;
}

type ArchiveContext = Pick<CoreContext, 'sqlite' | 'now' | 'iam'> & { logSettings: LogSettingsService } & Partial<Pick<CoreContext, 'telemetry' | 'config' | 'logExplorer'>>;

interface DayRow {
	org_id: string;
	day: string;
	files: string;
	rows: number;
	bytes: number;
	exported_at: number;
}

const dayLabel = (ms: number) => new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
const dayMs = (label: string) => Date.parse(`${label}T00:00:00Z`);

export class LogArchiveService {
	constructor(
		private readonly ctx: ArchiveContext,
		private readonly writer: () => LogArchiveWriter | null | undefined = () => ctx.telemetry,
		private readonly store: () => ObjectStore | null | undefined = () => ctx.config?.objectStore,
	) {}

	/** Rehydrate and export need ClickHouse with the search index and an object store. */
	available(): boolean {
		return Boolean(this.writer()?.installed && this.store());
	}

	/** Orgs whose effective `archiveEnabled` is on. */
	archiveOrgs(): string[] {
		const platformOn = this.ctx.logSettings.effective(LOG_SETTINGS_PLATFORM_ID).archiveEnabled;
		const rows = this.ctx.logSettings.rows('org');
		if (!platformOn) return rows.filter((entry) => entry.row.archiveEnabled === true).map((entry) => entry.id);
		let all: string[] = [];
		try {
			all = this.ctx.sqlite.query<{ id: string }, []>('SELECT id FROM organization').all().map((row) => row.id);
		} catch {
			all = rows.map((entry) => entry.id);
		}
		const off = new Set(rows.filter((entry) => entry.row.archiveEnabled === false).map((entry) => entry.id));
		return all.filter((id) => !off.has(id));
	}

	/**
	 * The daily pass: export missing days (yesterday and the two before) for every org with the
	 * archive on, then prune. Returns the days exported, or null when it did nothing.
	 */
	async tick(now = this.ctx.now()): Promise<{ exported: number; pruned: number } | null> {
		const writer = this.writer();
		const store = this.store();
		if (!writer?.installed || !store) return null;
		const today = dayLabel(now);
		const done = this.ctx.sqlite
			.query<{ last_value: string | null }, [string]>('SELECT last_value FROM alert_state WHERE key = ?')
			.get(LOG_ARCHIVE_STATE_KEY);
		if (done?.last_value === today) return null;
		if (!(await writer.logsReady().catch(() => false))) return null;
		let exported = 0;
		let failed = false;
		const todayStart = dayMs(today);
		for (const orgId of this.archiveOrgs()) {
			for (let back = CATCH_UP_DAYS + 1; back >= 1; back -= 1) {
				const day = dayLabel(todayStart - back * DAY_MS);
				if (this.#dayRow(orgId, day)) continue;
				try {
					await this.exportDay(orgId, day);
					exported += 1;
				} catch (error) {
					failed = true;
					console.error(`[logs] archive of ${orgId} ${day} failed; retrying next sweep`, error);
				}
			}
		}
		const pruned = await this.prune(now);
		if (!failed)
			this.ctx.sqlite.run(
				'INSERT INTO alert_state (key, last_fired_at, last_value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET last_fired_at = excluded.last_fired_at, last_value = excluded.last_value',
				[LOG_ARCHIVE_STATE_KEY, now, today],
			);
		return { exported, pruned };
	}

	/** Export one org's UTC day, an hour per file, and record it. */
	async exportDay(orgId: string, day: string): Promise<{ files: LogArchiveFile[]; rows: number; bytes: number }> {
		const writer = this.writer();
		const store = this.store();
		if (!writer || !store) throw new Error('The archive needs ClickHouse and an object store.');
		const start = dayMs(day);
		const counts = await writer.runQuery(
			`SELECT toHour(ts) AS h, count() AS n FROM ${LOGS_TABLE}
			 WHERE org_id = {org:String} AND ts >= {from:DateTime64(3)} AND ts < {to:DateTime64(3)}
			 GROUP BY h ORDER BY h`,
			{ asReader: false, params: { org: orgId, from: chDateTime64(start), to: chDateTime64(start + DAY_MS) } },
		);
		const files: LogArchiveFile[] = [];
		for (const [hour, count] of counts.data as Array<[number, number]>) {
			if (!Number(count)) continue;
			const from = start + Number(hour) * HOUR_MS;
			const bytes = await writer.queryLogsParquet(
				`SELECT * FROM ${LOGS_TABLE}
				 WHERE org_id = {org:String} AND ts >= {from:DateTime64(3)} AND ts < {to:DateTime64(3)}
				 ORDER BY scope_kind, scope_id, ts
				 FORMAT Parquet`,
				{ org: orgId, from: chDateTime64(from), to: chDateTime64(from + HOUR_MS) },
			);
			const key = archiveKey(orgId, day, Number(hour));
			await store.put(key, bytes, 'application/vnd.apache.parquet');
			files.push({ hour: Number(hour), key, rows: Number(count), bytes: bytes.byteLength });
		}
		const rows = files.reduce((sum, file) => sum + file.rows, 0);
		const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
		this.ctx.sqlite.run(
			`INSERT INTO log_archive_days (org_id, day, files, rows, bytes, exported_at) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (org_id, day) DO UPDATE SET files = excluded.files, rows = excluded.rows, bytes = excluded.bytes, exported_at = excluded.exported_at`,
			[orgId, day, JSON.stringify(files), rows, bytes, this.ctx.now()],
		);
		return { files, rows, bytes };
	}

	/** Remove archived days past each org's `archiveDays` (objects first, then the row). */
	async prune(now = this.ctx.now()): Promise<number> {
		const store = this.store();
		const rows = this.ctx.sqlite.query<DayRow, []>('SELECT * FROM log_archive_days').all();
		let pruned = 0;
		for (const row of rows) {
			const keepDays = this.ctx.logSettings.effective(row.org_id).archiveDays;
			if (dayMs(row.day) >= Math.floor(now / DAY_MS) * DAY_MS - keepDays * DAY_MS) continue;
			try {
				for (const file of parseFiles(row.files)) await store?.delete(file.key);
			} catch (error) {
				console.error(`[logs] archive prune of ${row.org_id} ${row.day} failed`, error);
				continue;
			}
			this.ctx.sqlite.run('DELETE FROM log_archive_days WHERE org_id = ? AND day = ?', [row.org_id, row.day]);
			pruned += 1;
		}
		return pruned;
	}

	/**
	 * What reading the archived part of a range would cost (§10.1): the days older than the search
	 * window that have archived files, their bytes and file count, and a rough time.
	 */
	estimateFor(boundary: LogReadBoundary, from: number, to: number, now = this.ctx.now()): LogArchiveEstimate {
		const budgetBytes = LOG_ARCHIVE_SCAN_BUDGET_BYTES;
		const empty = (reason: string | null, available: boolean, range: LogArchiveEstimate['range'] = null): LogArchiveEstimate => ({
			bytes: 0,
			files: 0,
			seconds: 0,
			days: [],
			range,
			available,
			reason,
			budgetBytes,
		});
		const horizon = this.searchHorizon(boundary, now);
		if (from >= horizon) return empty(null, this.available());
		const range = { from, to: Math.min(to, horizon) };
		if (!this.available()) return empty('The archive needs the telemetry store (ClickHouse) and an object store.', false, range);
		const days = this.#daysIn(boundary.orgId, range.from, range.to);
		const files = days.flatMap((row) => parseFiles(row.files).filter((file) => overlaps(dayMs(row.day) + file.hour * HOUR_MS, range)));
		const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
		return {
			bytes,
			files: files.length,
			seconds: Math.max(1, Math.ceil(files.length * SECONDS_PER_FILE + bytes / THROUGHPUT_BYTES_PER_SECOND)),
			days: days.map((row) => row.day),
			range,
			available: true,
			reason: files.length === 0 ? 'Nothing is archived for this range.' : bytes > budgetBytes ? 'The range scans more than the per-query budget; narrow it.' : null,
			budgetBytes,
		};
	}

	/** `POST /api/v1/logs/archive/estimate`: the caller's boundary, then `estimateFor`. */
	estimate(principal: Principal, input: unknown): LogArchiveEstimate {
		const parsed = logArchiveEstimateInputSchema.safeParse(input ?? {});
		if (!parsed.success) throw new ValidationError('Invalid archive estimate.', parsed.error.issues);
		const explorer = this.ctx.logExplorer;
		if (!explorer) throw new ValidationError('Log reads are not available.');
		const { boundary } = explorer.resolveBoundary(principal, parsed.data.scopes);
		return this.estimateFor(boundary, Math.min(parsed.data.from, parsed.data.to), Math.max(parsed.data.from, parsed.data.to));
	}

	/**
	 * The start of the searchable window for a read: the shortest search window among the org and
	 * the projects in the boundary (a project may keep fewer days than its org). Platform reads use
	 * the platform window.
	 */
	searchHorizon(boundary: LogReadBoundary, now = this.ctx.now()): number {
		const orgId = boundary.crossOrg && boundary.scopes.every((scope) => scope.kind === 'platform' || scope.kind === 'edge') ? LOG_SETTINGS_PLATFORM_ID : boundary.orgId;
		let days = this.ctx.logSettings.effective(orgId).searchDays;
		for (const scope of boundary.scopes) {
			if (scope.kind !== 'project' && scope.kind !== 'function') continue;
			days = Math.min(days, this.ctx.logSettings.effective(boundary.orgId, scope.id).searchDays);
		}
		return now - days * DAY_MS;
	}

	/**
	 * Explorer hook (`LogExplorerService.search`): when the read reaches past the search window,
	 * either add an `archive` warning with the estimate, or, with `archive: true`, run the archived
	 * part and merge it into the page (newest first, trimmed to the limit). Archived rows are not
	 * paged: the warning says so when more matched.
	 */
	async applyToSearch(
		read: LogStoreRead,
		page: { limit: number; order: 'asc' | 'desc'; cursor?: string; archive?: boolean },
		result: LogSearchResult,
	): Promise<LogSearchResult> {
		if (read.boundary.scopes.length === 0 || page.cursor) return result;
		const estimate = this.estimateFor(read.boundary, read.from, read.to);
		if (!estimate.range || estimate.files === 0) return result;
		if (!page.archive) {
			result.warnings.push(archiveWarning(`Part of this range is older than the search window and only in the archive: including it scans ${formatBytes(estimate.bytes)} in ${estimate.files} file${estimate.files === 1 ? '' : 's'} (about ${estimate.seconds} s). Search again with archive on to include it.`));
			return result;
		}
		if (estimate.bytes > estimate.budgetBytes) {
			result.warnings.push(archiveWarning(`The archived part of this range scans ${formatBytes(estimate.bytes)}, over the ${formatBytes(estimate.budgetBytes)} budget; narrow the range.`));
			return result;
		}
		const archived = await this.search({ ...read, from: estimate.range.from, to: estimate.range.to }, page.limit, page.order, estimate);
		const merged = [...result.records, ...archived.records].sort((a, b) => (page.order === 'desc' ? b.ts - a.ts : a.ts - b.ts) || a.id.localeCompare(b.id));
		result.records = merged.slice(0, page.limit);
		result.warnings.push(
			archiveWarning(
				archived.more || merged.length > page.limit
					? `Included the archive (${formatBytes(estimate.bytes)}). More archived lines matched than one page shows; narrow the range to see them.`
					: `Included the archive (${formatBytes(estimate.bytes)}).`,
			),
		);
		return result;
	}

	/** Run a compiled search over the archived files of the range, inside the scan budget. */
	async search(read: LogStoreRead, limit: number, order: 'asc' | 'desc', estimate: LogArchiveEstimate): Promise<{ records: LogRecord[]; more: boolean }> {
		const writer = this.writer();
		const store = this.store();
		if (!writer || !store) return { records: [], more: false };
		const days = this.#daysIn(read.boundary.orgId, read.from, read.to);
		const files = days.flatMap((row) => parseFiles(row.files).filter((file) => overlaps(dayMs(row.day) + file.hour * HOUR_MS, read)));
		if (files.length === 0) return { records: [], more: false };
		const urls: string[] = [];
		for (const file of files) urls.push(await store.presignGet(file.key, PRESIGN_SECONDS));
		const compiled = compileSearch(read, { limit, order }, { textIndex: null });
		const source = `(${urls.map((url) => `SELECT * FROM url(${sqlString(url)}, 'Parquet')`).join(' UNION ALL ')})`;
		const sql = compiled.sql.replace(`\nFROM ${LOGS_TABLE}\n`, `\nFROM ${source}\n`);
		// This runs as the writer, not `yoal_reader`: `url()` needs a grant the reader must not have.
		// The reader runs the platform SQL tab (D101), so a URL grant there would let that SQL fetch
		// any address the ClickHouse host can reach. The writer is held in check per query instead:
		// `readonly = 2` (reads only; `readonly = 1` also forbids table functions), and explicit
		// time, read, memory, thread and result-row caps, whatever defaults `runQuery` adds.
		const settings: ClickHouseSettings = {
			readonly: 2,
			max_execution_time: Math.min(600, Math.max(30, estimate.seconds * 3)),
			max_bytes_to_read: Math.max(estimate.bytes, 1) * READ_EXPANSION,
			read_overflow_mode: 'throw',
			max_memory_usage: ARCHIVE_MAX_MEMORY_BYTES,
			max_threads: 2,
			// Only the final result counts (a FROM subquery is not capped), so this never truncates the scan.
			max_result_rows: compiled.limit + 1,
			result_overflow_mode: 'break',
		};
		const result = await writer.runQuery(sql, { asReader: false, params: compiled.params, settings });
		const rows = result.data.map((row) => recordFromRow(row as unknown[]));
		return { records: rows.slice(0, compiled.limit), more: rows.length > compiled.limit };
	}

	#dayRow(orgId: string, day: string): DayRow | null {
		return this.ctx.sqlite.query<DayRow, [string, string]>('SELECT * FROM log_archive_days WHERE org_id = ? AND day = ?').get(orgId, day) ?? null;
	}

	#daysIn(orgId: string, from: number, to: number): DayRow[] {
		return this.ctx.sqlite
			.query<DayRow, [string, string, string]>('SELECT * FROM log_archive_days WHERE org_id = ? AND day >= ? AND day <= ? ORDER BY day')
			.all(orgId, dayLabel(from), dayLabel(to));
	}
}

/** A ClickHouse string literal for a server-made value (a presigned URL; never user text). */
export function sqlString(value: string): string {
	return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function archiveKey(orgId: string, day: string, hour: number): string {
	return `${LOG_ARCHIVE_PREFIX}/${orgId}/${day}/${String(hour).padStart(2, '0')}.parquet`;
}

function overlaps(hourStart: number, range: { from: number; to: number }): boolean {
	return hourStart < range.to && hourStart + HOUR_MS > range.from;
}

function parseFiles(text: string): LogArchiveFile[] {
	try {
		const value = JSON.parse(text) as unknown;
		return Array.isArray(value) ? (value as LogArchiveFile[]).filter((file) => file && typeof file.key === 'string') : [];
	} catch {
		return [];
	}
}

function archiveWarning(message: string): LogWarning {
	return { code: 'archive', message };
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
