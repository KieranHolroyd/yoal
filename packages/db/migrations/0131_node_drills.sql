-- Node offline drills (D235, docs/CLUSTERING.md §12.7). Additive only.
--
-- A drill takes one node off the control plane for a bounded time: its agent stops heartbeating
-- and pulling desired state and fails its ingress probe, so the failover controller reacts as it
-- would to a real loss. One drill runs at a time; the agent comes back by itself at `ends_at`.
-- Existing installs have no rows, so nothing changes until an operator starts one.
CREATE TABLE IF NOT EXISTS node_drills (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  node_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','cancelled','failed')),
  -- 1 when the node was picked at random rather than named.
  random INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
  started_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  -- When the control plane marked the node offline during the drill.
  offline_at INTEGER,
  cancelled_at INTEGER,
  -- The first heartbeat after the drill ended (or was cancelled).
  restored_at INTEGER,
  finished_at INTEGER,
  -- Detection and recovery times and the failover events in the window, written at the end.
  observations_json TEXT,
  message TEXT,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS node_drills_status_idx ON node_drills (status, started_at);
CREATE INDEX IF NOT EXISTS node_drills_node_idx ON node_drills (node_id, started_at);
