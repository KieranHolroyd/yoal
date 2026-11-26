import * as z from 'zod';
import type { LogLevel } from './log.ts';

/**
 * The Logs Explorer record model (docs/LOGS.md §3, LP1). Every source on the platform (app
 * runtime, builds, jobs, pipelines, managed services, Kubernetes, functions, the edge and Yoal's own
 * services) is read as one `LogRecord`, shaped after the OpenTelemetry logs data model with Yoal's
 * scope added. Stores map their rows onto it; nothing outside a store sees a table row.
 */

/** A scope is the CloudWatch "log group": the resource a record belongs to. */
export const logScopeKinds = [
	'project',
	'database',
	'storage',
	'broker',
	'k8s',
	'pipeline',
	'function',
	'edge',
	'platform',
] as const;
export type LogScopeKind = (typeof logScopeKinds)[number];

/** Scopes only platform admins can read (LP5). */
export const platformLogScopeKinds: readonly LogScopeKind[] = ['platform'];

export const logRecordSources = [
	'runtime',
	'build',
	'job',
	'pipeline',
	'system',
	'access',
	'otlp',
	'audit',
	'platform',
	'email',
] as const;
export type LogRecordSource = (typeof logRecordSources)[number];

/** OTel severity bands; the number is the lowest value of each band. */
export const logSeverities = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogSeverity = (typeof logSeverities)[number];

export const SEVERITY_NUMBER: Readonly<Record<LogSeverity, number>> = {
	trace: 1,
	debug: 5,
	info: 9,
	warn: 13,
	error: 17,
	fatal: 21,
};

/** Map an OTel SeverityNumber (1–24; 0 = unspecified, read as info) to its band. */
export function severityForNumber(n: number): LogSeverity {
	if (!Number.isFinite(n) || n <= 0) return 'info';
	if (n >= 21) return 'fatal';
	if (n >= 17) return 'error';
	if (n >= 13) return 'warn';
	if (n >= 9) return 'info';
	if (n >= 5) return 'debug';
	return 'trace';
}

/** The four-value level the SQLite tables store maps onto the OTel band numbers. */
export function severityNumberForLevel(level: LogLevel | LogSeverity): number {
	return SEVERITY_NUMBER[level] ?? SEVERITY_NUMBER.info;
}

/** Back to the stored four-value vocabulary (trace → debug, fatal → error). */
export function levelForSeverityNumber(n: number): LogLevel {
	const severity = severityForNumber(n);
	if (severity === 'trace') return 'debug';
	if (severity === 'fatal') return 'error';
	return severity;
}

/** Parse a free-form level word (`WARNING`, `err`, `crit`, `notice`…) into a band. */
export function severityForText(text: string | null | undefined): LogSeverity | null {
	const value = text?.trim().toLowerCase();
	if (!value) return null;
	if (/^(trace|trc|verbose|vrb|finest|finer)$/.test(value)) return 'trace';
	if (/^(debug|dbg|fine|d)$/.test(value)) return 'debug';
	if (/^(info|inf|information|informational|notice|i|log)$/.test(value)) return 'info';
	if (/^(warn|warning|wrn|w)$/.test(value)) return 'warn';
	if (/^(error|err|e|severe|failure|fail)$/.test(value)) return 'error';
	if (/^(fatal|ftl|crit|critical|alert|emerg|emergency|panic|f)$/.test(value)) return 'fatal';
	return null;
}

export const logScopeRefSchema = z.object({
	kind: z.enum(logScopeKinds),
	id: z.string().min(1).max(128),
});
export type LogScopeRef = z.infer<typeof logScopeRefSchema>;

/** `project:prj_…` — the URL and query-string form of a scope. */
export function formatLogScope(scope: LogScopeRef): string {
	return `${scope.kind}:${scope.id}`;
}

export function parseLogScope(value: string): LogScopeRef | null {
	const index = value.indexOf(':');
	if (index <= 0) return null;
	const result = logScopeRefSchema.safeParse({
		kind: value.slice(0, index),
		id: value.slice(index + 1),
	});
	return result.success ? result.data : null;
}

