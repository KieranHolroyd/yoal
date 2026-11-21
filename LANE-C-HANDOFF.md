# Lane C hand-back — W10 PITR/rewind and backups from replicas

Branch: `ha/w3-c-pitr-rewind`, base `main` at `0b187500`.
Feature commit: `c2703040` (`feat(ha): W10 PITR with replicas, pg_rewind re-attach and restore drill`).
Review-fix commits: `510a27f4` (first round) and `48b55b71` (verification review: readiness, primary-only
backups and the remaining NITs). This hand-off file is a docs-only commit on top; the final lane SHA
is the tip after it.

## 1. What was built

- **Replica PITR (behind `PITR_REWIND`, default off).** A replica of a PITR database runs the
  `yoal-postgres-pitr` image, mounts its own pgBackRest config directory and uses the **same
  stanza**. WAL received on the standby is archived by the primary; once promoted, the same
  container archives its own WAL, so the stanza follows the primary across a promotion.
- **Base backups stay on the primary.** pgBackRest's `backup-standby` needs both a primary and a
  standby host configured (`pg1-*` plus a `pg2-*` standby and `backup-standby=y`); this single-host
  layout only has the container pgBackRest runs in. Routing a backup to a replica is therefore
  deferred until that two-host config exists. The fixed verbs still carry the **database's** stanza
  (`configure` and `basebackup` take `stanza`) and the helper refuses a stanza its config was not
  written for; it is never re-derived from a container workload id.
- **Readiness.** PITR tasks wait for the workload that exists on the node. The agent runtime's
  `readyWorkloadIds()` reports a workload ready when the desired and applied activation versions
  match and the last report is `running`; it does not need the stats sampler's held monitor, which
  a read replica never has.
