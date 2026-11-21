-- Catalogue drills (HA-PLAN H27, §7.2, §10, W14; Wave 5 lane B). Additive only.
--
-- One row per `yoal ha drill <scenario>` run, whatever the scenario. `node-offline` and
-- `ingress-offline` hand the fault to the D235 node offline drill and `database-failover` to the W11
-- failover drill: their measurements stay in `node_drills` and `database_failover_drills`, and
-- `record_id` names that row. Every other scenario measures here. A scenario the runner cannot run
-- on a fleet is recorded `skipped` with the reason, never as a pass.
CREATE TABLE IF NOT EXISTS ha_drills (
  id TEXT PRIMARY KEY,
  scenario TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','passed','failed','cancelled','skipped')),
  -- The `node_drills` or `database_failover_drills` row the fault was handed to; NULL otherwise.
  record_id TEXT,
  -- An `--all` run groups its drills under one id.
  batch_id TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  rto_ms INTEGER CHECK (rto_ms IS NULL OR rto_ms >= 0),
  lost_commits INTEGER CHECK (lost_commits IS NULL OR lost_commits >= 0),
  lag_bytes INTEGER CHECK (lag_bytes IS NULL OR lag_bytes >= 0),
  failed_requests INTEGER CHECK (failed_requests IS NULL OR failed_requests >= 0),
  refused INTEGER CHECK (refused IS NULL OR refused IN (0, 1)),
  message TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ha_drills_created_idx ON ha_drills (created_at);
CREATE INDEX IF NOT EXISTS ha_drills_record_idx ON ha_drills (record_id);
