import { LOG_SETTINGS_PLATFORM_ID } from '@yoal/contracts';
import type { ClickHouseParams, ClickHouseSettings } from './clickhouse.ts';
import type { CoreContext } from './context.ts';
import type { LogSettingsService } from './log-settings.ts';
import { chDateTime64 } from './telemetry.ts';

/**
 * Log retention tiers (docs/LOGS.md §10.1, LP9):
 *
 * - **Hot tail (SQLite)** — `pruneHotTail`, from the maintenance sweep: rows older than the org's
 *   effective `hotDays` go, then each scope keeps at most `cap` newest rows per table, so a noisy
 *   project trims only its own history (the old global 500,000-row cap is gone). Orgs without an
 *   override share one DELETE; each override is one more. Kubernetes and pipeline lines keep their
 *   own retention, as before.
 * - **Search (ClickHouse `yoal.logs`)** — `pruneSearchIndex`, once per UTC day: a lightweight
 *   `DELETE` per org past its `searchDays` (and per project with a shorter window). The table's
 *   90-day TTL stays as the backstop.
 * - **Archive** — `LogArchiveService.prune` (log-archive.ts).
 */

/** Per-scope ceiling on hot-tail rows, per table (§10.2). */
export const LOG_SCOPE_ROW_CAP = 100_000;
const DAY_MS = 86_400_000;
/** `alert_state` key holding the UTC day the search index was last pruned. */
export const LOG_SEARCH_PRUNE_STATE_KEY = 'logs.search_prune_day';

/** Tables the hot-tail prune trims, with the columns that identify a scope in each. */
export const PRUNED_LOG_TABLES: ReadonlyArray<{ table: string; scope: readonly string[] }> = [
	{ table: 'log_events', scope: ['project_id'] },
	{ table: 'service_log_events', scope: ['kind', 'service_id'] },
	{ table: 'broker_log_events', scope: ['broker_id'] },
	{ table: 'log_records', scope: ['scope_kind', 'scope_id'] },
];

/** What retention needs from the telemetry store (a `TelemetryStore` satisfies it). */
export interface LogRetentionWriter {
	readonly installed: boolean;
	logsReady(): Promise<boolean>;
	execLogs(sql: string, params?: ClickHouseParams, settings?: ClickHouseSettings): Promise<void>;
}

type RetentionContext = Pick<CoreContext, 'sqlite' | 'now'> & { logSettings: LogSettingsService } & Partial<Pick<CoreContext, 'telemetry'>>;

export class LogRetentionService {
	constructor(
		private readonly ctx: RetentionContext,
		private readonly writer: () => LogRetentionWriter | null | undefined = () => ctx.telemetry,
	) {}

	/**
	 * Delete hot-tail rows past retention, then cap each scope. With `retentionMs` every org uses
	 * that window (the old behaviour, kept for callers and tests that pass one); otherwise each org
	 * uses its effective `hotDays`. Returns the rows removed.
	 */
	pruneHotTail(now = this.ctx.now(), retentionMs?: number, cap = LOG_SCOPE_ROW_CAP): number {
		const limit = Math.max(1, Math.floor(cap));
		const windows = retentionMs === undefined ? this.hotWindows() : { fallback: retentionMs, orgs: new Map<string, number>() };
		let removed = 0;
		for (const { table, scope } of PRUNED_LOG_TABLES) {
			removed += this.#pruneAge(table, now, windows);
			const columns = scope.join(', ');
			const match = scope.map((column) => `${column} = ?`).join(' AND ');
			const over = this.ctx.sqlite
				.query<Record<string, string>, [number]>(`SELECT ${columns} FROM ${table} GROUP BY ${columns} HAVING COUNT(*) > ?`)
				.all(limit);
			for (const row of over) {
				const values = scope.map((column) => row[column] ?? null);
				removed += this.ctx.sqlite.run(
					`DELETE FROM ${table} WHERE ${match} AND seq <= (
					   SELECT seq FROM ${table} WHERE ${match} ORDER BY seq DESC LIMIT 1 OFFSET ?
					 )`,
					[...values, ...values, limit],
				).changes;
			}
		}
		return removed;
	}

	/**
	 * The hot-tail window per org: the platform's effective value for every org without its own
	 * `hotDays`, and one entry per org (and the platform's own records) that differs.
	 */
	hotWindows(): { fallback: number; orgs: Map<string, number> } {
		const fallback = this.ctx.logSettings.effective(LOG_SETTINGS_PLATFORM_ID).hotDays * DAY_MS;
		const orgs = new Map<string, number>();
		for (const { id } of this.ctx.logSettings.rows('org')) {
			const days = this.ctx.logSettings.effective(id).hotDays * DAY_MS;
			if (days !== fallback) orgs.set(id, days);
		}
		return { fallback, orgs };
	}

