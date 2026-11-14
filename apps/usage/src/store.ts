import type { Database } from 'bun:sqlite';
import {
	usageCapabilityKeys,
	usageFeatureNames,
	usageMetricKeys,
	type UsageCapability,
	type UsageMetricKey,
	type UsagePing
} from '@yoal/contracts';

/**
 * The collector's storage (docs/USAGE-ANALYTICS.md).
 *
 * Two tables. `installs` is one row per anonymous install with its latest hardware facts and a
 * ping counter; `pings` keeps the validated payloads for a long retention window so a metric added
 * later can be answered retroactively. A ping id is unique, so a sender retrying after a timeout
 * does not double-count.
 */

export interface UsageStats {
	days: number;
	generatedAt: string;
	installs: { total: number; active7d: number; active30d: number };
	pings: { total: number; inWindow: number; last24h: number };
	versions: Array<{ name: string; installs: number }>;
	os: Array<{ name: string; installs: number }>;
	arch: Array<{ name: string; installs: number }>;
	metrics: Record<UsageMetricKey, { installs: number; total: number; average: number }>;
	features: Array<{ name: string; installs: number }>;
	capabilities: Array<{ name: UsageCapability; installs: number }>;
}

/** One UTC day of the time series. */
export interface UsageDay {
	/** `YYYY-MM-DD`, UTC. */
	day: string;
	/** Installs that pinged that day. */
	activeInstalls: number;
	/** Installs seen for the first time that day. */
	newInstalls: number;
	pings: number;
}

/** One install as the operator sees it. The id is a prefix: enough to tell installs apart. */
export interface UsageInstallRow {
	id: string;
	firstSeenAt: string;
	lastSeenAt: string;
	firstVersion: string;
	lastVersion: string;
	os: string;
	arch: string;
	pings: number;
	/** A few headline counts from the install's latest ping. */
	nodes: number | null;
	projects: number | null;
	users: number | null;
	features: number | null;
}

export interface UsageInstallPage {
	total: number;
	rows: UsageInstallRow[];
}

export const INSTALL_ID_HINT_LENGTH = 12;

const DAY_MS = 86_400_000;

export class UsageStore {
	constructor(
		private readonly db: Database,
		private readonly retentionDays = 400
	) {
		this.migrate();
	}

