# W11 model — automatic database failover and the arming policy

Step 2 of HA-PLAN §6.4, written from [`W11-SPEC.md`](./W11-SPEC.md) alone. The member machine it
extends is W9-SPEC §5; the only code reused is the simulator's event-queue/RNG style in
`tests/ha/sim/`. The production implementation of automatic failover was not read.

**Result: one counterexample to the New invariant (time to writable). No I3, I11, I12 or I13
violation in 5,000 schedules.** The counterexample is a two-fault, minimal schedule in which the
primary loses the arbiter and one other member, keeps serving through the H21 failsafe, then
fences; the one eligible member is reachable from the primary and answered its keep-alive, so
W11-SPEC §4.4 blocks it for one TTL **after** the lease expired and **after** the primary fenced.
With the allowed `pg_ctl promote` budget, writable time from the primary's last successful renew is
31.7–38.4 s, not ≤ 30 s.

| | |
|---|---|
| Model | `tests/ha/sim/w11/` (`spec.ts`, `policy.ts`, `model.ts`, `schedules.ts`, `run.ts`, `w11.test.ts`) |
| Command | `bun tests/ha/sim/w11/run.ts --runs 5000` |
| Runtime | 5,000 schedules in **2.5 s** (~0.50 ms/schedule); 38 unit tests in ~0.25 s |
| Exit code | **1** — 80 of 5,000 runs exceed the 30 s worst case; all 80 are the same defect |
| Spec status | **blocked on W11-SPEC §4.4 vs §9**; the spec was not patched |

---

## 1. What the model is

A deterministic discrete-event world with:

- **one arbiter** — a linearizable object store with conditional `PUT` (`If-Match`), one database
  lease, and an arbiter clock that is authoritative for expiry (W9-SPEC assumption 2);
- **three database members** `p a b`, the W9-SPEC §5 member machine plus the W11-SPEC §4–§5
  automatic-promotion path;
- **one consumer** that polls every member's role/generation every 1–2 s and forwards only to a
  `primary` at the highest generation (W11-SPEC §6); a same-generation tie fails closed;
- **one control-plane reader** with an availability flag. It never decides and never writes a
  lease; on return it reconciles the database row's generation from reports and the lease and
  never lowers it (W11-SPEC §7);
- **the per-database arming policy** as data (`policy.ts`), evaluated at start-up and re-evaluated
  live on the one condition that can change without an operator action (a `sync` database
  downgraded to effective `async`);
- a directed reachability graph (asymmetric partitions are expressible) and a drawn round-trip
  latency per RPC.

Time is a virtual millisecond counter. A run is a pure function of the seed and the schedule;
`w11.test.ts` asserts that a seed replays an identical trace and stats. The database is one object
with `p` primary and `a`/`b` replicas at generation 1. `b` is the initial synchronous standby
unless the schedule names `a`.

The checker runs after every event:

| Id | Check |
|---|---|
| **I3** | no two members in `primary` at one generation. The strict count (two primaries at *different* generations) is measured separately. |
| **I12** | at the transition to `primary`, the lease read at the successful CAS is the authority: a promotion while `syncState !== 'steady'` is `promotion-during-sync-change`; a promotion on a `sync` lease that does not name the promoter is `promotion-not-in-sync-set`; a promotion on an `async` lease without `acceptDataLoss` is `promotion-without-accept-data-loss`. |
| **I13** | at every promotion from a lease whose effective durability is `sync`, the promoted member's history contains every commit acknowledged under `sync`; at the end of the run the final primary does too; an ack is not issued by an old primary while a higher-generation primary exists without the commit. |
| **I11** | schedule expectations: a control-plane outage must not stop traffic or a failover and the row never lowers; an arbiter outage alone must not fail over or stop a healthy primary; a forbidden window contains no promotion. |
| **New / bound** | time to writable, per failover, from the lost primary's **last applied successful lease write** (renew or the acquire CAS) to the new primary's `PRIMARY` state: ≤ 30 s each; the median over all judged samples ≤ 25 s. |
| **policy** | an automatic promotion with `auto` refused is `promotion-not-armed`; a refused schedule that promotes is `promotion-when-forbidden`. |
| **support** | generations never decrease; a holder change is exactly +1; a member that answered a keep-alive within one TTL does not acquire (§4.4). |

---

## 2. State variables

### Arbiter

| Variable | Meaning |
|---|---|
| `#dbStore` | `{ body, etag, appliedAt }` — the one database lease |
| `etag` | fresh on every successful conditional write; a stale `If-Match` gets 412 |
| clock | virtual `T`; the authority for every expiry comparison |

