-- Ingress drift from the agent's applied state (HA-PLAN H17, W6; CLUSTERING §7.1). Additive only.
--
-- The heartbeat already carries `actualStateVersion`; until now the control plane read it only
-- for move and rollout progress. An ingress that is behind for the drift window is `drifted`: the
-- steering drivers must not send it new traffic while stale routes can serve a deleted site.
--
-- `actual_state_version` is the version the node last reported applying; `actual_state_at` is when
-- that value last changed (not every heartbeat), so "behind for two minutes" survives a control
-- plane restart. NULL means the node has not reported since this migration; it is not drifted.
ALTER TABLE nodes ADD COLUMN actual_state_version INTEGER;
ALTER TABLE nodes ADD COLUMN actual_state_at INTEGER;
