-- Mesh mode for the overlay (docs/CLUSTERING.md §4.7, D240). Additive only.
--
-- One row per pair of nodes that mesh mode tries to connect directly (`node_a < node_b`). `state` is
-- `probing` (the peer is up with no addresses while the hub carries traffic), `direct` (a handshake
-- proved the path and the pair's /32s moved onto it) or `relayed` (the probe failed; `retry_at`
-- says when to try again). Rows exist only while the install is in mesh mode. No CHECKs on purpose
-- (the lesson of 0028).
CREATE TABLE IF NOT EXISTS overlay_mesh_pairs (
  node_a TEXT NOT NULL,
  node_b TEXT NOT NULL,
  state TEXT NOT NULL,
  since INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,
  endpoints TEXT NOT NULL DEFAULT '',
  last_handshake_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (node_a, node_b)
);
