-- Attachment endpoints move per project (HA-PLAN §9, H24; review debt 2). Additive only.
--
-- `workloads.endpoints_gateway` is 1 when the project's own last deploy (or attach, or
-- `yoal ha migrate attachments`) ran with ENDPOINTS_GATEWAY on and every node holding a copy able
-- to run the gateway. Only such a project gets same-node and pooled endpoints, so a neighbour's
-- deploy or a replica coming and going never moves another app or restarts it.
ALTER TABLE workloads ADD COLUMN endpoints_gateway INTEGER NOT NULL DEFAULT 0;

-- Installs that already ran the gateway: keep every app that already uses it where it is. An app
-- uses it when one of its copies' nodes has a pooled or read endpoint, or a same-node endpoint, for
-- a database it is attached to, or when it is a container with any database endpoint (a container
-- reaches a database on another node only through the gateway). Pooled, read and same-node rows
-- exist only under the gateway. Remote primary rows (C2) exist on gateway-off installs too, because
-- SERVICE_ENDPOINTS defaults on, but only for process apps, which are not marked by them; the one
-- container that can have one without the gateway is a container left on another node after the
-- flag was turned off, and it has no URL either way until it is redeployed (marking it changes
-- nothing while the flag is off).
UPDATE workloads SET endpoints_gateway = 1
WHERE EXISTS (
  SELECT 1 FROM database_attachments a
  JOIN service_endpoints e ON e.service_kind = 'database' AND e.service_id = a.database_id
  WHERE a.project_id = workloads.project_id
    AND (e.role IN ('pool', 'read') OR e.consumer_node_id = e.upstream_node_id OR workloads.runtime = 'container')
    AND (
      e.consumer_node_id = workloads.node_id
      OR EXISTS (SELECT 1 FROM workload_replicas r WHERE r.workload_id = workloads.id AND r.node_id = e.consumer_node_id)
    )
);

-- `<P>_READ_*` through the stable read endpoint, per attachment. Set by the project's own deploy,
-- attach or migration from this release on, so a neighbour's deploy (which re-plans the node) or a
-- replica change never adds read variables to another app and restarts it. Backfill: an attachment
-- already had them when a read endpoint for its database exists on a node holding one of its copies.
ALTER TABLE database_attachments ADD COLUMN read_endpoint INTEGER NOT NULL DEFAULT 0;
UPDATE database_attachments SET read_endpoint = 1
WHERE EXISTS (
  SELECT 1 FROM service_endpoints e
  JOIN workloads w ON w.project_id = database_attachments.project_id
  WHERE e.service_kind = 'database' AND e.role = 'read' AND e.service_id = database_attachments.database_id
    AND (
      e.consumer_node_id = w.node_id
      OR EXISTS (SELECT 1 FROM workload_replicas r WHERE r.workload_id = w.id AND r.node_id = e.consumer_node_id)
    )
);

-- The read endpoint's replica set, so a change in it bumps the endpoint's version (the forwarder
-- cuts sessions to a replica that left) without changing the app's environment.
ALTER TABLE service_endpoints ADD COLUMN upstreams_key TEXT;
