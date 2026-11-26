-- Logs Explorer cost and safety (docs/LOGS.md §10, LP9). Additive only.
--
-- `log_ingest_daily`: lines and bytes admitted to the hot tail per scope per UTC day. It seeds the
-- per-project daily byte budget after a restart (§10.2) and feeds log GB/day on the usage page
-- (QUOTAS.md showback). `day` is the epoch-ms start of the UTC day. Dropped lines stay in
-- `log_drop_counts` (0142).
CREATE TABLE IF NOT EXISTS log_ingest_daily (
  org_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  project_id TEXT,
  day INTEGER NOT NULL,
  lines INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_kind, scope_id, day)
);
CREATE INDEX IF NOT EXISTS log_ingest_daily_org_day_idx ON log_ingest_daily (org_id, day);

-- The daily Parquet archive per org (§10.1): one row per archived UTC day, with its hourly files
-- (`files` is a JSON array of {hour, key, rows, bytes}). Rehydrate reads it for the estimate and
-- the file list; prune removes rows (and objects) past the org's archive days.
CREATE TABLE IF NOT EXISTS log_archive_days (
  org_id TEXT NOT NULL,
  day TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  rows INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  exported_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, day)
);
