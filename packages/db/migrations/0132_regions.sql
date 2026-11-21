-- Regions (HA-PLAN H26, W13; Wave 5 foundation). Additive only.
--
-- A region groups zones. Every existing node is in the implicit region `default`, so placement,
-- replication and failover are unchanged until an operator names another region, which needs the
-- REGIONS flag. A zone belongs to exactly one region; the control plane enforces it on write.
ALTER TABLE nodes ADD COLUMN region TEXT NOT NULL DEFAULT 'default';
-- Backfill: the column default already covers existing rows; this makes the intent explicit and
-- repairs an empty value written by hand.
UPDATE nodes SET region = 'default' WHERE region IS NULL OR region = '';

-- The region that holds this database's async standby replica, which never auto-promotes. NULL
-- for every existing database: no standby region.
ALTER TABLE databases ADD COLUMN standby_region TEXT;

-- `yoal ha region promote <region>`: one fenced, human-confirmed promotion of everything in a
-- standby region, in dependency order (control plane, databases, steering). The lease generation is
-- the fence: `fenced_generation` is strictly greater than `expected_generation`.
CREATE TABLE IF NOT EXISTS region_promotions (
  id TEXT PRIMARY KEY,
  to_region TEXT NOT NULL,
  from_region TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'awaiting-confirmation' CHECK (stage IN (
    'awaiting-confirmation','fencing','control-plane','databases','steering','completed','failed','cancelled'
  )),
  expected_generation INTEGER NOT NULL CHECK (expected_generation >= 0),
  fenced_generation INTEGER CHECK (fenced_generation IS NULL OR fenced_generation > expected_generation),
  -- `RegionPromotionItem[]`: what each step acts on, with the lag it was planned at.
  items_json TEXT NOT NULL DEFAULT '[]',
  accept_data_loss INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  requested_by TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  confirmed_by TEXT,
  confirmed_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  error TEXT,
  -- A promotion that runs was confirmed, with data loss accepted.
  CHECK (stage IN ('awaiting-confirmation','cancelled') OR (confirmed_at IS NOT NULL AND accept_data_loss = 1))
);
CREATE INDEX IF NOT EXISTS region_promotions_requested_idx ON region_promotions (requested_at);
-- At most one promotion is open (awaiting confirmation or running) at a time; a terminal stage
-- always sets finished_at.
CREATE UNIQUE INDEX IF NOT EXISTS region_promotions_open_idx ON region_promotions (coalesce(finished_at, 0))
  WHERE finished_at IS NULL;
