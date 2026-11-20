-- The per-install certificate authority (HA-PLAN H24 "Trust", CLUSTERING §4.3; HA Wave 1).
-- Additive only. Nothing writes these tables until YOAL_FEATURE_ENDPOINTS_GATEWAY is on, so a
-- single-node install has no rows.
--
-- `node_ca` holds the CA: the public certificate, and the private key sealed with the platform
-- master key (the same envelope as `org_keys.wrapped_key` and other sealed secrets), never
-- selected by a view. `state` is 'active' for the one CA that signs, 'previous' while a rotation
-- still trusts the old one, 'retired' after. One active row at a time.
CREATE TABLE IF NOT EXISTS node_ca (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','previous','retired')),
  cert_pem TEXT NOT NULL,
  key_sealed TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  subject TEXT NOT NULL,
  not_before INTEGER NOT NULL,
  not_after INTEGER NOT NULL,
  -- The next leaf serial is random; this only counts issues for the view.
  issued_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS node_ca_active_idx ON node_ca (state) WHERE state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS node_ca_fingerprint_idx ON node_ca (fingerprint);

-- Every leaf the CA signed from a node's CSR: public material only. `node_certificates` (0043)
-- stays the C2 pinned-certificate record; this is the CA's issue log, from which desired state
-- renders `nodeTrust` (the node's current leaf) and `revokedSerials`.
CREATE TABLE IF NOT EXISTS node_ca_certificates (
  serial TEXT PRIMARY KEY,
  ca_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  cert_pem TEXT NOT NULL,
  -- SHA-256 of the leaf's SubjectPublicKeyInfo, so a re-sent CSR for the same key is not re-signed.
  public_key_sha256 TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'enrol' CHECK (reason IN ('enrol','renew','rekey')),
  not_before INTEGER NOT NULL,
  not_after INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS node_ca_certificates_node_idx ON node_ca_certificates (node_id, not_after);
-- At most one unrevoked leaf per node and key: a re-sent CSR is answered with the existing leaf,
-- and a renewal for the same key revokes (supersedes) the old leaf in the same transaction.
CREATE UNIQUE INDEX IF NOT EXISTS node_ca_certificates_live_key_idx
  ON node_ca_certificates (node_id, public_key_sha256) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS node_ca_certificates_revoked_idx ON node_ca_certificates (revoked_at);
