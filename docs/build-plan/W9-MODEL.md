# W9 model — control-plane and database member machines (Revision 1)

Step 2 of HA-PLAN §6.4, written from [`W9-SPEC.md`](./W9-SPEC.md) **Revision 1** alone. The
production lease and database-member code (`packages/core/src/ha-lease.ts` and the member machine)
was not read; the only existing code reused is the simulator's event-queue/RNG style
(`tests/ha/sim/`).

**Result: no counterexample under Revision 1.** The first model's counterexample — recording the
new sync set before changing `synchronous_standby_names` — is now the regression schedule
`sync-change-minimal`, and it is safe: the lease is `syncState: 'changing'` with an empty `sync` set,
so no member promotes, and I13 is zero. The full suite is **5,000 schedules with 0 violations**,
including **557 sync-set transitions opened, 209 closed, 55 fallbacks, 87 downgrades and 209
primaries killed while `changing`**, plus explicit before-barrier and after-barrier schedules.

| | |
|---|---|
| Model | `tests/ha/sim/w9/` (`spec.ts`, `model.ts`, `schedules.ts`, `run.ts`, `w9.test.ts`) |
| Command | `bun tests/ha/sim/w9/run.ts --runs 5000` |
| Runtime | 5,000 schedules in ~8 s on a laptop (~1.6 ms/schedule); 16 unit tests in ~0.8 s |
| Exit code | `1` if any violation; Revision 1 produces none |

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
acquisition).

**Revision 1 change fields:** `effectiveSync` (the PG setting in force), `changePhase`
(`null | 'opening' | 'switching'`), `changeTarget`, `changeOld`, `changeOpenedAt`,
`changeTimeoutAt` (open + 30 s), `barrierId`, `barrierSnapshot` (the primary's history at barrier
issue), `killAfterOpen`, `killAfterBarrier` (schedule hooks), `syncLostSince`, `syncDowngradeAt`.

The lease's `syncState` (`'steady' | 'changing'`) is the authority; the local change fields are the
primary's progress through it.

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
- **I13.** At every promotion, every commit in the global `acked` map with `durability === 'sync'`
  must be in the promoter's history. At the end of the run, the final highest-generation primary
  must hold every such commit. At every ack, if a higher-generation primary exists and does not hold
  the commit, report `ack-lost-to-higher-primary`. Commits acknowledged under `async` are exempt.
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
8. **Promotions are automatic only.** `accept_data_loss` is never set automatically; a member not in
   the sync set, or any member while `changing`, cannot promote. `on_sync_loss` defaults to
   `downgrade` after 30 s.
9. **One database, three members, three control nodes.** `p` is the initial primary; `a` and `b` are
   replicas; `b` is the initial synchronous standby. A two-member fleet and a multi-database fleet
   are not modelled.
10. **A fenced/crashed old primary does not serve.** A restart is `fenced`; a freeze is fenced on
    resume if the proof expired; it can rewind and rejoin as a replica.
11. **After a mid-change death the model does not perform the human's manual promotion**; those
    runs simply have no primary.
12. **No operator force-promote, no control-plane-driven failover.** The control plane is a separate
    process that reads and writes its own lease; the database never consults it (H22).

---

## 6. Schedules

Each family is generated from the seed (family = `seed % 10`; `--family` fixes it). A schedule is
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
- `control-outage-minimal` — the I11 positive case.
- `wall-clock-fence` — a renewal loss plus a 90 s backward wall step; the `fence-wall-clock` mutant
  overlaps two primaries, the monotonic machine does not.

---

## 7. Results

`bun tests/ha/sim/w9/run.ts --runs 5000`, 5,000 schedules, **~8 s**:

