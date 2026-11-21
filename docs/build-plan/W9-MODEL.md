# W9 model — control-plane and database member machines (Revision 2)

Step 2 of HA-PLAN §6.4, written from [`W9-SPEC.md`](./W9-SPEC.md) **Revision 2** alone. The
production lease and database-member code (`packages/core/src/ha-lease.ts` and the member machine)
was not read; the only existing code reused is the simulator's event-queue/RNG style
(`tests/ha/sim/`).

**Result: no counterexample under Revision 2.** The Revision 1 counterexample is the regression
schedule `sync-change-minimal` and is safe (`changing`, no promotion, I13 zero). Revision 2 adds
the control-plane outage path: the node applies the `on_sync_loss` setting at its last observed ETag
while the control plane is away, reports it, and the control plane reconciles a stale ETag by
**never recording `sync`** — it re-opens a fresh barrier if the lease names a healthy member,
otherwise records the policy outcome — and alerts. The full suite is **5,000 schedules over 13
families with 0 violations**: 384 control-plane outages with the sync standby lost, 384 local
`on_sync_loss` applications, 11 same-ETag and 763 stale reconciliations, 337 fresh-barrier
re-opens, 774 alerts, and 384 transient outages with no reports and no alert.

| | |
|---|---|
| Model | `tests/ha/sim/w9/` (`spec.ts`, `model.ts`, `schedules.ts`, `run.ts`, `w9.test.ts`) |
| Command | `bun tests/ha/sim/w9/run.ts --runs 5000` |
| Runtime | 5,000 schedules in ~7.5 s on a laptop (~1.5 ms/schedule); 22 unit tests in ~0.7 s |
| Exit code | `1` if any violation; Revision 2 produces none |

---

## 1. What the model is

A deterministic discrete-event world with:

- **one arbiter** — a linearizable object store with conditional `PUT` (`If-Match`,
  `If-None-Match: *`), one object for the control lease and one for the database lease;
- **three control nodes** `c0 c1 c2`, the W9-SPEC §4 state machine;
- **three database members** `p a b`, the W9-SPEC §5 state machine;
- **one consumer** that polls every member's role/generation and forwards writes to the highest
  generation that answers `primary` (W9-SPEC §5.6), with no control-plane dependency;
- a directed reachability graph (asymmetric partitions are expressible) and a drawn round-trip
  latency per RPC.

Time is a virtual millisecond counter. A run is a pure function of the seed and the schedule;
`w9.test.ts` asserts that a seed replays an identical trace and stats. The database is one object
with `p` primary and `a`/`b` replicas at generation 1; the control plane starts empty and `c0`
creates the lease at epoch 1. `b` is the initial synchronous standby.

The checker runs after every event:

| Id | Check |
|---|---|
| **I3** | no two members in `primary` at one generation; no two control nodes in `primary` at one epoch. The *strict* count (two primaries at any generation) is also measured. |
| **I12** | a promotion on a `sync` database only happens when the acquired-from lease is `syncState: 'steady'` **and** names the promoter in `sync`; a promotion while `changing` is `promotion-during-sync-change`. |
| **I13** | at every promotion, and at the end of the run, the promoted member's history contains every commit acknowledged under `sync`; and an ack is not issued by an old primary while a higher-generation primary exists without the commit. This includes a promotion after a primary dies in the middle of a sync-set change. |
| **I11** | schedule expectations: a control-plane outage must not stop traffic or a database failover when the arbiter is reachable; an arbiter outage must not produce a promotion. |
| **support** | lease epochs/generations never decrease and change by exactly +1 on a takeover; a member that answered a keep-alive within one TTL does not acquire (§5.3); a promotion while `changing` is separately reported. |

---

## 2. State variables

### Arbiter

| Variable | Meaning |
|---|---|
| `#controlStore`, `#dbStore` | `{ body, etag, appliedAt }`, or absent for the control lease |
| `etag` | fresh on every successful conditional write; a stale `If-Match` gets 412 |
| clock | virtual `T`; the authority for every expiry comparison |

The arbiter applies a write at the request's arrival and answers with its current `T`. A lost
response still applied the write; the caller sees a timeout and must re-read.

### Control node (`ControlNode`)

`state ∈ {joining, standby, standby-behind, promoting, primary, fenced, unavailable}`,
`epoch` (highest seen, persisted across a restart), `alive`, `frozenUntil`, `wallOffset`,
`canPromote` (master key ∧ allowlisted config ∧ migrations ∧ replay), `observedEtag` and
`observedSince` (the 40 s quiet window), `lease`, `leaseEtag`, `lastServerDate` + `serverAt`
(the server-now estimate), `lastConfirmed` (last successful renew/takeover, monotonic),
`lastRenewSent`, `fenceTimer`.

