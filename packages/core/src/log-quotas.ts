import { formatLogScope, type LogScopeKind, type LogUsageReport, type LogUsageRow, type Principal } from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import type { LogSettingsService } from './log-settings.ts';
import { lookupLogScopeNames } from './log-store/sqlite-store.ts';

/**
 * Per-project log ingest quotas (docs/LOGS.md §10.2, LP9; docs/QUOTAS.md). Two limits per scope,
 * both from the effective log settings of its project (or its org, for service scopes):
 *
 * - **Rate:** an in-memory token bucket, `ingestLinesPerSecond` refilled up to `ingestBurst`.
 * - **Daily bytes:** `ingestMbPerDay` per UTC day. The running total is in memory and seeded on
 *   first sight from `log_ingest_daily` (0144), so a restart does not reset a day's budget.
 *
 * A batch keeps its earliest lines and drops the rest once a limit is hit. Drops are counted in
 * `log_drop_counts` (reason `quota`, also `exclude` and `sample` for rules) per scope per minute,
 * and at most one `system` line per minute per scope says how many lines were dropped and why
 * (`noticeDue`). Accepted lines and bytes go to `log_ingest_daily` for showback on the usage page.
 *
 * The buckets are per control-plane process, which is right with one active control plane; a
 * standby starts with full buckets. `YOAL_FEATURE_QUOTAS=0` turns enforcement off (QUOTAS.md),
 * and counting still runs.
 */

export interface LogIngestScope {
	orgId: string;
	scopeKind: LogScopeKind | string;
	scopeId: string;
	/** The project whose settings apply; null for service and platform scopes (org settings). */
	projectId: string | null;
}

export type LogDropReason = 'quota' | 'exclude' | 'sample';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** One notice per scope per minute at most (§10.2). */
export const LOG_QUOTA_NOTICE_INTERVAL_MS = MINUTE_MS;
const MAX_TRACKED_SCOPES = 50_000;

type QuotaContext = Pick<CoreContext, 'sqlite' | 'config' | 'now' | 'iam'> & { logSettings: LogSettingsService };

interface Bucket {
	tokens: number;
	at: number;
}

interface DayTotal {
	day: number;
	bytes: number;
}

interface PendingNotice {
	scope: LogIngestScope;
	lines: number;
	bytes: number;
	since: number;
}

export const scopeKeyOf = (scope: Pick<LogIngestScope, 'scopeKind' | 'scopeId'>) => `${scope.scopeKind}:${scope.scopeId}`;
export const dayStart = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;

export class LogQuotaService {
	readonly #buckets = new Map<string, Bucket>();
	readonly #days = new Map<string, DayTotal>();
	readonly #pending = new Map<string, PendingNotice>();
	readonly #lastNotice = new Map<string, number>();

	constructor(private readonly ctx: QuotaContext) {}

	get enforced(): boolean {
		return featureEnabled(this.ctx.config, 'QUOTAS');
	}

	/**
	 * How many of the lines (their stored sizes, in order) fit the scope's rate and daily budget.
	 * Consumes tokens and bytes for the admitted ones only.
	 */
	admit(scope: LogIngestScope, sizes: readonly number[], now = this.ctx.now()): number {
		if (sizes.length === 0) return 0;
		if (!this.enforced) return sizes.length;
		const settings = this.ctx.logSettings.effective(scope.orgId, scope.projectId);
		const key = scopeKeyOf(scope);
		const rate = settings.ingestLinesPerSecond;
		const burst = Math.max(1, settings.ingestBurst);
		const budget = settings.ingestMbPerDay * 1_000_000;
		const bucket = this.#bucket(key, burst, now);
		bucket.tokens = Math.min(burst, bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * rate);
		bucket.at = now;
		const total = this.#dayTotal(key, now);
		let admitted = 0;
		for (const size of sizes) {
			if (bucket.tokens < 1) break;
			if (total.bytes + size > budget) break;
			bucket.tokens -= 1;
			total.bytes += size;
			admitted += 1;
		}
		return admitted;
	}

	/** Count admitted lines for the daily budget and showback (one upsert per batch). */
	recordAccepted(scope: LogIngestScope, lines: number, bytes: number, now = this.ctx.now()): void {
		if (lines <= 0) return;
		const day = dayStart(now);
		try {
			this.ctx.sqlite.run(
				`INSERT INTO log_ingest_daily (org_id, scope_kind, scope_id, project_id, day, lines, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (scope_kind, scope_id, day) DO UPDATE SET lines = lines + excluded.lines, bytes = bytes + excluded.bytes`,
				[scope.orgId, scope.scopeKind, scope.scopeId, scope.projectId, day, lines, bytes],
			);
		} catch (error) {
			// Showback must never fail an append.
			console.error('[logs] ingest usage write failed', error);
		}
	}

