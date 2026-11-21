# Lane A handoff — W11 automatic database failover

Worktree: `/Users/kieranholroyd/.t3/worktrees/private-cloud-deploys/t3-w4-a-auto-failover`
Branch: `ha/w4-a-auto-failover` (base `main`, no merge performed)
Spec: `docs/build-plan/W11-SPEC.md` **Revision 4** (not changed)
Model: `docs/build-plan/W11-MODEL.md`, `tests/ha/sim/w11/` (not changed)
Migration: **none added** — `0131` was not needed (see §3).

## 1. What is implemented

| Area | Where | Notes |
|---|---|---|
| Shared W11 machine | `packages/contracts/src/database-failover-machine.ts` (+ `.test.ts`) | One reading of §4 candidate rules, §1.8/§4 fence notice, §5 promotion body/re-arm, §6 consumer selection, §7 reader reconciliation, §8 old primary, §9 measurement. No I/O; the arbiter clock is an input. |
| Arming / disarming / drill | `packages/core/src/database-failover-policy-service.ts` (+ `.test.ts`) | Real writes and audits. Every §3 refusal is enforced (`#evaluate`); `arm` evaluates with the requested async acknowledgement, records `autoArmedAt` + evidence across `generation`; `disarm` is immediate and never fences; `drill` starts the real promotion path (`promotion_source='drill'`) and records the measured time to writable, lost commits and arbiter evidence on completion. |
| Drill linkage | `packages/core/src/database-replica-service.ts` | The drill id rides the existing `database_failovers.evidence_json` (no migration). `promote()` takes `{source, drillId}` and writes `promotion_source`; terminal failovers call `completeDrill`. A drill over 30 s or unmeasured is recorded **failed**, so it cannot arm. |
| Per-database auto gate | `failover-service.ts` + `autoActiveForRow` | Even with `DB_AUTO_PROMOTE` and the handler installed, a `manual` database is a manual promotion. The live half only disables auto when effective durability stops meeting §1.3 (W11-MODEL assumption 9). |
| Node member machine | `apps/agent/src/database-member.ts` (+ `.test.ts`) | Candidate acquisition (stream-down debounce, arbiter-clock expiry, eligibility/named sync member, keep-alive block), the Revision 4 notice waiver, CAS `generation + 1`, `pg_ctl promote` (`replicaPromote`), clear sync, report generation/LSN; primary lease renewal and fencing with the notice sent concurrently under a 2 s bound; CAS-lost re-read; expired-lease fence (no resurrection). Fixed helper verbs only (`memberStatus`, `fenceWorkload`, `replicaPromote`, `syncConfigure`). |
| Control-plane reader | `database-member-service.ts` | `reconcilePromotions()` runs from `tick` regardless of flags: moves the row/endpoints/PITR stanza, inserts a reconciled failover, re-attaches the old primary as a replica, never lowers a generation, alerts on a same-generation tie and on an invalid/ineligible promotion. `consumerTarget()` is the same §6 selection over the heartbeat cache. |
| Desired state | `membersDesired()` | An armed database carries `failover {mode, acceptDataLoss, autoArmedAt}`; a manual database (the default) omits it, so the flag-off golden is byte-identical. `databaseMemberSchema` gained an additive `workloadId` so the machine can call the helper verbs. |
| Surfaces | `GET/POST /api/v1/databases/:name/failover`, `yoal db failover`, `yoal ha db arm|disarm|drill` | One audited server path; every refusal is shown verbatim. |
| CI | `.github/workflows/ha.yml` | `ha-sim` now runs the W11 model (`--runs 5000`) and its unit tests. |

Audit actions: `database.failover.arm`, `.disarm`, `.drill.start`, `.drill.complete`, `.reconciled`, `.invalid`.

## 2. Verified

| Command | Result |
|---|---|
| `bun run check` | every workspace package 0; `iam lint` baseline unchanged; the one pre-existing Svelte registry warning remains. |
| `bun test` | **6844 pass, 74 skip, 0 fail** (6918 tests, 614 files, ~200 s). |
| `bun test tests/ha` | **136 pass, 0 fail**. |
| `bun tests/ha/sim/w11/run.ts --runs 5000` | 5,000 schedules, **0 violations**, 3.35 s. I3/I11/I12/I13 zero; judged time-to-writable median 18.48 s, worst 30.00 s; 80 notice-less slower paths (median 30.78, worst 33.09), all alerted as §9/§11 allow. |
| `bun tests/ha/sim/w9/run.ts --runs 5000` | 0 violating runs (regression unchanged). |
| `bun run check:migrations` | ok; **no 0131**. |
| `packages/contracts/src/database-failover-machine.test.ts` | 28 tests: every candidate refusal, notice valid/stale/bad-epoch/forged, both waivers and the non-waivers, CAS body, reader apply/ignore/refuse/gap/two-primary, consumer fail-closed, old-primary fence. |
| `packages/core/src/database-failover-policy-service.test.ts` | 13 tests: flag off, all gates, async acknowledgement, sync refusal of `acceptDataLoss`, named drill, audit, disarm, drill start/failure/slow/unmeasured. |
| `packages/core/src/database-member-reader.test.ts` | 10 tests: desired-state policy omission/presence, consumer selection/no-answer/tie/stale, reader reconcile/never-lower/two-primary/invalid/no-row. |
| `apps/agent/src/database-member.test.ts` | 14 tests: candidate/promotion, keep-alive block, Revision-4 notice, stale/bad-epoch/forged, live stream, CAS loss and lost response, no-arbiter/report-only, fence notice fan-out/miss, healthy primary, arbiter outage alone, outage + silent member, helper mapping. |
| `packages/core/src/desired-state/golden.test.ts` | pass; flag-off desired state unchanged. |
| `packages/core/src/failover-service.test.ts` | pass, including a new manual-database-is-not-auto test. |

