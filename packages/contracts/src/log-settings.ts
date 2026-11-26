import { z } from 'zod';
import { logScopeRefSchema } from './log-record.ts';

/**
 * Logs cost and safety settings (docs/LOGS.md §10, LP9, LP6; decisions in §15). Stored as one JSON
 * object per row in `log_settings` (migration 0142) at three levels:
 *
 *   platform (`platform:platform`) → org (`org:<orgId>`) → project (`project:<projectId>`)
 *
 * A missing key inherits from the level above, and the platform row inherits from
 * `LOG_SETTINGS_DEFAULTS`. Not every key exists at every level (`LOG_SETTING_LEVELS`): the hot tail
 * and the archive are per org, search days, ingest quotas and the edge sample rate go down to a
 * project. An org or project may only *lower* an ingest quota: the platform value is the ceiling, so
 * a tenant cannot raise its own budget (QUOTAS.md: only a platform admin changes quotas).
 */

export const LOG_SETTINGS_PLATFORM_ID = 'platform';

export const logSettingsLevels = ['platform', 'org', 'project'] as const;
export type LogSettingsLevel = (typeof logSettingsLevels)[number];

/** Every key, each optional: a stored row or a patch. `null` in a patch clears the key (inherit). */
export const logSettingsFields = {
	/** SQLite hot tail, per org (§10.1). Unset = 3 days with the search index, 7 without. */
	hotDays: z.number().int().min(1).max(14),
	/** ClickHouse `yoal.logs`, per org and per project within the org's value (§10.1). */
	searchDays: z.number().int().min(1).max(90),
	/** Daily Parquet archive in the object store (§10.1). Off by default (decided §15.4). */
	archiveEnabled: z.boolean(),
	/** How long archived days are kept. */
	archiveDays: z.number().int().min(30).max(400),
	/** Ingest rate per project (or service scope), lines per second, steady state (§10.2). */
	ingestLinesPerSecond: z.number().int().min(1).max(1_000_000),
	/** Lines a scope may send at once above the steady rate (token bucket size). */
	ingestBurst: z.number().int().min(1).max(10_000_000),
	/** Daily byte budget per project (or service scope), in MB (10^6 bytes), UTC day. */
	ingestMbPerDay: z.number().int().min(1).max(10_000_000),
	/** Share of 2xx/3xx edge requests shipped as `access` records (LP6). Non-2xx is always shipped. */
	edgeSampleRate: z.number().min(0).max(1),
} as const;

export type LogSettingKey = keyof typeof logSettingsFields;
export const logSettingKeys = Object.keys(logSettingsFields) as LogSettingKey[];

/** A stored row: any subset of keys. Unknown or out-of-range keys are dropped, never fatal. */
export type LogSettingsRow = { [K in LogSettingKey]?: z.infer<(typeof logSettingsFields)[K]> };

/** A patch: a value sets the key, `null` clears it so it inherits again. */
export const logSettingsPatchSchema = z
	.object(
		Object.fromEntries(Object.entries(logSettingsFields).map(([key, field]) => [key, (field as z.ZodType).nullable().optional()])) as {
			[K in LogSettingKey]: z.ZodOptional<z.ZodNullable<(typeof logSettingsFields)[K]>>;
		},
	)
	.strict();
export type LogSettingsPatch = z.infer<typeof logSettingsPatchSchema>;

/** Parse a stored row leniently: each key on its own, so one bad value never hides the others. */
export function parseLogSettingsRow(raw: unknown): LogSettingsRow {
	const out: Record<string, unknown> = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out as LogSettingsRow;
	for (const key of logSettingKeys) {
		const value = (raw as Record<string, unknown>)[key];
		if (value === undefined || value === null) continue;
		const parsed = (logSettingsFields[key] as z.ZodType).safeParse(value);
		if (parsed.success) out[key] = parsed.data;
	}
	return out as LogSettingsRow;
}