	#pruneAge(table: string, now: number, windows: { fallback: number; orgs: Map<string, number> }): number {
		let removed = 0;
		const overridden = [...windows.orgs.keys()];
		for (const [orgId, ms] of windows.orgs)
			removed += this.ctx.sqlite.run(`DELETE FROM ${table} WHERE org_id = ? AND ts < ?`, [orgId, now - ms]).changes;
		if (overridden.length === 0) return removed + this.ctx.sqlite.run(`DELETE FROM ${table} WHERE ts < ?`, [now - windows.fallback]).changes;
		return (
			removed +
			this.ctx.sqlite.run(`DELETE FROM ${table} WHERE ts < ? AND org_id NOT IN (${overridden.map(() => '?').join(', ')})`, [
				now - windows.fallback,
				...overridden,
			]).changes
		);
	}

	/**
	 * Once per UTC day, delete `yoal.logs` rows past each org's (and project's) search window
	 * (§10.1). Lightweight `DELETE` marks rows and lets merges reclaim them, so it is cheap to run.
	 * Fail-open: an unreachable ClickHouse is retried on the next sweep. Returns the statements run,
	 * or null when it did nothing this time.
	 */
	async pruneSearchIndex(now = this.ctx.now()): Promise<number | null> {
		const writer = this.writer();
		if (!writer?.installed) return null;
		const day = new Date(Math.floor(now / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
		const done = this.ctx.sqlite
			.query<{ last_value: string | null }, [string]>('SELECT last_value FROM alert_state WHERE key = ?')
			.get(LOG_SEARCH_PRUNE_STATE_KEY);
		if (done?.last_value === day) return null;
		if (!(await writer.logsReady().catch(() => false))) return null;
		const statements = searchPruneStatements(this.ctx.logSettings, now);
		try {
			for (const statement of statements) await writer.execLogs(statement.sql, statement.params, { lightweight_deletes_sync: 0 } as ClickHouseSettings);
		} catch (error) {
			console.error('[logs] search-index retention failed; retrying next sweep', error);
			return null;
		}
		this.ctx.sqlite.run(
			'INSERT INTO alert_state (key, last_fired_at, last_value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET last_fired_at = excluded.last_fired_at, last_value = excluded.last_value',
			[LOG_SEARCH_PRUNE_STATE_KEY, now, day],
		);
		return statements.length;
	}
}

/**
 * The DELETE statements for one search-index pass (pure apart from the settings reads): one for
 * every org on the platform window, one per org with its own, one per project with a shorter one.
 */
export function searchPruneStatements(settings: LogSettingsService, now: number): Array<{ sql: string; params: ClickHouseParams }> {
	const fallbackDays = settings.effective(LOG_SETTINGS_PLATFORM_ID).searchDays;
	const statements: Array<{ sql: string; params: ClickHouseParams }> = [];
	const overridden: string[] = [];
	for (const { id } of settings.rows('org')) {
		const days = settings.effective(id).searchDays;
		if (days === fallbackDays) continue;
		overridden.push(id);
		statements.push({
			sql: 'DELETE FROM logs WHERE org_id = {org:String} AND ts < {cutoff:DateTime64(3)}',
			params: { org: id, cutoff: chDateTime64(now - days * DAY_MS) },
		});
	}
	statements.unshift({
		sql: overridden.length
			? 'DELETE FROM logs WHERE ts < {cutoff:DateTime64(3)} AND org_id NOT IN {orgs:Array(String)}'
			: 'DELETE FROM logs WHERE ts < {cutoff:DateTime64(3)}',
		params: overridden.length ? { cutoff: chDateTime64(now - fallbackDays * DAY_MS), orgs: overridden } : { cutoff: chDateTime64(now - fallbackDays * DAY_MS) },
	});
	// Projects with a shorter window than their org (a longer one is clamped to the org's).
	const projects = settings.rows('project').filter((entry) => entry.row.searchDays !== undefined);
	for (const { id } of projects) {
		const orgId = settings.projectOrg(id);
		if (!orgId) continue;
		const days = settings.effective(orgId, id).searchDays;
		if (days >= settings.effective(orgId).searchDays) continue;
		statements.push({
			sql: 'DELETE FROM logs WHERE org_id = {org:String} AND project_id = {project:String} AND ts < {cutoff:DateTime64(3)}',
			params: { org: orgId, project: id, cutoff: chDateTime64(now - days * DAY_MS) },
		});
	}
	return statements;
}
