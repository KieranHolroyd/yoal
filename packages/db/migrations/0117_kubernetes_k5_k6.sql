-- Managed Kubernetes K5 (backups, restore, patching, the log shipper) and K6 (multi-node and HA)
-- (docs/KUBERNETES.md). Additive only.

-- Datastore snapshots. The location is recorded like a database backup (D158 targets), and the
-- join token is sealed on the row because a restored datastore only opens with its own token.
CREATE TABLE IF NOT EXISTS k8s_backups (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  cluster_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'scheduled' CHECK (kind IN ('scheduled','manual','pre-upgrade')),
  datastore TEXT NOT NULL DEFAULT 'sqlite',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','ok','failed')),
  error TEXT,
  object_key TEXT NOT NULL,
  target_id TEXT,
  target_name TEXT,
  location_json TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  minor TEXT NOT NULL,
  release TEXT NOT NULL,
  token_secret TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS k8s_backups_cluster_idx ON k8s_backups (cluster_id, created_at);
CREATE INDEX IF NOT EXISTS k8s_backups_status_idx ON k8s_backups (status);

-- Pod logs pushed by the opt-in shipper (K23). Kept for the cluster's retention, then pruned.
CREATE TABLE IF NOT EXISTS k8s_pod_logs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  pod TEXT NOT NULL,
  container TEXT NOT NULL,
  stream TEXT NOT NULL DEFAULT 'stdout',
  message TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS k8s_pod_logs_cluster_seq_idx ON k8s_pod_logs (cluster_id, seq);
CREATE INDEX IF NOT EXISTS k8s_pod_logs_ts_idx ON k8s_pod_logs (ts);

-- Cluster: datastore, server count, schedules, upgrade state, the shipper and alert state.
ALTER TABLE k8s_clusters ADD COLUMN servers INTEGER NOT NULL DEFAULT 1;
ALTER TABLE k8s_clusters ADD COLUMN datastore TEXT NOT NULL DEFAULT 'sqlite';
ALTER TABLE k8s_clusters ADD COLUMN backup_hours INTEGER NOT NULL DEFAULT 24;
ALTER TABLE k8s_clusters ADD COLUMN backup_retention_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE k8s_clusters ADD COLUMN next_backup_at INTEGER;
ALTER TABLE k8s_clusters ADD COLUMN last_backup_at INTEGER;
ALTER TABLE k8s_clusters ADD COLUMN last_backup_status TEXT;
-- Rolling release state: the release being rolled out and the one to put back on failure.
ALTER TABLE k8s_clusters ADD COLUMN previous_release TEXT;
ALTER TABLE k8s_clusters ADD COLUMN upgrade_started_at INTEGER;
ALTER TABLE k8s_clusters ADD COLUMN upgrade_message TEXT;
-- End-of-support warnings already sent ('60', '30').
ALTER TABLE k8s_clusters ADD COLUMN eos_warned TEXT;
ALTER TABLE k8s_clusters ADD COLUMN shipper INTEGER NOT NULL DEFAULT 0;
-- sha256 of the shipper's ingest token; the token itself reaches the cluster only in a manifest.
ALTER TABLE k8s_clusters ADD COLUMN shipper_token_hash TEXT;
ALTER TABLE k8s_clusters ADD COLUMN shipper_token_secret TEXT;
ALTER TABLE k8s_clusters ADD COLUMN log_retention_days INTEGER NOT NULL DEFAULT 7;
-- Restore source: a new cluster's server machine unpacks this backup before its first start.
ALTER TABLE k8s_clusters ADD COLUMN restore_backup_id TEXT;
ALTER TABLE k8s_clusters ADD COLUMN alert_state TEXT;

-- Machines: where each runs on its own (K6), its routed overlay address, and its own release so a
-- rollout reaches one machine at a time.
ALTER TABLE k8s_machines ADD COLUMN overlay_ip TEXT;
ALTER TABLE k8s_machines ADD COLUMN release TEXT;
ALTER TABLE k8s_machines ADD COLUMN api_port INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS k8s_machines_overlay_ip_idx ON k8s_machines (overlay_ip) WHERE overlay_ip IS NOT NULL AND removed_at IS NULL;