	private migrate(): void {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS installs (
				install_id TEXT PRIMARY KEY,
				first_seen_at INTEGER NOT NULL,
				last_seen_at INTEGER NOT NULL,
				first_version TEXT NOT NULL,
				last_version TEXT NOT NULL,
				os TEXT NOT NULL,
				arch TEXT NOT NULL,
				pings INTEGER NOT NULL DEFAULT 0
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS pings (
				id TEXT PRIMARY KEY,
				install_id TEXT NOT NULL,
				received_at INTEGER NOT NULL,
				sent_at INTEGER NOT NULL,
				version TEXT NOT NULL,
				payload_json TEXT NOT NULL
			)
		`);
		this.db.run('CREATE INDEX IF NOT EXISTS pings_install_idx ON pings (install_id, received_at)');
		this.db.run('CREATE INDEX IF NOT EXISTS pings_received_idx ON pings (received_at)');
	}

	/**
	 * Store one validated ping. `receivedAt` is the collector's clock, never the sender's: a
	 * misconfigured clock on an install must not hide it from the active-install counts.
	 */
	record(ping: UsagePing, receivedAt: number): { stored: boolean } {
		const payload = JSON.stringify(ping);
		return this.db.transaction(() => {
			const inserted = this.db
				.query(
					'INSERT OR IGNORE INTO pings (id, install_id, received_at, sent_at, version, payload_json) VALUES (?, ?, ?, ?, ?, ?)'
				)
				.run(ping.id, ping.installId, receivedAt, Date.parse(ping.sentAt), ping.version, payload);
			// A retry is the same ping: it must not bump the install's counter or move last_seen_at.
			if (inserted.changes === 0) return { stored: false };
			this.db
				.query(
					`INSERT INTO installs (install_id, first_seen_at, last_seen_at, first_version, last_version, os, arch, pings)
					 VALUES (?, ?, ?, ?, ?, ?, ?, 1)
					 ON CONFLICT(install_id) DO UPDATE SET
						last_seen_at = excluded.last_seen_at,
						last_version = excluded.last_version,
						os = excluded.os,
						arch = excluded.arch,
						pings = installs.pings + 1`
				)
				.run(ping.installId, receivedAt, receivedAt, ping.version, ping.version, ping.os, ping.arch);
			this.prune(receivedAt);
			return { stored: true };
		})();
	}

	/** Drop raw pings past the retention window; per-install latest state survives in `installs`. */
	prune(now = Date.now()): number {
		const cutoff = now - this.retentionDays * DAY_MS;
		return this.db.query('DELETE FROM pings WHERE received_at < ?').run(cutoff).changes;
	}

	/** Everyone's latest ping inside the window, for the stats view. One row per install. */
	private latestPayloads(now: number, days: number): UsagePing[] {
		const since = now - days * DAY_MS;
		const rows = this.db
			.query<{ payload_json: string }, [number]>(
				`SELECT payload_json FROM pings p
				 WHERE p.received_at >= ?
				   AND p.received_at = (SELECT MAX(q.received_at) FROM pings q WHERE q.install_id = p.install_id)
				 GROUP BY p.install_id`
			)
			.all(since);
		const pings: UsagePing[] = [];
		for (const row of rows) {
			try {
				pings.push(JSON.parse(row.payload_json) as UsagePing);
			} catch {
				// A row written by an older version that no longer parses is skipped, never fatal.
			}
		}
		return pings;
	}

	private count(sql: string, ...params: Array<string | number>): number {
		return this.db.query<{ count: number }, Array<string | number>>(sql).get(...params)?.count ?? 0;
	}

	/** Daily active and new installs and ping counts for the last `days` UTC days, oldest first. */
	daily(now = Date.now(), days = 30): UsageDay[] {
		const today = Math.floor(now / DAY_MS);
		const first = today - days + 1;
		const since = first * DAY_MS;
		const active = new Map<number, { installs: number; pings: number }>();
		for (const row of this.db
			.query<{ d: number; installs: number; pings: number }, [number]>(
				`SELECT CAST(received_at / ${DAY_MS} AS INTEGER) AS d, COUNT(DISTINCT install_id) AS installs, COUNT(*) AS pings
				 FROM pings WHERE received_at >= ? GROUP BY d`
			)
			.all(since))
			active.set(row.d, { installs: row.installs, pings: row.pings });
		const fresh = new Map<number, number>();
		for (const row of this.db
			.query<{ d: number; installs: number }, [number]>(
				`SELECT CAST(first_seen_at / ${DAY_MS} AS INTEGER) AS d, COUNT(*) AS installs FROM installs WHERE first_seen_at >= ? GROUP BY d`
			)
			.all(since))
			fresh.set(row.d, row.installs);
		const series: UsageDay[] = [];
		for (let d = first; d <= today; d++)
			series.push({
				day: new Date(d * DAY_MS).toISOString().slice(0, 10),
				activeInstalls: active.get(d)?.installs ?? 0,
				newInstalls: fresh.get(d) ?? 0,
				pings: active.get(d)?.pings ?? 0
			});
		return series;
	}

	/** Installs, most recently seen first, with headline counts from each one's latest ping. */
	installs(options: { limit?: number; offset?: number; version?: string | null } = {}): UsageInstallPage {
		const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
		const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
		const where = options.version ? 'WHERE i.last_version = ?' : '';
		const params: Array<string | number> = options.version ? [options.version] : [];
		const total = this.count(`SELECT COUNT(*) AS count FROM installs i ${where}`, ...params);
		const rows = this.db
			.query<
				{
					install_id: string;
					first_seen_at: number;
					last_seen_at: number;
					first_version: string;
					last_version: string;
					os: string;
					arch: string;
					pings: number;
					payload_json: string | null;
				},
				Array<string | number>
			>(
				`SELECT i.*, (
					SELECT p.payload_json FROM pings p WHERE p.install_id = i.install_id ORDER BY p.received_at DESC LIMIT 1
				 ) AS payload_json
				 FROM installs i ${where}
				 ORDER BY i.last_seen_at DESC, i.install_id
				 LIMIT ? OFFSET ?`
			)
			.all(...params, limit, offset);
		return {
			total,
			rows: rows.map((row) => {
				let latest: UsagePing | null = null;
				try {
					latest = row.payload_json ? (JSON.parse(row.payload_json) as UsagePing) : null;
				} catch {
					latest = null;
				}
				return {
					id: row.install_id.slice(0, INSTALL_ID_HINT_LENGTH),
					firstSeenAt: new Date(row.first_seen_at).toISOString(),
					lastSeenAt: new Date(row.last_seen_at).toISOString(),
					firstVersion: row.first_version,
					lastVersion: row.last_version,
					os: row.os,
					arch: row.arch,
					pings: row.pings,
					nodes: latest?.metrics.nodes ?? null,
					projects: latest?.metrics.projects ?? null,
					users: latest?.metrics.users ?? null,
					features: latest ? latest.features.length : null
				};
			})
		};
	}

	stats(now = Date.now(), days = 30): UsageStats {
		const since = now - days * DAY_MS;
		const payloads = this.latestPayloads(now, days);

		const metrics = Object.fromEntries(
			usageMetricKeys.map((key) => [key, { installs: 0, total: 0, average: 0 }])
		) as UsageStats['metrics'];
		for (const ping of payloads) {
			for (const key of usageMetricKeys) {
				const value = ping.metrics[key] ?? 0;
				const bucket = metrics[key];
				bucket.installs += 1;
				bucket.total += value;
			}
		}
		for (const key of usageMetricKeys) {
			const bucket = metrics[key];
			bucket.average = payloads.length > 0 ? Math.round((bucket.total / payloads.length) * 10) / 10 : 0;
		}

		const featureCounts = new Map<string, number>(usageFeatureNames.map((name) => [name, 0]));
		const capabilityCounts = new Map<UsageCapability, number>(
			usageCapabilityKeys.map((name) => [name, 0])
		);
		for (const ping of payloads) {
			for (const name of ping.features) {
				if (featureCounts.has(name)) featureCounts.set(name, featureCounts.get(name)! + 1);
			}
			for (const name of ping.capabilities as UsageCapability[]) {
				if (capabilityCounts.has(name))
					capabilityCounts.set(name, capabilityCounts.get(name)! + 1);
			}
		}

		const installs = this.count('SELECT COUNT(*) AS count FROM installs');
		const active7d = this.count('SELECT COUNT(*) AS count FROM installs WHERE last_seen_at >= ?', now - 7 * DAY_MS);
		const active30d = this.count('SELECT COUNT(*) AS count FROM installs WHERE last_seen_at >= ?', now - 30 * DAY_MS);

		const grouped = (column: 'last_version' | 'os' | 'arch') =>
			this.db
				.query<{ name: string; installs: number }, [number]>(
					`SELECT ${column} AS name, COUNT(*) AS installs FROM installs WHERE last_seen_at >= ? GROUP BY ${column} ORDER BY installs DESC, name`
				)
				.all(since);

		return {
			days,
			generatedAt: new Date(now).toISOString(),
			installs: { total: installs, active7d, active30d },
			pings: {
				total: this.count('SELECT COUNT(*) AS count FROM pings'),
				inWindow: this.count('SELECT COUNT(*) AS count FROM pings WHERE received_at >= ?', since),
				last24h: this.count('SELECT COUNT(*) AS count FROM pings WHERE received_at >= ?', now - DAY_MS)
			},
			versions: grouped('last_version').slice(0, 20),
			os: grouped('os'),
			arch: grouped('arch'),
			metrics,
			features: [...featureCounts]
				.map(([name, installs]) => ({ name, installs }))
				.sort((a, b) => b.installs - a.installs || a.name.localeCompare(b.name)),
			capabilities: ([...capabilityCounts] as Array<[UsageCapability, number]>)
				.map(([name, installs]) => ({ name, installs }))
				.sort((a, b) => b.installs - a.installs || a.name.localeCompare(b.name))
		};
	}
}
