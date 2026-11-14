-- Scaling, rolling deploys, usage and link history (docs/SCALING.md). Additive only.

-- A copy that has not been rolled to the workload's deployment yet still runs this one. NULL means
-- "the workload's own deployment", which is every copy outside a rollout.
ALTER TABLE workload_replicas ADD COLUMN deployment_id TEXT;
-- The desired-state version a copy must be seen converged to before its `running` report counts.
-- Set when a rollout restarts the copy; cleared when the node confirms it.
ALTER TABLE workload_replicas ADD COLUMN applied_version INTEGER;
ALTER TABLE workload_replicas ADD COLUMN rolled_at INTEGER;

-- `rolling` while copies move to a new deployment one at a time, `paused` when a copy failed and
-- the rest were left on the previous release. NULL at every other time.
ALTER TABLE workloads ADD COLUMN rollout_status TEXT;
ALTER TABLE workloads ADD COLUMN rollout_message TEXT;
ALTER TABLE workloads ADD COLUMN rollout_started_at INTEGER;

-- The latest usage sample per copy, with a smoothed value the autoscaler reads. One row per copy
-- id (`<workload>` or `<workload>-r<n>`); no history here, on purpose: this is a control input.
CREATE TABLE IF NOT EXISTS workload_usage (
  copy_id TEXT PRIMARY KEY,
  workload_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  memory_bytes INTEGER,
  memory_bytes_avg REAL,
  cpu_nanos INTEGER,
  cpu_millis REAL,
  cpu_millis_avg REAL,
  sampled_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workload_usage_workload_idx ON workload_usage (workload_id);

-- One autoscaling policy per project. No CHECKs on purpose (the lesson of 0028): the contract
-- validates `metric`, so a new signal is a code change, never a table rebuild.
CREATE TABLE IF NOT EXISTS workload_scaling (
  project_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  min_replicas INTEGER NOT NULL DEFAULT 1,
  max_replicas INTEGER NOT NULL DEFAULT 3,
  metric TEXT NOT NULL DEFAULT 'cpu',
  target REAL NOT NULL DEFAULT 70,
  scale_down_minutes INTEGER NOT NULL DEFAULT 5,
  last_scaled_at INTEGER,
  last_evaluated_at INTEGER,
  last_observed REAL,
  last_desired INTEGER,
  last_reason TEXT,
  below_since INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workload_scale_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  from_replicas INTEGER NOT NULL,
  to_replicas INTEGER NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT,
  actor TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workload_scale_events_project_idx ON workload_scale_events (project_id, created_at);

-- A day of round-trip samples per ordered pair, thinned to one a minute, for the Fleet sparkline.
CREATE TABLE IF NOT EXISTS node_link_history (
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  rtt_ms REAL,
  loss_percent REAL,
  PRIMARY KEY (from_node_id, to_node_id, at)
);
-- When the link first stopped answering, so an alert fires once it has stayed down.
ALTER TABLE node_links ADD COLUMN down_since INTEGER;

-- Moving an app together with its app volumes (docs/SCALING.md §7). One row per move; the phase is
-- advanced by the controller from what the nodes report, so a restarted control plane carries on.
-- No CHECKs on purpose (the lesson of 0028).
CREATE TABLE IF NOT EXISTS project_relocations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workload_id TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  detail TEXT,
  error TEXT,
  volumes_json TEXT NOT NULL DEFAULT '[]',
  quiesce_version INTEGER NOT NULL DEFAULT 0,
  stopped_at INTEGER,
  phase_started_at INTEGER NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS project_relocations_project_idx ON project_relocations (project_id, created_at);
