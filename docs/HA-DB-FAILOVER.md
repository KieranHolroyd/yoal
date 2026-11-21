# Automatic database failover (W11) — operator notes

Status: **not enabled in this build.** The policy, drills and the node member machine are
implemented, but two prerequisites are not wired, so `auto` is refused and no automatic promotion
path is installed.

Spec: [`docs/build-plan/W11-SPEC.md`](./build-plan/W11-SPEC.md) Revision 4. The model is
[`docs/build-plan/W11-MODEL.md`](./build-plan/W11-MODEL.md).

## Why it stays off

1. **No per-node arbiter transport or peer channel.** The control plane's object store is the
   arbiter, but an agent has no conditional-write credentials for it and no mTLS member RPC. The W11
   member machine (`apps/agent/src/database-member.ts`) therefore runs **report-only**: it reports
   role/generation and never fences or promotes. An agent advertises
   `db-member-self-fencing` only when it actually holds that transport; this build does not.
2. **Consumer discovery is not in the forwarder yet.** `DatabaseMemberService.consumerTarget()` is
   the §6 selection over the control-plane cache (highest-generation primary, fail closed on none or
   a same-generation tie), but `ServiceForwarder` still uses one desired-state upstream and is
   re-pointed without a restart. Do not read the presence of `consumerTarget` as §6 being met.

## Enabling checklist (after the lab)

- Every data node advertises **both** `db-member` and `db-member-self-fencing`.
- The operator has set `YOAL_DB_MEMBER_SELF_FENCING=1` after the lab proved node-side fencing. The
  capability is the real signal; the environment variable is an additional assertion. Neither alone
  installs the controller.
- `DB_AUTO_PROMOTE` is on **and** the per-database policy is `auto`. `manual` is the default and is
  never promoted automatically.
- Arming refuses unless all W11-SPEC §3 conditions hold: engine Postgres; `sync`, or `async` with
  `acceptDataLoss`; at least three data nodes in two zones; a cross-node streaming replica; every
  member `db-member`; every data node `db-member-self-fencing`; no planned switchover or open sync
  change; a passed drill within 30 days that measured ≤30 s and proved an arbiter CAS.

## Arming, disarming, drilling

```sh
yoal db failover <database>                     # policy, evidence, every refusal
yoal db failover <database> --arm --yes         # sync: no extra flag
yoal db failover <database> --arm --yes --accept-data-loss   # async only
yoal db failover <database> --disarm            # immediate; never fences a healthy primary
yoal db failover <database> --drill --target <disposable-database>
```

A drill **never promotes the production database**: it must name a disposable target with a
cross-node replica. The drill records the measured time to writable; `arbiterTested` is set only
when the drill's acquired generation is actually held by its target in the arbiter. `lostCommits`
is `null` until a promotion path measures it, so a `sync` drill currently refuses `auto`
(`drill-lost-commits`) rather than claiming RPO 0.

Every arm, disarm, drill start/completion, reconciled promotion, invalid promotion and two-primary
observation is audited (`database.failover.*`). Member events (`fence-failed`,
`fence-notice-missed`, `promotion-failed`, …) ride the heartbeat and are audited and alerted.

## What the node machine does

- Replica: a candidate only when its stream is down for 5 s, the lease has expired by the arbiter's
  clock, the policy is armed and it is the named sync member (or async with data-loss acceptance),
  and it has not answered the primary's keep-alive within one TTL. A valid `fencing {generation,
  epoch}` notice from the lease holder waives the debounce and the TTL block for **that generation
  only**; it never waives the stream-down fact, an unexpired lease or eligibility.
- Candidate: CAS `generation + 1`, `pg_ctl promote` on the replica workload, clear the sync setting
  **on that same promoted workload**, report the generation/LSN. A lost CAS re-follows. A CAS win
  whose promote fails keeps renewing the `changing` lease and retries; it never leaves a won
  generation with no promoter, and it fences if the lease moves while `pg_ctl promote` runs. The 2 s
  fence-notice window starts after the fence is confirmed; fence and fan-out times are reported
  separately.
- Primary: renews from the arbiter; on a higher generation/other holder, an unprovable lease beyond
  one TTL without the failsafe, or an expired lease, it stops writes/read-only **first and confirms**
  it, then sends the notice within 2 s (including the peer lookup), and only then reports `fenced`.
  A fence that cannot be confirmed is retried and reported (`fence-failed`).
- Old primary: never resumes; desired state's rewind/rebuild re-attaches it as a replica.
- Control plane: only a reader here — it reconciles a promotion reported while it was down, never
  lowers a generation, alerts/audits invalid promotions and two primaries, and re-points the
  row/endpoints/PITR stanza.
