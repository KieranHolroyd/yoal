-- Replica durability and sync policy (HA-PLAN H23, W10; Wave 3 foundation). Additive only.
--
-- The lease object records the authoritative sync set; these columns are the requested policy and a
-- display cache, read by the W10 lane. Existing databases stay `async`, so behaviour is unchanged
-- with the flag off. No table rebuild: the CHECK values match the contracts.
ALTER TABLE databases ADD COLUMN durability TEXT NOT NULL DEFAULT 'async'
  CHECK (durability IN ('async','sync'));
ALTER TABLE databases ADD COLUMN sync_timeout_seconds INTEGER NOT NULL DEFAULT 30;
ALTER TABLE databases ADD COLUMN on_sync_loss TEXT NOT NULL DEFAULT 'downgrade'
  CHECK (on_sync_loss IN ('downgrade','block'));
-- The node the lease currently names as synchronous; NULL for async or none.
ALTER TABLE databases ADD COLUMN sync_replica_node_id TEXT;