/** One record as every surface (REST, SSE, CLI, MCP, UI) sees it. */
export interface LogRecord {
	/**
	 * Stable and unique across stores: `<table-tag>:<seq>` for SQLite rows (`le:`, `sle:`, `ble:`,
	 * `kle:`, `kpl:`, `pll:`, `lr:`) so a ClickHouse row and its SQLite origin share an id.
	 */
	id: string;
	/** Event time, epoch milliseconds. */
	ts: number;
	/** Receive time, epoch milliseconds, when known. */
	observedTs: number | null;
	orgId: string;
	scope: LogScopeRef;
	/** Display name of the scope (project slug, database name…), when the store knows it. */
	scopeName: string | null;
	/**
	 * The CloudWatch "log stream" inside the scope: `deployment:<id>`, `build:<id>`, `job:<runId>`,
	 * `pipeline-job:<jobId>`, `pod:<ns>/<pod>/<container>`, `unit:<name>`, `site:<host>`…
	 */
	stream: string | null;
	source: LogRecordSource;
	/** stdout, stderr or system, where the source has the notion. */
	channel: 'stdout' | 'stderr' | 'system' | null;
	severityNumber: number;
	severity: LogSeverity;
	/** Message text (capped at 16 KiB); ANSI escapes kept only when `ansi` is true. */
	body: string;
	/** True when `body` still carries ANSI colour escapes for the UI to render. */
	ansi?: boolean;
	/** Per-record fields: parsed JSON/logfmt keys, `http.*`, OTLP attributes. String values only. */
	attributes: Record<string, string>;
	/** Producer fields: `service.name`, `deployment.id`, `host.name`, `container.id`, `k8s.*`, `replica`. */
	resource: Record<string, string>;
	traceId: string | null;
	spanId: string | null;
	requestId: string | null;
	/** Drain template id (§8.1), hex; null until indexed. */
	patternId: string | null;
	/** Links the UI pivots on. Null when not applicable. */
	projectId: string | null;
	deploymentId: string | null;
	buildId: string | null;
	jobRunId: string | null;
	nodeId: string | null;
	replica: number | null;
}

/** Which engine answered a read. `sqlite` is lite mode (§0). */
export const logEngines = ['sqlite', 'clickhouse'] as const;
export type LogEngine = (typeof logEngines)[number];

/** A relative range (`15m`, `1h`, `24h`, `7d`) or absolute epoch-ms bounds. */
export const logTimeRangeSchema = z.union([
	z.object({ relative: z.string().regex(/^\d{1,4}(s|m|h|d|w)$/) }),
	z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }),
]);
export type LogTimeRange = z.infer<typeof logTimeRangeSchema>;

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Resolve a range to absolute bounds at `now`. */
export function resolveLogTimeRange(range: LogTimeRange, now: number): { from: number; to: number } {
	if ('relative' in range) {
		const match = /^(\d{1,4})(s|m|h|d|w)$/.exec(range.relative);
		const span = match ? Number(match[1]) * (UNIT_MS[match[2]!] ?? 3_600_000) : 3_600_000;
		return { from: now - span, to: now };
	}
	return { from: Math.min(range.from, range.to), to: Math.max(range.from, range.to) };
}

const scopesSchema = z.array(logScopeRefSchema).max(200).default([]);

/** Common read input: query text, scopes (empty = everything the caller may read) and time. */
export const logReadInputSchema = z.object({
	/** Log query text (docs/LOGS.md §6). Empty matches everything. */
	q: z.string().max(4_000).default(''),
	scopes: scopesSchema,
	/** Absolute bounds, epoch ms. Omitted `to` means now; omitted `from` means `to - 1h`. */
	from: z.number().int().nonnegative().optional(),
	to: z.number().int().nonnegative().optional(),
});
export type LogReadInput = z.infer<typeof logReadInputSchema>;

export const logSearchInputSchema = logReadInputSchema.extend({
	limit: z.number().int().min(1).max(1_000).default(200),
	/** Opaque cursor from a previous page's `older`/`newer`. */
	cursor: z.string().max(2_048).optional(),
	/** `desc` = newest first (the default view); `asc` reads forward from the cursor. */
	order: z.enum(['desc', 'asc']).default('desc'),
	/**
	 * Include the Parquet archive for the part of the range older than the search window
	 * (docs/LOGS.md §10.1). Without it such a read answers an `archive` warning with an estimate.
	 */
	archive: z.boolean().optional(),
});
export type LogSearchInput = z.infer<typeof logSearchInputSchema>;

export interface LogSearchResult {
	records: LogRecord[];
	/** Pass `older` with `order: 'desc'` to page back; `newer` with `order: 'asc'` to page forward. */
	cursor: { older: string | null; newer: string | null };
	engine: LogEngine;
	/** Non-fatal notes for the UI (`index_behind`, `sampled`, `capped`…). */
	warnings: LogWarning[];
	elapsedMs: number;
	/**
	 * On a first page (no `cursor` in the request): the SQLite hot-tail position taken just before
	 * the read, as a live-tail cursor. A tail opened with it resumes from page-load time even when
	 * the page has no `newer` cursor (an empty window, or the search index lagging), so lines
	 * written between the read and the tail connecting are not lost.
	 */
	tailCursor?: string;
}

