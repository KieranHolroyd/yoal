# W10 lane B hand-off — sync set, switchover, rewind

Branch `ha/w3-b-sync-switchover`, base `main` (`0b187500`). Implementation `56bdafdb`; this
revision fixes the independent review in `REVIEW-FINDINGS.md`. No merge to `main`; no VERSION bump;
`W9-SPEC` unchanged.

## Review response

### Blockers

| # | Fixed | Evidence |
| --- | --- | --- |
| 1 | The barrier now closes only on the **target** slot's fresh `pg_stat_replication.replay_lsn`; the `?? result.lsn` fallback is gone and a null replay is a failed result. | `database-member-service.ts` `applySyncResults`, `database-durability.ts` `#sync`; tests “the barrier closes only on the TARGET replay” and “a target slot that has not reported its replay is a failed result”. |
| 2 | `sync/configure` verifies `current_setting('synchronous_standby_names')` (and `synchronous_commit`) in a bounded loop after `pg_reload_conf()`, and the node refuses to report success unless the target row is `sync_state = 'sync'`. | `renderSyncConfigureSql`, agent `#sync`; helper and agent tests. |
| 3 | A failed switch never CASes a steady member. It re-arms the same `changing` transition at the previous member; the new `set-sync`/barrier proves the setting before the close. If the setting/barrier cannot be proven, `on_sync_loss` applies. | `#switchFailed`; tests “a failed change re-arms the previous member…” and the sync engine fallback tests. |
| 4 | `writes/stop` verifies read-only took effect and waits for no non-idle client backend (20 s bound). The switchover has an explicit `quiesce` step and samples the LSN only after it. | `renderStopWritesSql`, `runSwitchover`, agent drain; “stop and resume writes…” and “a quiesce failure refuses before promotion”. |
| 5 | `promoted` is latched immediately after `pg_ctl promote`; no later failure resumes the old primary. A post-promotion failure returns `promoted: true` and tells the operator to re-point/repair. | `database-switchover.ts`; “a re-point failure after promotion…” and “a promoted LSN behind the primary…”. |
| 6 | Promotion failure sets `switchoverStep = 'resume'` and alerts; a failed resume keeps the resume task and alerts instead of clearing it. | `onPromotionFailed`, `applySwitchoverResults`; “a failed resume keeps the resume task and alerts”. |
| 7 | The rewind route path is the **rework replica workload id** (`db_dbr_…`) and the body carries `databaseId`; both helper assertions now pass. A 200 route test exists. | `server.ts` rewind route, agent `#rewinds`; helper test “the rewind route accepts… (200)”. |
| 8 | Every lease CAS goes through `renewedLease()`, which sets `expiresAt = max(now, previous) + DB_TTL` (15 s). | `database-sync.ts`, all service CAS sites; “every CAS renewal extends…”. |
| 9 | Promotion takes the lease at the new generation (holder = new node, `sync: []`, `changing` for a sync database), clears the inherited setting through a `clear-sync` task, and re-arms through the Revision 1 transition. | `onPromotion`, `syncTasksForNode`, tick arming; “a promotion takes the lease at the new generation…”. |

### Majors / minors

| # | Fixed | Notes |
| --- | --- | --- |
| 10 | Sync and switchover results echo a `version`; a mismatch is ignored. | Old agents that omit it remain accepted. |
| 11 | The member tick runs on a 5 s primary-only loop in `hooks.server.ts` (with an overlap guard); maintenance stays a backstop. | The control plane is the primary today; lane A moves the machine to the node. |
| 12 | The sync-loss watchdog is evaluated on the **primary's node** from its own fresh slot sample and reports `on_sync_loss` at the lease ETag it acted on. | `downgrade` clears the setting locally; `block` leaves it named. Lease CAS still happens in the control plane (lane A owns node arbiter access); the ETag is the ownership token. |
| 13 | Lease writes are holder-gated; `parseLease` accepts spec-shaped leases without `durabilityEffective` and strict-validates every sync entry. | Node results carry the lease ETag and are ignored when it moved. |
| 14 | Role discovery no longer synthesises a primary or epoch 0: no report → `null`; the report carries the member's generation/epoch, the lease generation and the control epoch, plus `readOnly`/`fenced`. | Members route shows `unknown` until a report arrives. |
| 15 | `promote` refuses while `syncState = 'changing'` and refuses a non-member of a sync set without `acceptDataLoss`; `applyPromotionResults` refuses to re-point a changing database. | Route `If-Match` still applies. |
| 16 | Fixed `POST /v1/workloads/:id/checkpoint`; the drain calls it before stop-writes. | Helper + agent tests. |
| 17 | `yoal db switchover` has its own dispatcher (`switchoverCommand`) instead of being fed to the durability verb parser. | CLI test. |
| 18 | Fallback requires the previous member's replay ≥ the failed barrier and applies the setting/barrier before the CAS; a failed revert is `on_sync_loss`, never swallowed. | Engine + service tests. |
| 19 | `sync_attempt` increments on every open/re-arm and is part of the task version hash, so re-opening the same target is a new instruction. | Migration 0127. |
| 20 | The switchover route requires `If-Match: <primaryGeneration>`; the CLI sends it. | Service throws 412; test. |
| 21 | Replica units pass `-c default_transaction_read_only=off`, and the rewind path starts as a standby with it reset. | Unit + helper tests. |
| 22 | Dead `addRebuiltReplica` deleted; rebuild uses the existing rewind replica row + `activateRewindReplica`. | |
| 23 | `status().transition` reports the stored phase and barrier LSN (`sync_phase`, `sync_barrier_lsn`) instead of a fabricated `switching`/null. | Migration 0127. |
| 24 | `parseLease` rejects malformed/repeated sync entries; it no longer truncates silently. | Test. |
| 25 | The 100-switchover harness can now lose an in-flight commit: `stopWrites` leaves one transaction in flight, `quiesceWrites` commits it, and the test asserts `acked <= promoted`. A negative-control run that skips quiescence proves the harness detects the loss. Durations are explicitly the simulated clock. | `database-switchover.test.ts`. |

