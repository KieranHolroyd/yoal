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

## Running it

```sh
bun spikes/s2-litestream-follow/run.ts          # every scenario, about 2 h 15 min
S2_SCENARIOS=tuned S2_TUNED_MIN=5 bun spikes/s2-litestream-follow/run.ts
```

Needs Docker (OrbStack) and Bun on the host. It builds `yoal-w0-s2-node:1` (Debian 13, Bun 1.4.4,
Litestream 0.3.13 and 0.5.18 checked against pinned sha256), starts `yoal-w0-s2-*` containers on
their own network, seeds the database from `packages/db` (`seed.ts`), runs the scenarios and
removes the containers, volumes and network. Output (logs, lag CSVs, `summary.json`) goes to
`out/<stamp>/`, which is gitignored. Point it at R2 with `S2_S3_ENDPOINT`, `S2_S3_ACCESS_KEY`,
`S2_S3_SECRET_KEY` and `S2_S3_BUCKET`; the store freeze and request counts are MinIO-only.

| Scenario | What it does |
|---|---|
| `unit` | Unit config (`scripts/litestream.yml`, sync 1 s), followers at 1 s and 250 ms, `S2_SOAK_MIN` steady, then follower cut, primary cut, store freeze, follower `kill -9`, follower container restart, promotion, the promoted node replicating to the same path |
| `tuned` | Sync and monitor 250 ms, follow 250 ms, steady, then `kill -9` of the primary |
| `fallback` | 0.3.13 primary; restore-to-staging and swap every 60 s; 0.5.18 restore and follow of a v3 replica |
| `walstall` | A reader opened before the first follow apply (WAL header) blocks follow |
| `gap` | Follower down 7 min, past L0 retention |
| `cuts` | Second 60 s cut samples, and a follower cut with the no-progress watchdog prototype |
| `idle` | Store requests per second by phase (follower 1 s and 250 ms, writing and idle) |

Results: `docs/SPIKES.md`, section "S2 — Litestream follow lag (2026-11-20)".

## Deviations found while running

- **Litestream version.** The pin (0.3.13) cannot follow, so the follow measurements use 0.5.18
  (follow exists since 0.5.9); 0.3.13 is measured only through the fallback.
- **Follower command.** Yoal has no follower command, so it uses upstream's
  `restore -f -follow-interval <i> -o /data/yoal.db /data/yoal.db` with the unit's config file.
- **Tuned configuration.** Beyond the unit's own config, a `tuned` run shortens `sync-interval`
  and `monitor-interval` to 250 ms, because the unit config cannot meet p95 ≤ 1 s. The criteria
  are unchanged.
- **Probe.** It waits for the follower file's rollback-mode header before opening, after the
  first smoke run showed that an earlier reader stalls follow (`walstall` reproduces it).
- **Watchdog.** The `cuts` scenario runs a no-progress watchdog inside the rig (spike rule 5:
  prototype in the rig, not in production code).
- **Extra scenarios.** `gap`, `cuts` and `idle` were added after the main run to explain a failed
  cut and the request rates.
- **Faults.** Cuts are `docker network disconnect`, not `tc`. `kill -9` of the primary kills the
  whole container; the page cache survives, so this is not a power loss.

## R2 mode

```sh
(set -a; . <creds.env with R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY>; set +a;
 S2_TARGET=r2 S2_SCENARIOS=unit,tuned,idle S2_SOAK_MIN=12 S2_TUNED_MIN=12 bun spikes/s2-litestream-follow/run.ts)
```

- Every object goes under `yoal-w0-spikes/s2-<S2_RUN_ID>/<scenario>/`. The rig refuses to list or
  delete outside that prefix, deletes all of it at the end and lists it again to prove it is empty.
- Litestream reaches R2 through `proxy.ts`. Containers resolve the R2 host to the proxy
  (`--add-host`) and talk plain HTTP to it; the proxy forwards each signed request unchanged over
  HTTPS and counts operations by type, status and latency. SigV4 covers the Host header, not the
  scheme, so signatures stay valid.
- Credentials reach containers only through a 0600 env file in the run's output directory, which is
  deleted at the end. Logs, errors and `summary.json` are scrubbed of the key, secret, bucket and
  account host.
- `S2_BUDGET_USD` (default 0.8) stops the run when the counted operations at R2 list prices pass it.
- In R2 mode `unit` runs one follower (1 s) and only the follower cut and follower `kill -9`.

Deviations specific to R2:
- The replica `path` is moved under the run prefix; nothing else in the unit config changes.
- The proxy adds a local hop and buffers request bodies.
- The run was from this Mac, not from the production region.
- The watchdog was not run on R2, because the budget allowed one cut.