| Family | Runs | DB promotions | Control takeovers | Acks | Strict-overlap ms (max/run) | Violations |
|---|---:|---:|---:|---:|---:|---|
| `renew-loss` | 500 | 316 | 0 | 100,941 | 335 (121) | none |
| `cas-race` | 500 | 500 | 500 | 103,437 | 2,656 (587) | none |
| `arbiter-outage` | 500 | 287 | 0 | 98,066 | 0 | none |
| `asymmetric` | 500 | 500 | 0 | 97,138 | 844 (631) | none |
| `clock-step` | 500 | 7 | 0 | 106,212 | 0 | none |
| `stale-leader` | 500 | 370 | 130 | 97,415 | 0 | none |
| `sync-change` | 500 | 147 | 0 | 14,068 | 0 | none |
| `keepalive-acquire` | 500 | 500 | 0 | 98,806 | 202 (86) | none |
| `control-outage` | 500 | 500 | 407 | 94,481 | 0 | none |
| `mixed` | 500 | 162 | 220 | 86,471 | 0 | none |
| **total** | **5,000** | **3,289** | **1,257** | **897,035** | **4,037** | **0** |

- **I3, I11, I12 and I13: zero violations.** The same is true of every fixed scenario.
- The strict overlap is two primaries at *different* generations. I3's letter permits it; the
  plan's intent does not. Total 4.0 s over 5,000 runs (~0.8 ms/run), worst 631 ms in `asymmetric`.
  No write was acknowledged during an overlap (I13's ack check would have fired).
- `arbiter-outage`: variant A keeps the primary for the whole outage; variant B fences it and no
  promotion happens until the arbiter returns — the designed availability loss.
- `clock-step`: 7 promotions (some schedules also lose the arbiter); the other 493 are inert.

**Revision 1 coverage in the `sync-change` family** (500 runs):

| Outcome | Count |
|---|---:|
| transitions opened | 557 (some runs open a second one after a promotion) |
| transitions closed `steady` | 209 |
| barrier timeout → fallback to the healthy old member | 55 |
| barrier timeout → `on_sync_loss` downgrade | 87 |
| primary killed while `changing` (no auto promotion) | 209 |

The fixed schedules additionally cover a death **before the barrier** (`sync-change-minimal`) and
**after the barrier before the close** (`sync-change-after-barrier`), both with **0 promotions and
0 violations**.

### Checker validation (not part of the 5,000 count)

The model is not vacuous. Deliberately wrong variants are selectable with `--mutant`:

| Mutant | Run | Caught by |
|---|---|---|
| `promote-while-changing` | `--scenario sync-change-minimal` | **I12/promotion-during-sync-change**, and **I13/missing-ack** (the gate is what prevents the loss) |
| `ignore-eligibility` | `--family sync-change`, 50 runs | **I12/promotion-not-in-sync-set** in 6 runs |
| `ignore-keepalive` | `--family keepalive-acquire`, 100 runs | **support/acquired-too-early** in 6 runs |
| `cas-same-generation` | `--family keepalive-acquire`, 100 runs | **I3** at seed 58, plus the holder-change support rule in all 100 |
| `fence-25s` | `--family keepalive-acquire`, 100 runs | **strict overlap 695,444 ms** (max 9.6 s/run); its late writes are not acknowledged because its sync standby is gone |
| `fence-wall-clock` | `--scenario wall-clock-fence` | **strict overlap 25,714 ms** vs **0** for the same schedule with monotonic timers |

The I3 checker is also exercised directly: `forcePrimaryForTest('a',1)` +
`forcePrimaryForTest('b',1)` raises `two-primary-same-generation` (`w9.test.ts`).

---

## 8. Revision 1: the counterexample and the regression

The first model (Revision 0) found this trace. It is kept here because it is the reason Revision 1
exists, and it is now a regression schedule.

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

---

## 9. What is not modelled

- **The human decision after a mid-change death.** Revision 1 says no automatic promotion while
  `changing`; a person promotes the old member or uses `accept_data_loss` for the new one. The model
  stops at "no auto promotion" and does not perform the manual action, so those runs end without a
  primary. That is the designed safety outcome.
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

# the I11 case and the checker validation
bun tests/ha/sim/w9/run.ts --scenario control-outage-minimal
bun tests/ha/sim/w9/run.ts --scenario sync-change-minimal --mutant promote-while-changing
bun tests/ha/sim/w9/run.ts --scenario wall-clock-fence --mutant fence-wall-clock

bun test tests/ha/sim/w9
```
