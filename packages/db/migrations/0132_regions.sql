-- Regions (HA-PLAN H26, W13; Wave 5 foundation). Additive only.
--
-- A region groups zones. Every existing node is in the implicit region `default`, so placement,
-- replication and failover are unchanged until an operator names another region, which needs the
-- REGIONS flag. A zone belongs to exactly one region; the control plane enforces it on write.
-- Once a non-default region (or spread: region) is stored, an older control plane cannot parse it:
-- downgrading the control plane is unsupported until those values are put back.
ALTER TABLE nodes ADD COLUMN region TEXT NOT NULL DEFAULT 'default';
-- Backfill: the column default already covers existing rows; this makes the intent explicit and
-- repairs an empty value written by hand.
UPDATE nodes SET region = 'default' WHERE region IS NULL OR region = '';

-- The region that holds this database's async standby replica, which never auto-promotes. NULL
-- for every existing database: no standby region.
ALTER TABLE databases ADD COLUMN standby_region TEXT;

-- The flags each control-plane host runs with, from its W9 control report (JSON object of
-- name -> boolean), for the `flags-consistent` check. NULL until a host reports them.
ALTER TABLE control_state ADD COLUMN feature_flags_json TEXT;

-- `yoal ha region promote <region>`: one fenced, human-confirmed promotion of everything in a
-- standby region, in dependency order (control plane, databases, steering). The record is written
-- by the control plane in the surviving region, after its own promotion (the control-plane step),
-- under the new epoch; the plan before confirmation is never stored. So a stored row is always
-- confirmed with data loss accepted.
CREATE TABLE IF NOT EXISTS region_promotions (
  id TEXT PRIMARY KEY,
  to_region TEXT NOT NULL,
  from_region TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'control-plane' CHECK (stage IN (
    'control-plane','databases','steering','completed','failed','cancelled'
  )),
  -- The hash of the plan the operator confirmed (each step's expected generation is in it).
  plan_hash TEXT NOT NULL,
  -- The runner lease: one control plane runs the promotion at a time and renews between steps;
  -- another takes over only after lease_expires_at, with a conditional update on these values.
  runner_id TEXT,
  lease_expires_at INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  accept_data_loss INTEGER NOT NULL CHECK (accept_data_loss = 1),
  reason TEXT NOT NULL,
  confirmed_by TEXT NOT NULL,
  confirmed_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT,
  -- A terminal stage sets finished_at, and only a terminal stage does.
  CHECK ((stage IN ('completed','failed','cancelled')) = (finished_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS region_promotions_started_idx ON region_promotions (started_at);
-- At most one promotion is open (not terminal) at a time.
CREATE UNIQUE INDEX IF NOT EXISTS region_promotions_open_idx ON region_promotions (coalesce(finished_at, 0))
  WHERE finished_at IS NULL;

-- One row per step and resource, each with its own fence: the control-plane epoch for the control
-- step, each database's lease generation for its step. Steering has no lease of its own: its
-- writes are fenced by the new control epoch (expected_generation), and fenced_generation stays
-- NULL. A step is idempotent, keyed on fenced_generation: re-running a done step is a no-op.
CREATE TABLE IF NOT EXISTS region_promotion_steps (
  promotion_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  step TEXT NOT NULL CHECK (step IN ('control-plane','databases','steering')),
  kind TEXT NOT NULL CHECK (kind IN ('control-plane','database','steering')),
  resource_id TEXT NOT NULL,
  name TEXT NOT NULL,
  target_node_id TEXT,
  expected_generation INTEGER NOT NULL CHECK (expected_generation >= 0),
  fenced_generation INTEGER CHECK (fenced_generation IS NULL OR fenced_generation > expected_generation),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','skipped','failed')),
  lag_bytes INTEGER CHECK (lag_bytes IS NULL OR lag_bytes >= 0),
  lag_seconds REAL CHECK (lag_seconds IS NULL OR lag_seconds >= 0),
  started_at INTEGER,
  finished_at INTEGER,
  message TEXT,
  PRIMARY KEY (promotion_id, position)
);
CREATE UNIQUE INDEX IF NOT EXISTS region_promotion_steps_resource_idx
  ON region_promotion_steps (promotion_id, kind, resource_id);
