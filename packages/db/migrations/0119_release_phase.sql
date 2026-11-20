-- Release phase (HA-PLAN H25, W5; HA Wave 1). Additive only. Nothing writes these tables until
-- YOAL_FEATURE_RELEASE_PHASE is on, so a single-node install has no rows.
--
-- One row per release-command attempt. `release_id` is the deployment the command prepares. The
-- partial unique index is the run lease of I16: per release, at most one row is queued, running or
-- succeeded, all together. So no attempt starts while another is live, none is queued or started
-- after one succeeded, and at most one ever succeeds: a release command runs at most once per
-- release, and a rollout starts only after the succeeded row exists. A retry after a failure is a
-- new row with attempt + 1.
CREATE TABLE IF NOT EXISTS release_command_runs (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workload_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','timeout','cancelled')),
  command_json TEXT NOT NULL,
  timeout_seconds INTEGER NOT NULL,
  node_id TEXT,
  -- The node must start by this time (epoch ms); after it the lease is re-granted, never doubled.
  start_by INTEGER,
  exit_code INTEGER,
  error TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS release_command_runs_attempt_idx ON release_command_runs (release_id, attempt);
CREATE UNIQUE INDEX IF NOT EXISTS release_command_runs_lease_idx
  ON release_command_runs (release_id) WHERE status IN ('queued','running','succeeded');
CREATE INDEX IF NOT EXISTS release_command_runs_node_idx ON release_command_runs (node_id, status);
CREATE INDEX IF NOT EXISTS release_command_runs_project_idx ON release_command_runs (project_id, created_at);

-- Canary state for a deployment's rollout (H25 "Canary"): which copies soak, since when, and the
-- judge's verdict from the edge's own counters. One row per deployment that rolls with a canary.
CREATE TABLE IF NOT EXISTS deployment_canaries (
  deployment_id TEXT PRIMARY KEY,
  workload_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'soaking' CHECK (state IN ('soaking','passed','failed','skipped')),
  canary_copies INTEGER NOT NULL DEFAULT 1,
  soak_seconds INTEGER NOT NULL,
  -- JSON array of the copy ids (workload replica ids) that roll first.
  copies_json TEXT NOT NULL DEFAULT '[]',
  -- Last sample the judge read: { requests, status5xx, durationP95Ms } and the baseline.
  sample_json TEXT,
  reason TEXT,
  started_at INTEGER NOT NULL,
  judged_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deployment_canaries_state_idx ON deployment_canaries (state, started_at);