A write applies at the request's arrival and answers with the arbiter's current `T`. A lost
response still applied the write; the caller sees a timeout and must re-read. The model exposes
`appliedAt` on reads, so a re-read can recover the exact last successful lease write.

### Member (`DbMember`)

`state ∈ {streaming, candidate, promoting, primary, fencing, fenced, rewind}`, `generation`,
`history` (the set of commit ids it has applied), `alive`, `frozenUntil`, `wallOffset`, `lease`,
`leaseEtag`, `lastServerDate` + `serverAt` (the node's estimate of the arbiter clock), `durability`,
`durabilityEffective`, `streamFrom`, `streamEpoch` (invalidates in-flight WAL on a stream gap),
`replAt` (per-peer ordered delivery), `streamDownSince` (the §4.1 5 s debounce), `lastProof` /
`lastProofWall` (the renewal proof window, started at the **send** time), `lastLeaseApply` (the
arbiter apply time of the last successful lease write — the §9 clock), `lastRenewOk`,
`lastRenewSent`, `lastKeepAlive`, `peerLastAnswer` (the primary's keep-alive view),
`lastAnsweredToPrimary` (the member's own view, which gates acquisition), `effectiveSync` (the
actual `synchronous_standby_names`), the sync-change fields `changePhase` / `changeTarget` /
`changeOld` / `changeOpenedAt` / `changeTimeoutAt` / `barrierId` / `barrierSnapshot`,
`lostBaseline` (set when it stops serving, consumed by the next promotion), `promotedAt`, `acquire`
(the from-lease, body, generation, etag, send time and apply time), `fenceTimer`. Schedule hooks:
`killAfterOpen`, `killAfterBarrier`.

The lease's `syncState` (`'steady' | 'changing'`) is the authority; the local change fields are the
primary's progress through it.

### Commit / write

`Commit { id, gen, acceptedBy, durability, acked, ackAt, waitFor, timedOut }`. A commit is
**acknowledged** when the durability rule says it is durable, not when the client receives the
ack:

- `async` — on acceptance by the primary;
- `sync` — when the member named by `effectiveSync` (the actual setting, not the lease's recorded
  set) has it;
- a pending ack is released only while the accepting primary is still serving, or when the current
  highest-generation primary has the commit. A fenced node must not tell a client a write committed
  if the new primary does not have it;
- the I13 obligation is recorded with the **durability in force at ack time**.

The barrier is an internal commit (no client) appended to the primary's history and shipped in WAL
order. The client also has a 30 s write timeout; a timed-out write is not acknowledged.

### Policy and fleet facts

`PolicyConfig` in the scenario: `requested: 'manual' | 'auto'`, `globalFlag`, `acceptDataLoss`,
`dataNodes` (role data + capability `db-member`), `zones`, `drill: 'passed' | 'failed' | 'stale' |
'none'`, `replicaOnAnotherOnlineNode`, `switchoverActive`, `syncStepping`, `allDbMember`. The
database's configured `durability` is the scenario's, not part of `PolicyConfig`.

`evaluateArming` returns `{ armed, mode, refusals }`, naming **every** failing rule. `manual` is
the default mode and is not a refusal. The model records the decision on the world
(`armDecisionForTest()`), and a schedule with a refusal can never promote (`promotion-not-armed`
if a mutant forces it).

The live predicate `autoEnabledFor(armed, durabilityEffective, acceptDataLoss)` can only disable
auto: a `sync` database that `on_sync_loss` downgraded to effective `async` no longer meets
"durability is sync, or async with acceptDataLoss" (assumption 9).

### Control-plane reader

`control.available`, `control.rowGeneration`, `#maxGenerationSeen`. It has no write path. On return
it sets `rowGeneration = max(rowGeneration, maxGenerationSeen, every member's generation)`, logs
the reconciliation, and reports `control-reader-lowered-generation` if it would ever lower it.

### Consumer

Cached highest-generation `primary` answer, refreshed 1–2 s; a write every 0.5–0.9 s to that cached
target; fail-closed when no member answers `primary`, and fail-closed on a same-generation tie. No
control-plane call, ever.

---

## 3. Transitions

### Arming (W11-SPEC §3)

The policy is evaluated once at start-up. A refusal (or `requested: 'manual'`) sets
`armed = false`; the member machine then has no automatic acquisition path. Every rule is a pure
function, so the refusal table is exercised directly in `w11.test.ts`:

| Rule | Refusal |
|---|---|
| global flag off | `global-flag-off` |
| `async` without `acceptDataLoss` | `durability-async-without-accept-data-loss` |
| fewer than 3 data nodes | `fewer-than-three-data-nodes` |
| fewer than 2 zones | `fewer-than-two-zones` |
| no drill | `no-failover-drill` |
| drill failed | `failover-drill-failed` |
| drill older than 30 days | `failover-drill-stale` |
| no replica on another online node | `no-replica-on-another-online-node` |
| active switchover | `active-switchover` |
| sync transition in progress | `sync-transition` |
| a node does not declare `db-member` | `node-not-db-member` |

### Candidate (W11-SPEC §4)

A member in `streaming` becomes a `candidate` only when **all** hold:

1. its own stream has been down for `STREAM_DOWN_MS` (5 s) — the model tracks `streamDownSince`
   from the first tick that cannot prove a live primary stream;
2. the lease has expired by the arbiter's clock (`read.date >= lease.expiresAt`) and the member can
   reach the arbiter;
3. `auto` is enabled for the lease's effective durability (the arming decision plus the live
   `acceptDataLoss` rule);
4. it is eligible: for an effective `sync` lease it is named in the lease's `sync` set; for an
   effective `async` lease `acceptDataLoss` is set;
5. no other member has answered the primary's keep-alive within one TTL **from this member's own
   point of view** (`T - lastAnsweredToPrimary >= 15 s`) — the H21 failsafe agreement;
6. it is not already busy with a CAS.

### Promotion (W11-SPEC §5.1–§5.3)

| From | To | Trigger |
|---|---|---|
| `streaming` | `candidate` | the six conditions above |
| `candidate` | `promoting` | the CAS at `generation + 1` succeeds |
| `candidate` | `streaming` | the CAS loses (412) or errors; re-read, never retry blindly |
| `promoting` | `primary` | `pg_ctl promote` (0.3–5 s) |
| `primary` | `fencing` | 15 s without a proof and the failsafe does not hold, a 412/higher generation, a consumer role poll after the proof expired, or a resume after the lease expired |
| `fencing` | `fenced` | 50–300 ms to stop Postgres / set read-only |
| `fenced` | `rewind` → `streaming` | a higher-generation primary is reachable; history is replaced by the new primary's |

The CAS body is W11 §5.1: `generation + 1`, `holder = self`, `expiresAt = arbiter now + 15 s`,
`sync: []`, `syncState: 'changing'`, durability inherited from the lease it acquired from.

The winner sets `primary` (the time-to-writable mark), makes every reachable `streaming` peer follow
it, and checks:

- **I12** against the **from-lease** (the read at the CAS), not the acquired body;
- **I13** against every acknowledged `sync` commit if the from-lease's effective durability is
  `sync`;
- **New** against the lost primary's `lastLeaseApply` (`time-to-writable-exceeded` if > 30 s).

### Re-arming the sync set (W11-SPEC §5.3 + W9-SPEC §5.5)

The acquire CAS already wrote `changing` with an empty sync set. The new primary then:

- **async** — CAS to `steady`, `sync: []`, `durability: async`. A lost response is re-read; a
  `changing` lease with no local transition is resumed.
- **sync** — if a healthy replica is streaming from it, set `synchronous_standby_names` to that
  member, issue a barrier (snapshot = the new primary's whole history, shipped in WAL order), and
  close `steady {target}` when the barrier holds. If the barrier times out, fall back to the old
  member when it is healthy, otherwise apply `on_sync_loss` (`downgrade` after 30 s, or `block`).

While the lease is `changing`, no member may acquire. A new primary that dies before the close
leaves the fleet with no automatic promotion — the designed safety outcome, as in W9.

### Keeping the lease (W9-SPEC §5.3, W11-SPEC §4.4)

A primary renews every 5 s. A renewal is proved at its **send** time; `lastLeaseApply` is updated at
the arbiter's **apply** time. A primary may serve while the proof is younger than one TTL, **or**
while the arbiter is unreachable **and** every member answered its keep-alive within one TTL. The
failsafe is why an arbiter outage alone does not stop a healthy primary; the keep-alive gate is why
a member that answered cannot promote while the primary may still be serving.

A fence is recorded (`fenceEvents`) and, unless it is superseded by a higher generation, marks the
last applied lease write as the time-to-writable baseline.

### Sync set change from a healthy primary (W9-SPEC §5.5)

The primary notices its effective synchronous standby is down; after 2 s it opens
(`sync: []`, `changing`, same generation), switches `synchronous_standby_names` to a healthy
target, issues a barrier, and closes `steady {target}`. A failure falls back to the old member if
healthy, or applies `on_sync_loss`. If the primary dies while `changing`, no automatic promotion
occurs.

### Ordered WAL

A primary appends a commit to its history on acceptance and ships it to every member whose
`streamFrom` is the primary. Delivery times are monotone per peer. If a delivery cannot be made
(partition, lag, lost in flight), the stream **detaches** (`streamEpoch++` invalidates everything
already in flight) and the receiver re-attaches only after copying the primary's whole history.
This is what makes the barrier's "the new member has the barrier" imply "every earlier
acknowledged commit is on it". A fenced old primary copies the new primary's history when it
rewinds, discarding its divergent tail.

### Control plane (W11-SPEC §7)

A `control-down` fault flips a logical availability flag. It does not stop members, renewals,
promotions, sync transitions or traffic. On return, the reader reconciles the row generation from
the highest generation it has seen and never lowers it. This is the W11 reading: §5.3 makes the
winner re-arm the lease, so the sync CAS is the node's, not a control-plane writer's (assumption 8).

---

## 4. Properties, exactly

- **I3.** After every event, group members in `primary` by `generation`; a group of two or more is
  `I3/two-primary-same-generation`. `strictOverlapMs` also measures two primaries at *different*
  generations (the letter of I3 permits it; the plan's intent does not). The arbiter rejects a
  stale `If-Match`, a generation decrease and a holder change at one generation (support rules).
- **I12.** At `primary`, use the lease read at the CAS (`acquired.fromLease`): not `steady` →
  `promotion-during-sync-change`; effective `sync` and the promoter not in `sync` →
  `promotion-not-in-sync-set`; effective `async` without `acceptDataLoss` →
  `promotion-without-accept-data-loss`. A promotion with `auto` refused is `promotion-not-armed`.
- **I13.** At every promotion whose **from-lease** effective durability is `sync`, every commit in
  the global `acked` map with `durability === 'sync'` must be in the promoter's history. At the end
  of the run the final primary's lease decides. At every ack, if a higher-generation primary exists,
  records `sync`, and does not hold the commit, report `ack-lost-to-higher-primary`. A commit's
  durability is the one in force when the client was told it committed. A promotion from an
  effective `async` lease is an async failover and is exempt (assumption 10).
- **Time to writable.** On every promotion, if a lost primary's baseline exists, `promotion time −
  lastLeaseApply` is recorded; > 30,000 ms is `bound/time-to-writable-exceeded`. The runner checks
  the median over all judged samples ≤ 25,000 ms. A sample is **not judged** when the schedule marks
  `expect.ttf: false` (an arbiter outage for every member: §10 says no promotion is possible then,
  so a post-outage recovery is not a working-arbiter failover).
- **I11.** Each schedule may attach `failover`, `noPrimary`, `requireAcks`, `primaryStays`,
  `controlDown` and `autoRefused` expectations. `finalize()` counts acknowledged writes in the
  windows, finds the first promotion after the loss, checks the row generation, and forbids a fence
  of a primary that must keep serving.
- **Support.** `lease-generation-decreased`, `lease-holder-change-not-plus-one`,
  `acquired-too-early-after-keepalive`.

### Checker validation (not part of the 5,000 count)

The model is not vacuous. Deliberately wrong variants are selectable with `--mutant`:

| Mutant | Run | Caught by |
|---|---|---|
| `arm-anyway` | `--scenario w11-two-data-nodes` | **policy/promotion-not-armed** and an I11 forbidden promotion |
| `ignore-eligibility` | `--scenario w11-sync-named-dead` | **I12/promotion-not-in-sync-set** |
| `ignore-keepalive` | `--scenario w11-failsafe-keepalive` | **support/acquired-too-early-after-keepalive** |
| `cas-same-generation` | `--scenario w11-failsafe-keepalive` | **I3/two-primary-same-generation** and the holder-change support rule |
| `async-without-accept` | `--scenario w11-async-no-accept` | **I12/promotion-without-accept-data-loss** |
| `fence-wall-clock` | `--scenario w11-wall-clock-fence` | **strict overlap > 1 s** vs **0** for the monotonic machine |

The I3 checker is also exercised directly: `forcePrimaryForTest('a', 1)` +
`forcePrimaryForTest('b', 1)` raises `two-primary-same-generation` (`w11.test.ts`).

---

## 5. Assumptions

These are the model's reading of W11-SPEC. A different reading changes the result.

1. **The arbiter is linearizable** and its conditional write is atomic (W9-SPEC assumption 1). No
   stale reads, no lost update.
2. **The arbiter clock is monotone** and authoritative for expiry. Node timers are monotone; a
   node's wall clock is never used for a safety decision, so a wall-clock step is inert. The
   `fence-wall-clock` mutant is the deliberately wrong alternative.
3. **"now" in `expiresAt = now + TTL` is the node's best estimate of the arbiter's clock**: the last
   server `Date` plus elapsed monotonic time.
4. **A renewal is proved at its send time**; the apply time is `lastLeaseApply`, the §9 clock.
   Likewise a promotion's proof starts at the CAS send, not at `pg_ctl promote` completion.
5. **RPC legs are short**: 5–120 ms each way normally, ≤ 1.5 s under a fault. A partition either
   refuses (fast error) or black-holes (700 ms timeout). A lost response still applied the write;
   a lost CAS response is resolved by re-reading, and a lease that names the member at `gen+1`
   proves the win and lets it promote.
6. **The three sync steps are separate operations.** The model switches the setting immediately
   after the open and checks the barrier on the 1 s primary tick; the barrier's 30 s timeout is
   `SYNC_CHANGE_TIMEOUT`.
7. **WAL is ordered and gap-free per member.** The stream detaches on a gap and re-attaches only
   after a catch-up copy. This is what the barrier argument depends on; the model enforces it.
8. **The W11 member machine writes its own lease.** §5.3 gives the winner the re-arm, and §1.5/§7
   say the control plane never decides. The W9 Revision 2 "node applies locally, reconciler records
   on return" path is **not** re-modelled here: a control-plane outage does not gate the sync CAS.
   This is a more available reading than W9's; it cannot hide an I3/I12/I13 failure, and it makes
   the I11 control-plane case a positive test.
9. **`auto` is re-evaluated live on effective durability.** §3 states the arming action, which is
   an operator action. The model also disables auto when a `sync` database has been downgraded to
   effective `async` without `acceptDataLoss`, because the §3 condition no longer holds. This can
   only *disable* auto, never enable it; it is a conservative reading.
10. **An `on_sync_loss` downgrade is an accepted RPO > 0** (W9-SPEC decision 2). I13 is judged under
    the acquired lease's recorded effective durability; a promotion from an effective `async` lease
    is an async failover and is exempt. The model reports, but does not fail, acknowledged async
    commits missing from the final primary (`stats.asyncLostAcks`).
11. **Promotions are automatic only.** A manual promotion is not modelled. `acceptDataLoss` is never
    set automatically; a member not in the sync set, or any member while `changing`, cannot
    promote.
12. **One database, three members.** `p` is the initial primary; `a` and `b` are replicas; `b` is
    the initial synchronous standby unless a schedule names `a`. A genuinely two-member fleet is
    represented by a policy refusal (`dataNodes: 2`), not by removing a member.
13. **A fenced or crashed old primary does not serve.** A restart is `fenced`; a freeze is fenced on
    resume if the proof expired; it can rewind and rejoin as a replica.
14. **After a mid-change death the model does not perform a human's manual promotion.** Those runs
    end without a primary. That is the designed safety outcome.
15. **No operator force-promote, no control-plane-driven failover.** The control plane is a reader.

---

## 6. Schedules

Each family is generated from the seed (family = `seed % 13`; `--family` fixes it). A schedule is
data, printed by `--scenario`/`--trace`.

| Family | What it does |
|---|---|
| `power-off` | the primary is powered off at 4–12 s; sync or async; one promotion, TTF |
| `freeze` | the primary process freezes 22–50 s; the lease expires by the arbiter clock; a successor promotes; the stale leader resumes |
| `partition-arbiter-ok` | the primary loses both replicas but keeps the arbiter; it renews, no failover, traffic continues |
| `partition-isolated` | the primary loses the arbiter and both replicas; it fences; an eligible replica with arbiter access promotes |
| `arbiter-outage` | all members lose the arbiter 15–32 s; variant A keeps the primary via the failsafe, variant B also loses a member (fence, no promotion while the arbiter is away) |
| `two-candidates` | async + `acceptDataLoss`; the primary is isolated from the arbiter and both replicas; both candidates race the CAS; one wins, the loser re-follows |
| `stale-leader` | the primary freezes 25–50 s, a successor promotes, then the stale leader resumes and fences |
| `clock-step` | a wall clock steps ±30–120 s on a member, sometimes with the primary losing the arbiter and one or both replicas; the step is inert |
| `sync-named-dead` | the sync set names a dead member; variants: the primary closes a fresh set to `a` then dies; the primary dies before the close; both die; async + accept |
| `failsafe-keepalive` | the primary answers keep-alives while its own stream is down; variant A keeps serving with all peers answering and no failover; variant B also loses one member, so it fences and the answering member must wait out its TTL |
| `control-down` | the control plane is down for 50–100 s and the primary is killed 3 s later; failover and traffic continue; the row never falls (I11) |
| `refusal` | one of the eleven refusal rules or `manual`; the primary is killed; no automatic promotion |
| `mixed` | 2–4 of the above; invariants always run; the TTF is not judged (a global arbiter outage can be inside the mix) |

Fixed scenarios (the report's names): `w11-power-off-sync`, `w11-power-off-async`, `w11-freeze`,
`w11-partition-arbiter-ok`, `w11-partition-isolated`, `w11-arbiter-alone`,
`w11-arbiter-plus-member`, `w11-two-candidates`, `w11-stale-leader`, `w11-sync-named-dead`,
`w11-sync-named-dead-then-close`, `w11-no-drill`, `w11-two-data-nodes`, `w11-async-no-accept`,
`w11-control-down`, `w11-failsafe-keepalive`, `w11-failsafe-minimal`, `w11-wall-clock-fence`.

---

## 7. Results

`bun tests/ha/sim/w11/run.ts --runs 5000`, 5,000 schedules over 13 families, **2.5 s**, exit **1**
because of the counterexample in §8:

| Family | Runs | DB promotions | Acks | Primary losses | Fences | Candidates | Lost CAS | Control promotions | Strict-overlap ms (total / max) | Median TTF | Worst TTF | Violations |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `power-off` | 384 | 384 | 39,850 | 384 | 0 | 413 | 29 | 0 | 0 / 0 | 18.47 | 23.24 | none |
| `freeze` | 385 | 385 | 34,169 | 385 | 385 | 411 | 26 | 0 | 0 / 0 | 18.02 | 24.88 | none |
| `partition-arbiter-ok` | 385 | 0 | 37,920 | 0 | 0 | 0 | 0 | 0 | 0 / 0 | — | — | none |
| `partition-isolated` | 385 | 385 | 42,656 | 385 | 385 | 419 | 34 | 0 | 398 / 223 | 18.24 | 25.06 | none |
| `arbiter-outage` | 385 | 204 | 34,401 | 204 | 204 | 219 | 15 | 0 | 0 / 0 | — | — | none |
| `two-candidates` | 385 | 385 | 38,338 | 385 | 385 | 458 | 73 | 0 | 881 / 402 | 18.43 | 20.95 | none |
| `stale-leader` | 385 | 385 | 36,659 | 385 | 385 | 424 | 39 | 0 | 0 / 0 | 18.34 | 24.37 | none |
| `clock-step` | 385 | 234 | 45,851 | 234 | 234 | 241 | 7 | 0 | 566 / 201 | 18.86 | **32.03** | **18 bound** |
| `sync-named-dead` | 385 | 190 | 20,723 | 385 | 0 | 190 | 0 | 0 | 0 / 0 | 18.46 | 21.08 | none |
| `failsafe-keepalive` | 384 | 135 | 38,688 | 137 | 137 | 135 | 0 | 0 | 0 / 0 | **29.72** | **33.02** | **64 bound** |
| `control-down` | 384 | 384 | 45,701 | 384 | 0 | 423 | 39 | **384** | 0 / 0 | 18.40 | 21.24 | none |
| `refusal` | 384 | **0** | 3,668 | 384 | 0 | 0 | 0 | 0 | 0 / 0 | — | — | none |
| `mixed` | 384 | 161 | 49,931 | 164 | 107 | 172 | 11 | 26 | 0 / 0 | — | — | none |
| **total** | **5,000** | **3,232** | **468,555** | **3,816** | **2,222** | **3,505** | **273** | **410** | **1,845 / 402** | **18.48** | **33.02** | **80 runs** |

- **I3, I11, I12 and I13: zero violations** in all 5,000 schedules and every fixed scenario except
  the deliberate mutants.
- **The New bound: 80 of 5,000 runs fail**, all `bound/time-to-writable-exceeded`; the overall
  median is **18.48 s** (inside 25 s), the worst **33.02 s** (outside 30 s). The two affected
  families are `failsafe-keepalive` (64) and `clock-step` (18); the `clock-step` failures are the
  same keep-alive interaction when the schedule leaves the eligible member reachable, not a clock
  effect (the wall step is inert in that trace).
- **`power-off`** is the canonical M4 schedule: 384/384 promote, median 18.47 s, worst 23.24 s,
  zero strict overlap, I13 zero.
- **`arbiter-outage`**: variant A keeps the primary for the whole outage (acks continue); variant B
  fences it and no promotion happens inside the outage; 204 runs recover after the arbiter returns.
  These recoveries are not judged against §9 (`ttfExempt`).
- **`two-candidates`**: 73 of 385 runs lose a CAS and re-follow; every run has exactly one
  promotion and zero I3.
- **`refusal`**: 0 promotions in 384 runs across all refusal rules and `manual`.
- **`control-down`**: 384 promotions and 45,701 acks while the control plane was down; the row
  reconciled to generation 2 and never fell.
- **`sync-named-dead`**: 190 promotions only in the variants where the lease names the promoter at
  the acquired generation or the async path is explicitly accepted; the unnamed member never
  promoted; I13 zero.
- **Strict overlap** (two primaries at different generations) totals 1,845 ms, worst 402 ms in
  `two-candidates`; no acknowledged write was lost (I13's ack check would have fired). The letter
  of I3 permits it; the plan's intent does not. It is a liveness/consumer-discovery window, not an
  accepted safety margin.

### The 2-fault bound probe

The fixed minimal schedule (§8) is a separate targeted sweep, not part of the 5,000. Over seeds
1–5,000 with the same two faults: **2,316 of 5,000 seeds exceed 30 s; the worst is 38.43 s**
(seed 3541). The 5,000-schedule family run has a smaller worst only because its fault time is
randomised and most phases are gentler; the defect is structural.

---

## 8. Counterexample: W11-SPEC §4.4 vs §9 (the New invariant)

**Schedule `w11-failsafe-minimal` — two faults, both at 6.0 s:**

1. `p ↛ arb` (the primary cannot reach the arbiter; its renewals fail);
2. `p ↛ b` (one other member is unreachable, so the H21 failsafe fails).

The database is `sync` with `sync {a}`. `a` is reachable from `p`, can reach the arbiter, and
answers `p`'s keep-alive. Auto is armed (three data nodes, two zones, a passed recent drill).
Two faults are necessary: without the arbiter loss `p` renews; without the member loss the failsafe
holds forever and `p` keeps serving.

**Minimal trace** (`--scenario w11-failsafe-minimal --seed 3541 --trace`):

```
  0.000s p      initial lease at generation 1, sync {a}; last successful lease write
  6.000s net    p↛arb and p↛b (two faults)
  6.061s p      renew failed: partitioned; failsafe is active
 21.201s p      cannot prove the lease: b has now been silent one TTL; fencing
 21.258s a      WAL receiver down (the primary fenced)
 34.076s a      candidate at generation 2 (lease 1, sync {a}, sync)
 34.293s a      won the CAS at generation 2; pg_ctl promote (4140 ms)
 38.433s a      PRIMARY at generation 2
 38.433s !      bound/time-to-writable-exceeded: 38.4 s from p's last successful renew (worst 30 s)
```

**Why it exceeds the bound.** The clocks are nested:

| Interval | Value in the trace | Spec source |
|---|---|---|
| last successful lease write → lease expiry | 15.0 s | W9 §3 `DB_TTL` |
| lease expiry → primary fence | 6.2 s | H21 failsafe: `b` last answered at ~6 s, so the primary may serve until ~21 s |
| primary fence → last keep-alive answer by `a` | ~2.1 s | `p → a` is up; the last answer is at ~19 s |
| last answer by `a` → eligible | 15.0 s | W11 §4.4 — one TTL, because it answered |
| eligible → candidate CAS | ~0.2 s | detection tick + arbiter RPC |
| CAS → writable | 4.14 s | W11 §5.3 `pg_ctl promote` (allowed ≤ 5 s) |
| **total** | **38.43 s** | §9 says worst ≤ 30 s |

The primary's last renew is at 0 s; the lease expires at 15 s; the H21 failsafe lets the primary
serve until 21.2 s (it is alive and every member answered within the TTL — `b`'s last answer was
just before the 6 s partition). The eligible member `a` answered the primary's keep-alive at ~19 s.
W11 §4.4 then makes `a` wait until 34.0 s, **13 s after the primary has already fenced**. The
`pg_ctl promote` budget (≤ 5 s) takes it to 34–39 s depending on the phase. §9's "a candidate's
target by t≤15 s, writable by t≤22 s" assumes the candidate is free at the lease expiry; the
keep-alive gate can make it a target up to 15 s later, and the allowed promote budget adds up to 5 s.

This is not a race in one seed. The fixed two-fault schedule fails on **2,316 of 5,000 seeds**
(46%), with a worst of **38.43 s**; the `failsafe-keepalive` family fails 64 of 384 runs with a
median of 29.72 s, and the `clock-step` family's 18 failures are the same interaction.

**The spec conflict.** §4.4 says "A replica that answered is not a candidate, even if it can reach
the arbiter." §9 says time to writable is ≤ 30 s from the last successful lease renew. A primary
that keeps serving through the failsafe can keep answering a reachable candidate for a full TTL
after the last renew; when it then fences because a *different* member is silent, the answering
candidate is still blocked for the rest of its own TTL. The two rules cannot both hold in this
fault combination. The model stops here: this is a **spec defect**, not a code defect, and the spec
was not patched. The owner needs to decide the resolution (for example: exempt this fault class from
the bound; make the primary's fence visible to the members so they need not wait a TTL; measure the
keep-alive wait from the last lease renew rather than the last answer; or change the bound).

No other counterexample was found: I3, I11, I12 and I13 are clean across the 5,000 schedules and
the fixed scenarios.

---

## 9. What is not modelled

- **The production implementation.** The model is written from W11-SPEC and the W9 member machine;
  no automatic-failover code was read.
- **The human's manual promotion.** After a refused arming, a mid-sync-change death, or any
  no-eligible-member outcome, the model stops. It does not perform an operator promotion or
  `accept_data_loss`. Those runs have no primary by design.
- **The control-plane service, desired state, endpoints, PITR stanza and alerts.** The reader is a
  logical availability flag plus a row generation. It has no write path.
- **`on_sync_loss: block`** is implemented but not exercised by the default families.
- **A genuinely two-member fleet.** `dataNodes: 2` is a policy refusal; the simulation still has
  three members so that a mutant can promote and be caught.
- **Multiple databases, cross-node placement, regions, the witness arbiter.** Out of scope
  (W11 extends W9).
- **PostgreSQL.** `pg_ctl promote`, `synchronous_commit`, `pg_rewind` and rebuild are delays and a
  history copy, not a database. WAL is an ordered per-member stream with a gap/re-attach rule.
- **The master-key ceremony.** `canPromote` is a flag (W9).
- **Read-only standby HTTP surfaces.** States are roles, not endpoints.
- **Run leases, platform routes, audits.** W9-SPEC §4.6 is out of scope.
- **Clock drift** (100 ppm). Only wall-clock *steps* are modelled; arbiter clock steps are assumed
  away.
- **Network reordering/duplication beyond concurrent RPCs.** The send-time proof rule and the
  stream-epoch gap rule guard the rest. Multi-second response delays are not a schedule family.
- **A lost CAS response** is resolved by a re-read and a proof that the lease names the member at
  `gen+1`; the model does not require the response to arrive. It is not a TTF family, but it does
  not lose the promotion.

---

## 10. Reproduce

```sh
# the full run: 5,000 schedules, ~2.5 s, exits 1 on the counterexample below
bun tests/ha/sim/w11/run.ts --runs 5000

# one family, or one seed with its trace
bun tests/ha/sim/w11/run.ts --runs 500 --family failsafe-keepalive
bun tests/ha/sim/w11/run.ts --runs 1 --seed 9 --trace

# the counterexample: the minimal 2-fault schedule, two deterministic phases
bun tests/ha/sim/w11/run.ts --scenario w11-failsafe-minimal --seed 15 --trace      # 31.68 s
bun tests/ha/sim/w11/run.ts --scenario w11-failsafe-minimal --seed 3541 --trace    # 38.43 s

# the canonical pass cases
bun tests/ha/sim/w11/run.ts --scenario w11-power-off-sync --trace
bun tests/ha/sim/w11/run.ts --scenario w11-partition-arbiter-ok --trace
bun tests/ha/sim/w11/run.ts --scenario w11-partition-isolated --trace
bun tests/ha/sim/w11/run.ts --scenario w11-arbiter-alone --trace
bun tests/ha/sim/w11/run.ts --scenario w11-two-candidates --trace
bun tests/ha/sim/w11/run.ts --scenario w11-control-down --trace
bun tests/ha/sim/w11/run.ts --scenario w11-sync-named-dead --trace
bun tests/ha/sim/w11/run.ts --scenario w11-no-drill --trace
bun tests/ha/sim/w11/run.ts --scenario w11-two-data-nodes --trace
bun tests/ha/sim/w11/run.ts --scenario w11-async-no-accept --trace

# the checker's teeth
bun tests/ha/sim/w11/run.ts --scenario w11-two-data-nodes --mutant arm-anyway
bun tests/ha/sim/w11/run.ts --scenario w11-sync-named-dead --mutant ignore-eligibility
bun tests/ha/sim/w11/run.ts --scenario w11-failsafe-keepalive --mutant ignore-keepalive
bun tests/ha/sim/w11/run.ts --scenario w11-failsafe-keepalive --mutant cas-same-generation
bun tests/ha/sim/w11/run.ts --scenario w11-async-no-accept --mutant async-without-accept
bun tests/ha/sim/w11/run.ts --scenario w11-wall-clock-fence --mutant fence-wall-clock

bun test tests/ha/sim/w11
```
