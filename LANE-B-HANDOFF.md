# Lane B handoff — W15 observability and SLOs

Worktree: `/Users/kieranholroyd/.t3/worktrees/private-cloud-deploys/t3-w4-b-observability`
Branch: `ha/w4-b-observability` (base `main`, no merge performed)
Specs: `docs/build-plan/HA-WAVE-4.md`, `docs/HA-PLAN.md` §4 W15, `docs/build-plan/W9-SPEC.md` (read only)
Implementation SHA: `git log -1 --format=%H -- packages/core/src/slo-service.ts` (this hand-off file may be committed on top; `git rev-parse HEAD` is the final branch SHA)

## 1. What shipped

| Surface | Where | Flag |
|---|---|---|
| SLO create/update/list/remove/evaluate | `SloService` (`packages/core/src/slo-service.ts`), contract `sloObjectInputSchema` | `SLO_OBJECTS` |
| Error budget + multi-window burn | `packages/core/src/slo-evaluation.ts` (pure arithmetic) + telemetry adapter | `SLO_OBJECTS` |
| SLO burn alerts | `SloService.sweep()` from the 60 s maintenance sweep, routed as system alert kind `ha` | `SLO_OBJECTS` |
| SLO REST | `GET/POST /api/v1/projects/:slug/slos`, `GET …/slos/evaluate`, `DELETE …/slos/:id`, `GET /api/v1/slos` (platform overview) | `SLO_OBJECTS` |
| SLO read view | `Settings → Observability → SLOs` (`/settings/slo`): budget, burn state, create/remove | `SLO_OBJECTS` |
| External prober runner | `scripts/external-prober.ts` (HTTP/S, TCP/database, DNS; one POST per interval) | `EXTERNAL_PROBER` |
| Prober sink + registration | `ExternalProberService`: token once, sha256 at rest, sequence de-dupe, install match, revoke, health expiry | `EXTERNAL_PROBER` |
| Prober REST | `GET/POST /api/v1/ha/probers`, `DELETE /api/v1/ha/probers/:id`, `POST /api/v1/ha/prober/report` (Bearer token; **404** while the flag is off) | `EXTERNAL_PROBER` |
| Prober UI + alert | HA page panel; `ha.prober_stale:<id>` after `max(3 × interval, 120 s)` without a report | `EXTERNAL_PROBER` |
| `ha.effective_below_target` | `SloService.targets/targetsInternal`; weakest live workload/database/storage level vs the project’s declared level | always readable |
| Declaration surface | `GET/PUT /api/v1/projects/:slug/ha-target`, HA-page table + form; stored in `settings[ha_target:<projectId>]` | none (additive) |
| Alert `ha.effective_below_target` | `SloService.sweep()` after a 5 min grace, routed as system alert kind `ha` | none |
| HA status | `GET /api/v1/ha/status` adds `haTargets`; MCP `get_ha_status` adds the same | none |
| Timeline | `GET /api/v1/ha/timeline`; HA-page panel merging `database_failovers` + `database_failover_drills`, newest first, with computed/measured TTF and drill lost commits | none |
| Replication metrics | `yoal_database_primary_generation`, `_durability_effective`, `_sync_state`, `_replica_{status,streaming,lag_seconds,lag_bytes,is_sync}` in the org `/metrics` databases section | none (safe with flags off) |
| Lease metrics | control: `yoal_control_lease_{holder,epoch,expires_timestamp_seconds}`; database: `yoal_database_lease_{holder,generation,epoch,observed_timestamp_seconds}`, `_generation`, `_member_epoch` in `/metrics/platform` | none |
| Steering metrics | `yoal_steering_{active,driver_info,findings,healthy,ingress_node_ready}` in `/metrics/platform` | none |
| Effective-level metrics | `yoal_ha_{declared_level,effective_level,effective_below_target,level_blockers,level}` in `/metrics/platform` | none |
| Docs | `docs/METRICS.md` W15 additions | — |

**Flag off:** `SLO_OBJECTS` off → `list` is empty, every write/evaluate refuses, no rows exist, the overview says `enabled:false`, and the sweep evaluates nothing. `EXTERNAL_PROBER` off → no registration, the report route returns 404, and the sweep is a no-op. Desired state and the golden file were not touched. No daemon, no secret in desired state.