export interface LogWarning {
	code: 'index_behind' | 'needs_clickhouse' | 'capped' | 'sampled' | 'partial' | 'archive';
	message: string;
}

/** A tabular answer to a query with pipe stages (`| stats`, `| patterns`, `| dedup`, `| fields`). */
export interface LogTableResult {
	columns: Array<{ name: string; type: 'string' | 'number' | 'time' }>;
	rows: Array<Array<string | number | null>>;
	/** Set for `| patterns`: one sample record id per row, aligned with `rows`. */
	sampleIds?: Array<string | null>;
	/**
	 * Set for `| patterns`: each pattern's line count per bucket, aligned with `rows`. Every array
	 * has the same length N, and its buckets split the read's `from..to` into N equal slots (§8.1).
	 */
	sparklines?: number[][];
	engine: LogEngine;
	warnings: LogWarning[];
	elapsedMs: number;
}

export const logHistogramInputSchema = logReadInputSchema.extend({
	/** Target bucket count; the server picks a round interval near it. */
	buckets: z.number().int().min(10).max(500).default(60),
});
export type LogHistogramInput = z.infer<typeof logHistogramInputSchema>;

export interface LogHistogramResult {
	from: number;
	to: number;
	intervalMs: number;
	/** One entry per bucket start (epoch ms), counts by severity band. Empty buckets included. */
	buckets: Array<{ ts: number; counts: Partial<Record<LogSeverity, number>>; total: number }>;
	total: number;
	/** Deploys, alerts and node events inside the range, for markers. */
	markers: LogHistogramMarker[];
	engine: LogEngine;
	warnings: LogWarning[];
}

export interface LogHistogramMarker {
	ts: number;
	kind: 'deploy' | 'alert' | 'node';
	label: string;
	/** Dashboard path the marker links to. */
	href: string | null;
	scope: LogScopeRef | null;
}

export const logFieldsInputSchema = logReadInputSchema.extend({
	/** Only these fields (by query name); omitted = the built-ins plus the top attribute keys. */
	fields: z.array(z.string().max(200)).max(50).optional(),
	topValues: z.number().int().min(1).max(50).default(10),
});
export type LogFieldsInput = z.infer<typeof logFieldsInputSchema>;

export interface LogFieldSummary {
	/** Name as written in a query: `level`, `deployment`, `@http.status`, `resource.host.name`. */
	name: string;
	kind: 'builtin' | 'attribute' | 'resource';
	type: 'string' | 'number';
	/** Rows in the window that carry the field. */
	present: number;
	topValues: Array<{ value: string; count: number }>;
	/** Bucketed counts for a sparkline, same buckets for every field. */
	sparkline?: number[];
}

export interface LogFieldsResult {
	fields: LogFieldSummary[];
	total: number;
	engine: LogEngine;
	warnings: LogWarning[];
}

export const logContextInputSchema = z.object({
	id: z.string().min(3).max(200),
	before: z.number().int().min(0).max(500).default(50),
	after: z.number().int().min(0).max(500).default(50),
});
export type LogContextInput = z.infer<typeof logContextInputSchema>;

export interface LogContextResult {
	anchor: LogRecord | null;
	before: LogRecord[];
	after: LogRecord[];
	engine: LogEngine;
}

/** What this install can answer right now; the UI greys modes that need ClickHouse. */
export interface LogCapabilities {
	engine: LogEngine;
	clickhouse: { installed: boolean; healthy: boolean; indexLagMs: number | null };
	features: {
		attributes: boolean;
		regex: boolean;
		stats: boolean;
		patterns: boolean;
		compare: boolean;
		why: boolean;
		archive: boolean;
	};
	/** Scopes the caller may read, for the scope picker (capped; the picker searches beyond). */
	scopes: Array<LogScopeRef & { name: string; parent: string | null }>;
	platformAdmin: boolean;
}

/** Live tail (SSE) event payloads. Event names are the keys. */
export interface LogTailEvents {
	ready: { cursor: string; engine: LogEngine };
	records: { records: LogRecord[]; cursor: string };
	/** The subscriber fell behind; `dropped` lines were skipped to stay live. */
	sampled: { dropped: number };
	end: { reason: string };
}

/** Saved queries (§7.2). */
export const logSavedQueryInputSchema = z.object({
	name: z.string().min(1).max(120),
	q: z.string().max(4_000),
	scopes: scopesSchema,
	range: logTimeRangeSchema.default({ relative: '1h' }),
	columns: z.array(z.string().max(200)).max(30).default([]),
	visibility: z.enum(['personal', 'org']).default('personal'),
});
export type LogSavedQueryInput = z.infer<typeof logSavedQueryInputSchema>;