### Database member (`DbMember`)

`state ∈ {streaming, candidate, promoting, primary, fencing, fenced, rewind}`, `generation`,
`history` (the set of commit ids it has applied), `alive`, `frozenUntil`, `wallOffset`, `lease`,
`leaseEtag`, `lastServerDate` + `serverAt`, `durability` / `durabilityEffective`, `streamFrom`,
`streamEpoch` (invalidates in-flight WAL on a stream gap), `replAt` (per-peer ordered delivery),
`lastProof` / `lastProofWall` (the renewal proof window), `lastRenewOk`, `peerLastAnswer` (the
primary's keep-alive view), `lastAnsweredToPrimary` (the member's own view, which gates
acquisition), `localAsync` (Revision 2: the node applied the on_sync_loss setting locally while the
control plane was away).

**Revision 1 change fields:** `effectiveSync` (the PG setting in force), `changePhase`
(`null | 'opening' | 'switching'`), `changeTarget`, `changeOld`, `changeOpenedAt`,
`changeTimeoutAt` (open + 30 s), `barrierId`, `barrierSnapshot` (the primary's history at barrier
issue), `killAfterOpen`, `killAfterBarrier` (schedule hooks), `syncLostSince`, `syncDowngradeAt`.

The lease's `syncState` (`'steady' | 'changing'`) is the authority; the local change fields are the
primary's progress through it.

### Sync reconciler (Revision 2)

A logical control-plane writer for the sync fields, separate from the control-lease nodes. It has
`available`, a queue of `SyncReport { etag, applied: 'async' | 'block' | { sync }, at }`, and an
alert count. The database renewals go straight to the arbiter; the reconciler outage is a logical
control-plane outage, not an arbiter outage.

### Commit / write

`Commit { id, gen, acceptedBy, durability, acked, ackAt, waitFor }`. A commit is **acknowledged**
when the durability rule says it is durable, not when the client receives the ack:

