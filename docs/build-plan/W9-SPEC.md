# W9 spec — control-plane lease, epoch, and the database member machine

Status: **draft for owner approval.** This is step 1 of HA-PLAN §6.4. Nothing in Wave 3 lanes A–C
may be implemented until this document is approved. The model (step 2) is written from this text
alone; a counterexample changes this document, not the code.

Scope: HA-PLAN H21 (arbiter and failsafe), H22 (member-decided database failover), H23
(`sync` as a recorded synchronous replica), plus the control-plane half of C6 (CLUSTERING §6.3).
Out of scope: regions (W13), automatic database failover policy (`DB_AUTO_PROMOTE`, Wave 4), and the
witness arbiter (deferred).

## 1. Invariants

| Id | Meaning |
|---|---|
| I3 | At most one primary per database generation, and at most one control-plane holder per epoch. Two nodes never believe they are primary at the same generation/epoch. |
| I11 | With the control plane unreachable, existing traffic and database failover continue; agents serve cached desired state. |
| I12 | A replica promotes automatically only if the lease names it in the synchronous set at the generation it acquires. |
| I13 | No acknowledged commit is lost when a `sync` database fails over: the new primary has every commit the old one acknowledged. |

Supporting rules:
- Epochs and generations never decrease. A node persists the highest value it has seen before it
  serves or writes with it.
- Every write to a lease is a conditional write (compare-and-swap). A lost CAS is re-read, never
  retried blindly.
- A node that cannot prove it holds a lease must not act as though it does.

## 2. Assumptions

1. The arbiter is an object store or equivalent with atomic conditional PUT (`If-Match`,
   `If-None-Match: *`), or a database with equivalent row CAS. A store without conditional writes
   makes HA unavailable and the surfaces fail closed.
2. The arbiter's clock is the authority for lease expiry. Node clocks only order local timers; a
   node never decides "the lease has expired" from its own clock alone for a lease it does not hold.
3. Nodes have authenticated, mutually authenticated transport (mTLS) for keep-alives and role
   discovery. Messages carry node id, database id, generation and epoch.
4. At least one arbiter is reachable from every member for a promotion to happen. Its outage alone
   must not stop a healthy primary (H21 failsafe).
5. Node clocks may be skewed by up to 5 s during normal operation; a skew beyond 30 s is a fault
   the member machine must survive without breaking I3/I13.

## 3. Timers and constants

| Name | Value | Meaning |
|---|---|---|
| `CONTROL_TTL` | 30 s | Control lease validity from `expiresAt`. |
| `CONTROL_RENEW` | 10 s | Holder renew interval (3 renewals per TTL). |
| `CONTROL_TAKEOVER_QUIET` | 40 s | A standby may take over only when the object has been unchanged this long and its replay is current. |
| `CONTROL_FENCE_AFTER` | 20 s | A holder that cannot confirm the lease for this long stops serving writes and reports `fenced`. |
| `DB_TTL` | 15 s | Database lease validity. |
| `DB_RENEW` | 5 s | Primary renew interval (3 per TTL). |
| `DB_ACQUIRE` | ≤ 2 s | Budget for a replica's CAS after the lease expires. |
| `DB_PROMOTE` | ≤ 5 s | Budget for `pg_ctl promote`. |
| `DISCOVERY_INTERVAL` | 1–2 s | Consumer role/generation poll. |
| `KEEPALIVE_INTERVAL` | `DB_RENEW` | Member keep-alive to every peer. |
| `SYNC_DOWNGRADE_AFTER` | 30 s | `on_sync_loss: downgrade` waits this long before switching to async. |
| `RUN_LEASE_GRACE` | 60 s | A lone worker self-stops after this long without control-plane contact; promotion must account for it. |

## 4. Control-plane machine

### 4.1 Lease object

`yoal/ha/control-lease.json`:

```json
{
  "epoch": 7,
  "holderNodeId": "nod_…",
  "holderVersion": "0.16.3",
  "expiresAt": "2026-11-20T20:41:12Z"
}
```

- Create: `If-None-Match: *`, epoch 1.
- Renew: `If-Match: <etag>`, same epoch, `expiresAt = max(now, previousExpiresAt) + 30 s`.
- Take over: `If-Match: <etag>`, `epoch + 1`, new holder, `expiresAt = now + 30 s`.
- Any 409/412: re-read and re-evaluate; never overwrite blind.

### 4.2 States

