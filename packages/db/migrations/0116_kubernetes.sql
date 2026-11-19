-- Managed Kubernetes clusters (docs/KUBERNETES.md). Additive only.
-- A cluster is an org resource: k3s machines (one server, optional agents) run as helper-profiled
-- containers on one node in v1. The join token is sealed with the org data key (D18). `minor`,
-- `tier` and `purpose` carry no CHECK so a new minor or tier never needs a table rebuild (0028).

CREATE TABLE IF NOT EXISTS k8s_clusters (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  minor TEXT NOT NULL,
  release TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'userns',
  purpose TEXT NOT NULL DEFAULT 'lab',
  node_id TEXT NOT NULL,
  volume_id TEXT,
  memory_mb INTEGER NOT NULL,
  cpus REAL NOT NULL DEFAULT 1,
  agents INTEGER NOT NULL DEFAULT 0,
  api_port INTEGER NOT NULL,
  ingress_port INTEGER NOT NULL,
  api_access TEXT NOT NULL DEFAULT 'public',
  allow_cidrs TEXT NOT NULL DEFAULT '[]',
  window_hour INTEGER NOT NULL DEFAULT 3,
  window_hours INTEGER NOT NULL DEFAULT 2,
  auto_patch INTEGER NOT NULL DEFAULT 1,
  traefik INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','starting','running','degraded','failed','stopped')),
  message TEXT,
  token_secret TEXT NOT NULL,
  restart_generation INTEGER NOT NULL DEFAULT 0,
  -- Bumped whenever the helper-written manifests (RBAC, access keys, attachments) change.
  manifests_generation INTEGER NOT NULL DEFAULT 0,
  nodes_ready INTEGER,
  nodes_total INTEGER,
  deprecated_apis TEXT,
  stats_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  purge_at INTEGER,
  purge_requested_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS k8s_clusters_org_name_idx ON k8s_clusters (org_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS k8s_clusters_node_api_port_idx ON k8s_clusters (node_id, api_port);
CREATE UNIQUE INDEX IF NOT EXISTS k8s_clusters_node_ingress_port_idx ON k8s_clusters (node_id, ingress_port);
CREATE INDEX IF NOT EXISTS k8s_clusters_node_idx ON k8s_clusters (node_id);
CREATE INDEX IF NOT EXISTS k8s_clusters_deleted_idx ON k8s_clusters (deleted_at);

-- One row per k3s server or agent. The id doubles as the workload id on the node.
CREATE TABLE IF NOT EXISTS k8s_machines (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('server','agent')),
  ordinal INTEGER NOT NULL DEFAULT 0,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','starting','running','degraded','failed','stopped')),
  restarts INTEGER NOT NULL DEFAULT 0,
  -- Set when the machine is removed (scale down, cluster delete); the node purges its data dir.
  removed_at INTEGER,
  purge_requested_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS k8s_machines_ordinal_idx ON k8s_machines (cluster_id, role, ordinal) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS k8s_machines_cluster_idx ON k8s_machines (cluster_id);
CREATE INDEX IF NOT EXISTS k8s_machines_node_idx ON k8s_machines (node_id);

-- Public ingress hosts (K11): single-label names claimed under the content domain.
CREATE TABLE IF NOT EXISTS k8s_routes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  host TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS k8s_routes_host_idx ON k8s_routes (host);
CREATE INDEX IF NOT EXISTS k8s_routes_cluster_idx ON k8s_routes (cluster_id);

-- Databases and brokers written into the cluster as Secrets (K12).
CREATE TABLE IF NOT EXISTS k8s_attachments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('database','broker')),
  target_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  secret TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS k8s_attachments_secret_idx ON k8s_attachments (cluster_id, namespace, secret);
CREATE INDEX IF NOT EXISTS k8s_attachments_target_idx ON k8s_attachments (target_id);

-- Cluster access keys (K19): a long-lived token whose RBAC binding Yoal writes and prunes, so
-- revoking the key removes its access at once. Only the hash of the token's jti is kept.
CREATE TABLE IF NOT EXISTS k8s_access_keys (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('view','edit','admin')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS k8s_access_keys_name_idx ON k8s_access_keys (cluster_id, name) WHERE revoked_at IS NULL;

-- Machine runtime logs, the same shape as `broker_log_events`.
CREATE TABLE IF NOT EXISTS k8s_log_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  machine_id TEXT,
  node_id TEXT,
  source TEXT NOT NULL DEFAULT 'runtime' CHECK (source IN ('runtime','system')),
  stream TEXT NOT NULL DEFAULT 'stdout' CHECK (stream IN ('stdout','stderr','system')),
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('debug','info','warn','error')),
  message TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS k8s_log_events_cluster_seq_idx ON k8s_log_events (cluster_id, seq);
CREATE INDEX IF NOT EXISTS k8s_log_events_ts_idx ON k8s_log_events (ts);

-- Per-org grant of the `trusted` tier (K4): its cluster admins can become root on dedicated nodes.
CREATE TABLE IF NOT EXISTS k8s_trusted_orgs (
  org_id TEXT PRIMARY KEY,
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL
);