- `async` — on acceptance by the primary;
- `sync` — when the member named by `effectiveSync` has it (the actual
  `synchronous_standby_names`, not the lease's recorded set);
- a pending ack is only released while the accepting primary is still serving, or when the current
  highest-generation primary has the commit. A fenced node must not tell a client a write committed
  if the new primary does not have it;
- the I13 obligation is recorded with the **durability in force at ack time**: a commit accepted
  under `sync` but first acknowledged after the recorded `on_sync_loss` downgrade is `async`.

The barrier is an internal commit (no client) appended to the primary's history and shipped in WAL
order. The client also has a 30 s write timeout; a timed-out write is not acknowledged.

### Consumer

Cached highest-generation `primary` answer, refreshed 1–2 s; a write every 0.5–0.9 s to that cached
target; fail-closed when no member answers `primary`. No control-plane call, ever.

---

## 3. Transitions

### Control plane (W9-SPEC §4)

| From | To | Trigger |
|---|---|---|
| `joining` | `standby` | replica restored/replay current (short delay) |
| `standby` | `promoting` | lease unchanged for 40 s **and** expired by the arbiter's date **and** `canPromote`, then a CAS at `epoch+1` wins |
| `promoting` | `primary` | `canPromote` (0.2–0.8 s) |
| `primary` | `fenced` | a renew 409/412 (after a re-read shows another holder), a higher epoch, or 20 s without confirmation |
| `fenced` | `standby` | 5 s after fencing (simplified; the spec says "after the holder is stable") |
| `standby`/`unavailable` | `unavailable`/`standby` | errors persist longer than one TTL / a read succeeds |
| any | `joining` after a crash | restart: epoch persisted |

A renew that loses the CAS re-reads; if it is still the holder at its epoch it retries, else it
fences. The control plane has **no keep-alive quorum**: an arbiter outage alone fences it after 20 s
(W9-SPEC decision 1).

### Database member (W9-SPEC §5)

| From | To | Trigger |
|---|---|---|
| `streaming` | `candidate` | stream down **and** lease expired by the arbiter's date **and** `syncState === 'steady'` **and** eligible **and** it did not answer a keep-alive within one TTL |
| `candidate` | `promoting` | the CAS at `generation+1` wins |
| `candidate` | `streaming` | the CAS loses (412) or errors: re-read, never retry blindly |
| `promoting` | `primary` | `pg_ctl promote` (0.3–5 s) |
| `primary` | `fencing` | 15 s without a proof and the failsafe does not hold, a 412/higher generation, or a consumer role poll after the proof expired |
| `fencing` | `fenced` | 50–300 ms to stop Postgres / set read-only |
| `fenced` | `rewind` → `streaming` | a higher-generation primary is reachable; history is replaced by the new primary's |
| `primary` | keeps running past one TTL | **only** when the arbiter is unreachable **and** every member answered a keep-alive within 15 s (H21 failsafe) |

A renewal's proof window starts at the **request send time**; a promotion's proof starts at the CAS
send time, not at `pg_ctl promote` completion. `primary` renews every 5 s and drives the sync
transition below.

### The Revision 1 sync change (W9-SPEC §5.5)

The lease carries `syncState`. A change is made only from `steady`, and while it is open the lease
is `changing` with `sync: []`, so **no member may acquire automatically**:

1. **Open.** CAS the lease to `sync: []`, `syncState: 'changing'`, same generation. The primary's
   `effectiveSync` stays the old member during this step, so commits are still acknowledged by the
   old synchronous standby (or block, if it is the lost one).
2. **Switch + barrier.** Set `effectiveSync` to the new member, append an internal barrier commit
   to the primary's WAL and ship it. The barrier holds only when the new member's history contains
   the **whole snapshot** the primary had at barrier issue — with ordered WAL that means every
   earlier acknowledged commit too.
3. **Close.** CAS the lease to `sync: [new]`, `syncState: 'steady'`. Only now is the new member
   eligible. If the barrier cannot be acknowledged within 30 s: close with the new set only if it
   was acknowledged; otherwise fall back to the old member if it is healthy, or apply
   `on_sync_loss` (`downgrade` → `durability_effective = async`, `sync: []`, `steady`; or `block` →
   `sync: []`, `steady`, no eligible member).

If the primary dies while `changing`, no automatic promotion happens and the lease stays `changing`
until it expires. The model deliberately does not perform the human choice (promote the old member
or `accept_data_loss` for the new one); such runs end without a primary. That is the designed
safety outcome, not a liveness failure.

A new primary with `durability: sync` and no effective standby runs the same transition to pick one.
A fallback is safe because the old member was the effective sync standby during `opening`, and a
barrier that fails means no later commit was acknowledged through the new member (ordered WAL).

### Revision 2: the control-plane outage path

When the sync reconciler is unavailable the primary cannot open or close a transition (the CAS is
the control plane's). After a sync standby is lost it waits `SYNC_DOWNGRADE_AFTER` (30 s), then:

1. **Apply locally.** Set `effectiveSync` off (or to block) and `durabilityEffective = async` on the
   node, acknowledge the blocked writes, and keep renewing the lease. The lease is **not** touched;
   it still records the last `sync`/`syncState`/durability. The local setting is the effective
   durability for acknowledgements from this moment.
2. **Report.** Queue `{ etag: the last observed lease etag, applied: 'async' | 'block' }`. The node
   does not write the lease.
3. **Reconcile on return.** The reconciler reads the current lease:
   - **Same ETag**: record the applied value (CAS `sync: [], durability_effective = async/block,
     steady`) and alert.
   - **Stale ETag**: **never record `sync`**. If the lease is `steady` and names a healthy member,
     re-open a fresh transition with that member (open → switch → barrier → close); otherwise record
     the `on_sync_loss` outcome (`sync: []`, async, steady) or `block`. Alert either way.
   - A report whose lease has no serving holder is left for the next primary; that primary queues
     its own report.

The same-ETag path is a narrow race with the 5 s renewal: a report that lands after a renewal is
stale. Both paths are safe; only the stale path forbids `sync`. `record-sync-on-stale` is the
deliberately wrong mutant.

### Ordered WAL

A primary appends a commit to its history on acceptance and ships it to every member whose
`streamFrom` is the primary. Delivery times are monotone per peer. If a delivery cannot be made
(partition, lag, lost in flight), the stream **detaches** (`streamEpoch++` invalidates everything
already in flight) and the receiver re-attaches only after copying the primary's whole history.
This is what makes the barrier's "the new member has the barrier" imply "every earlier acknowledged
commit is on it". A fenced old primary copies the new primary's history when it rewinds, discarding
its divergent tail.

---

## 4. Properties, exactly

- **I3.** After every event, group members in `primary` by `generation`; a group of two or more is
  `I3/two-primary-same-generation`. Group control `primary` by `epoch` likewise. The arbiter also
  rejects (and reports) a holder change at the same generation/epoch and a decrease.
- **I12.** At the transition to `primary`, the lease read at the successful CAS is the authority:
  if its `syncState` is not `steady`, report `promotion-during-sync-change`; if `durability` is
  `sync` and its `sync` does not contain the promoter, report `promotion-not-in-sync-set`.
- **I13.** Judged under the durability the acquired lease records. At every promotion from a
  `durability_effective: 'sync'` lease, every commit in the global `acked` map with
  `durability === 'sync'` must be in the promoter's history; a promotion from a lease that records
  `async` is an async failover (the `on_sync_loss` downgrade's accepted RPO > 0) and is exempt. At
  the end of the run, the final primary's lease decides. At every ack, if a higher-generation primary
  exists, records `sync`, and does not hold the commit, report `ack-lost-to-higher-primary`. A
  commit's `durability` is the one in force when the client was told it committed, so commits
  acknowledged after the local async application are exempt.
- **Revision 2 rule.** A `sync` record written from a report whose ETag differs from the current
  lease is `support/stale-sync-recorded`. The normal reconciler never does it; the mutant does.
- **I11.** Each schedule may attach `controlOutage`, `requireAcks`, `failover` and `noPrimary`
  expectations; `finalize()` counts delivered acks in the windows and the first promotion after the
  loss. The failover bound is 35 s (H22's budget is 25 s; the model allows the detection/keep-alive
  phase), or the fault duration + 35 s when the only eligible replica is deliberately kept away from
  the arbiter.
- **Support.** `lease-epoch-decreased`, `lease-generation-decreased`,
  `lease-holder-change-not-plus-one` (a takeover must be exactly +1; a same-holder takeover is legal),
  `acquired-too-early-after-keepalive`.

---

## 5. Assumptions

These are the model's reading of Revision 1. A different reading changes the result.

1. **The arbiter is linearizable** and its conditional write is atomic (W9-SPEC assumption 1). No
   stale reads, no lost update.
2. **The arbiter clock is monotone** and authoritative for expiry (assumption 2). Node timers are
   monotone; a node's wall clock is never used for a safety decision, so a wall-clock step is inert.
   The model does not step the arbiter's clock.
3. **"now" in `expiresAt = now + TTL` is the node's best estimate of the arbiter's clock**: the last
   server `Date` plus elapsed monotonic time. Using the raw stale `Date` would make the lease expire
   up to one renew interval before the node's local fence window; the model does the safe thing.
4. **A renewal is proved at its send time.** The apply time is ≥ send; the response receipt can be
   later. Likewise a promotion's proof starts at the CAS send, not at `pg_ctl promote` completion.
5. **RPC legs are short**: 5–120 ms each way normally, ≤1.5 s under a fault. A partition either
   refuses (fast error) or black-holes (700 ms timeout).
6. **The three steps are separate operations.** The model switches the setting in the open
   callback and checks the barrier on the 1 s primary tick; the barrier's 30 s timeout is the
   spec's `SYNC_CHANGE_TIMEOUT`. A crash between any two steps is a schedule.
7. **WAL is ordered and gap-free per member** (the stream detaches on a gap and re-attaches only
   after a catch-up copy). This is what the barrier argument depends on; the model enforces it.
8. **Revision 2's sync reconciler is a logical control-plane writer**, separate from the
   control-lease nodes. Its outage (`sync-control-outage`) does not stop database renewals, the
   arbiter, or traffic; it stops the sync-state CAS.
9. **The node's locally applied setting is the effective durability at ack time.** The lease can lag
   during the outage by design; the reconciler records the outcome on return. A promotion from the
   stale sync lease is safe because only the recorded sync standby is eligible and it holds the
   pre-loss sync acks; a promotion after the reconciler records `async` is an async failover.
10. **The report carries the last observed lease ETag.** A renewal changes it, so a report older than
    the next renewal is stale; the same-ETag path is a race. The reconciler never treats a stale
    report as a `sync` record.
11. **The normal node applies only the on_sync_loss outcome** (async or block) locally. A new `sync`
    selection needs the fresh barrier; `node-applies-sync` is a deliberately wrong node.
12. **Promotions are automatic only.** `accept_data_loss` is never set automatically; a member not in
    the sync set, or any member while `changing`, cannot promote. `on_sync_loss` defaults to
    `downgrade` after 30 s.
13. **One database, three members, three control nodes.** `p` is the initial primary; `a` and `b` are
    replicas; `b` is the initial synchronous standby. A two-member fleet and a multi-database fleet
    are not modelled.
14. **A fenced/crashed old primary does not serve.** A restart is `fenced`; a freeze is fenced on
    resume if the proof expired; it can rewind and rejoin as a replica.
15. **After a mid-change death the model does not perform the human's manual promotion**; those
    runs simply have no primary.
16. **No operator force-promote, no control-plane-driven failover.** The control plane is a separate
    process that reads and writes its own lease; the database never consults it (H22).

---

## 6. Schedules

Each family is generated from the seed (family = `seed % 13`; `--family` fixes it). A schedule is
data, printed by `--scenario`/`--trace`.

| Family | What it does |
|---|---|
| `renew-loss` | the primary loses the arbiter for 8–24 s, with and without a peer partition; tests the H21 failsafe, the peer fence, and the eligible replica's acquisition |
| `cas-race` | the primary is isolated from the arbiter and both replicas (async database), so both replicas race the CAS; a control holder is also isolated so two control standbys race the epoch CAS |
| `arbiter-outage` | all members lose the arbiter for 15–32 s, with and without a member unreachable: variant A keeps the primary via the failsafe, variant B fences it and forbids any promotion (`noPrimary`) |
| `asymmetric` | three directed patterns: A reaches the arbiter while B cannot; B reaches the arbiter and A while P cannot; the arbiter's *return* path to P is broken |
| `clock-step` | a wall clock steps back or forward 30–120 s on a member or control node during a lease, sometimes with the primary's renewals lost |
| `stale-leader` | a member or the control holder freezes 20–50 s, a successor promotes, then the stale leader resumes; it must fence before serving |
| `sync-change` | the sync standby is lost and the primary runs the Revision 1 transition; the primary is killed in one of seven phases (see below) |
| `keepalive-acquire` | a member answers a keep-alive, is cut off from the primary, and reaches the arbiter; it must wait one TTL after its answer before acquiring |
| `control-outage` | all control nodes lose the arbiter (or crash) and the database primary is killed 3 s later; I11 requires traffic before the kill and a failover within the bound |
| `control-sync-loss` | the sync reconciler is away 38–55 s and the sync standby is lost; the primary applies async locally at the last ETag and reports, the control plane returns stale and records async + alert; 30% also kill the primary after the local application |
| `control-sync-stale` | the sync reconciler is away 40–55 s, the standby is lost 31–45 s: the local async report is stale on return, and if the standby healed the reconciler re-opens a fresh barrier; otherwise it records async |
| `control-transient` | the sync reconciler is away 8–20 s with no sync loss; traffic must not notice, and there is no report and no alert |
| `mixed` | 2–4 of the above with random targets/timings, healed by 100 s |

**`sync-change` phases** (one per run): (0) killed before the open — the old sync standby `b`
promotes normally; (1) killed inside the open before the switch; (2) killed after the switch before
the barrier; (3) killed after the barrier before the close; (4) killed after the close — `a`
promotes normally; (5) the barrier times out and the healthy old `b` is restored (`fallback`);
(6) the barrier times out and the old `b` is not healthy (`downgrade`). Phases 1–3 leave the lease
`changing`; no automatic promotion is allowed.

Fixed scenarios:

- `sync-change-minimal` — the **old counterexample**, now a regression: dies after the open, before
  the barrier, with the target lagging. Must not promote.
- `sync-change-after-barrier` — dies after the barrier, before the close. Must not promote.
- `sync-change-after-close` — the transition closed `steady {a}`, then the primary dies; `a`
  promotes with every acknowledged commit.
- `sync-change-fallback` — the barrier times out, the old `b` is healthy; step 3 falls back to it.
- `sync-change-downgrade` — the barrier times out and `b` is not healthy; `on_sync_loss` downgrades.
- `sync-change-close-race` — the close CAS applies but its response is lost; the primary adopts the
  steady lease and the new standby still promotes safely.
- `sync-control-loss` — Rev 2: outage + lost standby; local async, stale report, record async + alert.
- `sync-control-stale-reopen` — Rev 2: the standby heals before the control plane returns; stale
  report, fresh barrier to the healthy named member, close steady.
- `sync-control-same-etag` — Rev 2: the return races the next renewal (same ETag or stale); either
  way the applied value is recorded and an alert fires.
- `sync-control-transient` — Rev 2: a transient outage with nothing else failing; acks continue, no
  report, no alert.
- `sync-control-stale-sync` — Rev 2's forbidden act: a buggy node reports a new sync member from
  inside the outage; the normal reconciler refuses it, `--mutant record-sync-on-stale` records it and
  a lagging member promotes with missing acknowledged commits.
- `control-outage-minimal` — the I11 positive case.
- `wall-clock-fence` — a renewal loss plus a 90 s backward wall step; the `fence-wall-clock` mutant
  overlaps two primaries, the monotonic machine does not.

---

## 7. Results

`bun tests/ha/sim/w9/run.ts --runs 5000`, 5,000 schedules over 13 families, **~7.5 s**:

| Family | Runs | DB promotions | Control takeovers | Acks | Strict-overlap ms (max/run) | Violations |
|---|---:|---:|---:|---:|---:|---|
| `renew-loss` | 384 | 229 | 0 | 75,835 | 193 (101) | none |
| `cas-race` | 385 | 385 | 385 | 79,546 | 478 (199) | none |
| `arbiter-outage` | 385 | 205 | 0 | 75,991 | 0 | none |
| `asymmetric` | 385 | 385 | 0 | 75,284 | 8 (7) | none |
| `clock-step` | 385 | 5 | 0 | 81,738 | 0 | none |
| `stale-leader` | 385 | 295 | 90 | 74,705 | 0 | none |
| `sync-change` | 385 | 110 | 0 | 10,664 | 0 | none |
| `keepalive-acquire` | 385 | 385 | 0 | 75,849 | 59 (59) | none |
| `control-outage` | 385 | 385 | 318 | 72,724 | 0 | none |
| `control-sync-loss` | 384 | 109 | 0 | 51,433 | 0 | none |
| `control-sync-stale` | 384 | 0 | 0 | 53,956 | 0 | none |
| `control-transient` | 384 | 0 | 0 | 32,319 | 0 | none |
| `mixed` | 384 | 112 | 165 | 66,325 | 0 | none |
| **total** | **5,000** | **2,605** | **958** | **826,369** | **738** | **0** |

- **I3, I11, I12 and I13: zero violations.** The same is true of every fixed scenario.
- The strict overlap is two primaries at *different* generations. I3's letter permits it; the
  plan's intent does not. Total 738 ms over 5,000 runs, worst 199 ms in `cas-race`. No write was
  acknowledged during an overlap (I13's ack check would have fired).
- `arbiter-outage`: variant A keeps the primary for the whole outage; variant B fences it and no
  promotion happens until the arbiter returns — the designed availability loss.
- `clock-step`: 5 promotions (some schedules also lose the arbiter); the rest are inert.

**Revision 1 coverage in the `sync-change` family** (385 runs): 440 transitions opened (a run can
open a second after a promotion), 170 closed, 52 fell back to the healthy old member, 62 downgraded
and 158 primaries were killed while `changing` with no automatic promotion. The fixed schedules
cover a death **before the barrier** and **after the barrier before the close**, both **0 promotions
and 0 violations**.

**Revision 2 coverage** (the three new families):

| | `control-sync-loss` | `control-sync-stale` | `control-transient` |
|---|---:|---:|---:|
| runs | 384 | 384 | 384 |
| local `on_sync_loss` applications | 384 | 382 | 0 |
| reports reconciled | 384 | 382 | 0 |
| same ETag | 11 | 0 | 0 |
| stale ETag | 379 | 384 | 0 |
| fresh-barrier re-opens | 1 | 336 | 0 |
| alerts | 390 | 384 | 0 |
| acks | 51,433 | 53,956 | 32,319 |
| promotions | 109 | 0 | 0 |

`control-sync-loss` is the outage + lost standby: every run applies async locally, the report is
stale on return, the reconciler refuses `sync`, records async and alerts; 30 % also kill the primary
after the local application, and those promote a new primary within the bound (I11). `control-sync-
stale` heals the standby during the outage: the stale report finds a healthy named member and
re-opens a fresh barrier/close (336/382), otherwise records async. `control-transient` has no sync
loss: no reports, no alerts, and 32,319 acknowledged writes during the outage windows. The extra
stale counts over reports are retries after a CAS raced a renewal.

### Checker validation (not part of the 5,000 count)

The model is not vacuous. Deliberately wrong variants are selectable with `--mutant`:

| Mutant | Run | Caught by |
|---|---|---|
| `promote-while-changing` | `--scenario sync-change-minimal` | **I12/promotion-during-sync-change**, and **I13/missing-ack** (the gate is what prevents the loss) |
| `node-applies-sync` | `--scenario sync-control-stale-sync` | the normal reconciler refuses the stale `sync` report and records async; the lagging member promotes from the async lease with **no I13** |
| `record-sync-on-stale` | `--scenario sync-control-stale-sync` | **support/stale-sync-recorded** and **I13/missing-ack-at-promotion** — the forbidden act loses the pre-loss sync commits |
| `ignore-eligibility` | `--family sync-change`, 50 runs | **I12/promotion-not-in-sync-set** in 6 runs |
| `ignore-keepalive` | `--family keepalive-acquire`, 100 runs | **support/acquired-too-early** in 6 runs |
| `cas-same-generation` | `--family keepalive-acquire`, 100 runs | **I3** at seed 58, plus the holder-change support rule in all 100 |
| `fence-25s` | `--family keepalive-acquire`, 100 runs | **strict overlap 695,444 ms** (max 9.6 s/run); its late writes are not acknowledged because its sync standby is gone |
| `fence-wall-clock` | `--scenario wall-clock-fence` | **strict overlap 25,714 ms** vs **0** for the same schedule with monotonic timers |

The I3 checker is also exercised directly: `forcePrimaryForTest('a',1)` +
`forcePrimaryForTest('b',1)` raises `two-primary-same-generation` (`w9.test.ts`).

---

## 8. History: the counterexample and the revisions

The first model (Revision 0) found this trace. It is kept here because it is the reason Revision 1
exists (and Revision 2 extends the outage path); it is now a regression schedule.

### Revision 0 (defect)

W9-SPEC §5.1/§5.5 then said: *record the new set under the lease, then change
`synchronous_standby_names`*. With the lease naming `a` and the setting still naming `b`:

```
 1.272s b      commit #1 acknowledged (generation 1)        ← acked under sync via b
 1.753s p      step 1: lease records sync {a};
               synchronous_standby_names still b            ← unsafe window
 1.800s p      primary killed                               ← before step 2
17.096s a      candidate at generation 2 (lease 1, sync {a}) ← eligible under I12
17.179s a      won the CAS at generation 2
18.536s a      PRIMARY at generation 2; effective sync none
18.536s !      I13: a is missing acknowledged commit #1
```

A lagging replica promoted and lost an acknowledged commit: RPO > 0 in a `sync` database. I12 was
satisfied; I13 was not.

### Revision 1 (the same schedule, now safe)

The same four faults, with step 1 becoming **open** (`sync: []`, `changing`) and the target still
lagging:

```
 1.272s b      commit #1 acknowledged (generation 1)
 1.500s net    p↛b (drop)
 1.753s p      open: sync [], syncState changing (target a)   ← no member may acquire
 1.753s p      switch: synchronous_standby_names = a; barrier #3
 1.853s p      schedule kills the primary inside the open transition
 ...           no candidate: syncState is 'changing' at every read
 no violation; 0 promotions
```

The lease stays `changing` until it expires; `a` and `b` read it and do not CAS. The fleet pages
and a person chooses. **I13 is zero**, and the old `missing-ack-at-promotion` cannot occur because
no automatic promotion occurs.

Dying **after the barrier** is also safe:

```
 1.687s p      open: sync [], syncState changing (target a)
 1.687s p      switch: synchronous_standby_names = a; barrier #2
 2.290s p      barrier acknowledged; schedule kills the primary before the close
 no violation; 0 promotions
```

The barrier is on `a`, so a person may promote it without data loss; the automatic machine still
does not, because the lease was not closed. Dying **after the close** is a normal failover:

```
 2.344s p      close: sync {a}, syncState steady
19.598s a      PRIMARY at generation 2
 no violation; 1 promotion
```

The timeout paths are safe too: with the old `b` healthy, the model falls back at ~32 s
(`fallback: sync {b}, syncState steady`); with `b` unhealthy it downgrades
(`durability_effective = async`). A close whose response is lost is adopted on the next re-read and
the new standby still promotes with every acknowledged commit.

**No new counterexample was found.** The explored space is the 5,000 schedules above plus the fixed
scenarios: before/after the barrier, fallback, downgrade, close-response loss, and a primary killed
inside every phase of the transition.

### Revision 2: the control-plane outage path

`sync-control-loss` (`--scenario sync-control-loss`):

```
 2.000s reconciler control plane unreachable for 43.0 s
34.161s p        control plane away; applied on_sync_loss async locally at "e9"; report queued
45.000s reconciler control plane returned; reconciling reports
45.102s reconciler stale report "e9" (current "e14"): never recording sync; alert
45.218s reconciler recorded async: sync [], steady
 no violation; 0 promotions
```

The primary blocked writes for the 30 s `SYNC_DOWNGRADE_AFTER`, applied async locally so traffic
resumed, and left the lease stale. On return the ETag was stale (a renewal had moved it); the
reconciler refused `sync`, recorded the policy outcome and alerted. The writes acked after the local
application are async; the pre-loss sync acks are on `b`, which is the only eligible member of the
stale `sync {b}` lease. I13 holds.

`sync-control-stale-reopen` (the standby heals before the control plane returns):

```
34.161s p        applied on_sync_loss async locally at "e9"; report queued
55.106s reconciler stale report "e9" (current "e16"): never recording sync; alert
55.106s reconciler re-opening a fresh barrier to the healthy named member b
55.287s p        open: sync [], syncState changing (target b)
55.287s p        switch: synchronous_standby_names = b; barrier #79
55.566s p        close: sync {b}, syncState steady
 no violation; 0 promotions
```

The re-open uses a **fresh barrier**; the stale report itself is never recorded as `sync`.

`sync-control-transient` (nothing else fails): no report, no alert, 56 acknowledged writes in the
outage window. Traffic does not depend on the reconciler.

The wrong node and the wrong reconciler:

- `node-applies-sync` (the node reports `sync a` from inside the outage): the normal reconciler
  refuses the stale `sync` report, records `async`, and the lagging `a` later promotes from an
  **async** lease — no I13. This is the safe path.
- `record-sync-on-stale` (the reconciler records the stale `sync a`): `support/stale-sync-recorded`
  plus three `I13/missing-ack-at-promotion` violations when the lagging `a` promotes from the
  re-created **sync** lease. This is the checker validation, not a spec counterexample.

**No Revision 2 counterexample was found.** The normal reconciler never records `sync` from a stale
ETag; the 5,000-schedule run and every fixed scenario have zero I3/I11/I12/I13 violations.

---

## 9. What is not modelled

- **The human decision after a mid-change death.** Revision 1 says no automatic promotion while
  `changing`; a person promotes the old member or uses `accept_data_loss` for the new one. The model
  stops at "no auto promotion" and does not perform the manual action, so those runs end without a
  primary. That is the designed safety outcome.
- **The real control-plane process and desired state.** The Revision 2 reconciler is a logical
  writer of the sync fields with an availability flag; the control-plane service, its endpoints and
  its desired-state reconciliation are not modelled. The alert is a counter/log, not a page.
- **The Revision 2 local-async window's I13 reading.** I13 is judged under the durability in force
  when the ack was issued and under the acquired lease's recorded durability. The local async
  application makes the post-application acks async; a promotion from the stale sync lease is safe
  because only the recorded sync standby is eligible and it holds the pre-loss sync acks. A
  promotion from a lease the reconciler recorded as `async` is an async failover (the downgrade's
  accepted RPO > 0). This is the model's reading; the spec's "lease is the authority" is about the
  recorded state, and Revision 2 explicitly allows the local setting to precede the record.
- **`accept_data_loss`** as a manual, audited action; `block` is implemented but not exercised by
  the default families.
- **Run leases, desired state, the platform route, audits.** The control plane's `primary` is a
  role; its writes are not modelled. W9-SPEC §4.6 is out of scope.
- **The witness arbiter, regions, `DB_AUTO_PROMOTE`/`failover: auto` policy** (W13/Wave 4).
- **PostgreSQL.** `pg_ctl promote`, `synchronous_commit`, `pg_rewind` and rebuild are delays and a
  history copy, not a database. WAL is modelled as an ordered per-member stream with a gap/re-attach
  rule; there is no segment arithmetic.
- **The master-key ceremony.** `canPromote` is a flag.
- **Read-only standby HTTP surfaces** — states are roles, not endpoints.
- **Exact control-plane `standby-behind`/`unavailable` timing.** `standby-behind` is never entered;
  `unavailable` is entered after 30 s of errors. Rejoin after fencing is a fixed 5 s.
- **Network reordering/duplication beyond concurrent RPCs.** The send-time proof rule and the
  stream-epoch gap rule guard the rest. Multi-second response delays are not a schedule family.
- **Clock drift** (100 ppm). Only wall-clock *steps* are modelled. Arbiter clock steps are assumed
  away.
- **Multiple databases, two-member fleets, cross-node placement.**

---

## 10. Reproduce

```sh
# the full run: 5,000 schedules, ~8 s, exits 0
bun tests/ha/sim/w9/run.ts --runs 5000

# one family, or one seed with its trace
bun tests/ha/sim/w9/run.ts --runs 500 --family sync-change
bun tests/ha/sim/w9/run.ts --runs 1 --seed 3219 --trace

# the old counterexample (now safe), both sides of the barrier, and the timeout paths
bun tests/ha/sim/w9/run.ts --scenario sync-change-minimal --trace
bun tests/ha/sim/w9/run.ts --scenario sync-change-after-barrier --trace
bun tests/ha/sim/w9/run.ts --scenario sync-change-after-close --trace
bun tests/ha/sim/w9/run.ts --scenario sync-change-fallback --trace
bun tests/ha/sim/w9/run.ts --scenario sync-change-downgrade --trace
bun tests/ha/sim/w9/run.ts --scenario sync-change-close-race --trace

# Revision 2: the control-plane outage path and the stale report
bun tests/ha/sim/w9/run.ts --scenario sync-control-loss --trace
bun tests/ha/sim/w9/run.ts --scenario sync-control-stale-reopen --trace
bun tests/ha/sim/w9/run.ts --scenario sync-control-same-etag --trace
bun tests/ha/sim/w9/run.ts --scenario sync-control-transient --trace
bun tests/ha/sim/w9/run.ts --scenario sync-control-stale-sync --mutant node-applies-sync
bun tests/ha/sim/w9/run.ts --scenario sync-control-stale-sync --mutant record-sync-on-stale

# the I11 case and the checker validation
bun tests/ha/sim/w9/run.ts --scenario control-outage-minimal
bun tests/ha/sim/w9/run.ts --scenario sync-change-minimal --mutant promote-while-changing
bun tests/ha/sim/w9/run.ts --scenario wall-clock-fence --mutant fence-wall-clock

bun test tests/ha/sim/w9
```
