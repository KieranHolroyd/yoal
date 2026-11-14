-- Automatic rollback, surge deploys and usage peaks (docs/SCALING.md §4, §5). Additive only.

-- The deployment a rollout started from, so a failed one can be put back even when no copy is
-- left on it.
ALTER TABLE workloads ADD COLUMN rollout_from_deployment_id TEXT;
-- 1 while a single-copy app is deployed through a temporary second copy on another node; the
-- extra copy is removed when the rollout ends.
ALTER TABLE workloads ADD COLUMN rollout_surge INTEGER NOT NULL DEFAULT 0;
-- 1 when the current rollout is itself an automatic rollback, so a second failure pauses instead
-- of bouncing between two releases.
ALTER TABLE workloads ADD COLUMN rollout_auto INTEGER NOT NULL DEFAULT 0;
-- What the last automatic rollback undid and why; shown until the next deploy.
ALTER TABLE workloads ADD COLUMN rollback_note TEXT;
ALTER TABLE workloads ADD COLUMN rollback_at INTEGER;

-- The highest memory and CPU a copy reached today and yesterday (UTC days), for right-sizing.
ALTER TABLE workload_usage ADD COLUMN peak_day INTEGER;
ALTER TABLE workload_usage ADD COLUMN memory_peak_bytes INTEGER;
ALTER TABLE workload_usage ADD COLUMN cpu_peak_millis REAL;
ALTER TABLE workload_usage ADD COLUMN memory_peak_prev_bytes INTEGER;
ALTER TABLE workload_usage ADD COLUMN cpu_peak_prev_millis REAL;
