-- Fleet node updates (docs/CLUSTERING.md §3.11, D217). Additive only.
--
-- A rollout installs the control plane's signed release on many worker nodes in waves. The row is
-- the domain state every reader uses (dashboard, CLI, the heartbeat hook); a `node.rollout` flow run
-- (flow_id) drives it, so a restarted control plane resumes the rollout where it stopped.
-- `plan_json` holds the waves (arrays of node ids); `nodes_json` holds each node's progress.
-- At most one rollout is active (running or paused) at a time; the flow's key enforces it.
CREATE TABLE IF NOT EXISTS node_rollouts (
  id TEXT PRIMARY KEY,
  flow_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  phase TEXT,
  detail TEXT,
  target_version TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  options_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  nodes_json TEXT NOT NULL,
  current_wave INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  wave_started_at INTEGER,
  soak_until INTEGER,
  error TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS node_rollouts_status_idx ON node_rollouts (status, created_at);
CREATE INDEX IF NOT EXISTS node_rollouts_target_idx ON node_rollouts (target_version, trigger);
