import { hkdfSync } from 'node:crypto';
import { SEVERITY_NUMBER, type LogLevel } from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { createRedactor, createSecretFingerprints, type Redactor, type SecretFingerprintSet } from './log-redaction.ts';
import type { LogQuotaService, LogDropReason, LogIngestScope } from './log-quotas.ts';
import type { LogRuleService } from './log-rules.ts';
import { unifiedRowToLogRecord, type SqliteLogTag, type UnifiedLogRow } from './log-store/sqlite-sources.ts';

/**
 * The ingest guard (docs/LOGS.md §4 diagram, §10.2–§10.4): the one call every append path makes
 * before it writes a hot-tail table. In order:
 *
 * 1. **Rules** (`LogRuleService`): `exclude` drops, `sample` keeps a share (§10.3).
 * 2. **Quota** (`LogQuotaService`): the scope's token bucket and daily bytes (§10.2).
 * 3. **Redaction** (`createRedactor`, Lane D): built-in detectors, the org's (and project's)
 *    `redact` rules, and known-secret fingerprints of the org's secret values (§10.4). Bodies and
 *    attribute/resource values are masked before SQLite, drains, the live tail and the indexer.
 *
 * Lifecycle notices (`system` source) skip rules and quotas but are still redacted.
 *
 * **Known secrets.** The fingerprint key is derived from the master key with HKDF-SHA256
 * (`deriveLogFingerprintKey`), so it is stable across restarts and never stored. The fingerprint
 * set per org is built when its secrets change (`secretsChanged`, called by `SecretService`) or on
 * the org's first ingest after boot — never per line — by decrypting the org's `secret`-type
 * values once; the plaintext is dropped right after. The redactor then holds only fingerprints
 * (a rolling-hash prefilter plus keyed HMACs; spike S5), so the hot path decrypts nothing.
 */

type GuardContext = Pick<CoreContext, 'sqlite' | 'config' | 'now'> &
	Partial<Pick<CoreContext, 'secrets' | 'logs'>> & {
		logRules: LogRuleService;
		logQuotas: LogQuotaService;
	};

/** Secret values fingerprinted per org at most (values × encodings stay well under the matcher's bounds). */
export const MAX_FINGERPRINTED_SECRETS = 2_000;

const HKDF_SALT = 'yoal/logs';
const HKDF_INFO = 'log-redaction-secret-fingerprints-v1';

/** How far ahead of the control plane's clock a record's `ts` may be (node clock skew). */
export const LOG_MAX_FUTURE_MS = 5 * 60_000;

/**
 * A record's event time as stored by every ingest path: at most `now + LOG_MAX_FUTURE_MS`. A
 * future `ts` would otherwise sort above every real line for days, dodge age retention and pin
 * live-tail and search pages; an unusable value (not finite) becomes `now`.
 */
export function capLogTs(ts: number | null | undefined, now: number): number {
	if (ts === null || ts === undefined || !Number.isFinite(ts)) return now;
	return Math.min(ts, now + LOG_MAX_FUTURE_MS);
}

/** The fingerprint key: HKDF-SHA256 of the master key, 32 bytes (docs/LOGS.md §10.4). */
export function deriveLogFingerprintKey(masterKey: Uint8Array): Uint8Array {
	return new Uint8Array(hkdfSync('sha256', masterKey, HKDF_SALT, HKDF_INFO, 32));
}

/** How the guard reads and rewrites one row of an append path. */
export interface GuardAccess<T> {
	/** The row as unified columns, for rule predicates (seq 0). */
	unified(row: T, scope: LogIngestScope): UnifiedLogRow;
	/** Stored size in bytes (close enough: string lengths). */
	size(row: T): number;
	body(row: T): string;
	/** Attribute and resource maps to redact, when the table stores them. */
	maps?(row: T): { attributes: Record<string, string> | null; resource: Record<string, string> | null };
	/** A copy with a new body (and maps). */
	with(row: T, body: string, maps?: { attributes: Record<string, string> | null; resource: Record<string, string> | null }): T;
}

const LEVEL_SEVERITY: Record<string, number> = {
	debug: SEVERITY_NUMBER.debug,
	info: SEVERITY_NUMBER.info,
	warn: SEVERITY_NUMBER.warn,
	error: SEVERITY_NUMBER.error,
};

