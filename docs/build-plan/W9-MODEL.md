# W9 model — control-plane and database member machines

Step 2 of HA-PLAN §6.4, written from [`W9-SPEC.md`](./W9-SPEC.md) alone. The production lease and
database-member code (`packages/core/src/ha-lease.ts` and the member machine) was not read; the only
existing code reused is the simulator's event-queue/RNG style (`tests/ha/sim/`).

**Result: one counterexample, and it is a spec defect (I13).** W9-SPEC §5.1/§5.5 change the recorded
sync set *before* `synchronous_standby_names`. Between the two steps the lease names a replica that
is not yet the effective synchronous standby, so a crash lets that replica promote and lose an
acknowledged commit. I12 is satisfied; I13 is not. The full trace is in
[§8](#8-the-counterexample). No other counterexample was found in 5,000 schedules. The spec is
**not** patched here; §6.4 says the counterexample changes the spec at step 1.

| | |
|---|---|
| Model | `tests/ha/sim/w9/` (`spec.ts`, `model.ts`, `schedules.ts`, `run.ts`, `w9.test.ts`) |
| Command | `bun tests/ha/sim/w9/run.ts --runs 5000 --allow-known` |
| Runtime | 5,000 schedules in ~9 s on a laptop (~1.8 ms/schedule); 300 schedules in the unit test |
| Exit code | `1` if any violation; `--allow-known` exits 0 only when every violation is the known counterexample |

---

## 1. What the model is

A deterministic discrete-event world with:

- **one arbiter** — a linearizable object store with conditional `PUT` (`If-Match`,
  `If-None-Match: *`), one object for the control lease and one for the database lease;
- **three control nodes** `c0 c1 c2`, the full W9-SPEC §4 state machine;
- **three database members** `p a b`, the full W9-SPEC §5 state machine;
- **one consumer** that polls every member's role/generation and forwards writes to the highest
  generation that answers `primary` (W9-SPEC §5.6), with no control-plane dependency;
- a directed reachability graph, so asymmetric partitions are expressible, and a drawn round-trip
  latency per RPC.

Time is a virtual millisecond counter. Every event is a pure function of the seed and the schedule;
`w9.test.ts` asserts that a seed replays an identical trace and stats. The database is one object
(one database) with `p` primary and `a`/`b` replicas at generation 1; the control plane starts empty
and `c0` creates the lease at epoch 1.

The checker runs after every event:

| Id | Check |
|---|---|
| **I3** | no two members in `primary` at one generation; no two control nodes in `primary` at one epoch. The *strict* count (two primaries at any generation) is also measured, because the plan's intent is one primary even though I3's letter is per generation. |
| **I12** | a promotion on a `sync` database only happens when the lease it acquired from names the promoter in `sync`. |
| **I13** | at every promotion, and at the end of the run, the promoted member's history contains every commit acknowledged under `sync`; and an ack is not issued by an old primary while a higher-generation primary exists without the commit. |
| **I11** | schedule expectations: a control-plane outage must not stop traffic or a database failover when the arbiter is reachable; an arbiter outage must not produce a promotion. |
| **support** | lease epochs/generations never decrease and change by exactly +1 on a takeover; a member that answered a keep-alive within one TTL does not acquire (§5.3). |

---

## 2. State variables

### Arbiter

| Variable | Meaning |
|---|---|
| `#controlStore`, `#dbStore` | `{ body, etag, appliedAt }`, or absent for the control lease |
| `etag` | fresh on every successful conditional write; a stale `If-Match` gets 412 |
| clock | virtual `T`; the authority for every expiry comparison |

The arbiter applies a write at the request's arrival and answers with its current `T`. A lost
response still applied the write; the caller sees a timeout.

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
`lastProof` / `lastProofWall` (the renewal proof window), `lastRenewOk` (the last renew attempt
failed), `peerLastAnswer` (the primary's keep-alive view), `lastAnsweredToPrimary` (the member's own
view, which gates acquisition), `effectiveSync` (the PG setting in force), `pendingSetting` +
`settingAt` (step 1 done, step 2 due), `syncLostSince`, `syncDowngradeAt`.

### Commit / write

`Commit { id, gen, acceptedBy, durability, acked, ackAt, waitFor }`. A commit is **acknowledged**
when the durability rule says it is durable, not when the client receives the ack:

- `async` — on acceptance by the primary;
- `sync` — when the member named by `effectiveSync` has it (the actual
  `synchronous_standby_names`, not the lease's recorded set);
- a pending ack is only released while the accepting primary is still serving, or when the current
  highest-generation primary has the commit. A fenced node must not tell a client a write committed
  if the new primary does not have it.

The client also has a 30 s write timeout; a timed-out write is not acknowledged.

### Consumer

Cached highest-generation `primary` answer, refreshed 1–2 s; a write every 0.5–0.9 s to that cached
target; fail-closed when no member answers `primary`. No control-plane call, ever.

---

## 3. Transitions

### Control plane (W9-SPEC §4)

| From | To | Trigger |
|---|---|---|
| `joining` | `standby` | replica restored/replay current (modelled as a short delay) |
| `standby` | `promoting` | lease object unchanged for 40 s **and** expired by the arbiter's date **and** `canPromote`, then a CAS at `epoch+1` wins |
| `promoting` | `primary` | master key/config/migrations present (modelled as `canPromote`, 0.2–0.8 s) |
| `primary` | `fenced` | renew answers 409/412 (after a re-read that shows another holder), a higher epoch is observed, or 20 s without confirmation |
| `fenced` | `standby` | 5 s after fencing (simplified; the spec says "after the holder is stable") |
| `standby`/`unavailable` | `unavailable`/`standby` | arbiter errors persist longer than one TTL / a read succeeds |
| any | `joined` after a crash | process restart: `joining`, epoch persisted |

A renew that loses the CAS re-reads; if the node is still the holder at its epoch it retries, else
it fences. The control plane has **no keep-alive quorum**: an arbiter outage alone fences it after
20 s (W9-SPEC decision 1).

### Database member (W9-SPEC §5)

| From | To | Trigger |
|---|---|---|
| `streaming` | `candidate` | stream down **and** lease expired by the arbiter's date **and** eligible **and** it did not answer a keep-alive within one TTL |
| `candidate` | `promoting` | the CAS at `generation+1` wins |
| `candidate` | `streaming` | the CAS loses (412) or errors: re-read, never retry blindly |
| `promoting` | `primary` | `pg_ctl promote` (0.3–5 s) |
| `primary` | `fencing` | 15 s without a proof and the failsafe does not hold, a 412/higher generation, or a consumer role poll after the proof expired |
| `fencing` | `fenced` | 50–300 ms to stop Postgres / set read-only |
| `fenced` | `rewind` → `streaming` | a higher-generation primary is reachable; history is replaced by the new primary's |
| `primary` | keeps running past one TTL | **only** when the arbiter is unreachable **and** every member answered a keep-alive within 15 s (H21 failsafe) |

A renewal's proof window starts at the **request send time**, the last time the lease could have been
applied; using the response receipt would let a delayed response extend the lease past the arbiter's
`expiresAt`. A promotion's proof starts at the CAS send time, not at `pg_ctl promote` completion.

`primary` also renews every 5 s, changes the sync set on loss of the effective standby (two steps,
below), picks a standby when it has none, and downgrades after 30 s with none left.

### The two-step sync set (the defect, as written)

1. CAS the lease at the same generation with `sync: [target]` and a new `syncSetAt`.
2. After 0.8–1.8 s (two separate operations), set `effectiveSync = target`
   (`synchronous_standby_names`).

If the primary dies between 1 and 2, the lease names the target while the old standby is still the
effective synchronous one. The target is eligible under I12 and may be behind. This is the
counterexample.

### History / replication

A primary appends a commit to its own history on acceptance and ships it to every member whose
`streamFrom` is that primary, after 10–180 ms. A dropped link or a `lag` fault loses the delivery;
a reconnect copies the primary's history (WAL catch-up / `pg_rewind`). A fenced old primary copies
the new primary's history when it rewinds, discarding its divergent tail.

---

## 4. Properties, exactly

- **I3.** After every event, group members in `primary` by `generation`; a group of two or more is
  `I3/two-primary-same-generation`. Group control `primary` by `epoch` likewise. The arbiter also
  rejects (and reports) a holder change at the same generation/epoch and a decrease.
- **I12.** At the transition to `primary`, the lease read at the successful CAS is the authority:
  if `durability === 'sync'` and its `sync` does not contain the promoter, report
  `I12/promotion-not-in-sync-set`. (The acquired *new* lease removes the promoter from the set; the
  check is against the generation it acquired from, which is what "the lease names it" means.)
- **I13.** At every promotion, every commit in the global `acked` map with `durability === 'sync'`
  must be in the promoter's history. At the end of the run, the final highest-generation primary must
  hold every such commit. At every ack, if a higher-generation primary exists and does not hold the
  commit, report `ack-lost-to-higher-primary`. Commits acknowledged under `async` are exempt (RPO > 0
  is the recorded contract).
- **I11.** Each schedule may attach `controlOutage`, `requireAcks`, `failover` and `noPrimary`
  expectations; `finalize()` counts delivered acks in the windows and the first promotion after the
  loss. The failover bound is 35 s (the spec's H22 budget is 25 s; the model allows the extra
  detection/keep-alive phase), or the fault duration + 35 s when the only eligible replica is
  deliberately kept away from the arbiter.
- **Support.** `lease-epoch-decreased`, `lease-generation-decreased`,
  `lease-holder-change-not-plus-one` (a takeover must be exactly +1; a same-holder takeover is legal),
  and `acquired-too-early-after-keepalive`.

---

## 5. Assumptions

These are the model's reading of the spec. They are stated because a different reading changes the
result.

1. **The arbiter is linearizable** and its conditional write is atomic (W9-SPEC assumption 1). No
   stale reads, no lost update.
2. **The arbiter clock is monotone** and authoritative for expiry (assumption 2). Node timers are
   monotone; a node's wall clock is never used for a safety decision, so a wall-clock step is inert.
   The model does not step the arbiter's clock (a store whose clock jumps is outside assumption 2).
3. **"now" in `expiresAt = now + TTL` is the node's best estimate of the arbiter's clock**: the last
   server `Date` plus elapsed monotonic time since that response. Using the raw stale `Date` would
   make the lease expire up to one renew interval before the node's local fence window; that is an
   implementation obligation, and the model does the safe thing.
4. **A renewal is proved at its send time.** The apply time is ≥ send; the response receipt can be
   later. The model refuses to extend the proof window on a delayed success. Likewise a promotion's
   proof starts at the CAS send, not at `pg_ctl promote` completion.
5. **RPC legs are short**: 5–120 ms each way normally, ≤1.5 s under a fault. A partition either
   refuses (fast error) or black-holes (700 ms timeout). The model does not explore multi-second
   response delays except through freezes; the send-time proof rule above is what keeps them safe.
6. **The two steps are separate operations** with a 0.8–1.8 s gap. The spec does not give the gap;
   safety must hold for any non-zero gap, and the counterexample uses the smallest one that is
   physically plausible.
7. **Promotions are automatic only.** `accept_data_loss` is never set automatically; a member not in
   the sync set cannot promote a `sync` database. `on_sync_loss` defaults to `downgrade` after 30 s.
8. **One database, three members, three control nodes.** `p` is the initial primary; `a` and `b` are
   replicas; `b` is the initial synchronous standby. A two-member fleet and a multi-database fleet
   are not modelled.
9. **A fenced/crashed old primary does not serve.** A restart is `fenced`; a freeze is fenced on
   resume if the proof expired; it can rewind and rejoin as a replica.
10. **No operator force-promote, no control-plane-driven failover.** The control plane is a separate
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
| `asymmetric` | three directed patterns: A reaches the arbiter while B cannot; B reaches the arbiter and A while P cannot; the arbiter's *return* path to P is broken (renewals apply but answers are lost) |
| `clock-step` | a wall clock steps back or forward 30–120 s on a member or control node during a lease, sometimes with the primary's renewals lost |
| `stale-leader` | a member or the control holder freezes 20–50 s, a successor promotes, then the stale leader resumes; it must fence before serving |
| `sync-change` | the sync standby is cut off and a lagging async replica is recorded in the lease; the primary is killed in the window before `synchronous_standby_names` changes (the counterexample family), with a no-crash control arm |
| `keepalive-acquire` | a member answers a keep-alive, is cut off from the primary, and reaches the arbiter; it must wait one TTL after its answer before acquiring |
| `control-outage` | all control nodes lose the arbiter (or crash) and the database primary is killed 3 s later; I11 requires traffic before the kill and a failover within the bound |
| `mixed` | 2–4 of the above with random targets/timings, healed by 100 s |

Fixed scenarios:

- `--scenario sync-change-minimal` — the four-fault counterexample in §8.
- `--scenario control-outage-minimal` — the I11 positive case.
- `--scenario wall-clock-fence` — a renewal loss plus a 90 s backward wall step; the
  `fence-wall-clock` mutant overlaps two primaries, the monotonic machine does not.

---

## 7. Results

`bun tests/ha/sim/w9/run.ts --runs 5000 --allow-known`, 5,000 schedules, **~9 s**:

| Family | Runs | DB promotions | Control takeovers | Acks | Strict-overlap ms (max/run) | Violations |
|---|---:|---:|---:|---:|---:|---|
| `renew-loss` | 500 | 317 | 0 | 101,285 | 335 (121) | none |
| `cas-race` | 500 | 500 | 500 | 103,437 | 2,656 (587) | none |
| `arbiter-outage` | 500 | 287 | 0 | 97,598 | 0 | none |
| `asymmetric` | 500 | 500 | 0 | 96,378 | 844 (631) | none |
| `clock-step` | 500 | 7 | 0 | 106,201 | 0 | none |
| `stale-leader` | 500 | 370 | 130 | 97,000 | 0 | none |
| `sync-change` | 500 | 398 | 0 | 18,372 | 0 | 3,524 I13, 383 runs |
| `keepalive-acquire` | 500 | 500 | 0 | 98,040 | 202 (86) | none |
| `control-outage` | 500 | 500 | 406 | 93,622 | 0 | none |
| `mixed` | 500 | 239 | 217 | 99,245 | 0 | 1,520 I13, 50 runs |
| **total** | **5,000** | **3,618** | **1,253** | **911,178** | **4,037** | **5,044 I13 occurrences in 433 runs** |

- **Every violation is `I13/missing-ack-at-promotion`** from the two-step sync-set ordering. There
  are **0** I3, I12, I11, support or `ack-lost-to-higher-primary` violations outside that family.
- `--allow-known` classifies a run as known only when all its violations are that one kind. 433 of
  5,000 runs (8.7 %) reach it; they are concentrated in `sync-change` (383/500) and `mixed`
  (50/500), as intended.
- The **strict overlap** is two primaries at *different* generations. I3's letter permits it; the
  plan's intent does not. The total is 4.0 s over 5,000 runs (~0.8 ms/run), with a worst case of
  631 ms in `asymmetric` and 587 ms in `cas-race`. No write was acknowledged during any overlap
  (I13's ack check would have fired), so these are discovery-lag near-misses: the old primary is
  still `primary` for a fraction of a second after the new one promotes, but the consumer already
  routes to the new generation or the write is blocked on sync. They are reported rather than
  failing, and are a candidate for a stronger I3 in a later spec.
- `clock-step` has 7 promotions (some of its schedules also lose the arbiter); the other 493 are
  inert, which is the expected result for a wall-clock step (timers and expiry do not read it).
- `arbiter-outage`: variant A (all peers answering) keeps the primary for the whole outage and has
  no promotion; variant B (a peer unreachable) fences it, and **no** promotion happens until the
  arbiter returns — the designed availability loss.

### Checker validation (not part of the 5,000 count)

The model is not vacuous. Deliberately wrong variants are selectable with `--mutant`:

| Mutant | Run | Caught by |
|---|---|---|
| `ignore-eligibility` | `--family sync-change`, 50 runs | **I12** in 26 runs |
| `ignore-keepalive` | `--family keepalive-acquire`, 100 runs | **support/acquired-too-early** in 6 runs (the rule needs 15 s after an answer) |
| `cas-same-generation` | `--family keepalive-acquire`, 100 runs | **I3** at seed 58, plus the holder-change support rule in all 100 |
| `fence-25s` | `--family keepalive-acquire`, 100 runs | **strict overlap 691,946 ms** (max 9.7 s/run); its late writes are not acknowledged because its sync standby is gone, so I13's *ack* check stays clean — the overlap is the observable defect |
| `fence-wall-clock` | `--scenario wall-clock-fence` | **strict overlap 25,609 ms** vs **0** for the same schedule with monotonic timers |
| `sync-setting-first` | `--family sync-change`, 200 runs | **0 violations** — reversing the two steps removes the loss (diagnostic only; not a spec change) |

The I3 checker is also exercised directly: `forcePrimaryForTest('a',1)` + `forcePrimaryForTest('b',1)`
raises `two-primary-same-generation` (`w9.test.ts`).

---

## 8. The counterexample

**Spec defect.** W9-SPEC §5.1 and §5.5 change the sync set in this order:

> record the new set under the lease, then change `synchronous_standby_names` (H23)

and §5.4 makes a member eligible when it is in the *current* `sync` set. The spec's justification is
"so no acknowledged commit can be missing from the new primary". That is true for adding a
caught-up replica, but false for replacing the standby — or for recording a replica that is behind:

1. the lease names `{a}` (step 1), so `a` is eligible under I12;
2. `synchronous_standby_names` still names `b`, so commits acknowledged in the window are on `b`
   only;
3. the primary dies before step 2; `a` was never caught up;
4. `a` wins the CAS at generation+1 and becomes primary without those commits.

I12 holds and I13 fails. This is a defect in the spec's ordering, not in the model: the model
implements the text as written.

### The minimal schedule (4 faults)

```
#0 @0.000s  lag a (WAL to a dropped) until 3.0 s
#1 @1.500s  p↛b both directions (the synchronous standby is lost)
#2 @1.550s  sync change to a (step 1)
#3 @1.800s  kill-primary (p dies; step 2 was due at ~2.4–3.4 s)
```

`b` is the effective synchronous standby. `a` is an async replica and has received none of the
commits. The consumer is acked one commit through `b` before the partition.

### The trace (`bun tests/ha/sim/w9/run.ts --scenario sync-change-minimal --trace`)

```
 1.252s wal   WAL for commit #1 to a dropped
 1.272s b     commit #1 acknowledged (generation 1)        ← the commit under sync
 1.500s net   p↛b (drop) / b↛p (drop)                      ← b is lost
 1.753s p     step 1: lease records sync {a};
              synchronous_standby_names still b            ← the unsafe window opens
 1.800s p     primary killed                               ← dies before step 2
 2.060s a     WAL receiver down
17.096s a     candidate at generation 2 (lease 1, sync {a})  ← a is eligible (I12 ✓)
17.179s a     won the CAS at generation 2; pg_ctl promote
18.536s a     PRIMARY at generation 2; effective sync none
18.536s !     VIOLATION I13/missing-ack-at-promotion:
              a promoted at generation 2 without acknowledged commit #1;
              it was acked by p at generation 1 while
              synchronous_standby_names was b
```

The client was told commit #1 committed; the new primary does not have it. In a `sync` database that
is **RPO > 0**, the exact thing I13 forbids.

### What would fix the spec (step 1, not applied here)

Change the two steps to the safe order: set `synchronous_standby_names` to the new target and wait
until it has caught up to the current WAL position, **then** record the new set in the lease. A crash
between leaves the lease naming the old, authoritative standby (dead or alive), so no replica with a
missing commit is eligible. The cost is availability when the old standby is gone — the intended
tradeoff for a `sync` database. Alternatively record the union of old and new during the transition
and require the promoter to hold every acknowledged LSN.

The model's `sync-setting-first` diagnostic implements the first form. Over 200 `sync-change`
schedules it has **0 I13 violations**; it may promote the old standby `b` (which has the data) or
nobody if `b` is dead. That is evidence the loss is caused by the ordering, not by the schedule.

---

## 9. What is not modelled

- **Run leases, desired state, the platform route, audits.** The control plane's `primary` is a
  role; its writes are not modelled. W9-SPEC §4.6 is out of scope.
- **The witness arbiter, regions, `DB_AUTO_PROMOTE`/`failover: auto` policy** (W13/Wave 4).
- **PostgreSQL.** `pg_ctl promote`, `synchronous_commit`, `pg_rewind` and rebuild are delays and a
  history copy, not a database. WAL shipping is per-commit with a delay; there is no WAL segment
  arithmetic.
- **The master-key ceremony.** `canPromote` is a flag; the sealed delivery, fingerprint check and
  allowlisted-config digest are not modelled (a `master-key` fault clears the flag).
- **Read-only standby HTTP surfaces** (`/readyz`, `/metrics`, `/api/v1/ha/status`) — states are
  roles, not endpoints. The dashboard is not modelled.
- **Exact control-plane `standby-behind`/`unavailable` timing.** `standby-behind` is never entered;
  `unavailable` is entered after 30 s of errors and leaves on a successful read. Rejoin after
  fencing is a fixed 5 s rather than "the holder is stable".
- **Network reordering/duplication beyond concurrent RPCs.** Responses are not correlated to
  requests; a late success is possible only through concurrency and freezes, and the send-time proof
  rule is the guard. Multi-second response delays are not a schedule family.
- **Clock drift** (the spec's 100 ppm bound). Only wall-clock *steps* are modelled; a node's timers
  run at true rate. Over 15 s a 100 ppm drift is 1.5 ms, well below the model's event granularity.
- **Arbiter clock steps.** Assumed monotone; a store whose clock jumps is outside assumption 2.
- **`on_sync_loss: block`** is selectable on a scenario but only `downgrade` is exercised in the
  default families. `accept_data_loss` is never automatic and is not modelled as an operator action.
- **Multiple databases, two-member fleets, cross-node placement.** One database object, three
  members, three control nodes.

---

## 10. Reproduce

```sh
# the CI run: 5,000 schedules, ~8 s. Exits 1 because the spec defect is real.
bun tests/ha/sim/w9/run.ts --runs 5000

# same, but exit 0 while the only violations are the known counterexample
bun tests/ha/sim/w9/run.ts --runs 5000 --allow-known

# one family, or one seed with its trace
bun tests/ha/sim/w9/run.ts --runs 500 --family stale-leader
bun tests/ha/sim/w9/run.ts --runs 1 --seed 3219 --trace

# the minimal counterexample, the I11 case, the wall-clock case
bun tests/ha/sim/w9/run.ts --scenario sync-change-minimal --trace
bun tests/ha/sim/w9/run.ts --scenario control-outage-minimal
bun tests/ha/sim/w9/run.ts --scenario wall-clock-fence
bun tests/ha/sim/w9/run.ts --scenario wall-clock-fence --mutant fence-wall-clock

bun test tests/ha/sim/w9
```
