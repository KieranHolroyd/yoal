# Lane A handoff — W11 automatic database failover (review fixes)

Worktree: `/Users/kieranholroyd/.t3/worktrees/private-cloud-deploys/t3-w4-a-auto-failover`
Branch: `ha/w4-a-auto-failover` (base `main`, no merge performed)
Spec: `docs/build-plan/W11-SPEC.md` **Revision 4** (unchanged)
Model: `docs/build-plan/W11-MODEL.md`, `tests/ha/sim/w11/` (unchanged)
Migration: **none** — `0131` still unused.

## 0. Review blockers — fixed / not fixed

| # | Verdict | Where / evidence |
|---|---|---|
| 1 | **Fixed** | `DB_MEMBER_SELF_FENCING_CAPABILITY` (`db-member-self-fencing`) is a separate capability, never in the static `nodeCapabilities`. The agent advertises it only when its member runner has an arbiter transport (`selfFencing === true`). `DatabaseReplicaService.selfFencing()` requires **all data nodes** to advertise it (plus the flag, an arbiter and the `YOAL_DB_MEMBER_SELF_FENCING=1` assertion). Arming has a new named refusal `no-self-fencing-path`. Because this build wires the agent report-only, it advertises nothing and `installAutoPromotion` refuses. Tests: policy `no-self-fencing-path`; replica self-fencing test; agent `reportOnlyPeerTransport` path. |
| 2 | **Fixed** | `autoActiveForRow()` now includes `DB_AUTO_PROMOTE`, `failoverMode`, `syncState === 'steady'` and the §1.3 durability rule. The controller calls `DatabaseMemberService.automaticPromotionRefusal()` before starting: lease present, same generation, `steady`, expired by the arbiter clock, not already held by the candidate, and for `sync` the candidate is in the lease's `sync` set. A refusal is a `blocked` event, not a promotion. Tests: failover-service lease-gate test (live lease blocks, expired starts). |
| 3 | **Fixed** | `DatabaseMemberRunner` promotes `workloadId` (the replica workload `db_<replicaId>`), not the database id: `helper.promote(workloadId, databaseId)`. Test asserts `[['db_dbr_a', 'db_main']]`. |
| 4 | **Fixed** | `#fence` now: set `fencing` → `fenceWorkload(readonly)` → read `memberStatus` and require `readOnly || inRecovery` → **then** send the `fencing {generation, epoch}` notice; `peers()` and the fan-out share the 2 s budget (both raced with a deadline); only then `fenced`. An unconfirmed fence emits `fence-failed`, is retried next pass and does not send a notice. Tests: fence-confirm ordering, fence-failure retry, best-effort miss. |
| 5 | **Fixed** | Drill start records `arbiterTested = false`, `lostCommits = null`. `completeDrill` reads the arbiter and sets `arbiterTested` only when the drill's generation is held by its target (a real CAS); `lostCommits` stays `null` because no promotion path measures it yet. `arm` therefore refuses a `sync` drill with `lost-commits` (null ≠ 0) instead of claiming RPO 0. Tests: CAS-proven completion, no-CAS completion, measured-null. |
| 6 | **Fixed** | Debounce, keep-alive age, proof age, renewal and fence-notice budget use a monotonic `now` (default `performance.now`); `wallNow` (default `Date.now`) is used only for `observedAt`, event `at` and the notice's `at`. `evaluateCandidate` gained `monotonicNow` so expiry still uses the arbiter clock. |
| 7 | **Fixed** | On a CAS win the runner keeps a `pendingPromotion`; it renews the won `changing` lease, retries `pg_ctl promote` every ≥2 s, and reports `promotion-retry`/`promotion-failed`. It never abandons a won generation. If the lease moves while `pg_ctl promote` runs it fences rather than reporting primary. Tests: fail-then-retry, lease-moved-during-promote. |
| 8 | **Fixed** | `applyMemberReports` stores the member's own `observedAt` and ignores any report older than the stored one. Test asserts the exact `observed_at` and that a stale `fenced` report cannot overwrite a newer `primary`. |
| 9 | **Fixed** | Control-plane renewal refuses an expired lease (no resurrection) and is skipped once every involved node advertises `db-member-self-fencing` (the node renews). The agent machine renews from the arbiter (`#keepPrimary`). Tests: expired lease unchanged; self-fencing fleet unchanged; agent renewal count ≥1. |
| 10 | **Fixed** | `view.active` and the controller share `autoActiveForRow`. `no-self-fencing-path` is an arm refusal. |
| 11 | **Fixed (with a consequence)** | `databaseFailoverDrillRequestSchema` gained `drillDatabaseId`; `drill()` refuses without it, refuses naming the policy database itself, and promotes only the named disposable target (row `drillDatabaseId` is set, production row untouched). CLI: `--target <disposable>`. Test asserts the production database's node did not move. |
| 12 | **Documented, not wired** | New operator doc `docs/HA-DB-FAILOVER.md` states clearly that discovery is unimplemented in `ServiceForwarder` and the feature stays off. `consumerTarget()` is the §6 selection over the control-plane cache only; no claim that §6 is met. |
| 13 | **Fixed** | Notices are stored per database in a generation-keyed map; the candidate asks for the lease's generation, and only a matching generation/from/epoch authorises a waiver. Test: a generation-2 notice cannot authorise a generation-1 acquisition; the matching one can. |
| 14 | **Fixed** | The agent buffers member events and sends `databaseMemberEvents` in the heartbeat (acknowledged only after a successful send). `applyMemberEvents` audits every event and alerts `fence-failed`, `fence-notice-missed` and `promotion-failed`. Test asserts the audit. |
| 15 | **Fixed** | `runFailoverStage('fence')` calls `begin(..., { source: 'auto' })`; test asserts `promotion_source = 'auto'`. |
| 16 | **Fixed** | Both two-primary paths audit: the reader (`database.failover.two_primaries`) and consumer discovery (once per database/generation). Test asserts both. |
| 17 | **Fixed** | Waiver test now uses **default** 5 s/15 s timings (and a separate stale-notice test proves the debounce holds). CAS counts asserted (`renewals === 1`). Proof-before-outage asserted (reads > 0). Drill lost commits asserted `null`. Workload-id arguments asserted. Reader has a valid lease-backed apply test. |
| 18 | **Fixed** | `YOAL_DB_MEMBER_SELF_FENCING` is documented in `docs/HA-DB-FAILOVER.md`: it is only an additional operator assertion; the capability is the real signal, and neither alone advertises/promotes. |
| 19 | **Fixed** | See 13–18; the handoff and docs are updated. |

