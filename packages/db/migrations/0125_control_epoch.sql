-- Control-plane standby state (HA-PLAN H21, C6; Wave 3 foundation). Additive only.
--
-- The arbiter object is authoritative for the lease. These columns/tables are the control plane's
-- local record: the highest epoch a node has observed (never decreased), and the last role/lease a
-- control node reported. Nothing writes them while CONTROL_STANDBY is off.
ALTER TABLE nodes ADD COLUMN ha_epoch INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS control_state (
  node_id TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'joining',
  epoch INTEGER NOT NULL DEFAULT 0,
  holder_node_id TEXT,
  lease_expires_at INTEGER,
  can_promote INTEGER NOT NULL DEFAULT 0,
  replication_lag_seconds REAL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS control_state_role_idx ON control_state (role, epoch);
