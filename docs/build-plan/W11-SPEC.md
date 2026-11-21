# W11 spec — automatic database failover

Status: **approved 2026-11-21** (owner delegated the decisions; they are in §1). This is step 1 of
HA-PLAN §6.4 for W11. It extends [W9-SPEC.md](./W9-SPEC.md) §5 (the database member machine, which is
implemented) with the policy that decides *when* a replica may promote automatically. Nothing in W11
is implemented before the model in step 2 is clean.

## 1. Decisions

1. **Automatic failover is per database and defaults to `manual`.** It also needs the global
   `DB_AUTO_PROMOTE` flag, which stays off until the M4 lab and soak pass.
2. **`auto` is refused** unless there are at least **three data nodes in at least two zones**, the
   arbiter has passed a failover drill in the last 30 days, every involved agent declares
   `db-member`, and the database has no active switchover.
3. **`sync` auto is RPO 0**: only the replica named in the lease's sync set at the acquired
   generation may promote (I12). **`async` auto needs an explicit `acceptDataLoss`** on the database;
   without it the mode is refused, not silently RPO > 0.
4. **Promotion always needs the arbiter.** An arbiter outage alone causes no failover and no stop
   (H21 failsafe); an arbiter outage plus an unreachable member stops the primary.
5. **The control plane never decides.** Nodes promote; the control plane reads heartbeats, records,
   alerts and reconciles. With it down, failover still happens (I11).
6. **Consumers fail closed**: poll members every 1–2 s for role/generation, forward only to a
   `primary` at the highest generation; if none answers, refuse writes.
7. **The old primary never resumes.** It is fenced, then rewinds or rebuilds as a replica.

## 2. Invariants

| Id | Meaning |
|---|---|
| I3 | At most one primary per database generation. |
| I11 | Control plane down: traffic and failover continue. |
| I12 | Automatic promotion only for the member named in the sync set at the acquired generation. |
| I13 | In `sync`, no acknowledged commit is absent from the promoted primary. |
| New | Time to writable: median ≤ 25 s, worst ≤ 30 s from the primary's last successful lease renew. |

## 3. Policy and eligibility

Per database: `failoverMode: 'manual' | 'auto'`, `acceptDataLoss: boolean` (async only),
`lastFailoverDrillAt`, `autoArmedAt`.

`auto` may be armed only when all hold:

- the global flag `DB_AUTO_PROMOTE` is on and the database's `durability` is `sync`, or `async` with
  `acceptDataLoss = true`;
- `count(nodes with role data and capability db-member) >= 3`, in ≥ 2 distinct zones;
- `now - lastFailoverDrillAt <= 30 days`, and the drill passed;
- the database has a replica on another online node;
- no active switchover (`switchoverStep` not null) and no sync transition (`syncState !== 'stepping'`);
- every involved node is on a version that declares `db-member`.

Arming is an audited operator action. Turning `auto` off is immediate.

## 4. Detection

A replica becomes a candidate only when **all** hold:

1. **Its own stream is down**: the WAL receiver reports not streaming for `STREAM_DOWN_MS` (5 s).
2. **The primary lease has expired by the arbiter's clock** (not the replica's), and the replica can
   reach the arbiter.
3. **It is eligible** (I12 for sync; any replica for async with `acceptDataLoss`).
4. **No member has answered the primary's keep-alive within one TTL** — the H21 failsafe agreement.
   A replica that answered is not a candidate, even if it can reach the arbiter.

`STREAM_DOWN_MS` is a debounce, not a detection bound: the lease expiry (15 s) dominates.

## 5. Promotion

1. Candidate CASes the lease at `generation + 1` with `sync: []`, `syncState: 'changing'`, holder =
   itself, `expiresAt = arbiter now + 15 s`.
2. Losing the CAS means another member won: re-follow and do not promote.
3. Winner runs `pg_ctl promote` (≤ 5 s), records the new generation, clears the sync setting, and
   re-arms the Rev-1 transition (sync []/steady or a fresh set) as the new primary.
4. It reports `{status: 'promoted', generation, lsn}`; the control plane re-points the database row,
   endpoints and PITR stanza, then the old primary is rewound or rebuilt.

The candidate that wins must be able to prove the generation it holds before serving writes.

## 6. Consumers

Each endpoint knows every member from desired state and asks role/generation over mTLS every 1–2 s.
It forwards only to `primary` at the highest generation. If two primaries at the same generation
answer, it fails closed and alerts (I3 violation). If none answers, it refuses writes rather than
guessing.

## 7. Control plane reader

- Reads `databaseMembers` reports, updates the row, the generation, endpoints and stanza, alerts and
  audits.
- If it is down, nodes promote and consumers continue; on return it reconciles from reports and the
  lease, and never lowers a generation.
- It may refuse a promotion result (wrong generation, not eligible) but cannot undo a promotion. An
  invalid promotion is fenced and paged.

## 8. Rejoin

- The old primary's agent notices it lost the lease (or a higher generation) and fences before its
  TTL ends.
- It comes back only as a replica: `pg_rewind` against the new primary, rebuild on failure, its slot
  recreated by the new primary. It is never served as a primary while its generation is behind.

## 9. Timers and budget

| Stage | Bound |
|---|---|
| Stream down debounce | 5 s |
| Primary lease TTL after last renew | 15 s |
| Candidate CAS | ≤ 2 s |
| `pg_ctl promote` | ≤ 5 s |
| Consumer discovery | ≤ 2 s |
| **Worst total** | **≤ 29 s** (median target 20–25 s) |

The clock starts at the primary's last successful lease renew; a primary that stops renewing at t=0
is a candidate's target by t≤15 s, writable by t≤22 s, and discoverable by t≤24 s.

## 10. Failure matrix

| Fault | Result |
|---|---|
| Primary node powered off | Stream down + lease expiry + no keep-alive → one candidate promotes. ≤ 30 s. |
| Primary process frozen | Same; the lease expires by the arbiter clock. |
| Network partition, primary can reach the arbiter | It keeps renewing; no promotion. |
| Network partition, primary cannot reach the arbiter or members | It fences (failsafe); a candidate with arbiter access promotes. |
| Arbiter unreachable (all) | No promotion; primary keeps serving only while every member answers keep-alive. |
| Two candidates | One CAS wins; the loser re-follows. |
| Stale leader resumes | Sees the higher generation and fences; rewind as replica. |
| `async` with acceptDataLoss | Promotion may lose commits; the alert and audit say so. |
| `auto` on 2 data nodes | Refused at arming; manual only. |
| Sync set names a dead member | The Rev-1 transition handles it; `auto` promotion follows the lease, not the setting. |

## 11. Model obligations

The model is written from this spec only and checks:

- I3, I12, I13 as in W9, with automatic promotion enabled;
- I11 with the control plane down;
- the time-to-writable bound under: power off, freeze, partition (with and without arbiter), clock
  step, stale leader, two candidates, arbiter outage alone;
- refusal of `auto` on two data nodes, no drill, async without acceptDataLoss;
- no failover and no stop on an arbiter outage alone.

## 12. Arming and drills

- `yoal ha db arm <database>` (or the settings surface) checks the policy, records `autoArmedAt` and
  audits.
- A failover drill is the same path with a disposable database; it records `lastFailoverDrillAt` and
  the measured time to writable. Arming without a drill is refused.
- Disarming is immediate and does not fence a healthy primary.
