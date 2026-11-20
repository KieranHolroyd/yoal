# Spike S2 (local half) — Litestream follow lag

Written before any rig code (CLUSTERING §15.1 rule 1). Results go to `docs/SPIKES.md` (section
`S2 — Litestream follow lag (2026-11-20)`).

## Question

From CLUSTERING §15.2 (S2), §6.2 and HA-PLAN §4 W2:

> Can the standby follow the Litestream replica continuously rather than re-restoring on each poll,
> and at what lag? C6's ≤ 1 s control-plane RPO and its promotion path rest on this, and SQLite has
> no other continuous copy.

## Pass criteria (CLUSTERING §15.2, quoted, not loosened)

> p95 replay lag ≤ 1 s and p99 ≤ 5 s over 24 h; a promotion from the follower gives an identical
> fingerprint and `PRAGMA integrity_check` ok; recovery after a 60 s cut in ≤ 30 s; a restart keeps
> the replay position.

How each is measured here:

| # | Criterion | Measured as | Pass |
|---|---|---|---|
| C1 | Replay lag | Time from commit on the primary to the row being visible to a read-only reader of the follower's file, from a timestamped heartbeat row written in every transaction (50 tx/s). Reported for the steady run and for the whole run including faults | p95 ≤ 1 s and p99 ≤ 5 s |
| C2 | Promotion | Quiesce the primary, wait for the follower to reach the primary's last heartbeat, stop the follower, open its file read-write: `PRAGMA integrity_check` = `ok` and `scripts/yoal-db-fingerprint.ts` byte-identical to the primary's | Identical and `ok` |
| C3 | 60 s cut | Disconnect the follower (and, separately, the primary) from the object store for 60 s; time from reconnect until the follower's lag is back under 1 s | ≤ 30 s |
| C4 | Restart | Kill and restart the follower; it must resume from its saved position (no full re-restore) and reach lag < 1 s | Resumes from position |

Also run (method in §15.2): `kill -9` of the primary during a write, then promotion from the
follower. Expected RPO there is the unsynced tail; the follower must still pass integrity and match
a fresh `litestream restore` of the replica byte-for-byte.

**Duration.** The plan asks for 24 h. This session runs as long as is reasonable (at least 1 h); the
24 h run is still owed and is listed as such in the results.

## Agreed fallback (CLUSTERING §15.2 / §15.4, HA-PLAN §4 W2)

> `litestream restore` into a staging file every 60 s and an atomic swap: the control-plane RPO
> becomes the interval, and promotion waits for the last swap to finish.

§15.4: control-plane RPO becomes the interval (30–60 s), promotion waits for the last swap, C6 grows
5 days, §6.1's standby table changes. If reached, the rig also measures restore time for the
control-plane-sized database and swap time.

## Deviations known up front

- **Object store:** local MinIO in an OrbStack container, not R2 (no credentials; the R2 half runs
  later). The target is a config (`S2_S3_*` env), so the same rig points at R2.
- **MinIO image:** the locally cached `quay.io/minio/minio` pinned by digest
  (`sha256:14cea493…`, `RELEASE.2025-09-07T16-13-09Z`) instead of building from source as
  `spikes/s3-cas/stores/minio.Dockerfile` does; upstream no longer publishes images and the build
  costs disk this Mac is short of.
- **Database:** generated with the real `packages/db` migrations, not a copy of a live `yoal.db`
  (the brief forbids production files).
- **Duration:** ≥ 1 h, not 24 h (above).