## 3. Not verified, and why

- **Lab: kill the primary's node, 20 repetitions per §7.2** — needs the Docker/VMs and the owner fleet; not run here. The model and the unit machines are the evidence available in this tree.
- **A real end-to-end automatic promotion on two hosts** — blocked by §4, not by the machine logic.
- **24 h soak** — needs the lab and a day.
- **Drill against a genuinely disposable database** — the contract/drill path promotes the named database (`drillDatabaseId = databaseId`); creating a disposable copy is not in this lane. The drill records the real measurement and does not fake a pass.
- **Consumer forwarding** — the selection logic is tested, but the agent forwarder still uses the desired-state upstream (re-pointed in place, no restart). See §4.3.
- **W11 report fields on the control plane** — the agent now reports `arbiterReachable`/`leaseExpiresAt`/`primaryKeepAliveAt`; `database_member_status` has no columns for them, and the reader does not need them. Persisting them would need a migration; I judged that not needed for the exit.

## 4. Deviations and open questions

1. **No migration 0131.** Arming uses the 0129 columns, drills use 0130, and the drill/failover link uses the existing `evidence_json`. Persisting the three W11 heartbeat fields would be the only candidate for 0131; deferred because nothing reads them yet.
2. **The node machine is wired report-only in production.** `apps/agent/src/main.ts` constructs `DatabaseMemberRunner` with `arbiter: null` and `reportOnlyPeerTransport()`. The foundation gives an agent **no direct arbiter transport or credentials** and **no cross-node member RPC**; desired state must not carry secrets. The machine therefore reports role/generation honestly and never claims to fence. `selfFencing()` refuses unless `YOAL_DB_MEMBER_SELF_FENCING=1` is set *and* an arbiter exists — the operator assertion that every data node really has the W11 transport. **This is the one design question for the integrator: how each node gets least-privilege conditional-write access to the arbiter (and an mTLS peer channel) without putting a secret in desired state.** Until that is answered, `DB_AUTO_PROMOTE` cannot safely be turned on outside the lab, even though arming is implemented.
3. **Consumer discovery is not in the forwarder yet.** `selectConsumerTarget` and `consumerTarget` implement §6 exactly, and the control-plane cache is tested (including fail-closed on two primaries). The agent `ServiceForwarder` still has one upstream per endpoint and is re-pointed by desired state without a restart. Polling members over mTLS needs a cross-node member-probe surface the foundation does not have (the only probe is the local helper verb); that is the second open question, not a spec change.
4. **`databaseMemberSchema.workloadId` is additive.** It is required for the machine to call `fenceWorkload`/`replicaPromote` on the right workload; an older agent ignores it. The flag-off golden is unaffected because `databaseMembers` is omitted while `SYNC_REPLICA` is off.
5. **Live auto policy is the model's conservative half.** `autoActiveForRow` checks `failoverMode` plus effective durability, not every arming refusal on every tick. Re-checking a 30-day drill or data-node count each tick would silently turn a live `auto` into manual; W11-MODEL assumption 9 only disables on durability. The full refusal set is enforced at arming.
6. **A drill over the bound or unmeasured is `failed`, not `passed`.** The foundation contract already rejects a passed drill >30 s or a measured `null`; the service records the same. This is a deliberate reading of §12 ("records the measured time to writable"), not a contract change.
7. **`oldPrimaryAction` is shared**, so the reader and the agent classify a stale primary the same way. The agent fences; the rewind/rebuild itself reuses W10's `databaseReplicaRewinds` (or a purge when the capabilities are absent).

No spec change is requested. Items 2 and 3 are implementation blockers, not spec ambiguities.

## 5. Files of record

- Machine: `packages/contracts/src/database-failover-machine.ts`; contracts `database-member.ts`.
- Policy/drill: `packages/core/src/database-failover-policy-service.ts`; `database-replica-service.ts` (`promote` source, drill completion, `selfFencing`, `reattachForReader`).
- Reader/desired state: `packages/core/src/database-member-service.ts` (`reconcilePromotions`, `consumerTarget`, `membersDesired`).
- Controller gate: `packages/core/src/failover-service.ts`; `packages/core/src/config.ts` (`dbMemberSelfFencing`).
- Agent: `apps/agent/src/database-member.ts`, `apps/agent/src/main.ts`.
- Surfaces: `apps/control-plane/src/routes/api/v1/databases/[name]/failover/+server.ts`, `apps/cli/src/commands/{db,db-failover,ha}.ts`, `apps/cli/src/api.ts`.
- CI: `.github/workflows/ha.yml`.

## 6. Final SHA

`git rev-parse HEAD` in the worktree is authoritative; the handoff file is committed on top of the implementation.
