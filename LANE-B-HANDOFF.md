# W10 lane B hand-off — sync set, switchover, rewind

Branch `ha/w3-b-sync-switchover`, base `main` (`0b187500`). Code commit `56bdafdb`; this hand-off adds one
commit. No merge to `main`.

## What is implemented

- **Durability per database** (`async`/`sync`, `sync_timeout_seconds`, `on_sync_loss`) through
  `DatabaseMemberService` (`PUT /api/v1/databases/:name/durability`, `GET` for status) and
  `yoal db durability <name> --sync|--async|--timeout|--on-sync-loss`. `sync` is refused with fewer
  than two cross-node replicas in different zones unless `on_sync_loss: block`, with no fresh
  replica, on a non-Postgres engine, while a replica is being removed, or when the node lacks the
  `db-member` capability.
- **H23 exactly as W9-SPEC Revision 1**: the lease object (`yoal/ha/db/<id>.json`) carries `sync`,
  `syncState`, `durability`, `durabilityEffective` and `syncSetAt`; a change is
  **open** (`sync: []`, `changing`, non-promotable) → **switch** (`synchronous_standby_names`,
  `synchronous_commit=on`, barrier commit, LSN) → **close** (`sync: [new]`, `steady`). A barrier
  timeout falls back to a healthy previous member, else `on_sync_loss` (`downgrade` clears the
  setting and records `durability_effective: async`; `block` keeps the unavailable member named so
  writes wait). A lost synchronous standby starts the same transition to another replica or, after
  `sync_timeout`, the policy. `database-sync.ts` is pure and shared by the engine and the service;
  `mayAcquire`/`acquireRefusal` implement I12.
- **Planned switchover**: `POST /api/v1/databases/:name/switchover` (`GET` lists history),
  `yoal db switchover <name> <replica>`. Drain on the old primary (checkpoint, read-only, report
  `pg_current_wal_lsn()` plus a fresh `pg_stat_replication` replay LSN for the target), refuse on a
  non-zero gap and resume writes, then promote through the existing C7 task and re-point.
  `database-switchover.ts` models the sequence and is load-tested (below).
- **Helper fixed verbs**: `sync/configure`, `sync/barrier`, `writes/stop`, `writes/resume`,
  `fence` (`stop|readonly`), `member`, `replica/rewind` and the existing `replica/promote`.
  Structured bodies only; no SQL from the control plane.
- **Rewind**: a switchover creates a replica row on the old primary's node *without a slot* (so it
  cannot race a `pg_basebackup`), moves the old data dir into that replica's directory and runs
  `pg_rewind --write-recovery-conf` in a one-shot container; on failure the target dir is removed
  and the replica's standby script rebuilds. The slot is added only after the outcome, so desired
  state starts the replica then. `wal_log_hints=on` and `POSTGRES_INITDB_ARGS=--data-checksums`
  are set for new (and existing) Postgres units.
- **Role discovery (database side)**: `databaseMembers` desired state (primary + replicas, node,
  address, generation, durable/effective, sync state), a member probe in the helper, heartbeat
  `databaseMembers` reports, `database_member_status`, and `GET /databases/:name/members`. The
  shared contract `DatabaseMemberReport` carries role, generation, epoch, recovery, replay LSN.
- **Alerts**: new system kind `database_replica` for replica down, lag (> 30 s / 256 MB), lost slot,
  refused switchover, sync downgrade/block and sync fallback. Docs updated in `docs/ALERTS.md`.
- **Migration 0127** (one file, inline in `packages/db/src/migrations.ts`): `databases` sync cache
  (`sync_state`, `durability_effective`, `sync_set_at`, `sync_change_started_at`,
  `sync_previous_node_id`, `sync_lost_at`), `database_failovers` switchover/rewind fields, and
  `database_member_status`. **It is numbered 0127, not 0128**: the checker rejects a gap, and the
  plan says a spare is a claim, not a number. Renumber at merge if lane A's 0127 lands first.

## Verified

- `bun run check` — all packages, 0 errors (one pre-existing Svelte warning).
- `bun test` — 6,474 pass, 74 skip, 0 fail across 589 files (the pipeline log line is normal test
  output; a first run had one unrelated flake, clean on re-runs).
- `bun scripts/check-migrations.ts` — 127 migrations, no destructive statement.
- Focused: `packages/core/src/database-sync.test.ts` (13), `database-switchover.test.ts` (5, the
  100-run under-load switchover: 0 lost commits, max duration ≤ 5 s),
  `database-member-service.test.ts` (7: prerequisites, open/close, 30 s downgrade, switchover
  drain/gap/resume/rewind/rebuild, role discovery), `apps/helper/src/replication.test.ts`
  (19: sync setting/barrier/stop/resume/probe/rewind/checksums).
- Flag-off golden desired state is byte-identical: the W10 desired keys are absent, not empty.

## Not verified / deliberately left

- **No live fleet**: the 100-switchover proof is the deterministic engine simulation, not 100 real
  Postgres instances under load. The desired-state path adds the agent's 2 s durability loop and
  the normal heartbeat/promotion latency, so end-to-end ≤ 5 s is unproven in the lab.
- **Lane A not merged**: the control plane drives the sync transition through
  `databaseSyncTasks` + heartbeat results instead of the primary's node owning the loop. The pure
  engine is intended to move into `apps/agent/src/database-member.ts` unchanged; the seam is the
  task/result pair. Auto-promotion and the keeper/fence machine are not implemented here.
- **Consumer routing**: members are discoverable and probed, but `ServiceForwarder` still routes by
  planned upstream; polling-based primary selection in the forwarder is not wired.
- **`db_replica_metrics_1m` / Prometheus replica metrics** are not added; alerts use the existing
  slot samples and the `database_replica` system alerts.
- **Replica-based moves**: the switchover API exists, but the database move flow still uses
  stop/dump/restore; not switched over.
- Rewind/rebuild and the data-checksum initdb path have unit/route coverage only, not a real
  Postgres rewind.
- `accept_data_loss`, automatic database failover (W11) and PITR/backup from replicas (lane C) are
  untouched.

## Files

Core: `database-sync.ts`, `database-switchover.ts`, `database-member-service.ts`,
`database-replica-service.ts`, `databases.ts`, `desired-state/databases.ts`, `context.ts`,
`index.ts`, `maintenance.ts`, `nodes.ts`. Contracts: `database-member.ts`, `agent.ts`,
`database.ts`, `system-alerts.ts`. DB: `schema.ts`, `migrations.ts`,
`migrations/0127_sync_switchover_rewind.sql`. Helper: `replication.ts`, `server.ts`, `systemd.ts`,
`units.ts`. Agent: `database-durability.ts`, `helper-client.ts`, `main.ts`. Surfaces:
three control-plane routes, `apps/cli/src/commands/db-durability.ts`, `db.ts`, `api.ts`,
`databases.ts`. Tests as listed above. No VERSION bump.

Final head SHA: reported in the hand-back message (this file is its own commit).