## 2. Verified

| Command | Result |
|---|---|
| `bun run check` | all workspace packages exit 0; one pre-existing Svelte warning in `settings/registry/+page.svelte`. |
| `bun test` | **6793 pass, 74 skip, 0 fail** (6867 tests, 611 files, 205 s). |
| `bun test packages/core/src/slo-observability.test.ts` | 14 pass: flag-off gates, create/update/remove, error budget, multi-window burn, unsupported indicator note, database signal, burn sweep, effective target + 5 min grace, timeline order/TTF/lost commits, prober token/de-dupe/stale/revoke, metrics series. |
| `bun test packages/core/src/ha-wave4-foundation.test.ts` | pass; the foundation’s “not implemented” expectations were replaced with the real lane-B behaviour. |
| `bun test packages/contracts` | pass, including `ha-observability.test.ts`. |
| `bun test packages/core/src/desired-state/golden.test.ts` | pass; desired state byte-identical. |
| `bun run check:migrations` | ok; **no migration 0132 added** (see deviations). |
| `bun test apps/control-plane/src/lib/server/mcp*.test.ts` | 88 pass. |

## 3. Not verified, and why

- **Live external prober against a real control plane** — no live fleet, no public target and no TLS ingress were used, per the brief. The runner is a standalone Bun script; its HTTP/TCP/DNS probes and POST path were type-checked, not run against a deployed endpoint. Prove with `--once` against a test control plane before enabling the flag.
- **Real ClickHouse evaluation over 30 days** — unit tests use a fake telemetry store. The adapter uses the existing `TelemetryStore.query`/`queryDatabaseMetrics`; an install should evaluate one 24 h and one 30 d SLO and compare the budget with the traffic chart.
- **Real failover/drill rows** — the timeline is tested with seeded rows. A live drill will confirm the TTF computation (`promotionSucceededAt - startedAt`; a running row is null).
- **Database lease expiry metric** — `database_member_status` stores generation/epoch/observed_at, not the lease expiry; the arbiter is the authority and reading it per scrape would be async. Control-plane lease expiry is exported; database freshness is `observed_timestamp_seconds`. This is a deliberate limit, not a hidden value.
- **Dashboard visuals** — `svelte-check` passes; no browser run. The SLO page and HA panels need a human look at one real install.

## 4. Deviations

1. **No migration 0132.** `0130_drills_slo.sql` already provides `slo_objects` and `database_failover_drills`; the declared HA target and prober registrations are small JSON/settings rows (`ha_target:<projectId>`, `external_prober_registrations`). A table would be more queryable but is not needed for W15, and this keeps the flag-off schema byte-identical and the 0132 reservation free.
2. **Prober authentication is a Bearer registration token, not an HMAC signature.** The brief allows “node-authenticated or token endpoint”; storing only `sha256(token)` means the server cannot verify an HMAC made with the raw token. The token is single-purpose, shown once, revocable and matched to `proberId` and optional `installId`. A duplicate/older `sequence` is acknowledged with `accepted: 0` so a retry after a lost response is safe.
3. **SLO evaluation supports two indicators** (`http_availability`, `database_writable`), matching the contract’s examples. Any other string is stored but evaluates to a note (“has no evaluator”) rather than a fabricated healthy ratio. Add sources to `TelemetrySloSignalSource` as they become measurable.
4. **`http_availability` counts non-5xx as success** (4xx is a client error). This is documented in `packages/contracts/src/slo.ts`; change it before first use if the owner prefers “2xx/3xx only”.
5. **A project with no live resource has `effective: null` and never alerts**, even with a declared target. Alerting on “not placed” would page during project creation; the effective metric is absent until a resource exists.
6. **The effective-level declaration lives in `settings`, not a new project column.** It is additive and flag-independent; no W11 contract changed. The check and timeline are always readable because they describe existing placement/history, while SLO/prober writes are flag-gated.
7. **New system alert kind `ha`.** It covers `ha.effective_below_target`, `ha.slo_burn` and `ha.prober_stale`; existing installs see one extra System-alerts row, no new delivery by itself.
8. **Timeline durability for a failover is the database’s current effective durability**, not a historical snapshot; a drill records the durability it ran under. Lost commits are null for failovers because no measurement is stored, and 0/n for drills.
