import {
	parseLogLine,
	severityForNumber,
	SEVERITY_NUMBER,
	type LogRecord,
	type LogRecordSource,
	type LogScopeKind,
} from '@yoal/contracts';

/**
 * Adapters over the hot-tail tables (docs/LOGS.md §3–4, LP1; adapters first per §15). Each source
 * table is one SELECT that projects its rows onto the same unified columns, so lite-mode reads can
 * UNION ALL them and the ClickHouse indexer can cursor each one. Nothing here filters by tenant:
 * callers AND the `LogReadBoundary` in (`org_id`, `scope_kind`, `scope_id` are always present).
 *
 * Unified columns (every SELECT yields exactly these, in this order):
 *   tag, seq, ts, observed_ts, org_id, scope_kind, scope_id, stream, source, channel,
 *   severity_number, body, attributes, resource, trace_id, span_id, request_id,
 *   project_id, deployment_id, build_id, job_run_id, node_id
 */
export const UNIFIED_LOG_COLUMNS = [
	'tag',
	'seq',
	'ts',
	'observed_ts',
	'org_id',
	'scope_kind',
	'scope_id',
	'stream',
	'source',
	'channel',
	'severity_number',
	'body',
	'attributes',
	'resource',
	'trace_id',
	'span_id',
	'request_id',
	'project_id',
	'deployment_id',
	'build_id',
	'job_run_id',
	'node_id',
] as const;

export interface UnifiedLogRow {
	tag: SqliteLogTag;
	seq: number;
	ts: number;
	observed_ts: number | null;
	org_id: string;
	scope_kind: string;
	scope_id: string;
	stream: string | null;
	source: string;
	channel: string | null;
	severity_number: number;
	body: string;
	attributes: string | null;
	resource: string | null;
	trace_id: string | null;
	span_id: string | null;
	request_id: string | null;
	project_id: string | null;
	deployment_id: string | null;
	build_id: string | null;
	job_run_id: string | null;
	node_id: string | null;
}

export type SqliteLogTag = 'le' | 'sle' | 'ble' | 'kle' | 'kpl' | 'pll' | 'lr';

export interface SqliteLogSource {
	tag: SqliteLogTag;
	/** The physical table; its `seq` is the cursor. */
	table: string;
	/** Scope kinds this table can hold (lets a read skip tables outside the boundary). */
	scopeKinds: readonly LogScopeKind[];
	/** A SELECT yielding the unified columns. Alias of the base table is `t`. */
	select: string;
	/** Column expression for the base table's seq/ts (for cursoring and time pruning). */
	seqColumn: string;
	tsColumn: string;
}

const LEVEL_TO_SEVERITY = `CASE t.level WHEN 'debug' THEN ${SEVERITY_NUMBER.debug} WHEN 'warn' THEN ${SEVERITY_NUMBER.warn} WHEN 'error' THEN ${SEVERITY_NUMBER.error} ELSE ${SEVERITY_NUMBER.info} END`;
const CHANNEL_TO_SEVERITY = `CASE t.stream WHEN 'stderr' THEN ${SEVERITY_NUMBER.warn} ELSE ${SEVERITY_NUMBER.info} END`;

