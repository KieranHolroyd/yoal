-- W7 certificates (HA-PLAN H20): durable reissue requests and the per-ingress fingerprint report.
--
-- `reissue_requested_at` is what makes "removing an ingress reissues" survive a control-plane
-- restart. Without it the request would live only in memory: the removed node is already gone, so
-- nothing would remember that every certificate it held must be replaced.
--
-- `nodes.certificate_fingerprint` is the last fingerprint a node reported in its heartbeat. The
-- preflight compares it on every ingress; it is public data (a hash), never key material.
ALTER TABLE ingress_certificates ADD COLUMN reissue_requested_at INTEGER;
ALTER TABLE nodes ADD COLUMN certificate_fingerprint TEXT;
