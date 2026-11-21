-- Per-database automatic failover policy (HA-PLAN W11; Wave 4 foundation). Additive only.
--
-- `failover_mode` defaults to `manual`, so every existing database keeps today's behaviour even
-- when DB_AUTO_PROMOTE is on. An `async` database may only be armed with `accept_data_loss = 1`;
-- a `sync` one is RPO 0 without it (W11-SPEC §1.3). `last_failover_drill_at` is the evidence
-- arming reads; `auto_armed_at` is when an operator last armed automatic failover.
ALTER TABLE databases ADD COLUMN failover_mode TEXT NOT NULL DEFAULT 'manual'
  CHECK (failover_mode IN ('manual','auto'));
ALTER TABLE databases ADD COLUMN accept_data_loss INTEGER NOT NULL DEFAULT 0;
ALTER TABLE databases ADD COLUMN auto_armed_at INTEGER;
ALTER TABLE databases ADD COLUMN last_failover_drill_at INTEGER;
-- The eligibility evidence captured when the policy was last armed, so an operator can explain an
-- existing `auto` without recomputing it from a fleet that has changed. `{}` for manual databases.
ALTER TABLE databases ADD COLUMN failover_evidence_json TEXT NOT NULL DEFAULT '{}';

-- How a failover was started, and the evidence the promotion relied on. A manual promotion keeps
-- the defaults, so no existing row changes meaning.
ALTER TABLE database_failovers ADD COLUMN promotion_source TEXT NOT NULL DEFAULT 'manual'
  CHECK (promotion_source IN ('manual','auto','drill'));
ALTER TABLE database_failovers ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '{}';
