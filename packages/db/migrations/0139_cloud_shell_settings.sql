-- Cloud shell settings (D239, docs/CLOUD-SHELL.md §2). Additive only.
--
-- `memory_mb`, `cpus`, `idle_minutes`: what this run of the shell got, copied from the person's
-- settings when it starts (NULL on rows started before this migration: the old defaults apply).
ALTER TABLE cloud_shells ADD COLUMN memory_mb INTEGER CHECK (memory_mb IS NULL OR memory_mb > 0);
ALTER TABLE cloud_shells ADD COLUMN cpus INTEGER CHECK (cpus IS NULL OR cpus > 0);
ALTER TABLE cloud_shells ADD COLUMN idle_minutes INTEGER CHECK (idle_minutes IS NULL OR idle_minutes > 0);

-- A person's choices for their shell in one org. Kept apart from `cloud_shells` so they survive a
-- reset; a NULL node_id lets the control plane pick the node for a new disk.
CREATE TABLE IF NOT EXISTS cloud_shell_settings (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  node_id TEXT,
  disk_mb INTEGER NOT NULL CHECK (disk_mb > 0),
  memory_mb INTEGER NOT NULL CHECK (memory_mb > 0),
  cpus INTEGER NOT NULL CHECK (cpus > 0),
  idle_minutes INTEGER NOT NULL CHECK (idle_minutes > 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