| State | Entered when | Serves | Leaves when |
|---|---|---|---|
| `joining` | `control` role set, replica not restored | `/readyz` 503 | replica restored and replay within 5 s |
| `standby` | follows the replica, replay within 5 s | humans: read-only status, `/readyz`, `/metrics`, `/api/v1/ha/status` | takes over, or falls behind |
| `standby-behind` | replay older than 5 s or replica missing | as standby, `canPromote: false` | replay catches up |
| `promoting` | won the CAS at E+1 | `/readyz` only | replay caught up, config loaded, maintenance started |
| `primary` | finished promoting, epoch E | everything | cannot confirm the lease for 20 s, or a higher epoch is observed |
| `fenced` | lost the lease, saw a higher epoch, or 20 s without confirmation | reads only; **503 for every write and every `/api/agent/*`** | re-joins as standby after the holder is stable |
| `unavailable` | arbiter or replica unusable, no safe role | `/readyz` 503 | arbiter reachable and a role established |

### 4.3 Transitions

- `standby → promoting`: the lease object has been unchanged for `CONTROL_TAKEOVER_QUIET`, replay is
  current, `canPromote: true`, and the CAS at the current ETag with `epoch + 1` succeeds.
- `promoting → primary`: replay is current, the master key and allowlisted config are present,
  migrations are applied, maintenance starts. Only then does it serve writes.
- `primary → fenced`: a renew returns 409/412, a read shows a higher epoch, or renewal cannot be
  confirmed for `CONTROL_FENCE_AFTER`. Fencing persists the epoch first, stops writes, and makes
  `/api/agent/*` answer 503 with `x-yoal-role: fenced` and `x-yoal-epoch`.
- `fenced → standby`: the holder's epoch is observed and stable, and the replica is restored or
  follows within 5 s.
- Any state → `unavailable`: arbiter errors that are not CAS conflicts persist longer than one TTL
  and no other role is provable.

### 4.4 What each state reads and writes

- The primary renews the lease every `CONTROL_RENEW`; it writes desired state, run leases, audits.
- A standby never writes the lease unless taking over; it reads the lease and the replica. It
  answers `/api/agent/*` with 503 (agents keep cached state, I11) and never renews a run lease.
- Every agent caches the highest epoch and the control address list; it refuses a lower epoch and
  retries the next address.
- The platform route is an upstream list of control nodes in desired state, with `lb_policy first`
  and health checks on `/readyz`; a standby with `canPromote: false` may be healthy for humans but
  must not be first.

### 4.5 Enrolment and secrets

- The standby is enrolled by a ceremony requiring a second factor: it generates a key pair, the
  primary signs its control certificate, and the master key plus the allowlisted `yoal.env` values
  are delivered sealed to that host (recovery kit + activation), never in desired state.
- A promoted standby must have: the master key (verified by a fingerprint), the allowlisted config
  digest equal to the primary's, and migrations applied. Missing any: `canPromote: false`.

### 4.6 Run leases

- A lone worker stops itself after `RUN_LEASE_GRACE` without control-plane contact. Promotion must
  not restart work on the authority of a stale lease: after promotion, run-lease TTLs are validated
  against the promotion time, and a run whose lease could have expired is treated as lost, not as
  still held.
- A fenced or standby control plane never renews a run lease (a node that cannot write must not
  hand out authority).

## 5. Database member machine (H21–H23)

### 5.1 Lease object

`yoal/ha/db/<databaseId>.json`:

```json
{
  "generation": 12,
  "holderNodeId": "nod_…",
  "expiresAt": "…",
  "sync": ["nod_replica_a"],
  "durability": "sync",
  "syncSetAt": "…"
}
```

- Renew every `DB_RENEW`, `If-Match`, same generation, `expiresAt = now + 15 s`.
- Acquire: only when the stream is down, the lease has expired by the arbiter's clock, the replica
  is eligible, and the CAS at `generation + 1` succeeds. A lost CAS means another member won; the
  loser re-follows.
- The `sync` set and `durability` are changed only by the holder, in two steps: record the new set
  under the lease, then change `synchronous_standby_names` (H23).

### 5.2 States per member

| State | Meaning | Writes | Transition |
|---|---|---|---|
| `streaming` | replica following, receiver up | no | stream down + lease expired + eligible → `candidate` |
| `candidate` | attempting the CAS at generation+1 | no | CAS won → `promoting`; lost → `streaming` |
| `promoting` | `pg_ctl promote` in progress | no | promote OK → `primary`; failure → `fenced`/`streaming` per error |
| `primary` | holds the lease, accepts writes | yes | cannot prove the lease → `fencing` |
| `fencing` | stopping Postgres or setting read-only | no | stopped → `fenced` |
| `fenced` | must not serve as primary | no | re-attach as replica after rewind/rebuild |
| `rewind` | `pg_rewind` against the new primary | no | caught up → `streaming`; failure → rebuild → `streaming` |

### 5.3 Primary rules

- Renews the lease every 5 s. If it cannot prove the lease (CAS conflict, higher generation, or no
  confirmation for one TTL), it stops Postgres or sets it read-only (per `fence`) **before** the
  TTL ends.
