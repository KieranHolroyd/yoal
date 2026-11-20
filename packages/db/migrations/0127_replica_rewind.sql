-- Old-primary re-attachment by pg_rewind (HA-PLAN W10; Wave 3 lane C). Additive only.
--
-- The integrator renumbers this file into the checked-in stream; the SQL is independent of its
-- number (scripts/check-migrations.ts requires a sequential stream).
--
-- After a promotion the old primary may come back with a diverged data dir. Instead of purging it
-- and paying for a full `pg_basebackup`, the control plane can record a replica on that node whose
-- data comes from the old primary's directory: the agent stops the old unit, the helper runs
-- `pg_rewind` against the new primary through the replica link and renames the directory to the
-- replica's workload id. All null/false for every existing replica, so behaviour is unchanged
-- with PITR_REWIND off.
ALTER TABLE database_replicas ADD COLUMN rewind_from_database_id TEXT;
ALTER TABLE database_replicas ADD COLUMN rewind_requested_at INTEGER;
ALTER TABLE database_replicas ADD COLUMN rewind_done_at INTEGER;
ALTER TABLE database_replicas ADD COLUMN rewind_fallback INTEGER NOT NULL DEFAULT 0;
ALTER TABLE database_replicas ADD COLUMN rewind_error TEXT;
