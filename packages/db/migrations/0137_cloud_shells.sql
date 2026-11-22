-- Cloud shell (D236, docs/CLOUD-SHELL.md). Additive only.
--
-- One row per person and org: the node holding their 1 GiB home disk and the shell's state. A
-- running shell is a `csh_…` workload in that node's desired state; a stopped one keeps its disk
-- on the node and leaves desired state. A reset or deleted shell is `deleting` until the node
-- reports the disk gone (`purgedCloudShells`), then the row is removed; at most one row per person
-- and org is anything else.
CREATE TABLE IF NOT EXISTS cloud_shells (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  node_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('stopped','starting','running','deleting')),
  disk_mb INTEGER NOT NULL CHECK (disk_mb > 0),
  -- The access key the shell's CLI signs in with (`access_keys.id`), and its value sealed with the
  -- org key so a re-fetched activation can hand it over again. Both NULL while stopped.
  access_key_id TEXT,
  access_key_sealed TEXT,
  -- Bumped on every start; folded into the activation version so the container restarts fresh.
  generation INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  last_active_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cloud_shells_owner_idx ON cloud_shells (org_id, user_id) WHERE status <> 'deleting';
CREATE INDEX IF NOT EXISTS cloud_shells_node_idx ON cloud_shells (node_id);