## What is implemented

- **Durability per database** (`async`/`sync`, `sync_timeout_seconds`, `on_sync_loss`) through
  `DatabaseMemberService` and `yoal db durability`. `sync` still requires two cross-node replicas in
  different zones unless `on_sync_loss: block`.
- **H23 Revision 1**: lease `open` (`sync: []`, `changing`) → set the target + verified barrier →
  close (`sync: [target]`, `steady`). A timeout re-arms the previous member (fresh setting and
  barrier) or applies `on_sync_loss`. A lost standby starts the same transition.
- **Planned switchover**: checkpoint → stop writes → quiesce → final LSN → target replay equality →
  promote → re-point. A gap or a failed quiesce refuses and resumes; a post-promotion failure never
  resumes the old primary.
- **Rewind**: the old primary's data dir is moved into a slotless replica on its node and
  `pg_rewind` runs in a one-shot container; a failed rewind removes the copy and the replica's
  standby script rebuilds.
- **Role discovery + alerts**: member reports (role, generation, epoch, recovery, LSN, read-only,
  fenced), `database_member_status`, `GET /databases/:name/members`, and `database_replica` alerts
  for down/lag/lost slot, refused switchover, sync fallback/downgrade/block and failed resume.
- **Migration 0127** (additive) adds the display cache, switchover/rewind fields, member status and
  the `sync_attempt`/`sync_phase`/`sync_barrier_lsn`/lease-token columns. It is still numbered
  **0127**, not 0128: the checker rejects a gap. Renumber at merge if lane A's 0127 lands first.

## Verified

- `bun run check` — all packages, 0 errors (one pre-existing Svelte warning in
  `settings/registry/+page.svelte`). `iam lint: no new role/kind checks`.
- `bun test` — 6,500 pass, 74 skip, 0 fail across 590 files. (One first run had a single unrelated
  flake; two clean re-runs.)
- `YOAL_MIGRATION_BASE_REF=origin/main bun scripts/check-migrations.ts` — ok, 127 migrations, no
  unreviewed destructive statement. Running it against `HEAD` reports “0127 modified” because 0127
  is committed on this branch and not on `main`; the PR-base comparison is the meaningful one.
- Focused: 84 tests across `database-sync.test.ts`, `database-switchover.test.ts`,
  `database-member-service.test.ts`, `database-replica-service.test.ts`,
  `apps/helper/src/replication.test.ts`, `apps/agent/src/database-durability.test.ts`; plus the CLI
  dispatcher test. The switchover suite includes the 100-run in-flight-loss harness and its negative
  control.
- Flag-off golden desired state: 1 pass, byte-identical; the W10 keys are absent, not empty.

## Not verified / deliberately left

- **No live fleet**: the switchover proof is a deterministic model with a simulated clock. It can
  lose a commit if quiescence is skipped, and the harness catches that; it is not 100 real Postgres
  instances under load. End-to-end ≤ 5 s and a real `pg_rewind` need the lab/fleet.
- **Node-hosted lease writes**: the watchdog decision and setting change run on the primary's node,
  but the lease CAS still runs in the control plane at the ETag the node reported. A fully
  node-owned lease needs lane A's arbiter client; until then a control-plane outage can delay the
  lease record (the setting is already safe).
- **Consumer routing**: members are discoverable and probed, but `ServiceForwarder` still routes by
  planned upstream; polling-based primary selection is not wired.
- **Replica-based moves**: the switchover API exists, but the move flow still uses stop/dump/restore.
- **Replica metrics**: `db_replica_metrics_1m` / Prometheus replica series are not added.
- `accept_data_loss`, automatic database failover (W11) and PITR/backup from replicas (lane C) are
  untouched.

## W9-SPEC change needed (not made)

Revision 1 §5.5 says the lease is written first and the setting follows. The node-hosted watchdog
necessarily clears `synchronous_standby_names` **before** the control plane can CAS the lease, to
keep I11 (the data plane keeps working while the control plane is unreachable); it gates the action
on the lease ETag and the control plane then records the same outcome. The spec should state that
node-hosted `on_sync_loss` may apply the setting at the last observed lease ETag, with the lease CAS
following. No other spec change was needed; the fallback is stricter than §5.5 (a fresh barrier and
target replay proof), which is consistent with I13.

## Files

Core: `database-sync.ts`, `database-switchover.ts`, `database-member-service.ts`,
`database-replica-service.ts`, `nodes.ts`. Contracts: `database-member.ts`. DB: `schema.ts`,
`migrations/0127_sync_switchover_rewind.sql`, generated `migrations.ts`. Helper: `replication.ts`,
`server.ts`, `systemd.ts`. Agent: `database-durability.ts`, `helper-client.ts`. Surfaces:
control-plane `hooks.server.ts`, the three database routes, CLI `db-durability.ts`, `db.ts`,
`api.ts`, `databases.ts`. Tests: the six focused files above plus the CLI dispatcher test.

Final head SHA: reported in the hand-back message (this file is its own commit).