export const SQLITE_LOG_SOURCES: readonly SqliteLogSource[] = [
	{
		tag: 'le',
		table: 'log_events',
		scopeKinds: ['project'],
		seqColumn: 't.seq',
		tsColumn: 't.ts',
		select: `SELECT 'le' AS tag, t.seq AS seq, t.ts AS ts, NULL AS observed_ts, t.org_id AS org_id,
  'project' AS scope_kind, t.project_id AS scope_id,
  CASE WHEN t.job_run_id IS NOT NULL THEN 'job:' || t.job_run_id
       WHEN t.build_id IS NOT NULL AND t.source <> 'runtime' THEN 'build:' || t.build_id
       WHEN t.deployment_id IS NOT NULL THEN 'deployment:' || t.deployment_id
       ELSE NULL END AS stream,
  CASE WHEN t.job_run_id IS NOT NULL THEN 'job' ELSE t.source END AS source,
  t.stream AS channel, ${LEVEL_TO_SEVERITY} AS severity_number, t.message AS body,
  NULL AS attributes, NULL AS resource, NULL AS trace_id, NULL AS span_id, NULL AS request_id,
  t.project_id AS project_id, t.deployment_id AS deployment_id, t.build_id AS build_id,
  t.job_run_id AS job_run_id, t.node_id AS node_id
FROM log_events t`,
	},
	{
		tag: 'sle',
		table: 'service_log_events',
		scopeKinds: ['storage', 'database'],
		seqColumn: 't.seq',
		tsColumn: 't.ts',
		select: `SELECT 'sle' AS tag, t.seq AS seq, t.ts AS ts, NULL AS observed_ts, t.org_id AS org_id,
  t.kind AS scope_kind, t.service_id AS scope_id, NULL AS stream, t.source AS source,
  t.stream AS channel, ${LEVEL_TO_SEVERITY} AS severity_number, t.message AS body,
  NULL AS attributes, NULL AS resource, NULL AS trace_id, NULL AS span_id, NULL AS request_id,
  NULL AS project_id, NULL AS deployment_id, NULL AS build_id, NULL AS job_run_id, t.node_id AS node_id
FROM service_log_events t`,
	},
	{
		tag: 'ble',
		table: 'broker_log_events',
		scopeKinds: ['broker'],
		seqColumn: 't.seq',
		tsColumn: 't.ts',
		select: `SELECT 'ble' AS tag, t.seq AS seq, t.ts AS ts, NULL AS observed_ts, t.org_id AS org_id,
  'broker' AS scope_kind, t.broker_id AS scope_id, NULL AS stream, t.source AS source,
  t.stream AS channel, ${LEVEL_TO_SEVERITY} AS severity_number, t.message AS body,
  NULL AS attributes, NULL AS resource, NULL AS trace_id, NULL AS span_id, NULL AS request_id,
  NULL AS project_id, NULL AS deployment_id, NULL AS build_id, NULL AS job_run_id, t.node_id AS node_id
FROM broker_log_events t`,
	},
	{
		tag: 'kle',
		table: 'k8s_log_events',
		scopeKinds: ['k8s'],
		seqColumn: 't.seq',
		tsColumn: 't.ts',
		select: `SELECT 'kle' AS tag, t.seq AS seq, t.ts AS ts, NULL AS observed_ts, t.org_id AS org_id,
  'k8s' AS scope_kind, t.cluster_id AS scope_id,
  CASE WHEN t.machine_id IS NOT NULL THEN 'machine:' || t.machine_id ELSE NULL END AS stream,
  t.source AS source, t.stream AS channel, ${LEVEL_TO_SEVERITY} AS severity_number, t.message AS body,
  NULL AS attributes, NULL AS resource, NULL AS trace_id, NULL AS span_id, NULL AS request_id,
  NULL AS project_id, NULL AS deployment_id, NULL AS build_id, NULL AS job_run_id, t.node_id AS node_id
FROM k8s_log_events t`,
	},
	{
		tag: 'kpl',
		table: 'k8s_pod_logs',
		scopeKinds: ['k8s'],
		seqColumn: 't.seq',
		tsColumn: 't.ts',
		select: `SELECT 'kpl' AS tag, t.seq AS seq, t.ts AS ts, NULL AS observed_ts, t.org_id AS org_id,
  'k8s' AS scope_kind, t.cluster_id AS scope_id,
  'pod:' || t.namespace || '/' || t.pod || '/' || t.container AS stream,
  'runtime' AS source, t.stream AS channel, ${CHANNEL_TO_SEVERITY} AS severity_number, t.message AS body,
  NULL AS attributes,
  json_object('k8s.namespace.name', t.namespace, 'k8s.pod.name', t.pod, 'k8s.container.name', t.container) AS resource,
  NULL AS trace_id, NULL AS span_id, NULL AS request_id,
  NULL AS project_id, NULL AS deployment_id, NULL AS build_id, NULL AS job_run_id, NULL AS node_id
FROM k8s_pod_logs t`,
	},
	{
		tag: 'pll',
		table: 'pipeline_log_lines',
		scopeKinds: ['pipeline'],
		seqColumn: 't.seq',
		tsColumn: 't.ts',
		select: `SELECT 'pll' AS tag, t.seq AS seq, t.ts AS ts, NULL AS observed_ts, j.org_id AS org_id,
  'pipeline' AS scope_kind, j.repository_id AS scope_id, 'pipeline-job:' || t.job_id AS stream,
  'pipeline' AS source, t.stream AS channel,
  CASE t.stream WHEN 'stderr' THEN ${SEVERITY_NUMBER.warn} ELSE ${SEVERITY_NUMBER.info} END AS severity_number,
  t.text AS body,
  json_object('pipeline.run', t.run_id, 'pipeline.job', t.job_id, 'pipeline.step', CAST(t.step AS TEXT)) AS attributes,
  NULL AS resource, NULL AS trace_id, NULL AS span_id, NULL AS request_id,
  NULL AS project_id, NULL AS deployment_id, NULL AS build_id, NULL AS job_run_id, NULL AS node_id
FROM pipeline_log_lines t JOIN pipeline_jobs j ON j.id = t.job_id`,
	},
	{
		tag: 'lr',
		table: 'log_records',
		scopeKinds: ['project', 'database', 'storage', 'broker', 'k8s', 'pipeline', 'function', 'edge', 'platform'],
		seqColumn: 't.seq',
		tsColumn: 't.ts',
		select: `SELECT 'lr' AS tag, t.seq AS seq, t.ts AS ts, t.observed_ts AS observed_ts, t.org_id AS org_id,
  t.scope_kind AS scope_kind, t.scope_id AS scope_id, t.stream AS stream, t.source AS source,
  t.channel AS channel, t.severity_number AS severity_number, t.body AS body,
  t.attributes AS attributes, t.resource AS resource, t.trace_id AS trace_id, t.span_id AS span_id,
  t.request_id AS request_id, t.project_id AS project_id, t.deployment_id AS deployment_id,
  NULL AS build_id, NULL AS job_run_id, t.node_id AS node_id
FROM log_records t`,
	},
];

