-- Endpoint roles for attachments everywhere (HA-PLAN H24, W4; HA Wave 1 lane B). Additive only.
--
-- C2 stored one endpoint per (consumer, kind, service): the attachment itself. H24 also offers the
-- database's pooled connection and a stable read port. `role` distinguishes them, so the unique
-- key becomes (consumer_node_id, service_kind, service_id, role). Existing rows are `primary` and
-- keep their id, port and meaning.
--
-- `read` rows use the read range 23000-23999 on the consumer node; `primary` and `pool` rows keep
-- 21000-21999. `version` bumps on every re-point of `upstream_node_id`/`upstream_port` (a promotion
-- or a replica moved), never on the local port, so the agent can tell a failover from a restart.
ALTER TABLE service_endpoints ADD COLUMN role TEXT NOT NULL DEFAULT 'primary'
  CHECK (role IN ('primary','pool','read'));
ALTER TABLE service_endpoints ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS service_endpoints_pair_idx;
CREATE UNIQUE INDEX IF NOT EXISTS service_endpoints_pair_idx
  ON service_endpoints (consumer_node_id, service_kind, service_id, role);
