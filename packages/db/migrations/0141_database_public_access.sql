-- Public database access (docs/DATABASES.md §19, D241). Additive only.
--
-- `database_public_access`: one row per database that has ever been exposed. The port is kept while
-- the database exists, so turning access off and on again keeps the same URL. `rules` is a JSON
-- array of `{ cidr, label }`, `credential_ids` a JSON array of `dbc_…` ids (Postgres). `version`
-- bumps on every change and rides desired state. No CHECKs on purpose (the lesson of 0028).
CREATE TABLE IF NOT EXISTS database_public_access (
  database_id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  port INTEGER NOT NULL,
  rules TEXT NOT NULL DEFAULT '[]',
  allow_anywhere INTEGER NOT NULL DEFAULT 0,
  credential_ids TEXT NOT NULL DEFAULT '[]',
  max_connections INTEGER NOT NULL DEFAULT 20,
  expires_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  enabled_at INTEGER,
  enabled_by TEXT,
  disabled_at INTEGER,
  disabled_reason TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS database_public_access_port ON database_public_access (port);

-- What each ingress last reported for a database's listener.
CREATE TABLE IF NOT EXISTS database_public_access_nodes (
  database_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  state TEXT NOT NULL,
  error TEXT,
  open INTEGER NOT NULL DEFAULT 0,
  accepted INTEGER NOT NULL DEFAULT 0,
  refused INTEGER NOT NULL DEFAULT 0,
  auth_failures INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (database_id, node_id)
);

-- Recent refusals, the last 200 per database.
CREATE TABLE IF NOT EXISTS database_public_access_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  database_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS database_public_access_events_db ON database_public_access_events (database_id, id);
