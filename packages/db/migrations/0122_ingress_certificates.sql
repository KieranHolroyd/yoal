-- Ingress set and shared certificates (HA-PLAN H17/H20, Wave 2 opening). Additive only.
--
-- Nothing writes these tables until YOAL_FEATURE_SHARED_CERTIFICATES is on, so a single-node
-- install has no rows. The ingress *set* needs no table: membership is the node's `roles_json`
-- (`ingress`), and the compatibility first ingress stays `mode = 'edge'` / YOAL_EDGE_NODE_ID.
--
-- One row per certificate the fleet serves for a host. The private key is sealed with the platform
-- master key (the node_ca envelope), never selected by a read path. `fingerprint` is what the
-- heartbeat reports and what every ingress compares, so a renewal is visible as a change rather
-- than as a silent per-node issue. `source = 'byo'` is never renewed by Yoal.
CREATE TABLE IF NOT EXISTS ingress_certificates (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  serial TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  cert_pem TEXT NOT NULL,
  key_sealed TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'acme' CHECK (source IN ('acme','byo')),
  not_after INTEGER NOT NULL,
  renewed_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ingress_certificates_host_fingerprint_idx
  ON ingress_certificates (host, fingerprint);
CREATE INDEX IF NOT EXISTS ingress_certificates_host_idx ON ingress_certificates (host, not_after);
CREATE UNIQUE INDEX IF NOT EXISTS ingress_certificates_live_idx
  ON ingress_certificates (host) WHERE revoked_at IS NULL;

-- The ACME challenge lease: one ingress holds HTTP-01 or DNS-01 for a host at a time, and every
-- other ingress relays `/.well-known/acme-challenge/*` to it over the overlay (H20).
CREATE TABLE IF NOT EXISTS acme_leases (
  host TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS acme_leases_node_idx ON acme_leases (node_id);
