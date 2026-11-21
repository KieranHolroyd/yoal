import type {
	ExternalProberAck,
	ExternalProberList,
	ExternalProberRegistration,
	ExternalProberRegistrationInput,
	ExternalProberReport,
	ExternalProberTarget,
	ExternalProberView,
	Principal,
} from '@yoal/contracts';
import { externalProberRegistrationInputSchema } from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { CoreError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from './errors.ts';
import { newId, parseJson, randomToken, sha256Hex } from './util.ts';

/** One registration, stored as one JSON document in `settings`; no migration for a small list. */
interface StoredProber {
	proberId: string;
	name: string;
	installId: string | null;
	intervalSeconds: number;
	/** sha256 hex of the raw token; the token itself is never stored. */
	tokenHash: string;
	createdBy: string;
	createdAt: number;
	revokedAt: number | null;
	lastSequence: number;
	lastReportAt: number | null;
	lastSentAt: number | null;
	targets: ExternalProberTarget[];
}

interface ProberDocument {
	version: 1;
	registrations: StoredProber[];
}

const SETTINGS_KEY = 'external_prober_registrations';
const TOKEN_PREFIX = 'yoalp_';
/** A prober is unhealthy after max(3 intervals, this); a short interval cannot page on one miss. */
const MIN_STALE_SECONDS = 120;

/**
 * The external prober's registration and report sink (HA-PLAN W15).
 *
 * A tiny runner outside the fleet registers once, receives a token, and POSTs what it saw. The sink
 * verifies the token, de-duplicates by sequence and keeps the newest report per prober; `sweep()`
 * raises `ha.prober_stale` when a prober stops reporting, so an outage that also hides the control
 * plane is still visible from outside.
 *
 * Everything is gated by `EXTERNAL_PROBER`: with it off, no prober can register and the report route
 * is absent, so nothing accepts reports.
 */
export class ExternalProberService {
	constructor(private readonly ctx: CoreContext) {}

	/** Whether the sink accepts reports; the HTTP route is absent while this is false. */
	enabled(): boolean {
		return featureEnabled(this.ctx.config, 'EXTERNAL_PROBER');
	}

	/** Register a prober and return its token once. */
	register(principal: Principal, input: ExternalProberRegistrationInput): ExternalProberRegistration {
		if (!this.enabled())
			throw new CoreError('unavailable', 'The external prober is off: enable EXTERNAL_PROBER first (HA-PLAN W15).', 409);
		this.#requireAdmin(principal);
		const parsed = externalProberRegistrationInputSchema.safeParse(input);
		if (!parsed.success) throw new ValidationError('Invalid prober registration.', parsed.error.issues);
		const document = this.#read();
		if (document.registrations.some((row) => row.revokedAt === null && row.name === parsed.data.name))
			throw new CoreError('conflict', `A prober named "${parsed.data.name}" is already registered.`, 409);
		const token = `${TOKEN_PREFIX}${randomToken(32)}`;
		const now = this.ctx.now();
		const stored: StoredProber = {
			proberId: newId('prb_'),
			name: parsed.data.name,
			installId: parsed.data.installId,
			intervalSeconds: parsed.data.intervalSeconds,
			tokenHash: sha256Hex(token),
			createdBy: principal.userId,
			createdAt: now,
			revokedAt: null,
			lastSequence: 0,
			lastReportAt: null,
			lastSentAt: null,
			targets: [],
		};
		document.registrations.push(stored);
		this.#write(document);
		this.ctx.audit.record({
			principal,
			action: 'ha.prober.register',
			resource: 'external_prober',
			resourceId: stored.proberId,
			args: { name: stored.name, intervalSeconds: stored.intervalSeconds, installId: stored.installId },
			result: 'ok',
		});
		return { prober: this.#view(stored, now), token };
	}

	/** Registered probers with their last report and health; never the token or its hash. */
	list(principal: Principal): ExternalProberList {
		if (!this.ctx.platformIam.canView(principal))
			throw new ForbiddenError('platform:read', 'External probers are platform-wide.');
		if (!this.enabled()) return { enabled: false, probers: [] };
		const now = this.ctx.now();
		return {
			enabled: true,
			probers: this.#read()
				.registrations.map((row) => this.#view(row, now))
				.sort((a, b) => a.name.localeCompare(b.name)),
		};
	}

	/** Revoke a prober; its next report is refused. */
	revoke(principal: Principal, proberId: string): ExternalProberView {
		if (!this.enabled())
			throw new CoreError('unavailable', 'The external prober is off: enable EXTERNAL_PROBER first (HA-PLAN W15).', 409);
		this.#requireAdmin(principal);
		const document = this.#read();
		const row = document.registrations.find((candidate) => candidate.proberId === proberId);
		if (!row) throw new NotFoundError('External prober');
		if (row.revokedAt === null) {
			row.revokedAt = this.ctx.now();
			this.#write(document);
			this.ctx.audit.record({
				principal,
				action: 'ha.prober.revoke',
				resource: 'external_prober',
				resourceId: proberId,
				args: { name: row.name },
				result: 'ok',
			});
		}
		return this.#view(row, this.ctx.now());
	}

	/**
	 * Accept one report. The token is the prober's only credential; a duplicate or older sequence is
	 * acknowledged with `accepted: 0` and changes nothing, so a retry after a lost response is safe.
	 */
	async report(token: string | null, report: ExternalProberReport): Promise<ExternalProberAck> {
		if (!this.enabled())
			throw new CoreError('unavailable', 'The external prober is off: enable EXTERNAL_PROBER first (HA-PLAN W15).', 409);
		if (!token) throw new UnauthorizedError('Send the prober token as a Bearer credential.');
		const hash = sha256Hex(token);
		const document = this.#read();
		const row = document.registrations.find((candidate) => candidate.tokenHash === hash && candidate.revokedAt === null);
		if (!row) throw new UnauthorizedError('Unknown or revoked prober token.');
		if (row.proberId !== report.proberId)
			throw new UnauthorizedError('The token does not belong to that prober.');
		if (row.installId !== null && report.installId !== null && row.installId !== report.installId)
			throw new CoreError('conflict', 'The report names a different install than the registration.', 409);
		const now = this.ctx.now();
		const receivedAt = new Date(now).toISOString();
		if (report.sequence <= row.lastSequence)
			return { proberId: row.proberId, sequence: report.sequence, receivedAt, accepted: 0 };
		row.lastSequence = report.sequence;
		row.lastReportAt = now;
		row.lastSentAt = Date.parse(report.sentAt);
		row.targets = report.targets;
		this.#write(document);
		return { proberId: row.proberId, sequence: report.sequence, receivedAt, accepted: report.targets.length };
	}

	/** Raise `ha.prober_stale` for every prober past its health window. No-op while off. */
	async sweep(): Promise<string[]> {
		if (!this.enabled()) return [];
		const now = this.ctx.now();
		const fired: string[] = [];
		for (const row of this.#read().registrations) {
			if (row.revokedAt !== null) continue;
			const view = this.#view(row, now);
			if (!view.stale) continue;
			const key = `ha.prober_stale:${row.proberId}`;
			if (!this.ctx.alerts.systemRoute(key)) continue;
			const last = this.ctx.sqlite
				.query<{ last_fired_at: number | null }, [string]>('SELECT last_fired_at FROM alert_state WHERE key = ?')
				.get(key);
			const cooldown = this.ctx.policies.get().systemAlertRepeatMinutes * 60_000;
			if (last?.last_fired_at && now - last.last_fired_at < cooldown) continue;
			this.ctx.sqlite.run(
				'INSERT INTO alert_state (key, last_fired_at, last_value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET last_fired_at = excluded.last_fired_at, last_value = excluded.last_value',
				[key, now, row.proberId],
			);
			await this.ctx.alerts.deliverSystem({
				key,
				title: `External prober silent: ${row.name}`,
				detail:
					`Prober "${row.name}" (${row.proberId}) has not reported for more than ${view.staleAfterSeconds}s ` +
					'(or never reported). Outside-in availability is unknown until it returns.',
				severity: 'warning',
			});
			fired.push(key);
		}
		return fired;
	}

	#view(row: StoredProber, now: number): ExternalProberView {
		const staleAfterSeconds = Math.max(MIN_STALE_SECONDS, row.intervalSeconds * 3);
		const since = row.lastReportAt ?? stackAgeStart(row);
		const stale = row.revokedAt === null && now - since > staleAfterSeconds * 1_000;
		const counts = { up: 0, degraded: 0, down: 0 };
		for (const target of row.targets) counts[target.status] += 1;
		return {
			proberId: row.proberId,
			name: row.name,
			installId: row.installId,
			intervalSeconds: row.intervalSeconds,
			createdBy: row.createdBy,
			createdAt: new Date(row.createdAt).toISOString(),
			revokedAt: row.revokedAt === null ? null : new Date(row.revokedAt).toISOString(),
			lastReportAt: row.lastReportAt === null ? null : new Date(row.lastReportAt).toISOString(),
			lastSequence: row.lastSequence,
			stale,
			staleAfterSeconds,
			targets: row.targets.map((target) => ({
				target: target.target,
				kind: target.kind,
				status: target.status,
				statusCode: target.statusCode,
				latencyMs: target.latencyMs,
				error: target.error,
				checkedAt: target.checkedAt,
			})),
			counts,
		};
	}

	#requireAdmin(principal: Principal): void {
		if (!this.ctx.platformIam.canAdminister(principal))
			throw new ForbiddenError('platform:administer', 'Registering an external prober is a platform-admin action.');
	}

	#read(): ProberDocument {
		const row = this.ctx.sqlite.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY);
		const raw = parseJson<Partial<ProberDocument>>(row?.value ?? null, {});
		if (!raw || !Array.isArray(raw.registrations)) return { version: 1, registrations: [] };
		return { version: 1, registrations: raw.registrations as StoredProber[] };
	}

	#write(document: ProberDocument): void {
		this.ctx.sqlite.run(
			'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
			[SETTINGS_KEY, JSON.stringify(document), this.ctx.now()],
		);
	}
}

/** A prober that has never reported is stale after the window from its registration, not from epoch. */
function stackAgeStart(row: StoredProber): number {
	return row.createdAt;
}
