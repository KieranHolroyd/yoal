import {
	DEFAULT_LOG_EDGE_SAMPLE_RATE,
	LOG_HOT_DAYS_WITH_INDEX,
	LOG_SETTING_CEILINGS,
	LOG_SETTING_LEVELS,
	LOG_SETTINGS_DEFAULTS,
	LOG_SETTINGS_PLATFORM_ID,
	logSettingKeys,
	logSettingsPatchSchema,
	parseLogSettingsRow,
	type EffectiveLogSettings,
	type LogSettingKey,
	type LogSettingsLevel,
	type LogSettingsRow,
	type LogSettingsView,
	type LogSettingSource,
	type Principal,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { CoreError, NotFoundError, ValidationError } from './errors.ts';

/**
 * Logs cost and safety settings with inheritance (docs/LOGS.md §10, LP9; decisions §15). One JSON
 * row per level in `log_settings` (0142): platform → org → project. Reads are cached in memory and
 * the cache is cleared by every write in this process, so ingest, prune and desired state never
 * read SQLite per line.
 *
 * Effective values:
 * - a key a level may not set (`LOG_SETTING_LEVELS`) is ignored at that level;
 * - ingest quotas (`LOG_SETTING_CEILINGS`) set by an org or project are clamped to the value above,
 *   so a tenant can only lower its budget; raising one is a platform change;
 * - a project's `searchDays` is clamped to its org's;
 * - `hotDays` unset everywhere is 3 days while the search index runs (ClickHouse with `LOG_INDEX`),
 *   otherwise the platform policy `logRetentionDays` (7 by default, the pre-Explorer behaviour).
 *
 * Who writes: the platform row needs a platform admin; an org or project row needs `logs:configure`
 * on that scope. Platform and unattributed edge records (org `platform`) use the platform row.
 */

type SettingsContext = Pick<CoreContext, 'sqlite' | 'now' | 'iam' | 'platformIam' | 'policies' | 'audit'> &
	Partial<Pick<CoreContext, 'logIndexer'>>;

interface StoredRow {
	settings: string;
}

const cacheKey = (level: LogSettingsLevel, id: string) => `${level}:${id}`;

export class LogSettingsService {
	readonly #rows = new Map<string, LogSettingsRow | null>();
	readonly #effective = new Map<string, EffectiveLogSettings>();
	/** Called after every write (desired state, quota buckets and redactor caches listen). */
	readonly onChange: Array<(change: { level: LogSettingsLevel; id: string }) => void> = [];

	constructor(private readonly ctx: SettingsContext) {}

	/** Whether the search index (ClickHouse `yoal.logs` with `LOG_INDEX` on) is running here. */
	searchIndexOn(): boolean {
		try {
			return Boolean(this.ctx.logIndexer?.enabled);
		} catch {
			return false;
		}
	}

	/** One level's stored row (null when none), cached. */
	row(level: LogSettingsLevel, id: string): LogSettingsRow | null {
		const key = cacheKey(level, id);
		if (this.#rows.has(key)) return this.#rows.get(key) ?? null;
		let row: LogSettingsRow | null = null;
		try {
			const stored = this.ctx.sqlite
				.query<StoredRow, [string, string]>('SELECT settings FROM log_settings WHERE scope_type = ? AND scope_id = ?')
				.get(level, id);
			if (stored) row = parseLogSettingsRow(JSON.parse(stored.settings));
		} catch {
			row = null;
		}
		this.#rows.set(key, row);
		return row;
	}

	/** Every stored row of a level (for prune and archive passes, which run per org). */
	rows(level: LogSettingsLevel): Array<{ id: string; row: LogSettingsRow }> {
		try {
			return this.ctx.sqlite
				.query<{ scope_id: string; settings: string }, [string]>('SELECT scope_id, settings FROM log_settings WHERE scope_type = ?')
				.all(level)
				.map((stored) => {
					let row: LogSettingsRow = {};
					try {
						row = parseLogSettingsRow(JSON.parse(stored.settings));
					} catch {
						row = {};
					}
					return { id: stored.scope_id, row };
				});
		} catch {
			return [];
		}
	}

	/**
	 * Effective settings for an org (projectId null) or a project in it. The platform's own records
	 * (org `platform`) resolve from the platform row alone.
	 */
	effective(orgId: string, projectId: string | null = null): EffectiveLogSettings {
		const index = this.searchIndexOn();
		const key = `${index ? 1 : 0}|${orgId}|${projectId ?? ''}`;
		const cached = this.#effective.get(key);
		if (cached) return cached;
		const platform = this.row('platform', LOG_SETTINGS_PLATFORM_ID) ?? {};
		const org = orgId === LOG_SETTINGS_PLATFORM_ID ? null : this.row('org', orgId);
		const project = projectId ? this.row('project', projectId) : null;
		const result = resolveLogSettings({
			platform,
			org,
			project,
			searchIndex: index,
			hotDaysFallback: this.ctx.policies.get().logRetentionDays,
		});
		if (this.#effective.size > 10_000) this.#effective.clear();
		this.#effective.set(key, result);
		return result;
	}

	/**
	 * The `accessLogSampleRate` for a project's routes in desired state (LP6), or undefined when it
	 * is the agent's default, so desired state stays byte-identical until someone changes it.
	 */
	edgeSampleRateFor(orgId: string, projectId: string): number | undefined {
		const rate = this.effective(orgId, projectId).edgeSampleRate;
		return rate === DEFAULT_LOG_EDGE_SAMPLE_RATE ? undefined : rate;
	}

	/** `GET /api/v1/logs/settings`: the platform (admins), the caller's org, or one of its projects. */
	view(principal: Principal, target: { level: LogSettingsLevel; project?: { id: string; slug: string; orgId: string } | null }): LogSettingsView {
		const platform = this.row('platform', LOG_SETTINGS_PLATFORM_ID) ?? {};
		const searchIndex = this.searchIndexOn();
		const archiveAvailable = searchIndex;
		if (target.level === 'platform') {
			if (!this.ctx.platformIam.canAdminister(principal) && !this.ctx.platformIam.canView(principal))
				throw new CoreError('forbidden', 'Only a platform admin can read the platform log settings.', 403);
			return {
				level: 'platform',
				target: { orgId: null, projectId: null, projectSlug: null },
				platform,
				org: null,
				project: null,
				effective: this.effective(LOG_SETTINGS_PLATFORM_ID),
				canEdit: this.ctx.platformIam.canAdminister(principal),
				searchIndex,
				archiveAvailable,
			};
		}
		const project = target.level === 'project' ? target.project ?? null : null;
		if (target.level === 'project' && (!project || project.orgId !== principal.orgId)) throw new NotFoundError('Project');
		const resource = project ? { type: 'project' as const, id: project.id } : { type: 'org' as const };
		if (!this.ctx.iam.can(principal, 'logs:read', resource) && !this.ctx.iam.can(principal, 'logs:configure', resource))
			throw new CoreError('forbidden', 'You need permission to read logs here.', 403);
		return {
			level: target.level,
			target: { orgId: principal.orgId, projectId: project?.id ?? null, projectSlug: project?.slug ?? null },
			platform,
			org: this.row('org', principal.orgId),
			project: project ? this.row('project', project.id) : null,
			effective: this.effective(principal.orgId, project?.id ?? null),
			canEdit: this.ctx.iam.can(principal, 'logs:configure', resource),
			searchIndex,
			archiveAvailable,
		};
	}

	/**
	 * Apply a patch to one level. `null` clears a key. Keys the level may not set are refused with
	 * a 422 rather than ignored, so a client learns the rule.
	 */
	update(
		principal: Principal,
		target: { level: LogSettingsLevel; project?: { id: string; orgId: string } | null },
		input: unknown,
	): LogSettingsRow {
		const parsed = logSettingsPatchSchema.safeParse(input ?? {});
		if (!parsed.success) throw new ValidationError('Invalid log settings.', parsed.error.issues);
		let id: string;
		if (target.level === 'platform') {
			if (!this.ctx.platformIam.canAdminister(principal))
				throw new CoreError('forbidden', 'Only a platform admin can change the platform log settings.', 403);
			id = LOG_SETTINGS_PLATFORM_ID;
		} else if (target.level === 'org') {
			this.ctx.iam.require(principal, 'logs:configure', { type: 'org' });
			id = principal.orgId;
		} else {
			const project = target.project;
			if (!project || project.orgId !== principal.orgId) throw new NotFoundError('Project');
			this.ctx.iam.require(principal, 'logs:configure', { type: 'project', id: project.id });
			id = project.id;
		}
		const issues: Array<{ path: string[]; message: string }> = [];
		for (const key of Object.keys(parsed.data) as LogSettingKey[]) {
			if (!LOG_SETTING_LEVELS[key].includes(target.level))
				issues.push({ path: [key], message: `${key} cannot be set per ${target.level}.` });
		}
		if (issues.length) throw new ValidationError('These settings cannot be set at this level.', issues);
		const current: Record<string, unknown> = { ...(this.row(target.level, id) ?? {}) };
		for (const [key, value] of Object.entries(parsed.data)) {
			if (value === undefined) continue;
			if (value === null) delete current[key];
			else current[key] = value;
		}
		const next = parseLogSettingsRow(current);
		const now = this.ctx.now();
		this.ctx.sqlite.run(
			`INSERT INTO log_settings (scope_type, scope_id, settings, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (scope_type, scope_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
			[target.level, id, JSON.stringify(next), now, principal.userId ?? null],
		);
		this.invalidate();
		this.ctx.audit.record({
			principal,
			action: 'logs.settings_update',
			resource: 'logs',
			resourceId: `${target.level}:${id}`,
			args: { level: target.level, changes: parsed.data },
			result: 'ok',
		});
		for (const listener of this.onChange) {
			try {
				listener({ level: target.level, id });
			} catch (error) {
				console.error('[logs] settings listener failed', error);
			}
		}
		return next;
	}

	/** The org a project belongs to (null when it is gone). */
	projectOrg(projectId: string): string | null {
		try {
			return this.ctx.sqlite.query<{ org_id: string }, [string]>('SELECT org_id FROM projects WHERE id = ?').get(projectId)?.org_id ?? null;
		} catch {
			return null;
		}
	}

	/** Forget cached rows (after a write, or a test that writes SQL directly). */
	invalidate(): void {
		this.#rows.clear();
		this.#effective.clear();
	}
}

/**
 * Inheritance and clamping, pure (docs/LOGS.md §10.1–§10.3). `hotDaysFallback` is what an unset
 * hot tail means without a search index (the platform policy `logRetentionDays`).
 */
export function resolveLogSettings(input: {
	platform: LogSettingsRow;
	org: LogSettingsRow | null;
	project: LogSettingsRow | null;
	searchIndex: boolean;
	hotDaysFallback: number;
}): EffectiveLogSettings {
	const sources = {} as Record<LogSettingKey, LogSettingSource>;
	const values: Record<string, unknown> = {};
	const levels: Array<[LogSettingsLevel, LogSettingsRow | null]> = [
		['platform', input.platform],
		['org', input.org],
		['project', input.project],
	];
	for (const key of logSettingKeys) {
		let value: unknown = key === 'hotDays' ? (input.searchIndex ? LOG_HOT_DAYS_WITH_INDEX : input.hotDaysFallback) : LOG_SETTINGS_DEFAULTS[key as Exclude<LogSettingKey, 'hotDays'>];
		let source: LogSettingSource = 'default';
		for (const [level, row] of levels) {
			if (!row || !LOG_SETTING_LEVELS[key].includes(level)) continue;
			const own = row[key];
			if (own === undefined) continue;
			// An org or project can only lower a quota (the platform's value is the ceiling) and a
			// project's search window stays inside its org's.
			const ceiling = level !== 'platform' && (LOG_SETTING_CEILINGS.includes(key) || (key === 'searchDays' && level === 'project'));
			if (ceiling && typeof own === 'number' && typeof value === 'number' && own > value) continue;
			value = own;
			source = level;
		}
		values[key] = value;
		sources[key] = source;
	}
	return { ...(values as Omit<EffectiveLogSettings, 'sources'>), sources };
}