- **`pg_rewind` re-attachment.** After a promotion, the old primary's node gets a replica that
  adopts its diverged data directory instead of a full `pg_basebackup`:
  - new helper verb `POST /v1/workloads/<replica id>/replica/rewind` with
    `{ databaseId, user, password, walLogHints }` (owner credentials from the node activation
    endpoint; `walLogHints` says the control plane rendered `-c wal_log_hints=on`);
  - stops the old unit, refuses to delete/reuse a running container, checks data checksums or hint
    logging, runs `pg_rewind -R` through the existing replica link socket, renames
    `<state>/<databaseId>` to `<state>/<replicaId>` and writes a `yoal-rewind.json` marker there;
  - only a marker for the same database and replica makes a re-run report success (a fallback's
    fresh `PG_VERSION`, or another replica's marker, does not);
  - transport failures (connection/TLS/socket) are retried: three attempts in total (the first run
    plus two retries). Any other failure deletes the diverged directory and returns
    `fallback: 'rebuild'`, after which the replica bootstraps normally;
  - a failed rewind result marks the row removing with `rebuildOnPurge` and drops its slot, so the
    old directory is purged and a fresh replica is rebuilt automatically (no permanently pending
    row), which also lets the failover record `oldPurgedAt`;
  - the replica is held out of desired state until the result arrives, so `pg_basebackup` never
    races the adoption; the rewind task is itself withheld until the new primary applied its
    replication task (slot + `pg_hba`).
- **Data checksums.** With the flag on, new Postgres databases get
  `POSTGRES_INITDB_ARGS=--data-checksums`; existing clusters render `wal_log_hints=on`.
- **Object-store repositories.** pgBackRest's own Azure/GCS clients (`repo1-type=azure|gcs`), using
  the existing `ObjectStoreTarget`/credentials and the lane E capability gate
  (`object-store-kinds`), plus a 0400 GCS service-account key file. A non-S3 PITR repository also
  needs `PITR_REWIND`; with it off PITR stays S3-only as it shipped.
- **Drill.** `scripts/pitr-rewind-drill.sh` writes a pre-promotion marker, optionally promotes a
  replica, writes a post-promotion marker, restores to a time after it, and requires **both**
  markers in the copy. The archive wait and `pg_switch_wal()` run in both the marker and explicit
  `YOAL_REWIND_DRILL_TARGET_TIME` paths; the PASS line only reports a promotion when
  `YOAL_REWIND_DRILL_PROMOTE=1`. The existing Litestream `scripts/yoal-restore-drill.sh` is
  untouched.
- Docs: `docs/PITR.md` (replica section, verbs, drill, deferred standby backups, live-check list),
  `docs/CLUSTERING.md` §9 status and limits.

## 2. First review findings fixed

1. `databasesOf()` gates a `basebackup`/`status` task on `task.workloadId` (falling back to
   `databaseId`), so a task that names another workload waits for the workload that exists on that
   node; restore still waits for `[databaseId, targetDatabaseId]`. The runtime source of that ready
   set is covered in §3.
2. The stanza is carried on `pitrConfigure(workloadId, repo, stanza)` and
   `pitrBaseBackup(workloadId, type, stanza)`, validated by the agent against
   `pitrStanzaFor(task.databaseId)` and by the helper against its rendered config, and used for
   `[stanza]` and `--stanza` (tests assert the exact stanza).
3. The rewind task carries `walLogHints: true` when the control plane rendered `pgRewind` (a runtime
   `-c wal_log_hints=on` is invisible in config files); the helper still treats a `pg_rewind`
   failure as the backstop.
4. `pitrRewindForNode()` accepts `db-member` as equivalent to `pitr-rewind` for a mixed fleet.
5. The migration's SQL body comment no longer names a migration number (filename/re-numbering stays
   the integrator's call).
6. A failed rewind marks the row `removingAt` + `rebuildOnPurge`, drops its slot, and keeps
   `rewindError`; the old directory becomes purgeable.
7. The old-primary purge confirmation (`oldPurgedAt`) consequently arrives for a failed rewind too.
8. Non-zero `pg_rewind` exits are classified: transport failures retry (bounded) before a rebuild;
   unsupported/structural failures rebuild at once.
9. Rewind success is recorded by the `yoal-rewind.json` marker written by the rewind itself, read
   on re-entry; `PG_VERSION` alone is no longer treated as a successful adoption.
10. The drill uses `if [ "$PROMOTE" = 1 ]` for the promotion suffix and runs the archive
    wait/`pg_switch_wal()` in both marker and explicit-target paths.
11. Cleanups: the unused slot assertion is gone, `containerRunning` uses `pitrContainerName`, and
    `pitrTasksForNode` narrows in SQL to the node's primary databases.
12. `docs/PITR.md` explains why `backup-standby` is not set (the two-host config is missing), and
    that replica backups are deferred rather than shipped broken.

## 3. Verification review fixes

1. **PITR readiness no longer depends on the stats sampler.** `WorkloadRuntime.readyWorkloadIds()`
   returns ids whose desired/applied activation versions match and whose report is `running`, with
   no monitor required; `main.ts` uses it for every PITR task. A test converges a `db_dbr_…` replica
   with no monitor and proves it is in the ready set while absent from `databaseTargets()`.
2. **Backups from a replica are deferred.** Removed the replica branch of `pitrWorkloadFor`, the
   replica scope in `pitrTasksForNode`, the permissive replica activation/ack paths and the now-dead
   `backupMember`. PITR tasks, activations and result acks are primary-only again. The stanza and
   rewind work stays. `docs/PITR.md`, the feature description and the hand-off say clearly that a
   two-host `pg1`/`pg2` `backup-standby` config is required first.
3. **NITs.** Retry wording is "three attempts (two retries)" in code, tests and docs. The dead
   `slot` is gone from the rewind task, activation, helper verb, agent client and server allowlist;
   the replica unit still gets `primary_slot_name` from its own desired-state profile.
   `pitrStatus` never falls back to `pitrStanzaFor(workloadId)` (an unconfigured status reports an
   empty stanza), and the rewind marker must carry the request's `databaseId` and `replicaId`.

## 4. Verified

Commands run on this worktree after the verification-review fixes:

| What | Command | Result |
|---|---|---|
| Types / lint, every package | `bun run check` | all `Exited with code 0`; control-plane `0 errors, 1 warning` (pre-existing `settings/registry` warning); `iam lint` clean |
| Full suite | `bun test` | **6474 pass, 74 skip, 0 fail** (6548 tests / 587 files) |
| HA unit suite | `bun test tests/ha` | 86 pass, 0 fail |
| Migrations | `YOAL_MIGRATION_BASE_REF=531d9b74 bun run check:migrations` | `ok`; the plain command passes once the fix commit exists |
| Golden desired state | `packages/core/src/desired-state/golden.test.ts` | **unchanged**, 1 pass |
| Drill syntax | `bash -n scripts/pitr-rewind-drill.sh` | ok |

Focused coverage added or extended:

- `packages/core/src/database-rewind.test.ts`: replica of a PITR DB uses the PITR image and same
  stanza; **base backups stay on the primary** and a replica node may not fetch the activation;
  promotion keeps the stanza; the old primary gets a rewind replica (no purge, no workload until
  rewind); the rewind task carries `walLogHints` and no slot; rewind success and build fallback
  release the replica; a **failed** rewind marks the row removing, purges the old dir and rebuilds a
  fresh replica; the `db-member` capability alias is accepted; restore selection uses a window
  reported by the new primary; flag-off path keeps the old refusals and sends no
  `pgRewind`/checksums env.
- `apps/agent/src/runtime.test.ts`: `readyWorkloadIds()` includes a `db_dbr_…` replica workload with
  no monitor, while `databaseTargets()` does not.
- `apps/helper/src/pitr.test.ts`: Azure/GCS configs, GCS key file (0400, removed on kind change),
  pg_rewind argv (owner user, `-R`, link mount, no password in argv), checksums parsing,
  `wal_log_hints` fallback, successful rewind and rebuild fallback, replica+PITR unit rendering;
  the exact requested stanza appears in the rendered `[stanza]` and every `--stanza=` argv for a
  backup inside another workload; a mismatched stanza is refused; the marker (matched by database
  and replica) drives idempotence; transport retry and the three-attempt/two-retry limit;
  `walLogHints` from the control plane; an unconfigured status reports no derived stanza.
- `apps/agent/src/database-pitr.test.ts`: a task that names another workload configures and backs up
  in that container with the database's stanza; readiness waits for that workload; a wrong stanza
  fails without touching the helper; restore/steps unchanged.
- `apps/agent/src/database-replication.test.ts`: rewind activation fetch, `walLogHints` forwarding,
  one-shot result, fallback and failure.
- `packages/core/src/databases-pitr-stores.test.ts`: non-S3 repositories fail closed while
  `PITR_REWIND` is off.

## 5. Not verified (needs the real fleet / lab)

- A real Podman + Quadlet run of the replica PITR unit and `pg_rewind` through the agent link socket
  (SELinux/AppArmor labels included). The argv, files, retry classification and fallback are
  unit-tested.
- Azure Blob / GCS with pgBackRest end to end (Azurite / fake-gcs-server first), including the GCS
  key file and `repo1-type=azure|gcs`.
- `scripts/pitr-rewind-drill.sh` against a live promotion; it was syntax-checked (`bash -n`) only.
- The **single-node gate** (`tests/ha/scenarios/single-node-gate.ts`). No lab was running in this
  lane; `bun tests/lab/lab.ts status` showed every node missing, and starting the four-node lab was
  out of scope. Flag-off desired state and the golden fixtures were verified by tests.
- 100 switchovers under load, the 24 h soak, amd64, and W11 member-driven healing.
- Backing up from a replica is not applicable yet (deferred until the two-host `pg1`/`pg2` config).

## 6. Deviations and integration notes

- **Migration number.** A migration was needed for the rewind columns, but the checked-in stream
  must be sequential (`scripts/check-migrations.ts`), so this branch has
  `packages/db/migrations/0127_replica_rewind.sql`, not the reserved number. Renumber it when lanes
  A/B bring their migrations. The SQL is additive (`ALTER TABLE database_replicas ADD COLUMN`) and
  its body comment names no number.
- **Capability.** A new `pitr-rewind` capability (`nodeCapabilities`) gates the W10 shape and the
  rewind verb. `db-member` (lane B) is accepted as an equivalent on a mixed fleet, so the two names
  can coexist during rollout; keep one `rewind*` column/desired-field set at merge.
- **Backups from a replica are deferred**, not half-shipped. The `workloadId` field stays on the
  task contract for that future path (and for older/newer mixed states), but the control plane
  always names the primary, and activation/acking are primary-only.
- **Rewind credentials.** `pg_rewind --source-server` needs a role allowed to execute PostgreSQL's
  catalog file functions. Rather than grant those to `yoal_repl` (and add a normal-connection
  `pg_hba` rule), the rewind activation returns the **database owner** (a superuser) and its
  password; the role exists on the new primary because its data is a physical copy. This avoids a
  replication-task version bump and keeps the flag-off desired state byte-identical.
- **Re-attachment hook.** `DatabaseReplicaService.repoint()` calls `reattachOldPrimary()`. This is
  the one shared seam with lane B: keep the call when rewriting the promotion path. The lane B
  contract is:
  - desired state `databaseReplicaRewinds` (optional; omitted while empty to preserve the golden);
  - `rewindsForNode(nodeId)`, `rewindActivation(nodeId, replicaId)`, `applyRewindResults(...)`;
  - heartbeat `databaseReplicaRewindResults`;
  - agent runner `DatabaseReplicationRunner` (helper `rewindReplica`).
- **Same-node replica after promotion.** If a same-node read replica existed on the old primary's
  node, that row is rebuilt by the existing path; no rewind row is added for the same
  `(database, node)` pair. The common cross-node case gets the rewind.
- **Non-S3 PITR gate.** `pitrStoreProblem()` refuses Azure/GCS while `PITR_REWIND` is off; the lane E
  store test was updated to enable `PITR_REWIND` and gains a flag-off case. No `YOAL_PITR_REPO_*`
  Azure/GCS environment selection was added (programmatic `DatabasePitrRepository` only), as lane E
  did.
- **`PITR_REWIND` off** keeps the old replica-of-PITR and PITR-with-replicas refusals, sends no
  `pgRewind`, no `POSTGRES_INITDB_ARGS`, no replica routing and no rewind task. The golden fixtures
  and the single-node desired state are unchanged.
- Files shared with lane B (expect merge review): `packages/core/src/database-replica-service.ts`,
  `packages/core/src/databases.ts`, `packages/core/src/desired-state/databases.ts`,
  `packages/core/src/nodes.ts`, `packages/contracts/src/agent.ts`,
  `packages/contracts/src/database-replication.ts`.
- No `VERSION` bump; no spec file changed.

## 7. Final commits

- Feature: `c2703040`
- Review fixes (round 1): `510a27f4`
- Review fixes (round 2): `48b55b71`
- Hand-off commit (this file): the tip of `ha/w3-c-pitr-rewind` after `48b55b71`.