export function sqliteLogSource(tag: string): SqliteLogSource | undefined {
	return SQLITE_LOG_SOURCES.find((source) => source.tag === tag);
}

/** `le:123` → `{ tag: 'le', seq: 123 }`; null for ids that are not SQLite rows. */
export function parseSqliteLogId(id: string): { tag: SqliteLogTag; seq: number } | null {
	const match = /^(le|sle|ble|kle|kpl|pll|lr):(\d{1,18})$/.exec(id);
	if (!match) return null;
	return { tag: match[1] as SqliteLogTag, seq: Number(match[2]) };
}

const REPLICA_PREFIX = /^\[r(\d{1,2})\] /;

function parseJsonObject(text: string | null): Record<string, string> {
	if (!text) return {};
	try {
		const value = JSON.parse(text) as unknown;
		if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
		const out: Record<string, string> = {};
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			if (entry === null || entry === undefined) continue;
			out[key] = typeof entry === 'string' ? entry : JSON.stringify(entry);
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * One unified row → `LogRecord`. Rows stored before ingestion parsed lines still read with a level
 * and a clean message (the same "parse on the way out" rule as `LogService.present`). A parsed
 * level only upgrades the default `info`, never a level the node or an earlier parse chose.
 */
export function unifiedRowToLogRecord(row: UnifiedLogRow): LogRecord {
	let body = row.body;
	let replica: number | null = null;
	const replicaMatch = row.tag === 'le' ? REPLICA_PREFIX.exec(body) : null;
	if (replicaMatch) {
		replica = Number(replicaMatch[1]);
		body = body.slice(replicaMatch[0].length);
	}
	let severityNumber = Number(row.severity_number) || SEVERITY_NUMBER.info;
	if (row.source !== 'system' && row.tag !== 'lr') {
		const parsed = parseLogLine(body);
		if (parsed.format !== 'raw') {
			if (parsed.message) body = parsed.message;
			if (parsed.level && severityNumber === SEVERITY_NUMBER.info)
				severityNumber = SEVERITY_NUMBER[parsed.level];
		}
	}
	const resource = parseJsonObject(row.resource);
	if (replica === null && row.tag === 'le' && row.deployment_id) replica = 0;
	if (replica !== null) resource.replica = String(replica);
	if (row.deployment_id) resource['deployment.id'] = row.deployment_id;
	if (row.node_id) resource['host.id'] = row.node_id;
	const channel = row.channel === 'stdout' || row.channel === 'stderr' || row.channel === 'system' ? row.channel : null;
	return {
		id: `${row.tag}:${row.seq}`,
		ts: Number(row.ts),
		observedTs: row.observed_ts === null ? null : Number(row.observed_ts),
		orgId: row.org_id,
		scope: { kind: row.scope_kind as LogScopeKind, id: row.scope_id },
		scopeName: null,
		stream: row.stream,
		source: row.source as LogRecordSource,
		channel,
		severityNumber,
		severity: severityForNumber(severityNumber),
		body,
		attributes: parseJsonObject(row.attributes),
		resource,
		traceId: row.trace_id,
		spanId: row.span_id,
		requestId: row.request_id,
		patternId: null,
		projectId: row.project_id,
		deploymentId: row.deployment_id,
		buildId: row.build_id,
		jobRunId: row.job_run_id,
		nodeId: row.node_id,
		replica,
	};
}
