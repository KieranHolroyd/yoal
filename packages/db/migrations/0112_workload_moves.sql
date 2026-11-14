-- Workload moves and private networks (docs/CLUSTERING.md §3.10, §4.6, D214–D216). Additive only.
--
-- `moving_from_node_id` is set while a single-copy workload moves with a surge: the old node keeps
-- running and serving its copy until the new node reports `running`, then the column is cleared and
-- the old node stops it. NULL at every other time, so an install that never moves a workload reads
-- exactly as before. `placement_reason` records why the workload is where it is (deploy, drain,
-- failover, rebalance, manual), as `workload_replicas.placement_reason` does for spread copies.
ALTER TABLE workloads ADD COLUMN moving_from_node_id TEXT;
ALTER TABLE workloads ADD COLUMN moved_at INTEGER;
ALTER TABLE workloads ADD COLUMN placement_reason TEXT;

-- A named private network (a provider VPC, a vSwitch, a home LAN). Nodes that share one peer
-- directly on their `lan_endpoint`, whatever their zone or role.
ALTER TABLE nodes ADD COLUMN private_network TEXT;

-- Measured links between nodes: a passive round-trip sample on every heartbeat and the last
-- on-demand throughput test. One row per ordered pair; no CHECKs on purpose (the lesson of 0028).
CREATE TABLE IF NOT EXISTS node_links (
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT 'overlay',
  rtt_ms REAL,
  rtt_min_ms REAL,
  rtt_max_ms REAL,
  loss_percent REAL,
  sampled_at INTEGER,
  test_id TEXT,
  test_status TEXT,
  test_error TEXT,
  test_started_at INTEGER,
  test_finished_at INTEGER,
  upload_bps REAL,
  download_bps REAL,
  test_rtt_ms REAL,
  test_jitter_ms REAL,
  test_bytes INTEGER,
  test_seconds REAL,
  test_token TEXT,
  test_port INTEGER,
  test_streams INTEGER,
  test_requested_seconds INTEGER,
  test_expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (from_node_id, to_node_id)
);
