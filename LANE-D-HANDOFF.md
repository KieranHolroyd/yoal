# Lane D hand-off — W12 platform dependencies

Plan: [HA-WAVE-3.md](./docs/build-plan/HA-WAVE-3.md), [HA-PLAN.md](./docs/HA-PLAN.md) W12/H28 and
§2.2 G20, [CLUSTERING.md](./docs/CLUSTERING.md) §3.8/§10.3. Branch `ha/w3-d-platform-deps`, base
`main` at `0b187500`.

Implementation commit **`4b58cc17`**. This hand-off is committed on top; the final tip is reported
in the hand-back message. No merge to `main`, no cloud spend, no `VERSION` bump, no new flag.

## What shipped

- **Registry storage on the platform object store.** `registry.s3` has a third mode, `platform`.
  zot writes blobs under `/zot` in the bucket named by `YOAL_OBJECT_STORE`'s S3 configuration
  (`R2_BUCKET` for `r2`) using the platform credential at activation, so no key is copied into the
  settings row. The registry node can then move without copying data: the managed-storage
  same-node refusal no longer applies. Azure/GCS platform stores are refused with the fix (zot
  needs S3). Settings → Registry offers the mode; `RegistryS3View.mode` includes it.
- **Bounded disk telemetry spool on agents.** `TelemetrySpool` persists completed access-log
  buckets as atomic segment files under `<YOAL_DATA_DIR>/telemetry-spool`, replays oldest-first,
  acknowledges only after a 2xx, and is bounded by buckets and bytes
  (`YOAL_TELEMETRY_SPOOL_BUCKETS`, `YOAL_TELEMETRY_SPOOL_BYTES`). Past the bound the oldest minutes
  are dropped and recorded as per-host gaps, persisted across restarts. `/metrics` exposes
  `yoal_agent_telemetry_spool_queued|bytes|dropped_total`.
- **Visible gap band.** The telemetry batch carries an optional `spool` report (`queued`, `bytes`,
  `dropped`, `gaps`). The control plane keeps the gap ranges in one `settings` row
  (`telemetry.spool_gaps`, seven-day retention, no migration); `MetricsService` attaches the
  matching gaps to project/deployment/overview traffic views, and `TrafficChart` shades them as a
  warning band with a legend entry. A gap is never drawn as zero traffic.
- **HA profile and preflight refusal.** `cluster_config.ha.profile` defaults to `single`; `ha` and
  `ha-dr` are refused by `PATCH /cluster/config` and `PUT /api/v1/ha/profile` while a blocker
  remains. The blocker list is `GET /api/v1/ha/preflight` and the **Settings → High availability**
  panel: local platform store, registry blobs on disk/managed RustFS, and an offline identity/mail
  node are named with the exact fix.
