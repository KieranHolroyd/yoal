-- Old-primary re-attachment by pg_rewind (HA-PLAN W10; Wave 3 lane C). Additive only.
--
-- Lane C's reservation is 0129, but the checked-in stream must be sequential (scripts/check-
-- migrations.ts) and 0127/0128 belong to lanes A/B, which are not in this branch. Renumber this
-- file to 0129 at integration; the SQL is independent of its number.
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
