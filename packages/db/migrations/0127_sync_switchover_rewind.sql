-- W10 sync transitions, switchovers and rewind (HA-PLAN H23, W10; Wave 3 lane B). Additive only.
--
-- `databases` caches what the lease object (the authority) says, so the REST surface, CLI and
-- alerts can show a changing or downgraded database without reading the arbiter on every request.
-- Existing rows are `async`/`steady`, which is their current behaviour with SYNC_REPLICA off.
ALTER TABLE databases ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'steady'
  CHECK (sync_state IN ('steady','changing'));
ALTER TABLE databases ADD COLUMN durability_effective TEXT NOT NULL DEFAULT 'async'
  CHECK (durability_effective IN ('async','sync'));
-- When the current sync set was closed; NULL for async or never.
ALTER TABLE databases ADD COLUMN sync_set_at INTEGER;

-- A planned switchover uses the same fence/promote/re-point bookkeeping as a failover, but the old
-- primary is rewound and re-attached instead of purged. `kind` keeps that decision structured.
ALTER TABLE database_failovers ADD COLUMN kind TEXT NOT NULL DEFAULT 'failover'
  CHECK (kind IN ('failover','switchover'));
-- The primary's last LSN after writes stopped, and the measured start; the replica's replay LSN is
-- already on its row. `rewound_at` marks the old primary handled (rewound or rebuilt).
ALTER TABLE database_failovers ADD COLUMN drain_lsn TEXT;
ALTER TABLE database_failovers ADD COLUMN switchover_step TEXT;
ALTER TABLE database_failovers ADD COLUMN switchover_started_at INTEGER;
ALTER TABLE database_failovers ADD COLUMN rewound_at INTEGER;
-- `rewound` re-attached the old copy; `rebuild` needs a fresh replica on that node instead.
ALTER TABLE database_failovers ADD COLUMN rewind_status TEXT;
-- The replica row created on the old primary's node to hold the rewound copy.
ALTER TABLE database_failovers ADD COLUMN rewind_replica_id TEXT;
-- When the current change was opened; a stuck change older than SYNC_CHANGE_TIMEOUT falls back.
ALTER TABLE databases ADD COLUMN sync_change_started_at INTEGER;
-- The member being replaced, so a failed switch can fall back to it (H23 step 3).
ALTER TABLE databases ADD COLUMN sync_previous_node_id TEXT;
-- First observation of "no synchronous standby", for the 30 s downgrade timer.
ALTER TABLE databases ADD COLUMN sync_lost_at INTEGER;
-- Counts sync-set openings, so re-opening the same target produces a new task version (W10 review).
ALTER TABLE databases ADD COLUMN sync_attempt INTEGER NOT NULL DEFAULT 0;
-- The phase the primary's node last reported for the open change, for an honest status report.
ALTER TABLE databases ADD COLUMN sync_phase TEXT CHECK (sync_phase IN ('opening','switching','waiting-barrier','closing','rearming'));
-- The barrier LSN the node wrote, so status does not fabricate it.
ALTER TABLE databases ADD COLUMN sync_barrier_lsn TEXT;
-- The lease ETag/expiry the control plane last read, sent to the primary's node as its ownership
-- token: a node result at another ETag can never close a newer change.
ALTER TABLE databases ADD COLUMN sync_lease_etag TEXT;
ALTER TABLE databases ADD COLUMN sync_lease_expires_at INTEGER;

-- The last role/generation/replay position each member reported (W9-SPEC §5.6). Role discovery
-- reads this, so a consumer poll does not need the control plane or a fresh helper round trip.
CREATE TABLE IF NOT EXISTS database_member_status (
  database_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  role TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  epoch INTEGER NOT NULL DEFAULT 0,
  streaming INTEGER NOT NULL DEFAULT 0,
  in_recovery INTEGER NOT NULL DEFAULT 0,
  lsn TEXT,
  durability_effective TEXT NOT NULL DEFAULT 'async',
  sync_state TEXT NOT NULL DEFAULT 'steady',
  read_only INTEGER NOT NULL DEFAULT 0,
  fenced INTEGER NOT NULL DEFAULT 0,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (database_id, node_id)
);