## 1. What is report-only / what remains before enabling

- **Report-only:** `apps/agent/src/main.ts` constructs the member machine with `arbiter: null` and
  `reportOnlyPeerTransport()`. It reports roles/generations/events; it never fences, renews, promotes
  or advertises `db-member-self-fencing`.
- **Remaining (blocking):** a per-node direct arbiter transport (conditional read/CAS with
  least-privilege credentials) and an mTLS peer channel, then wiring them into
  `DatabaseMemberRunner` and advertising the capability. This is the only design question; no spec
  or model change is requested.
- **Remaining (non-blocking for the flag):** a cross-node member probe in `ServiceForwarder` for §6
  consumer discovery; persisting the three W11 report fields (`arbiterReachable`,
  `leaseExpiresAt`, `primaryKeepAliveAt`) would need a migration (not needed by the reader).
- **Drill lost commits:** no promotion path measures acknowledged-commit loss yet, so a `sync`
  drill records `null` and `sync` auto stays refused. Raising `arbiterTested` is measurable now;
  `lostCommits = 0` is not claimed.

## 2. Verified

| Command | Result |
|---|---|
| `bun run check` | every workspace package 0; only the pre-existing Svelte registry warning. |
| `bun test` | **6858 pass, 74 skip, 0 fail** (6932 tests, 614 files, ~207 s). |
| `bun test tests/ha` | **136 pass, 0 fail**. |
| `bun tests/ha/sim/w11/run.ts --runs 5000` | 0 violating runs; 2,232 notices delivered; 80 notice-less slower paths (allowed, alerted). |
| `bun tests/ha/sim/w9/run.ts --runs 5000` | 0 violating runs. |
| `bun test packages/core/src/desired-state/golden.test.ts` | pass; flag-off desired state unchanged. |
| `bun run check:migrations` | ok; **no 0131**. |

Focused tests: `packages/contracts/src/database-failover-machine.test.ts` (28),
`packages/core/src/database-failover-policy-service.test.ts` (15),
`packages/core/src/database-member-reader.test.ts` (16),
`apps/agent/src/database-member.test.ts` (17), plus failover/replica/foundation tests.

## 3. Not verified, and why

- Lab kill-node ×20 per §7.2, the 24 h soak, and anything on a real fleet: needs the owner lab.
- A real automatic promotion on two hosts: blocked by the missing node transport above.
- A genuinely disposable drill target is operator-provided; this lane does not create the copy.
- Forwarder consumer polling: unimplemented by design (see §1/docs).
- Real S3/R2/Azure/GCS CAS from a node: the agent has no transport to test.

## 4. Files of record

- Machine: `packages/contracts/src/database-failover-machine.ts`; contracts
  `database-member.ts` (capability, event schema), `database-failover-policy.ts` (refusal,
  evidence, drill target), `agent.ts` (heartbeat events).
- Policy/drill/self-fencing: `packages/core/src/database-failover-policy-service.ts`,
  `database-replica-service.ts`.
- Reader/events/desired state: `packages/core/src/database-member-service.ts`, `nodes.ts`.
- Controller gate: `packages/core/src/failover-service.ts`, `config.ts`.
- Agent: `apps/agent/src/database-member.ts`, `main.ts`.
- Surfaces: `apps/control-plane/src/routes/api/v1/databases/[name]/failover/+server.ts`,
  `apps/cli/src/commands/{db,db-failover,ha}.ts`, `apps/cli/src/api.ts`.
- Docs: `docs/HA-DB-FAILOVER.md`; CI `.github/workflows/ha.yml`.

## 5. Final SHA

`git rev-parse HEAD` in the worktree is authoritative; this handoff is committed on top of the fixes.
