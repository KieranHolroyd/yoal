# W11 model — automatic database failover, the arming policy, and the fence notice

Step 2 of HA-PLAN §6.4, written from [`W11-SPEC.md`](./W11-SPEC.md) **Revision 4** alone. The
member machine it extends is W9-SPEC §5; the only code reused is the simulator's event-queue/RNG
style in `tests/ha/sim/`. The production implementation of automatic failover was not read.

**Result: no counterexample.** Revision 4's fence notice fixes both Revision 2's one-TTL block and
Revision 3's remaining stream-down tail. A valid notice waives the §4.1 5 s debounce (and the §4.4
keep-alive block); the fixed canonical two-fault schedule over seeds 1–5,000 has **0 seeds over
30 s**, with a worst of **28.123 s**. Without a delivered notice the block and the debounce hold,
and the run is reported as an allowed slower path with an alert, not a bound violation. I3, I11,
I12 and I13 are zero across 5,000 schedules.

| | |
|---|---|
| Model | `tests/ha/sim/w11/` (`spec.ts`, `policy.ts`, `model.ts`, `schedules.ts`, `run.ts`, `w11.test.ts`) |
| Command | `bun tests/ha/sim/w11/run.ts --runs 5000` |
| Runtime | 5,000 schedules in **2.6 s** (~0.52 ms/schedule); 44 unit tests in ~1.5 s |
| Exit code | `0`; 0 violating runs |
| Spec status | **clean under Revision 4** for the checked invariants and the notice path |

---

## 1. What the model is

A deterministic discrete-event world with:

- **one arbiter** — a linearizable object store with conditional `PUT` (`If-Match`), one database
  lease, and an arbiter clock that is authoritative for expiry (W9-SPEC assumption 2);
- **three database members** `p a b`, the W9-SPEC §5 member machine plus the W11-SPEC §4–§5
  automatic-promotion path and the Revision 3–4 fence notice (§1.8, §5.0);
- **one consumer** that polls every member's role/generation every 1–2 s and forwards only to a
  `primary` at the highest generation (W11-SPEC §6); a same-generation tie fails closed;
- **one control-plane reader** with an availability flag. It never decides and never writes a
  lease; on return it reconciles the database row's generation from reports and the lease and
  never lowers it (W11-SPEC §7);
- **the per-database arming policy** as data (`policy.ts`), evaluated at start-up and re-evaluated
  live on the one condition that can change without an operator action (a `sync` database
  downgraded to effective `async`);
- **best-effort fence-notice delivery**: delivered, lost, delayed, duplicated, stale and bad-epoch,
  with a per-target schedule fault;
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
| **notice** | a valid notice for the generation being acquired from waives the §4.1 5 s debounce and the §4.4 one-TTL block. It does **not** waive "the stream is down": the receiver must still have observed not streaming. A notice for another generation, epoch or sender is never used. A fenced primary that cannot deliver its notice is a reported slower path, not a bound failure. |
| **policy** | an automatic promotion with `auto` refused is `promotion-not-armed`; a refused schedule that promotes is `promotion-when-forbidden`. |
| **support** | generations never decrease; a holder change is exactly +1; a member that answered a keep-alive within one TTL does not acquire unless it holds a valid notice. |

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
`fenceNotices` (a map keyed by the generation the sender held), `lostBaseline` (set when it stops
serving, consumed by the next promotion), `promotedAt`, `acquire` (the from-lease, body,
generation, etag, send time and apply time), `fenceTimer`. Schedule hooks: `killAfterOpen`,
`killAfterBarrier`.

The lease's `syncState` (`'steady' | 'changing'`) is the authority; the local change fields are the
primary's progress through it.

### Fence notice (Revisions 3–4)

`FenceNotice { generation, epoch, from, at }`. The sender is the primary's member id; `generation` is
the lease generation it held; `epoch` is the sender's authenticated database term. The model treats
`epoch` as equal to the generation because the W9 database lease has a generation but no separate
epoch; a control-plane epoch is not used by the member machine (H22). A notice is usable only when:

1. `generation === lease.generation` (the generation being acquired from);
2. `from === lease.holderNodeId` (the authenticated sender held that generation);
3. `epoch === generation` (not a bad-epoch forgery).

A valid notice waives **both** the §4.4 one-TTL keep-alive block and the §4.1 5 s stream-down
debounce (Revision 4). It does not waive the requirement that the receiver has observed the stream
not streaming: the notice proves the stream ended because the holder fenced, not that the member
may promote with a live stream. The receiver stores a cross-generation notice (so a stale/future
delivery is observable) but the candidate check above never authorises it. A duplicate is
idempotent.

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