/** Which levels may set each key (§10.1–§10.3). */
export const LOG_SETTING_LEVELS: Record<LogSettingKey, readonly LogSettingsLevel[]> = {
	hotDays: ['platform', 'org'],
	searchDays: ['platform', 'org', 'project'],
	archiveEnabled: ['platform', 'org'],
	archiveDays: ['platform', 'org'],
	ingestLinesPerSecond: ['platform', 'org', 'project'],
	ingestBurst: ['platform', 'org', 'project'],
	ingestMbPerDay: ['platform', 'org', 'project'],
	edgeSampleRate: ['platform', 'org', 'project'],
};

/** Keys an org or project may only lower below the platform value. */
export const LOG_SETTING_CEILINGS: readonly LogSettingKey[] = ['ingestLinesPerSecond', 'ingestBurst', 'ingestMbPerDay'];

/** Hot-tail days when nothing is set: with a search index the tail is short (decided §15). */
export const LOG_HOT_DAYS_WITH_INDEX = 3;
/** …and without one, the tail is all there is. The platform policy `logRetentionDays` (7) applies. */
export const LOG_HOT_DAYS_WITHOUT_INDEX = 7;
/** The agent's own default for `accessLogSampleRate` (LP6, decided 2026-11-25). */
export const DEFAULT_LOG_EDGE_SAMPLE_RATE = 0.1;

/** Built-in values (hot days is resolved from the install: see `LOG_HOT_DAYS_*`). */
export const LOG_SETTINGS_DEFAULTS: Required<Omit<LogSettingsRow, 'hotDays'>> = {
	searchDays: 14,
	archiveEnabled: false,
	archiveDays: 90,
	ingestLinesPerSecond: 1_000,
	ingestBurst: 20_000,
	ingestMbPerDay: 5_120,
	edgeSampleRate: DEFAULT_LOG_EDGE_SAMPLE_RATE,
};

/** Where an effective value came from. */
export type LogSettingSource = 'default' | LogSettingsLevel;

/** Settings after inheritance and clamping, for one org or project. */
export interface EffectiveLogSettings {
	hotDays: number;
	searchDays: number;
	archiveEnabled: boolean;
	archiveDays: number;
	ingestLinesPerSecond: number;
	ingestBurst: number;
	ingestMbPerDay: number;
	edgeSampleRate: number;
	sources: Record<LogSettingKey, LogSettingSource>;
}

/** `GET /api/v1/logs/settings`: each level as stored, and the effective result. */
export interface LogSettingsView {
	level: LogSettingsLevel;
	/** The org or project this view is for (null for the platform). */
	target: { orgId: string | null; projectId: string | null; projectSlug: string | null };
	platform: LogSettingsRow;
	org: LogSettingsRow | null;
	project: LogSettingsRow | null;
	effective: EffectiveLogSettings;
	/** True when the caller may change this level. */
	canEdit: boolean;
	/** Whether a search index (ClickHouse `yoal.logs`) is on, which sets the hot-tail default. */
	searchIndex: boolean;
	/** Whether archived ranges can be rehydrated here (ClickHouse plus an object store). */
	archiveAvailable: boolean;
}

// ------------------------------------------------------------------------------------- rules

/** §10.3–§10.4: drop at ingest, keep a share at ingest, keep out of the index, or mask text. */
export const logRuleKinds = ['exclude', 'sample', 'index_only', 'redact'] as const;
export type LogRuleKind = (typeof logRuleKinds)[number];

const ruleBase = {
	name: z.string().trim().min(1).max(80),
	/** Log query (no pipe stages) for exclude/sample/index_only; ignored for redact. */
	query: z.string().max(4_000).default(''),
	/** A JavaScript regular expression for redact; a leading `(?i)` makes it case-insensitive. */
	pattern: z.string().max(512).nullable().optional(),
	/** Share of matching lines KEPT by a sample rule (0–1). */
	sampleRate: z.number().min(0).max(1).nullable().optional(),
	enabled: z.boolean().default(true),
};

