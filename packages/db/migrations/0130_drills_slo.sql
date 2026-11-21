-- Failover drills and W15 SLO objects (HA-PLAN W11 §12, W15; Wave 4 foundation). Additive only.
--
-- A drill is a real promotion on a disposable database. Its measured time to writable, lost
-- commits and arbiter evidence are what arming reads: a failed, untested, unmeasured, too-slow or
-- stale drill refuses `auto` (W11-SPEC §3, §9, §12). Existing installs have no rows, so no policy
-- changes.
CREATE TABLE IF NOT EXISTS database_failover_drills (
  id TEXT PRIMARY KEY,
  -- The database whose policy this drill proves; the disposable copy (if any) is below.
  database_id TEXT NOT NULL,
  drill_database_id TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','passed','failed')),
  -- The durability in force for the drill; a `sync` drill must prove RPO 0.
  durability TEXT NOT NULL DEFAULT 'async' CHECK (durability IN ('async','sync')),
  from_node_id TEXT,
  to_node_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  -- From the primary's last successful lease renew to the new primary accepting a write.
  time_to_writable_ms INTEGER CHECK (time_to_writable_ms IS NULL OR time_to_writable_ms >= 0),
  -- Acknowledged commits lost; a `sync` drill must record 0 (I13).
  lost_commits INTEGER CHECK (lost_commits IS NULL OR lost_commits >= 0),
  arbiter_tested INTEGER NOT NULL DEFAULT 0,
  arbiter_tested_at INTEGER,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  message TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS database_failover_drills_database_idx
  ON database_failover_drills (database_id, started_at);
CREATE INDEX IF NOT EXISTS database_failover_drills_status_idx
  ON database_failover_drills (status, finished_at);

-- SLO objects per project (HA-PLAN W15). `target` is a success ratio in (0,1); the error budget is
-- derived as `1 - target` and a burn rate is `consumed / elapsed` at evaluation time. The burn
-- policy is a multi-window array. Nothing writes these rows while SLO_OBJECTS is off, so a
-- single-node install has no rows and no behaviour change.
CREATE TABLE IF NOT EXISTS slo_objects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  -- The signal the evaluator measures, e.g. `http_availability`; never a query string.
  indicator TEXT NOT NULL,
  target REAL NOT NULL CHECK (target > 0 AND target < 1),
  window_seconds INTEGER NOT NULL CHECK (window_seconds >= 3600),
  burn_alerts_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS slo_objects_project_name_idx ON slo_objects (project_id, name);
CREATE INDEX IF NOT EXISTS slo_objects_org_idx ON slo_objects (org_id);