export interface LogSavedQuery extends LogSavedQueryInput {
	id: string;
	ownerId: string;
	createdAt: number;
	updatedAt: number;
}

/**
 * A structured record shipped by a node for the new sources (platform units, edge access lines,
 * OTLP). Tenancy (org/scope) is never taken from the node payload for app scopes: the control plane
 * resolves it from the workload or site id, and only platform/edge scopes are node-stamped.
 */
export const nodeLogRecordSchema = z.object({
	ts: z.number().int().nonnegative(),
	source: z.enum(logRecordSources),
	severityNumber: z.number().int().min(0).max(24).default(9),
	body: z.string().max(16_384),
	attributes: z.record(z.string().max(256), z.string().max(4_096)).default({}),
	resource: z.record(z.string().max(256), z.string().max(1_024)).default({}),
	traceId: z.string().max(64).optional(),
	spanId: z.string().max(32).optional(),
	requestId: z.string().max(128).optional(),
	channel: z.enum(['stdout', 'stderr', 'system']).optional(),
});
export type NodeLogRecord = z.infer<typeof nodeLogRecordSchema>;

export const nodeLogBatchSchema = z.object({
	/**
	 * Who the batch belongs to. `workload`/`site` ids resolve to a project server-side; `platform`
	 * carries the systemd unit name and is only accepted from the node that ran it.
	 */
	target: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('workload'), workloadId: z.string().min(3).max(128) }),
		z.object({ kind: z.literal('site'), host: z.string().min(1).max(253) }),
		z.object({ kind: z.literal('platform'), unit: z.string().min(1).max(128) }),
	]),
	records: z.array(nodeLogRecordSchema).max(1_000),
	/** Lines the node dropped (sampling, overflow) since the last batch, for the drop counter. */
	dropped: z.number().int().nonnegative().default(0),
});
export type NodeLogBatch = z.infer<typeof nodeLogBatchSchema>;

/** Compare (docs/LOGS.md §8.2): patterns new/rising/falling/gone between two windows. ClickHouse only. */
export const logCompareInputSchema = logReadInputSchema.extend({
	baseline: z.discriminatedUnion('kind', [
		/** The window of the same length immediately before the current one. */
		z.object({ kind: z.literal('previous') }),
		/** The current window shifted back, e.g. 1 day or 7 days. */
		z.object({ kind: z.literal('offset'), offsetMs: z.number().int().positive() }),
		/** Deploy-aware: the window before vs after this deployment went live (same length each side). */
		z.object({ kind: z.literal('deploy'), deploymentId: z.string().min(1).max(64) }),
		z.object({ kind: z.literal('range'), from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }),
	]),
	limit: z.number().int().min(1).max(500).default(100),
});
export type LogCompareInput = z.infer<typeof logCompareInputSchema>;

export interface LogCompareRow {
	patternId: string;
	template: string;
	current: number;
	baseline: number;
	/** Counts are normalised per minute before classifying when the windows differ in length. */
	change: 'new' | 'gone' | 'rising' | 'falling' | 'steady';
	/** current/baseline rate; null when the baseline is zero. */
	ratio: number | null;
	sampleId: string | null;
}

export interface LogCompareResult {
	current: { from: number; to: number; total: number };
	baseline: { from: number; to: number; total: number };
	rows: LogCompareRow[];
	engine: LogEngine;
	warnings: LogWarning[];
}

/** Why? (docs/LOGS.md §8.3): which field values are over-represented in a selection. ClickHouse only. */
export const logWhyInputSchema = logReadInputSchema.extend({
	/** The brushed region; the baseline is the rest of `from..to`. */
	selection: z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }),
	/** Field names to consider; omitted = built-ins plus the top attribute keys. */
	fields: z.array(z.string().max(200)).max(40).optional(),
	limit: z.number().int().min(1).max(100).default(25),
});
export type LogWhyInput = z.infer<typeof logWhyInputSchema>;

export interface LogWhyRow {
	/** Query name, e.g. `node`, `@http.route`. */
	field: string;
	value: string;
	selectionCount: number;
	baselineCount: number;
	selectionShare: number;
	baselineShare: number;
	/** selectionShare − baselineShare; rows are ranked by it. */
	lift: number;
}

export interface LogWhyResult {
	selection: { from: number; to: number; total: number };
	baseline: { from: number; to: number; total: number };
	rows: LogWhyRow[];
	engine: LogEngine;
	warnings: LogWarning[];
}