export const logRuleInputSchema = z.object({
	...ruleBase,
	kind: z.enum(logRuleKinds),
	/** Project slug or id; omitted = the whole org. */
	project: z.string().max(200).nullable().optional(),
});
export type LogRuleInput = z.input<typeof logRuleInputSchema>;

export const logRuleUpdateSchema = z
	.object({
		name: ruleBase.name.optional(),
		query: z.string().max(4_000).optional(),
		pattern: ruleBase.pattern,
		sampleRate: ruleBase.sampleRate,
		enabled: z.boolean().optional(),
	})
	.strict();
export type LogRuleUpdate = z.infer<typeof logRuleUpdateSchema>;

export interface LogRuleView {
	id: string;
	name: string;
	kind: LogRuleKind;
	query: string;
	pattern: string | null;
	sampleRate: number | null;
	enabled: boolean;
	projectId: string | null;
	projectSlug: string | null;
	createdBy: string;
	createdAt: string;
	updatedAt: string;
}

/** `POST /api/v1/logs/rules/preview`: replay the last 15 minutes through a draft rule (§10.3). */
export const logRulePreviewInputSchema = z.object({
	kind: z.enum(logRuleKinds),
	query: z.string().max(4_000).default(''),
	pattern: z.string().max(512).nullable().optional(),
	sampleRate: z.number().min(0).max(1).nullable().optional(),
	project: z.string().max(200).nullable().optional(),
	/** Minutes to replay; default 15. */
	minutes: z.number().int().min(1).max(60).default(15),
});
export type LogRulePreviewInput = z.input<typeof logRulePreviewInputSchema>;

export interface LogRulePreviewResult {
	/** Lines replayed (capped). */
	scanned: number;
	/** Lines the rule's query (or pattern) matches. */
	matched: number;
	/** Expected share of scanned lines dropped at ingest (exclude, sample), 0–100. */
	droppedPercent: number;
	/** Share kept out of the search index (index_only), 0–100. */
	indexSkippedPercent: number;
	/** Most common templates among matched lines. */
	topPatterns: Array<{ template: string; count: number }>;
	/** Redact: up to five matched lines after masking (never before). */
	examples: string[];
	/** True when the replay hit its line cap. */
	capped: boolean;
	minutes: number;
}

// ------------------------------------------------------------------------------------- archive

/** `POST /api/v1/logs/archive/estimate`. */
export const logArchiveEstimateInputSchema = z.object({
	scopes: z.array(logScopeRefSchema).max(200).default([]),
	from: z.number().int().nonnegative(),
	to: z.number().int().nonnegative(),
});
export type LogArchiveEstimateInput = z.input<typeof logArchiveEstimateInputSchema>;

export interface LogArchiveEstimate {
	/** Archived Parquet bytes a rehydrate would scan. */
	bytes: number;
	files: number;
	/** Rough wall time. */
	seconds: number;
	/** UTC days (YYYY-MM-DD) of the range that live only in the archive. */
	days: string[];
	/** The part of the range older than the search window. Null when none is. */
	range: { from: number; to: number } | null;
	/** Whether a rehydrate can run here, and why not. */
	available: boolean;
	reason: string | null;
	/** The per-query scan budget; an estimate above it is refused. */
	budgetBytes: number;
}

// ------------------------------------------------------------------------------------- usage

/** One project's (or service scope's) log ingest, for showback (QUOTAS.md, §10.2). */
export interface LogUsageRow {
	scope: { kind: string; id: string };
	name: string | null;
	projectId: string | null;
	/** Per UTC day, oldest first. */
	days: Array<{ day: string; lines: number; bytes: number; droppedLines: number }>;
	bytes: number;
	lines: number;
	droppedLines: number;
	/** Average bytes per day across the window. */
	bytesPerDay: number;
}

export interface LogUsageReport {
	days: number;
	rows: LogUsageRow[];
	totalBytes: number;
	totalLines: number;
	totalDroppedLines: number;
}