	/** Count dropped lines (`log_drop_counts`, per minute); quota drops also queue a notice. */
	recordDropped(scope: LogIngestScope, reason: LogDropReason, lines: number, bytes: number, now = this.ctx.now()): void {
		if (lines <= 0) return;
		try {
			this.ctx.sqlite.run(
				`INSERT INTO log_drop_counts (org_id, scope_kind, scope_id, minute, reason, lines, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (scope_kind, scope_id, minute, reason) DO UPDATE SET lines = lines + excluded.lines, bytes = bytes + excluded.bytes`,
				[scope.orgId, scope.scopeKind, scope.scopeId, Math.floor(now / MINUTE_MS) * MINUTE_MS, reason, lines, bytes],
			);
		} catch (error) {
			console.error('[logs] drop count write failed', error);
		}
		if (reason !== 'quota') return;
		const key = scopeKeyOf(scope);
		const pending = this.#pending.get(key);
		if (pending) {
			pending.lines += lines;
			pending.bytes += bytes;
		} else this.#pending.set(key, { scope, lines, bytes, since: now });
	}

	/**
	 * Notices that are due: at most one per scope per minute, each summing the drops since the
	 * previous one. Call after an append (for that scope) and from the maintenance sweep (all), so a
	 * burst that stops still gets its notice.
	 */
	noticesDue(now = this.ctx.now(), only?: LogIngestScope): Array<{ scope: LogIngestScope; message: string; lines: number }> {
		const out: Array<{ scope: LogIngestScope; message: string; lines: number }> = [];
		const keys = only ? [scopeKeyOf(only)] : [...this.#pending.keys()];
		for (const key of keys) {
			const pending = this.#pending.get(key);
			if (!pending) continue;
			const last = this.#lastNotice.get(key);
			if (last !== undefined && now - last < LOG_QUOTA_NOTICE_INTERVAL_MS) continue;
			this.#pending.delete(key);
			this.#lastNotice.set(key, now);
			if (this.#lastNotice.size > MAX_TRACKED_SCOPES) this.#lastNotice.clear();
			out.push({ scope: pending.scope, lines: pending.lines, message: quotaNoticeText(pending, this.ctx.logSettings.effective(pending.scope.orgId, pending.scope.projectId)) });
		}
		return out;
	}

	/**
	 * Log ingest per scope per UTC day for the caller's org (QUOTAS.md showback): lines and bytes
	 * admitted, and lines dropped. Project scopes the caller cannot read are left out.
	 */
	usage(principal: Principal, options: { days?: number; projectId?: string | null } = {}): LogUsageReport {
		this.ctx.iam.require(principal, 'project:read', options.projectId ? { type: 'project', id: options.projectId } : { type: 'org' });
		const days = Math.max(1, Math.min(90, Math.floor(options.days ?? 7)));
		const now = this.ctx.now();
		const from = dayStart(now) - (days - 1) * DAY_MS;
		const project = options.projectId ?? null;
		const ingest = this.ctx.sqlite
			.query<{ scope_kind: string; scope_id: string; project_id: string | null; day: number; lines: number; bytes: number }, [string, number, string | null, string | null]>(
				`SELECT scope_kind, scope_id, project_id, day, lines, bytes FROM log_ingest_daily
				 WHERE org_id = ? AND day >= ? AND (? IS NULL OR project_id = ?) ORDER BY day`,
			)
			.all(principal.orgId, from, project, project);
		const drops = this.ctx.sqlite
			.query<{ scope_kind: string; scope_id: string; day: number; lines: number }, [number, string, number]>(
				`SELECT scope_kind, scope_id, (minute / ?) AS day, SUM(lines) AS lines FROM log_drop_counts
				 WHERE org_id = ? AND minute >= ? GROUP BY scope_kind, scope_id, day`,
			)
			.all(DAY_MS, principal.orgId, from);
		const rows = new Map<string, LogUsageRow>();
		const dayLabel = (ms: number) => new Date(ms).toISOString().slice(0, 10);
		const row = (kind: string, id: string, projectId: string | null): LogUsageRow => {
			const key = `${kind}:${id}`;
			let entry = rows.get(key);
			if (!entry) {
				entry = { scope: { kind, id }, name: null, projectId, days: [], bytes: 0, lines: 0, droppedLines: 0, bytesPerDay: 0 };
				for (let index = 0; index < days; index++) entry.days.push({ day: dayLabel(from + index * DAY_MS), lines: 0, bytes: 0, droppedLines: 0 });
				rows.set(key, entry);
			}
			return entry;
		};
		for (const item of ingest) {
			const entry = row(item.scope_kind, item.scope_id, item.project_id);
			const slot = entry.days[Math.round((item.day - from) / DAY_MS)];
			if (slot) {
				slot.lines += item.lines;
				slot.bytes += item.bytes;
			}
			entry.lines += item.lines;
			entry.bytes += item.bytes;
		}
		for (const item of drops) {
			if (project && !(item.scope_kind === 'project' && item.scope_id === project)) continue;
			const entry = row(item.scope_kind, item.scope_id, item.scope_kind === 'project' ? item.scope_id : null);
			const slot = entry.days[Math.round((Number(item.day) * DAY_MS - from) / DAY_MS)];
			if (slot) slot.droppedLines += item.lines;
			entry.droppedLines += item.lines;
		}
		const visible = [...rows.values()].filter(
			(entry) => entry.scope.kind !== 'project' || this.ctx.iam.can(principal, 'project:read', { type: 'project', id: entry.scope.id }),
		);
		const names = lookupLogScopeNames(
			this.ctx.sqlite,
			visible.map((entry) => ({ kind: entry.scope.kind as LogScopeKind, id: entry.scope.id })),
		);
		for (const entry of visible) {
			entry.name = names.get(formatLogScope({ kind: entry.scope.kind as LogScopeKind, id: entry.scope.id })) ?? null;
			entry.bytesPerDay = Math.round(entry.bytes / days);
		}
		visible.sort((a, b) => b.bytes - a.bytes);
		return {
			days,
			rows: visible,
			totalBytes: visible.reduce((sum, entry) => sum + entry.bytes, 0),
			totalLines: visible.reduce((sum, entry) => sum + entry.lines, 0),
			totalDroppedLines: visible.reduce((sum, entry) => sum + entry.droppedLines, 0),
		};
	}

	/** Forget buckets and totals (tests; a settings change takes effect on the next refill anyway). */
	reset(): void {
		this.#buckets.clear();
		this.#days.clear();
		this.#pending.clear();
		this.#lastNotice.clear();
	}

	#bucket(key: string, burst: number, now: number): Bucket {
		let bucket = this.#buckets.get(key);
		if (!bucket) {
			if (this.#buckets.size > MAX_TRACKED_SCOPES) this.#buckets.clear();
			bucket = { tokens: burst, at: now };
			this.#buckets.set(key, bucket);
		}
		return bucket;
	}

	#dayTotal(key: string, now: number): DayTotal {
		const day = dayStart(now);
		let total = this.#days.get(key);
		if (!total || total.day !== day) {
			if (this.#days.size > MAX_TRACKED_SCOPES) this.#days.clear();
			const [kind, ...rest] = key.split(':');
			let seeded = 0;
			try {
				seeded =
					this.ctx.sqlite
						.query<{ bytes: number }, [string, string, number]>('SELECT bytes FROM log_ingest_daily WHERE scope_kind = ? AND scope_id = ? AND day = ?')
						.get(kind ?? '', rest.join(':'), day)?.bytes ?? 0;
			} catch {
				seeded = 0;
			}
			total = { day, bytes: seeded };
			this.#days.set(key, total);
		}
		return total;
	}
}

function quotaNoticeText(pending: PendingNotice, settings: { ingestLinesPerSecond: number; ingestBurst: number; ingestMbPerDay: number }): string {
	const lines = pending.lines === 1 ? '1 line' : `${pending.lines.toLocaleString('en-US')} lines`;
	return (
		`Dropped ${lines} (quota): this scope is over its log ingest limit of ` +
		`${settings.ingestLinesPerSecond.toLocaleString('en-US')} lines/s (burst ${settings.ingestBurst.toLocaleString('en-US')}) ` +
		`or ${settings.ingestMbPerDay.toLocaleString('en-US')} MB/day. A platform admin can raise it in Settings → Logs; an exclusion or sample rule lowers the volume.`
	);
}