/** Rows with `message` + `level` (log_events, service/broker/k8s log events). */
export function messageRowAccess<T extends { message: string; level?: LogLevel | string; source?: string; stream?: string | null; ts?: number | null }>(
	tag: SqliteLogTag,
	extra: (row: T) => Partial<UnifiedLogRow> = () => ({}),
): GuardAccess<T> {
	return {
		unified: (row, scope) => ({
			tag,
			seq: 0,
			ts: Number(row.ts ?? 0),
			observed_ts: null,
			org_id: scope.orgId,
			scope_kind: scope.scopeKind,
			scope_id: scope.scopeId,
			stream: null,
			source: row.source ?? 'runtime',
			channel: row.stream ?? null,
			severity_number: LEVEL_SEVERITY[String(row.level ?? 'info')] ?? SEVERITY_NUMBER.info,
			body: row.message,
			attributes: null,
			resource: null,
			trace_id: null,
			span_id: null,
			request_id: null,
			project_id: scope.projectId,
			deployment_id: null,
			build_id: null,
			job_run_id: null,
			node_id: null,
			...extra(row),
		}),
		size: (row) => row.message.length,
		body: (row) => row.message,
		with: (row, body) => (body === row.message ? row : { ...row, message: body }),
	};
}

/** Rows whose text lives in another field (`pipeline_log_lines.text`). */
export function textRowAccess<T extends { ts?: number | null; stream?: string | null }>(
	tag: SqliteLogTag,
	field: keyof T & string,
	extra: (row: T) => Partial<UnifiedLogRow> = () => ({}),
): GuardAccess<T> {
	const text = (row: T) => String(row[field] ?? '');
	const base = messageRowAccess<{ message: string; stream?: string | null; ts?: number | null }>(tag);
	return {
		unified: (row, scope) => ({ ...base.unified({ message: text(row), stream: row.stream ?? null, ts: row.ts ?? null }, scope), ...extra(row) }),
		size: (row) => text(row).length,
		body: text,
		with: (row, body) => (body === text(row) ? row : { ...row, [field]: body }),
	};
}

/** `log_records` rows as built by `buildLogRecordRows` (attributes/resource are JSON text). */
export const recordRowAccess: GuardAccess<Omit<UnifiedLogRow, 'seq'>> = {
	unified: (row) => ({ ...row, seq: 0 }),
	size: (row) => row.body.length + (row.attributes?.length ?? 0),
	body: (row) => row.body,
	maps: (row) => ({ attributes: parseMap(row.attributes), resource: parseMap(row.resource) }),
	with: (row, body, maps) => ({
		...row,
		body,
		...(maps?.attributes ? { attributes: JSON.stringify(maps.attributes) } : {}),
		...(maps?.resource ? { resource: JSON.stringify(maps.resource) } : {}),
	}),
};

function parseMap(text: string | null): Record<string, string> | null {
	if (!text || text === '{}') return null;
	try {
		const value = JSON.parse(text) as unknown;
		return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : null;
	} catch {
		return null;
	}
}

export interface GuardOptions {
	/** Lifecycle notices: redacted only, never dropped or counted against a quota. */
	system?: boolean;
	now?: number;
}

export interface GuardStats {
	kept: number;
	dropped: Partial<Record<LogDropReason, number>>;
}

export class LogIngestGuard {
	#key: Uint8Array | null = null;
	readonly #fingerprints = new Map<string, SecretFingerprintSet>();
	readonly #redactors = new Map<string, Redactor>();
	#random: () => number;
	/** The most recent `admit` outcome (tests and diagnostics). */
	last: GuardStats = { kept: 0, dropped: {} };