- **Failsafe (H21).** If the arbiter is unreachable, the primary keeps running only while **every**
  member answers the authenticated keep-alive each renew interval. If any member is unreachable for
  one TTL, it fences, because that member may have promoted.
- A member that answered a keep-alive within one TTL must not acquire the lease, even if it can
  reach the arbiter. Promotion always needs the arbiter.
- Consequence, by design: an arbiter outage alone causes no failover and no stop; an arbiter outage
  plus a member unreachable stops the primary, as today.

### 5.4 Replica rules

- Watches its WAL receiver and the lease. It becomes a candidate only when the stream is down **and**
  the lease has expired by the arbiter's clock **and** it is eligible.
- Eligible means: it is in the current `sync` set for a `sync` database (I12), or the database is
  `async`. A replica dropped from the sync set cannot promote without `accept_data_loss`.
- On winning the CAS it promotes at generation+1, then records the new generation. On losing it
  re-follows and never promotes.
- After a promotion, the old primary re-attaches via `pg_rewind`, falling back to a rebuild.

### 5.5 Sync set (H23)

- `sync` renders `synchronous_standby_names` for one named replica and `synchronous_commit = on`.
- The name of the synchronous replica lives in the lease. Changing it is two steps under the lease:
  record the new set, then change the setting.
- Losing the synchronous replica: the primary picks another replica the same way. With none left it
  follows `on_sync_loss`: `downgrade` after `SYNC_DOWNGRADE_AFTER` (alert,
  `durability_effective = async`, recorded in the lease) or `block`.
- A replica that was dropped from the set cannot promote itself with RPO > 0 without
  `accept_data_loss`, because the lease records the effective durability.

### 5.6 Consumers

- Each endpoint knows every member from desired state (mTLS already exists) and asks "role and
  generation?" every 1–2 s. It forwards only to the member answering `primary` at the highest
  generation. No control plane is needed for this.
- With no primary answer, it fails closed (no silent write to an unknown member).

## 6. Failure matrix

| Fault | Control plane | Database | Invariant |
|---|---|---|---|
| Arbiter unreachable 10 min | Primary renews fail; standbys cannot take over. Primary stays if it has quorum? No: control plane has no keep-alive quorum; it fences after 20 s. | Primary keeps running only while every member answers keep-alive; no promotion. | I11 for traffic, I3 holds |
| One zone partitioned | Standby cannot take over (lease unchanged but cannot confirm replay/lease); primary keeps serving if it can renew. | Members that cannot keep-alive trigger the primary's failsafe; the isolated member must not acquire. | I3 |
| Primary control node killed | Standby takes over after 40 s quiet + CAS at E+1. | Unaffected unless the database runs there. | I3, I11 |
| Stale leader resumes | Sees a higher epoch, fences before writing. | Sees higher generation, fences. | I3 |
| Clock skew ±5 s | Timers skew by up to 5 s; takeover quiet window absorbs it. | Expiry uses the arbiter clock; keep-alive windows absorb skew. | I3, I13 |
| Sync replica lost | No control-plane change. | Downgrade after 30 s or block; alert. | I13 until downgrade |
| Arbiter outage + one replica unreachable | Primary unaffected unless it is the control holder? It fences on quorum loss (H21). | Primary fences; no promotion (no arbiter). | I3 preserved, availability lost, as designed |

## 7. Model obligations (step 2)

The model is written from this spec only and checks:

- **I3**: never two `primary` actors at one generation/epoch.
- **I12**: an automatic promotion occurs only for a member named in the lease's `sync` set at the
  acquired generation.
- **I13**: under `sync`, no acknowledged commit is absent from the promoted primary's history.
- **I11**: with the control plane unavailable, traffic continues and database failover (when the
  arbiter is reachable) still completes.

Schedules to explore: lease renewal loss, CAS races between two candidates, arbiter outage with and
without member loss, asymmetric partition (A reaches arbiter, B reaches A), clock step back during a
lease, stale leader resume, sync-set change racing a promotion, and a member that answered a
keep-alive trying to acquire.

## 8. Open questions for the owner

1. Does the control plane need a keep-alive quorum like the database failsafe, or is fencing after
   20 s without confirmation the intended rule? This spec assumes the latter (CLUSTERING §6.3).
2. `on_sync_loss` default: `downgrade` after 30 s, or `block`? This spec assumes `downgrade` with a
   loud alert, per H23.
3. Should a standby serve the dashboard read-only at all, or only `/readyz`/`/metrics`? CLUSTERING
   says read-only status; this spec keeps that.
4. May `accept_data_loss` be offered for a sync database at all, and by whom (platform admin only)?
5. Promotion when the master key cannot be verified: fence and page, or promote without secrets
   (apps keep running on cached secrets)? This spec says `canPromote: false`.
