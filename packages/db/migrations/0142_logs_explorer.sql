-- Logs Explorer foundation (docs/LOGS.md, LP1/LP2/LP9/LP10). Additive only.
--
-- `log_records`: the generic hot-tail table for sources added by the Explorer (Yoal's own service
-- units, edge access lines, OTLP records). Shaped like the LogRecord contract; attributes and
-- resource are JSON objects of string values. The sibling tables (log_events, service_log_events,
-- broker_log_events, k8s_log_events, k8s_pod_logs, pipeline_log_lines) stay as they are and are
-- read through adapters (decided 2026-11-25, LOGS.md §15). No CHECKs on kind or source (0028).
CREATE TABLE IF NOT EXISTS log_records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  stream TEXT,
  source TEXT NOT NULL,
  channel TEXT,
  severity_number INTEGER NOT NULL DEFAULT 9,
  body TEXT NOT NULL,
  attributes TEXT NOT NULL DEFAULT '{}',
  resource TEXT NOT NULL DEFAULT '{}',
  trace_id TEXT,
  span_id TEXT,
  request_id TEXT,
  project_id TEXT,
  deployment_id TEXT,
  node_id TEXT,
  ts INTEGER NOT NULL,
  observed_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS log_records_scope_seq_idx ON log_records (scope_kind, scope_id, seq);
CREATE INDEX IF NOT EXISTS log_records_org_seq_idx ON log_records (org_id, seq);
CREATE INDEX IF NOT EXISTS log_records_ts_idx ON log_records (ts);
CREATE INDEX IF NOT EXISTS log_records_request_idx ON log_records (request_id) WHERE request_id IS NOT NULL;

-- Explicit time indexes for the adapters' time-range reads where the sibling tables lack one per
-- scope (log_events already has ts and per-project seq indexes).
CREATE INDEX IF NOT EXISTS log_events_project_ts_idx ON log_events (project_id, ts);

-- The ClickHouse indexer (LP2): one cursor per source table, moved only after ClickHouse acks.
CREATE TABLE IF NOT EXISTS log_index_cursors (
  source_table TEXT PRIMARY KEY NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  -- Epoch ms of the newest row indexed, for the "index N minutes behind" banner.
  indexed_ts INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

-- Saved queries (§7.2). `scopes` is a JSON array of {kind,id}; `range` a JSON LogTimeRange;
-- `columns` a JSON array of field names. Personal rows are visible to their owner only.
CREATE TABLE IF NOT EXISTS log_saved_queries (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  range TEXT NOT NULL DEFAULT '{"relative":"1h"}',
  columns TEXT NOT NULL DEFAULT '[]',
  visibility TEXT NOT NULL DEFAULT 'personal',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS log_saved_queries_org_idx ON log_saved_queries (org_id, visibility);
CREATE INDEX IF NOT EXISTS log_saved_queries_owner_idx ON log_saved_queries (owner_id);

-- Ingest and index rules (§10.3, §10.4): `kind` is exclude | sample | index_only | redact.
-- `query` is log-query text for exclude/sample/index_only; `pattern` a regex for redact.
CREATE TABLE IF NOT EXISTS log_rules (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  project_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  query TEXT NOT NULL DEFAULT '',
  pattern TEXT,
  replacement TEXT,
  sample_rate REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS log_rules_org_idx ON log_rules (org_id, enabled);

-- Retention, quotas and sampling (§10.1, §10.2, LP6, LP9) per platform, org or project.
-- `settings` is a JSON object validated by @yoal/contracts; missing keys inherit.
CREATE TABLE IF NOT EXISTS log_settings (
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (scope_type, scope_id)
);

-- Lines dropped at ingest (quota, exclusion, node-side sampling), per scope per minute (§10.2).
CREATE TABLE IF NOT EXISTS log_drop_counts (
  org_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  minute INTEGER NOT NULL,
  reason TEXT NOT NULL,
  lines INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_kind, scope_id, minute, reason)
);
CREATE INDEX IF NOT EXISTS log_drop_counts_org_minute_idx ON log_drop_counts (org_id, minute);