1. its own stream is down — the receiver has observed not streaming. The §4.1 5 s debounce applies
   **unless** the member holds a valid Revision 4 fence notice for the lease generation; the notice
   satisfies the debounce because it proves the stream ended because the holder fenced;
2. the lease has expired by the arbiter's clock (`read.date >= lease.expiresAt`) and the member can
   reach the arbiter;
3. `auto` is enabled for the lease's effective durability (the arming decision plus the live
   `acceptDataLoss` rule);
4. it is eligible: for an effective `sync` lease it is named in the lease's `sync` set; for an
   effective `async` lease `acceptDataLoss` is set;
5. no other member has answered the primary's keep-alive within one TTL **from this member's own
   point of view** (`T - lastAnsweredToPrimary >= 15 s`) — **or** it holds a valid fence notice for
   the lease generation (§1.8/§4.4), in which case the one-TTL block is skipped;
6. it is not already busy with a CAS.

A valid notice therefore removes both settling waits; an invalid, stale, bad-epoch, forged or absent
notice removes neither.

### Promotion (W11-SPEC §5.0–§5.3)

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
- **New** against the lost primary's `lastLeaseApply` (`time-to-writable-exceeded` if > 30 s). A
  fenced primary that could not deliver its notice is classified as an allowed slower path instead
  (§9/§11) and counted separately.

### Fencing primary and the notice (W11-SPEC §1.8, §5.0)

`#fence(member, reason)`:

1. sets `state = 'fencing'`, so every write and agent call is already refused;
2. records the failover baseline and marks it `fenced` (a fence decision, not a crash/freeze);
3. **sends `fencing {generation, epoch}` to every peer immediately** (the model's send is at the
   decision, well within §5.0's 2 s), over the normal RPC path, so a partition, freeze, crash,
   refused edge or delay affects it exactly as it affects a keep-alive;
4. schedules the `fencing → fenced` transition (50–300 ms) after the send attempt. Postgres stops
   after the attempt; delivery is best effort.

The notice is sent by a `fencing` member, not a `primary`; the receiver accepts it from any member
and the candidate check authorises it only against the lease's recorded holder.

Delivery is best effort and the schedule can perturb it per target:

| Mode | Effect |
|---|---|
| `drop` | the notice is not sent; the member has none; the one-TTL block and the 5 s debounce apply |
| `delay` | the send is immediate; the network holds the delivery by `value` ms (≤ 2 s in the families). The member may already have promoted via the TTL/debounce |
| `duplicate` | the notice is sent twice; the receiver's map is idempotent |
| `stale` | the notice names `generation - 1`; it is stored but never authorises the current lease |
| `bad-epoch` | the notice names the current generation with `epoch - 1`; the receiver rejects it |

A cross-generation notice delivered after a promotion is stored and counted
(`fenceNoticeStaleIgnored`) but is never used, because the candidate check requires the lease
generation and the lease holder. A lost response still delivered the notice; the receiver's map is
the truth and the sender's failure counter is only an attempt count.

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
a member that answered cannot promote while the primary may still be serving. The Revision 3–4
notice is the only exception to that gate, and (Revision 4) the only exception to the §4.1 debounce.

A fence is recorded (`fenceEvents`) and, unless it is superseded by a higher generation, marks the
last applied lease write as the time-to-writable baseline. The baseline carries the lost
generation and whether the loss was a fence decision, so the bound can be judged only when the
notice path was actually available.

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
  lastLeaseApply` is recorded. If the baseline is a **fence** and the promoter does **not** hold a
  valid notice for the lost generation, the one-TTL block and the 5 s debounce are expected; a
  latency > 30 s is the spec's allowed **slower path** (stats, `slowPathLatenciesMs`, alert) rather
  than a bound violation. If the notice was held, or the loss was a crash/freeze, > 30,000 ms is
  `bound/time-to-writable-exceeded`. The runner checks the median over all judged samples
  ≤ 25,000 ms. A sample is not judged when the schedule marks `expect.ttf: false` (an arbiter
  outage for every member, or a primary that kept serving through the failsafe and only fences
  after the outage): §10 says no promotion is possible while the arbiter is away.
- **Notice.** A candidate that answered a keep-alive within one TTL or whose stream has not been
  down for 5 s must not CAS unless it holds a valid notice for the generation being acquired from,
  from the lease's holder, with a matching epoch. A notice for another generation is stored and
  counted but never authorises. A notice never authorises a live stream: the receiver must have
  observed not streaming.
- **I11.** Each schedule may attach `failover`, `noPrimary`, `requireAcks`, `primaryStays`,
  `controlDown` and `autoRefused` expectations. `finalize()` counts acknowledged writes in the
  windows, finds the first promotion after the loss, checks the row generation, and forbids a fence
  of a primary that must keep serving.
- **Support.** `lease-generation-decreased`, `lease-holder-change-not-plus-one`,
  `acquired-too-early-after-keepalive` (the notice is the only exception).

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
| `trust-stale-notice` | `--scenario w11-failsafe-notice-stale` | **support/acquired-too-early-after-keepalive**: a cross-generation notice is trusted and the one-TTL block is skipped |

The I3 checker is also exercised directly: `forcePrimaryForTest('a', 1)` +
`forcePrimaryForTest('b', 1)` raises `two-primary-same-generation` (`w11.test.ts`).

---

## 5. Assumptions

These are the model's reading of W11-SPEC Revision 4. A different reading changes the result.

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
16. **The notice's `epoch` is the sender's database term, equal to the generation.** W9-SPEC §5.1
    has a generation but no separate database epoch; the model carries both fields and requires
    both to name the generation being acquired from. A control-plane epoch is not consulted
    (H22). The receiver stores cross-generation notices but the candidate check is the authority.
17. **A valid notice waives both settling waits, not the stream-down fact.** Revision 4 says the
    notice satisfies the §4.1 debounce; it does not say a member may promote with a live stream.
    The model therefore requires the receiver to have observed not streaming and waives only the
    5 s duration and the §4.4 TTL block. This is the conservative reading; it already meets the
    bound (fixed canonical worst 28.123 s).
18. **The notice is best effort.** Lost, delayed, duplicated, stale and bad-epoch deliveries are
    schedules. The primary's send is immediate at the fence decision (within §5.0's 2 s); a
    `delay` fault holds the network delivery, not the primary's send. A lost notice falls back to
    the TTL/debounce rules and is reported with an alert, as §9 requires. A notice is not a lease
    write and cannot itself authorise a promotion without an expired lease.
19. **A primary that keeps serving through the failsafe is not a failover.** For the clean
    `failsafe-keepalive` family the primary serves for the whole arbiter outage; a post-return
    fence is a recovery, not the §9 clock. The model marks that schedule `ttf: false` and does not
    judge its post-outage promotion against the bound. The canonical two-fault mixed case (primary
    cannot renew and one member is silent) **is** judged.

---

## 6. Schedules

Each family is generated from the seed (family = `seed % 14`; `--family` fixes it). A schedule is
data, printed by `--scenario`/`--trace`.

| Family | What it does |
|---|---|
| `power-off` | the primary is powered off at 4–12 s; sync or async; one promotion, TTF |
| `freeze` | the primary process freezes 22–50 s; the lease expires by the arbiter clock; a successor promotes; the stale leader resumes |
| `partition-arbiter-ok` | the primary loses both replicas but keeps the arbiter; it renews, no failover, traffic continues |
| `partition-isolated` | the primary loses the arbiter and both replicas; it fences; an eligible replica with arbiter access promotes; the notice attempt cannot reach anyone, so the TTL block and the debounce are already satisfied by the lease expiry (TTF 18–25 s) |
| `arbiter-outage` | all members lose the arbiter 15–32 s; variant A keeps the primary via the failsafe, variant B also loses a member (fence, no promotion while the arbiter is away) |
| `two-candidates` | async + `acceptDataLoss`; the primary is isolated from the arbiter and both replicas; both candidates race the CAS; one wins, the loser re-follows |
| `stale-leader` | the primary freezes 25–50 s, a successor promotes, then the stale leader resumes and fences; its gen-1 notice is cross-generation to the gen-2 members and is ignored |
| `clock-step` | a wall clock steps ±30–120 s on a member, sometimes with the primary losing the arbiter and one or both replicas; the step is inert. When the eligible replica is still reachable, 30 % of runs drop its notice to exercise the slower path |
| `sync-named-dead` | the sync set names a dead member; variants: the primary closes a fresh set to `a` then dies; the primary dies before the close; both die; async + accept |
| `failsafe-keepalive` | the primary answers keep-alives while its own stream is down. Variant A keeps serving with all peers answering (no failover, `ttf: false` for the post-outage recovery). Variant B is the canonical two-fault mixed case; 35 % of those runs drop the eligible member's notice |
| `control-down` | the control plane is down for 50–100 s and the primary is killed 3 s later; failover and traffic continue; the row never falls (I11) |
| `refusal` | one of the eleven refusal rules or `manual`; the primary is killed; no automatic promotion |
| `fence-notice` | the canonical two-fault case with the notice delivered (50 %) or dropped, delayed (≤ 2 s), duplicated, stale or bad-epoch (the remaining 50 %); the notice is sent to the eligible member `a` |
| `mixed` | 2–4 of the above; invariants always run; the TTF is not judged (a global arbiter outage can be inside the mix) |

Fixed scenarios (the report's names): `w11-power-off-sync`, `w11-power-off-async`, `w11-freeze`,
`w11-partition-arbiter-ok`, `w11-partition-isolated`, `w11-arbiter-alone`,
`w11-arbiter-plus-member`, `w11-two-candidates`, `w11-stale-leader`, `w11-sync-named-dead`,
`w11-sync-named-dead-then-close`, `w11-no-drill`, `w11-two-data-nodes`, `w11-async-no-accept`,
`w11-control-down`, `w11-failsafe-keepalive`, `w11-failsafe-minimal`,
`w11-failsafe-notice-lost`, `w11-failsafe-notice-delayed`,
`w11-failsafe-notice-duplicated`, `w11-failsafe-notice-stale`, `w11-wall-clock-fence`.

---

## 7. Results

### The 5,000-schedule family run

`bun tests/ha/sim/w11/run.ts --runs 5000`, 5,000 schedules over 14 families, **2.6 s**, exit **0**:

| Family | Runs | Promotions | Acks | Losses | Fences | Candidates | Lost CAS | Control promos | Strict ms (total / max) | Median TTF | Worst TTF | Notice delivered | Notice missed | Slow path | Slow med | Slow worst | Violations |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `power-off` | 357 | 357 | 37,123 | 357 | 0 | 387 | 30 | 0 | 0 / 0 | 18.25 | 21.21 | 0 | 0 | 0 | — | — | none |
| `freeze` | 358 | 358 | 31,629 | 358 | 358 | 386 | 28 | 0 | 0 / 0 | 18.47 | 22.00 | 716 | 0 | 0 | — | — | none |
| `partition-arbiter-ok` | 358 | 0 | 35,304 | 0 | 0 | 0 | 0 | 0 | 0 / 0 | — | — | 0 | 0 | 0 | — | — | none |
| `partition-isolated` | 357 | 357 | 39,579 | 357 | 357 | 390 | 33 | 0 | 490 / 282 | 18.36 | 25.06 | 0 | 354 | 0 | — | — | none |
| `arbiter-outage` | 357 | 177 | 32,353 | 177 | 177 | 203 | 26 | 0 | 0 / 0 | — | — | 181 | 0 | 0 | — | — | none |
| `two-candidates` | 357 | 357 | 35,587 | 357 | 357 | 426 | 69 | 0 | 1,059 / 487 | 18.05 | 20.99 | 0 | 351 | 0 | — | — | none |
| `stale-leader` | 357 | 357 | 34,204 | 357 | 357 | 385 | 28 | 0 | 0 / 0 | 18.33 | 21.08 | 714 | 0 | 0 | — | — | none |
| `clock-step` | 357 | 194 | 42,726 | 194 | 194 | 206 | 12 | 0 | 369 / 194 | 18.44 | 29.79 | 73 | 167 | 6 | 30.61 | 32.02 | none |
| `sync-named-dead` | 357 | 177 | 19,367 | 357 | 0 | 177 | 0 | 0 | 0 / 0 | 18.61 | 25.30 | 0 | 0 | 0 | — | — | none |
| `failsafe-keepalive` | 357 | 120 | 37,008 | 120 | 120 | 121 | 1 | 0 | 0 / 0 | 19.85 | 29.90 | 80 | 44 | 24 | 30.74 | 32.16 | none |
| `control-down` | 357 | 357 | 42,206 | 357 | 0 | 390 | 33 | 357 | 0 / 0 | 18.36 | 21.19 | 0 | 0 | 0 | — | — | none |
| `refusal` | 357 | 0 | 3,631 | 357 | 0 | 0 | 0 | 0 | 0 / 0 | — | — | 0 | 0 | 0 | — | — | none |
| `fence-notice` | 357 | 357 | 46,187 | 357 | 357 | 357 | 0 | 0 | 0 / 0 | 19.63 | **30.00** | 312 | 104 | 50 | 30.78 | 33.09 | none |
| `mixed` | 357 | 171 | 45,677 | 179 | 116 | 183 | 12 | 32 | 0 / 0 | — | — | 156 | 0 | 0 | — | — | none |
| **total** | **5,000** | **3,339** | **482,581** | **3,884** | **2,393** | **3,611** | **272** | **389** | **1,918 / 487** | **18.48** | **30.00** | **2,232** | **1,020** | **80** | **30.78** | **33.09** | **0 runs** |

- **I3, I11, I12 and I13: zero violations** in all 5,000 schedules.
- **The New bound: zero violating runs.** The judged median is **18.48 s**; the judged worst is
  **30.00 s** (the `fence-notice` family, at the bound; no sample exceeds 30,000 ms).
- **With a delivered notice:** the `fence-notice` family's median is **19.63 s** (down from 25.09 in
  Rev 3), and its worst is 30.00 s. The `failsafe-keepalive` judged median is **19.85 s** (down from
  25.43), worst 29.90. The `clock-step` judged worst is 29.79.
- **Without a delivered notice:** 80 promotions take the allowed slower path, median **30.78 s**,
  worst **33.09 s**, each with an alert. They are not counted as bound violations, exactly as
  §9/§11 permit. `fence-notice` contributes 50, `failsafe-keepalive` 24, `clock-step` 6.
- **`fence-notice`** is the direct Rev 4 family: 312 notices delivered to the eligible member, 104
  promotions without one (drop/stale/bad-epoch/delayed-past-the-window), 50 slower-path samples.
  The delivered half is within the bound.
- **`failsafe-keepalive`**: 80 delivered, 44 misses, 24 slower paths (median 30.74, worst 32.16);
  the judged worst is 29.90. The clean variant is `ttf: false` (the primary kept serving).
- **`partition-isolated`** and `two-candidates` have zero delivered notices (the primary is
  partitioned from both members), 354/351 misses, and **no slow path**: the members' last answers
  aged from the fault, so the TTL block and the debounce are satisfied by the lease expiry.
- **`arbiter-outage`**: 181 delivered notices; variant A keeps the primary, variant B fences and no
  promotion happens inside the outage. The post-outage recoveries are not judged (`ttfExempt`).
- **`control-down`**: 357 promotions and 42,206 acks while the control plane was down; the row
  reconciled and never fell. **`refusal`**: 0 promotions in 357 runs.
- **`sync-named-dead`**: 177 promotions, all in the variants where the lease names the promoter at
  the acquired generation or the async path is accepted; the unnamed member never promoted; I13
  zero. The variant-0 kill is 10 s after the member death so the `b → a` close does not race it.
- **Strict overlap** (two primaries at different generations) totals 1,918 ms, worst 487 ms in
  `two-candidates`; no acknowledged write was lost (I13's ack check would have fired).

### The targeted canonical probe

The fixed `w11-failsafe-minimal` schedule (two faults: `p↛arb` and `p↛b`, lease `sync {a}`) over
seeds 1–5,000, with the notice delivered:

| | |
|---|---|
| judged samples | 5,000 |
| over 30 s | **0** |
| slow path | 0 (the notice was delivered) |
| worst | **28.123 s** (seed 3071) |
| seed 3752 (the Rev-3 counterexample) | **23.79 s** (Rev 3: 33.46 s) |
| without the notice (drop), seed 3541 | **38.43 s**, reported as a slower path with an alert, **no bound violation** |

The delivered canonical is clean across the whole seed range. The 5,000 family run's
`fence-notice` worst is exactly 30.00 s because one randomised phase sits at the bound; no sample
exceeds it.

---

## 8. Counterexamples: none under Revision 4

### 8.1 What Revision 4 fixed

Revision 2's counterexample was the §4.4 one-TTL keep-alive block (38.43 s). Revision 3's notice
fixed the block when delivered but left the §4.1 5 s stream-down debounce: at seed 3752 the fixed
canonical was **33.46 s** even with the notice delivered, because the primary kept the WAL stream
to `a` up until it fenced, so the debounce started after the lease expiry. Revision 4 makes a valid
notice satisfy the debounce as well. The same seed is now **23.79 s**; the fixed canonical over
seeds 1–5,000 has **0 seeds over 30 s**, worst **28.123 s** (seed 3071).

The trace now shows the notice doing both jobs:

```
 21.388s p   cannot prove the lease (b silent one TTL); fencing
 21.479s a   received fence notice for generation 1
 22.311s a   WAL receiver down
 22.390s a   candidate at generation 2   ← the notice waived the 5 s debounce
 22.480s a   won the CAS; pg_ctl promote (1306 ms)
 23.786s a   PRIMARY at generation 2
 23.786s a   time to writable 23.79 s from p's last lease renew
```

### 8.2 Without delivery the block and the debounce hold

`w11-failsafe-notice-lost` at seed 3541 is **38.43 s**, with `fenceNoticeMisses=1`,
`fenceNoticeAlerts=1`, `slowPathLatenciesMs`, and **no** `time-to-writable-exceeded`. The 5,000 run's
80 slower paths (median 30.78, worst 33.09) are the same path, exactly as §9/§11 permit. A stale,
bad-epoch, forged or duplicate-only-with-the-wrong-generation notice does not waive either wait.

**No counterexample was found under Revision 4.** The fixed canonical and the 5,000-schedule run
have no I3/I11/I12/I13 violation and no judged sample over 30 s.

---

## 9. What is not modelled

- **The production implementation.** The model is written from W11-SPEC and the W9 member machine;
  no automatic-failover code was read.
- **The human's manual promotion.** After a refused arming, a mid-sync-change death, or any
  no-eligible-member outcome, the model stops. It does not perform an operator promotion or
  `accept_data_loss`. Those runs have no primary by design.
- **The control-plane service, desired state, endpoints, PITR stanza and alerts.** The reader is a
  logical availability flag plus a row generation. It has no write path.
- **Notice authentication beyond the model's three checks.** The notice is authenticated by
  `from === lease.holderNodeId`, the generation, and the epoch; the model does not model mTLS,
  signatures or a control-plane epoch. A forged notice from another member is rejected by the
  `from` check; a stale/future one is stored but never authorises.
- **The 2 s send deadline as a delivered guarantee.** The model sends at the fence decision
  (0 s); a `delay` fault holds the network delivery (≤ 2 s in the families), not the primary's
  send. A network that delays the notice beyond the window falls back to the TTL/debounce path.
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
- **Network reordering/duplication beyond concurrent RPCs and the notice modes.** The send-time
  proof rule, the stream-epoch gap rule and the notice's generation/from/epoch check guard the rest.
- **A lost CAS response** is resolved by a re-read and a proof that the lease names the member at
  `gen+1`; the model does not require the response to arrive. It is not a TTF family, but it does
  not lose the promotion.
- **A primary that keeps serving through a long arbiter outage and then fences on return.** Its
  post-outage recovery is a liveness path, not the §9 clock; the clean `failsafe-keepalive`
  variant marks it `ttf: false` (assumption 19).

---

## 10. Reproduce

```sh
# the full run: 5,000 schedules, ~2.6 s, exit 0
bun tests/ha/sim/w11/run.ts --runs 5000

# one family, or one seed with its trace
bun tests/ha/sim/w11/run.ts --runs 500 --family fence-notice
bun tests/ha/sim/w11/run.ts --runs 1 --seed 3752 --family fence-notice --trace

# the canonical two-fault case, with the notice delivered
bun tests/ha/sim/w11/run.ts --scenario w11-failsafe-minimal --seed 15 --trace      # 18.47 s
bun tests/ha/sim/w11/run.ts --scenario w11-failsafe-minimal --seed 3541 --trace    # 25.42 s
bun tests/ha/sim/w11/run.ts --scenario w11-failsafe-minimal --seed 3752 --trace    # 23.79 s
# seeds 1-5000: 0 over 30 s, worst 28.123 s (seed 3071); the unit test runs the loop

# without delivery: the one-TTL block and the debounce hold; reported as a slower path with an alert
bun tests/ha/sim/w11/run.ts --scenario w11-failsafe-notice-lost --seed 3541 --trace  # 38.43 s
bun tests/ha/sim/w11/run.ts --scenario w11-failsafe-notice-stale --seed 3752 --trace # 35.05 s

# best-effort delivery variants
bun tests/ha/sim/w11/run.ts --scenario w11-failsafe-notice-delayed --seed 3752 --trace
bun tests/ha/sim/w11/run.ts --scenario w11-failsafe-notice-duplicated --seed 3752 --trace
bun tests/ha/sim/w11/run.ts --scenario w11-failsafe-notice-stale --trace
bun tests/ha/sim/w11/run.ts --scenario w11-failsafe-notice-stale --mutant trust-stale-notice --trace

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
