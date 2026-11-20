# Lane C hand-back — W10 PITR/rewind and backups from replicas

Branch: `ha/w3-c-pitr-rewind`, base `main` at `0b187500`.
Code commit: `c2703040` (`feat(ha): W10 PITR with replicas, pg_rewind re-attach and restore drill`).
This hand-off file is a docs-only commit on top; the final lane SHA is the tip after it.

## 1. What was built

- **Replica PITR (behind `PITR_REWIND`, default off).** A replica of a PITR database runs the
  `yoal-postgres-pitr` image, mounts its own pgBackRest config directory and uses the **same
  stanza**. WAL received on the standby is archived by the primary; once promoted, the same
  container archives its own WAL, so the stanza follows the primary across a promotion.
- **Backups from a replica.** The control plane routes a `basebackup` task to a streaming/lagging
  replica on an online node (`workloadId` on the desired task) and the agent runs `pgbackrest
  backup` in that container. The stanza, repository and retention are unchanged.
- **`pg_rewind` re-attachment.** After a promotion, the old primary's node gets a replica that
  adopts its diverged data directory instead of a full `pg_basebackup`:
  - new helper verb `POST /v1/workloads/<replica id>/replica/rewind` with
    `{ databaseId, slot, user, password }` (owner credentials from the node activation endpoint);
  - stops the old unit, refuses to delete/reuse a running container, checks data checksums or
    `wal_log_hints=on`, runs `pg_rewind -R` through the existing replica link socket, renames
    `<state>/<databaseId>` to `<state>/<replicaId>`;
  - any failure deletes the diverged directory and returns `fallback: 'rebuild'`; the replica then
    bootstraps normally;
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
  markers in the copy. The existing Litestream `scripts/yoal-restore-drill.sh` is untouched.
- Docs: `docs/PITR.md` (replica section, verbs, drill, live-check list), `docs/CLUSTERING.md` §9
  status and limits.

## 2. Verified

Commands run on this worktree:

| What | Command | Result |
|---|---|---|
| Types / lint, every package | `bun run check` | all `Exited with code 0`; control-plane `0 errors, 1 warning` (pre-existing `settings/registry` warning); `iam lint` clean |
| Full suite | `bun test` | **6461 pass, 74 skip, 0 fail** (6535 tests / 587 files) |
| HA unit suite | `bun test tests/ha` | 86 pass, 0 fail |
| Migrations | `bun run check:migrations` | `ok` |
| Golden desired state | `packages/core/src/desired-state/golden.test.ts` | **unchanged** |

Focused coverage added or extended:

- `packages/core/src/database-rewind.test.ts`: replica of a PITR DB uses the PITR image and same
  stanza; a base backup routes to the replica and only its node may fetch the activation; promotion
  keeps the stanza; the old primary gets a rewind replica (no purge, no workload until rewind);
  rewind success and build fallback release the replica; restore selection uses a window reported
  by the new primary; flag-off path keeps the old refusals and sends no `pgRewind`/checksums env.
- `apps/helper/src/pitr.test.ts`: Azure/GCS configs, GCS key file (0400, removed on kind change),
  pg_rewind argv (owner user, `-R`, link mount, no password in argv), checksums parsing,
  `wal_log_hints` fallback, successful rewind and rebuild fallback, replica+PITR unit rendering.
- `apps/agent/src/database-replication.test.ts`: rewind activation fetch, one-shot result, fallback
  and failure.
- `apps/agent/src/database-pitr.test.ts`: a task with `workloadId` configures and backs up in the
  replica container, reporting the same source database.
- `packages/core/src/databases-pitr-stores.test.ts`: non-S3 repositories fail closed while
  `PITR_REWIND` is off.

## 3. Not verified (needs the real fleet / lab)

- A real Podman + Quadlet run of the replica PITR unit, a backup from a replica, and `pg_rewind`
  through the agent link socket (SELinux/AppArmor labels included). The argv, files and fallback
  are unit-tested.
- Azure Blob / GCS with pgBackRest end to end (Azurite / fake-gcs-server first), including the GCS
  key file and `repo1-type=azure|gcs`.
- `scripts/pitr-rewind-drill.sh` against a live promotion; it was syntax-checked (`bash -n`) only.
- The **single-node gate** (`tests/ha/scenarios/single-node-gate.ts`). No lab was running in this
  lane; `bun tests/lab/lab.ts status` showed every node missing, and starting the four-node lab was
  out of scope. Flag-off desired state and the golden fixtures were verified by tests.
- 100 switchovers under load, the 24 h soak, amd64, and W11 member-driven healing.

## 4. Deviations and integration notes

- **Migration number.** A migration was needed for the rewind columns, but the checked-in stream
  must be sequential (`scripts/check-migrations.ts`), so this branch has
  `packages/db/migrations/0127_replica_rewind.sql`, not the reserved `0129`. Renumber to **0129**
  when lanes A/B bring 0127/0128. The SQL is additive (`ALTER TABLE database_replicas ADD COLUMN`).
- **Capability.** The brief names `db-member`; that capability does not exist on this branch's
  agents yet. A new `pitr-rewind` capability (`nodeCapabilities`) gates the W10 shape and the
  rewind verb. It can be aliased to `db-member` when lane B advertises that.
- **Rewind credentials.** `pg_rewind --source-server` needs a role allowed to execute PostgreSQL's
  catalog file functions. Rather than grant those to `yoal_repl` (and add a normal-connection
  `pg_hba` rule), the rewind activation returns the **database owner** (a superuser) and its
  password; the role exists on the new primary because its data is a physical copy. This avoids a
  replication-task version bump and keeps the flag-off desired state byte-identical.
- **Re-attachment hook.** `DatabaseReplicaService.repoint()` now calls `reattachOldPrimary()`. This
  is the one shared seam with lane B: keep the call when rewriting the promotion path. The lane B
  contract is:
  - desired state `databaseReplicaRewinds` (optional; omitted while empty to preserve the golden);
  - `rewindsForNode(nodeId)`, `rewindActivation(nodeId, replicaId)`, `applyRewindResults(...)`;
  - heartbeat `databaseReplicaRewindResults`;
  - agent runner `DatabaseReplicationRunner` (helper `rewindReplica`).
- **Same-node replica after promotion.** If a same-node read replica existed on the old primary's
  node, that row is rebuilt by the existing path; no rewind row is added for the same
  `(database, node)` pair. The common cross-node case gets the rewind.
- **Non-S3 PITR gate.** `pitrStoreProblem()` now refuses Azure/GCS while `PITR_REWIND` is off; the
  lane E store test was updated to enable `PITR_REWIND` and gains a flag-off case. No
  `YOAL_PITR_REPO_*` Azure/GCS environment selection was added (programmatic
  `DatabasePitrRepository` only), as lane E did.
- **`PITR_REWIND` off** keeps the old replica-of-PITR and PITR-with-replicas refusals, sends no
  `pgRewind`, no `POSTGRES_INITDB_ARGS`, no replica routing and no rewind task. The golden
  fixtures and the single-node desired state are unchanged.
- Files shared with lane B (expect merge review): `packages/core/src/database-replica-service.ts`,
  `packages/core/src/databases.ts`, `packages/core/src/desired-state/databases.ts`,
  `packages/core/src/nodes.ts`, `packages/contracts/src/agent.ts`,
  `packages/contracts/src/database-replication.ts`.
- No `VERSION` bump; no spec file changed.

## 5. Final commits

- Code: `c2703040`
- Hand-off commit (this file): the tip of `ha/w3-c-pitr-rewind` after `c2703040`.