	constructor(
		private readonly ctx: GuardContext,
		options: { random?: () => number } = {},
	) {
		this.#random = options.random ?? Math.random;
		ctx.logRules.onChange.push((orgId) => this.#forgetRedactors(orgId));
	}

	/** Swap the sampler's randomness (tests). */
	setRandom(random: () => number): void {
		this.#random = random;
	}

	/**
	 * Filter, limit and redact one batch for a scope. Returns the rows to store, in order. Counts
	 * accepted and dropped lines and writes a quota notice when one is due.
	 */
	admit<T>(scope: LogIngestScope, rows: readonly T[], access: GuardAccess<T>, options: GuardOptions = {}): T[] {
		if (rows.length === 0) return [];
		const now = options.now ?? this.ctx.now();
		const dropped: Partial<Record<LogDropReason, { lines: number; bytes: number }>> = {};
		const drop = (reason: LogDropReason, row: T) => {
			const entry = (dropped[reason] ??= { lines: 0, bytes: 0 });
			entry.lines += 1;
			entry.bytes += access.size(row);
		};
		let kept: T[] = [...rows];
		if (!options.system) {
			// 1. Exclusion and sampling (§10.3), only when the org has such a rule.
			if (this.#hasIngestRules(scope)) {
				const next: T[] = [];
				for (const row of kept) {
					let decision: 'keep' | 'exclude' | 'sample' = 'keep';
					try {
						decision = this.ctx.logRules.ingestDecision(unifiedRowToLogRecord(access.unified(row, scope)), this.#random);
					} catch {
						decision = 'keep';
					}
					if (decision === 'keep') next.push(row);
					else drop(decision, row);
				}
				kept = next;
			}
			// 2. Quota (§10.2): the earliest lines that fit. Edge `access` lines use their own bucket,
			//    so outside traffic cannot spend the scope's runtime-log quota.
			if (kept.length > 0) {
				const isAccess = kept.map((row) => access.unified(row, scope).source === 'access');
				const admitted = { access: 0, scope: 0 };
				const accessRows = kept.filter((_, index) => isAccess[index]);
				const scopeRows = kept.filter((_, index) => !isAccess[index]);
				if (accessRows.length > 0)
					admitted.access = this.ctx.logQuotas.admit({ ...scope, bucket: 'access' }, accessRows.map((row) => access.size(row)), now);
				if (scopeRows.length > 0) admitted.scope = this.ctx.logQuotas.admit(scope, scopeRows.map((row) => access.size(row)), now);
				if (admitted.access < accessRows.length || admitted.scope < scopeRows.length) {
					const next: T[] = [];
					let seenAccess = 0;
					let seenScope = 0;
					kept.forEach((row, index) => {
						const fits = isAccess[index] ? seenAccess++ < admitted.access : seenScope++ < admitted.scope;
						if (fits) next.push(row);
						else drop('quota', row);
					});
					kept = next;
				}
			}
		}
		// 3. Redaction (§10.4) of everything that is stored.
		if (kept.length > 0) {
			const redactor = this.redactor(scope.orgId, scope.projectId);
			kept = kept.map((row) => {
				const body = access.body(row);
				const text = body ? redactor.redact(body).text : body;
				const maps = access.maps?.(row);
				if (!maps || (!maps.attributes && !maps.resource)) return access.with(row, text);
				return access.with(row, text, { attributes: redactMap(redactor, maps.attributes), resource: redactMap(redactor, maps.resource) });
			});
		}
		// Accounting.
		const bytes = kept.reduce((sum, row) => sum + access.size(row), 0);
		if (!options.system) this.ctx.logQuotas.recordAccepted(scope, kept.length, bytes, now);
		for (const [reason, entry] of Object.entries(dropped) as Array<[LogDropReason, { lines: number; bytes: number }]>)
			this.ctx.logQuotas.recordDropped(scope, reason, entry.lines, entry.bytes, now);
		this.last = {
			kept: kept.length,
			dropped: Object.fromEntries(Object.entries(dropped).map(([reason, entry]) => [reason, entry!.lines])),
		};
		if (dropped.quota) this.flushNotices(now, scope);
		return kept;
	}

	/** Redact one text for a scope (callers outside the batch paths, e.g. a build's text summary). */
	redact(orgId: string, projectId: string | null, text: string): string {
		return text ? this.redactor(orgId, projectId).redact(text).text : text;
	}

	/**
	 * Write the quota notices that are due (one `system` line per scope per minute, §10.2) into
	 * `log_records`, and publish them to the live tail. `only` limits it to one scope (after an
	 * append); the maintenance sweep calls it for all, so a burst that stopped still gets one.
	 */
	flushNotices(now = this.ctx.now(), only?: LogIngestScope): number {
		const due = this.ctx.logQuotas.noticesDue(now, only);
		if (due.length === 0) return 0;
		const logs = this.ctx.logs;
		const before = logs?.appendWanted() ? logs.maxSeq('lr') : null;
		for (const notice of due) {
			try {
				this.ctx.sqlite.run(
					`INSERT INTO log_records (org_id, scope_kind, scope_id, stream, source, channel, severity_number, body, attributes, resource, project_id, ts, observed_ts)
					 VALUES (?, ?, ?, NULL, 'system', 'system', ?, ?, ?, '{}', ?, ?, ?)`,
					[
						notice.scope.orgId,
						notice.scope.scopeKind,
						notice.scope.scopeId,
						SEVERITY_NUMBER.warn,
						notice.message,
						JSON.stringify({ 'yoal.dropped_lines': String(notice.lines), 'yoal.drop_reason': 'quota' }),
						notice.scope.projectId,
						now,
						now,
					],
				);
			} catch (error) {
				console.error('[logs] quota notice write failed', error);
			}
		}
		if (logs && before !== null) logs.publishInserted('lr', before);
		return due.length;
	}

	/** The cached redactor for an org (and project): built-ins, rules, and secret fingerprints. */
	redactor(orgId: string, projectId: string | null): Redactor {
		const key = `${orgId}|${projectId ?? ''}`;
		const cached = this.#redactors.get(key);
		if (cached) return cached;
		const rules = this.ctx.logRules.redactionRules(orgId, projectId);
		let redactor: Redactor;
		try {
			redactor = createRedactor({ rules, fingerprints: this.#fingerprintsFor(orgId), fingerprintKey: this.#fingerprintKey() });
		} catch (error) {
			// A rule that no longer compiles must not stop ingest: fall back to built-ins and secrets.
			console.error('[logs] redaction rules failed to compile; using built-ins only', error);
			redactor = createRedactor({ fingerprints: this.#fingerprintsFor(orgId), fingerprintKey: this.#fingerprintKey() });
		}
		if (this.#redactors.size > 10_000) this.#redactors.clear();
		this.#redactors.set(key, redactor);
		return redactor;
	}

	/**
	 * An org's secrets changed (`SecretService.set` / `delete`): rebuild its fingerprint set now, so
	 * the next line is checked against the new value and the old one stops costing anything.
	 */
	secretsChanged(orgId: string): void {
		this.#fingerprints.delete(orgId);
		this.#forgetRedactors(orgId);
		this.#fingerprintsFor(orgId);
	}

	/** Number of secret fingerprints held for an org (tests, diagnostics). */
	fingerprintCount(orgId: string): number {
		return this.#fingerprints.get(orgId)?.entries.length ?? 0;
	}

	#hasIngestRules(scope: LogIngestScope): boolean {
		try {
			return this.ctx.logRules.hasIngestRules(scope.orgId, scope.projectId);
		} catch {
			return false;
		}
	}

	#fingerprintKey(): Uint8Array {
		this.#key ??= deriveLogFingerprintKey(this.ctx.config.masterKey);
		return this.#key;
	}

	#fingerprintsFor(orgId: string): SecretFingerprintSet {
		const cached = this.#fingerprints.get(orgId);
		if (cached) return cached;
		let values: string[] = [];
		try {
			values = this.ctx.secrets?.valuesForLogRedaction(orgId, MAX_FINGERPRINTED_SECRETS) ?? [];
		} catch (error) {
			console.error('[logs] could not read secrets for redaction fingerprints', error);
			values = [];
		}
		const set = createSecretFingerprints(values, this.#fingerprintKey());
		values.length = 0;
		if (this.#fingerprints.size > 10_000) this.#fingerprints.clear();
		this.#fingerprints.set(orgId, set);
		return set;
	}

	#forgetRedactors(orgId: string): void {
		for (const key of [...this.#redactors.keys()]) if (key.startsWith(`${orgId}|`)) this.#redactors.delete(key);
	}
}

function redactMap(redactor: Redactor, map: Record<string, string> | null): Record<string, string> | null {
	if (!map) return null;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(map)) {
		if (typeof value !== 'string' || !value) {
			out[key] = value;
			continue;
		}
		// Redact as `key=value`, so credential-named keys (`password`, `api_key`) are caught by the
		// same detectors as in a body line.
		const pair = redactor.redact(`${key}=${value}`).text;
		out[key] = pair.startsWith(`${key}=`) ? pair.slice(key.length + 1) : redactor.redact(value).text;
	}
	return out;
}