- **Movable identity and mail.** Identity's `identity.node_id` has an operator path now
  (`PATCH /api/v1/ha/placement`, or the HA page's select; `null` clears the pin). Mail delegates to
  the existing `email.configure` node setting. Both re-render desired state; the operator steps
  (including identity's current non-replicated SQLite caveat) are in `docs/OPS.md` §3.9.
- **Pre-pull failover reserve.** The proven gap: a single-copy app only pre-pulled on nodes while
  `rolloutStatus === 'rolling'`, so a node that could take the app after a node loss had no image.
  `imagePrePullsForNode` now treats every eligible destination of a single-copy app as a reserve;
  spread sets keep the rollout-only reserve. Regression test added.
- **Docs.** OPS §3.9 (HA profile, registry storage, spool sizing, identity/mail moves), REGISTRY §6
  and G6, CLUSTERING §10.3, API rows for the three new routes.

## Verified

- `bun run check` — all packages pass (one pre-existing Svelte warning in
  `settings/registry/+page.svelte`).
- `bun test` — **6,464 pass, 74 skip, 0 fail** (6,538 tests, 588 files), including the golden
  single-node gate. (An earlier full run had one unrelated CLI auth flake in
  `apps/cli/src/commands/node-tasks.test.ts`; it passes in isolation and on the final full run.)
- `bun run check:migrations` — 126 migrations, no new migration; **0130 was not needed**. All new
  state is in the existing `settings` JSON row (`cluster_config.ha`, `telemetry.spool_gaps`,
  `identity.node_id`) and registry config.
- Focused:
  - `apps/agent/src/telemetry-spool.test.ts` — replay across restart, oldest-first ack,
    count/bytes bounds, per-host gap record and its survival across restart.
  - `apps/agent/src/telemetry.test.ts` — a failed flush survives on disk and a new client replays
    it; the bound drops the oldest minute and the next POST carries the gap; `spool` is on the wire.
  - `packages/core/src/registry.test.ts` — local (default), external, managed and platform modes;
    platform activation uses the live platform key and never stores it; node move allowed; local,
    Azure and GCS stores refused with the fix.
  - `packages/core/src/ha-preflight.test.ts` — default `single`, `ha` refused with local storage,
    accepted once external, permission split, identity setting + desired-state bump, mail move
    through `email.configure`, spool gap merge/host filter and the traffic view attaching only its
    own hosts' gaps.
  - `apps/control-plane/.../_lib/traffic-series.test.ts` — gap bands clip to the chart window.
  - `packages/core/src/release-phase.test.ts` — the failover reserve pre-pull.

## Not verified / needs the lab

- **Real object stores.** The platform mode was exercised against a configured fake descriptor, not
  a live R2/Azure/GCS bucket; zot itself was not started against the platform key. Needs the lab or
  a cloud run: push/pull one image with `YOAL_OBJECT_STORE=r2`, kill the registry node, move the
  node, pull the same digest.
- **Multi-node failover with the spool.** The agent tests use a scripted fetch failure; a real
  control-plane outage longer than the spool bound and the dashboard band were not observed in a
  four-node lab.
- **Identity/mail move with data.** The setting and desired-state move are tested; identity's
  SQLite copy/Litestream restore and mail's in-spool drain were not run. The honest limit is
  documented in OPS §3.9 (identity is a move with a short outage; per-pool replicas are deferred).
- **Mixed-version agents.** An older agent ignores `spool`; the preflight warns until every agent
  reports one. The full-fleet rollout was not run.
- **`ha-dr`.** Stored and validated, but no profile-specific DR rule is added in W12 (regions are
  W13).

## Deviations / notes for the integrator

1. **No migration 0130.** The reserved number stays unused. If a future lane needs a real
   `telemetry_spool_gaps` table, migrate the settings row then; the service isolates the shape.
2. **New cluster section `ha`.** Additive, default `{ profile: 'single' }`; it is not in desired
   state, so the single-node golden is unchanged. W14's `yoal ha init --profile` should write this
   row through `ClusterConfigService`, not a second setting.
3. **Registry `s3.mode: 'platform'`.** Additive union member. `managed`/`external`/disk behave
   exactly as before. The platform credential is resolved live at activation; the settings row
   stores only its public key id and blank secret. `activationVersion` includes a hash of the live
   secret so a rotation re-renders zot.
4. **Spool files are segment JSON, not SQLite.** They are atomic, bounded and replay-safe because
   ClickHouse's `(host, bucket)` replacement makes a duplicate harmless. A corrupt segment is
   skipped, not fatal.
5. **Gap state is a settings row, not ClickHouse.** It must work when ClickHouse is the thing that
   was down; the row is pruned to seven days/500 ranges.
6. **Identity placement mirrors `nodes.ts`** (pin, then edge, then online capable in id order) so
   the preflight does not claim a node desired state would not use.
7. **Pre-pull cap.** `imagePrePulls` remains capped at 200 per node; a very large fleet could
   truncate reserves. No new bound was invented.
