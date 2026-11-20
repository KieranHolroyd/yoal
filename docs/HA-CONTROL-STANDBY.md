# Control-plane standby: operator runbook

Implements the control-plane half of HA-PLAN H21 and [CLUSTERING §6](./CLUSTERING.md), against
the approved [W9 spec](./build-plan/W9-SPEC.md) Revision 1. The flag is `CONTROL_STANDBY`
(`YOAL_FEATURE_CONTROL_STANDBY=1`), opt-in and **off by default**; it advertises the `ha-epoch`
capability on agents. With the flag off nothing in this document runs and a single-node install is
byte-identical (the desired-state golden test pins that).

## What it does

- One control node holds `yoal/ha/control-lease.json` in the platform object store. Every write is a
  conditional PUT; the store's `Date` is the only trusted clock.
- TTL 30 s, renew 10 s, takeover quiet window 40 s, fence after 20 s. Epochs never decrease.
- Roles: `joining`, `standby`, `standby-behind`, `promoting`, `primary`, `fenced`, `unavailable`.
  A non-primary returns `503` for every `/api/agent/*` request with `x-yoal-role` and
  `x-yoal-epoch`, and never renews a run lease. Agents keep their cached desired state (I11).
- A promotion needs a verified master-key fingerprint, the primary's config digest, applied
  migrations and replay within 5 s (`canPromote`). Missing any refuses the CAS.
- The platform route on every ingress renders the control-node upstream list with
  `lb_policy first` and a `/readyz` health check; the lease holder is first.

## Prerequisites

1. **An arbiter that supports conditional writes.** S3/R2, Azure Blob and GCS do (the object store
   must be one of those; the local filesystem store cannot arbitrate). Without it the surfaces fail
   closed: `/readyz` 503, every agent request 503.
2. **A control node identity.** `YOAL_NODE_ID` on the control-plane host, or the host name is used.
   It is the lease `holderNodeId`.
3. **The install CA** (`ENDPOINTS_GATEWAY=1`) to sign the standby's control certificate. Enrolment
   refuses without it instead of issuing an unsigned certificate.
4. **A replica restore step** that writes `<dataDir>/ha-control-replica.json`:
   `{"restored":true,"lagSeconds":0.2,"position":"ltx:42/9f"}`. Until it exists the node stays
   `joining` and `canPromote:false`. Set `YOAL_CONTROL_REPLICA_STATUS` to change the path.
5. **Overlay reachability**: peer control nodes are dialled at `<private address>:8080` for the
   platform upstream list. A node without an overlay address is omitted from the list. Declare a
   direct endpoint per node with `YOAL_CONTROL_ADDRESSES=nod_a=https://a.example.com,nod_b=…`; the
   binding is by node id, never by position.

## Enable on the primary

```sh
# /etc/yoal/yoal.env
YOAL_FEATURE_CONTROL_STANDBY=1
YOAL_NODE_ID=nod_a                 # or leave it to the host name
```

Restart `yoal-control-plane`. `curl -fsS http://localhost/readyz` must show `role: primary` and the
lease epoch. `yoal ha control status` shows every control node that has reported.

A restart does not decrease the epoch: the highest epoch is written to
`<dataDir>/ha-control-epoch.json` before the node serves, and the lease is created at
`highest + 1` only when the object is absent.

## Enrol a standby (second factor)

The ceremony needs a platform-admin dashboard session that has proved a passkey or authenticator
code. An API key or MCP token is refused: there is no step-up state behind it.

On the standby, generate its own key and CSR (the private key never leaves the host):

```sh
openssl ecparam -name prime256v1 -genkey -noout -out /etc/yoal/control.key
chmod 400 /etc/yoal/control.key
openssl req -new -key /etc/yoal/control.key -subj "/CN=nod_b" \
  -addext "subjectAltName=URI:yoal://node/nod_b" -out /tmp/control.csr
```

On any machine with the CLI signed in to an owner session:

```sh
yoal ha control enrol --node nod_b --csr /tmp/control.csr --out /tmp/nod_b.enrol.json
```

The command prints a certificate serial and a **one-time activation code**, and writes the sealed
bundle and certificate to a 0600 file. The activation code is *not* written to that file. The bundle
and the code are not stored on the platform and never appear in desired state, the audit log or a
server log.

On the standby:

```sh
yoal ha control enrol --open /tmp/nod_b.enrol.json --code <activation-code>
```

This unseals the bundle, verifies the master-key fingerprint and the config digest, writes
`/etc/yoal/master.key` (0400) and the allowlisted values into `/etc/yoal/yoal.env` (0600, merged),
and writes `<dataDir>/ha-control-enrolment.json` (0600). The record is promotion evidence: a node
without it never wins a term, automatically or by operator command. Use `--data-dir`,
`--master-key` and `--env` for non-default paths. Then:

1. Set `YOAL_CONTROL_ROLE=standby`, `YOAL_FEATURE_CONTROL_STANDBY=1`, `YOAL_NODE_ID=nod_b`, and the
   same `BETTER_AUTH_SECRET` as the primary (dashboard sessions survive a promotion only when it is
   identical).
2. Restore the control DB replica into its own data directory, start `yoal-control-plane`, and keep
   `ha-control-replica.json` current from the Litestream follow. Re-running the `--open` command
   after the restore refreshes the record's replica fallback.
3. Check `curl -fsS http://localhost/readyz` → `role: standby`, `epoch` equal to the primary's,
   `canPromote: true`, `replication.lagSeconds < 1`. The co-located agent reports the same document
   in its heartbeat (`YOAL_CONTROL_LOCAL_URL`, or the control socket), so `yoal ha control status`
   shows the standby too.

The dashboard enrolment UI is owner-gated and not part of this lane; the API and CLI are the
supported path.

## Promote and demote

```sh
yoal ha control status                     # roles, epochs, lease holder, canPromote, replay lag
yoal ha control promote --expect-epoch 7   # 409 if the lease is not at 7, or canPromote is false
yoal ha control status                     # every node reports epoch 8
```

Promotion reads the lease, checks the evidence, then CASes at the current ETag. A stale ETag loses
the CAS (the old primary may still renew), so the command fails rather than bumping twice. A fenced
node is refused until it is re-seeded, and a host with no enrolment record is always refused.
`--expect-epoch` is compared with the record read for the CAS, not a cached value.

The ordinary operator path applies the same gate as an automatic takeover: the lease must be
released, or expired by the arbiter's clock and unchanged for 40 s. `--break-glass` skips only that
wait, for §18.5 recovery after the old primary's units are stopped; it is still a CAS, so it cannot
create two holders.

Planned switchover: stop writes on the old primary, wait for its lease to be released or to expire,
then promote the standby. An unplanned promotion waits out the 40 s quiet window; the old primary
fences at 20 s, so the two never both accept agents.

The old primary fences on its own; leave it running to inspect, stop it, discard its SQLite and
restore the replica from the new primary before re-enrolling it as a standby. Its epoch file keeps
it from going backwards.

## Failure behaviour

| Fault | Behaviour |
|---|---|
| Arbiter unreachable | The primary keeps serving for 20 s, then fences. A standby cannot take over and reports `unavailable` after 30 s. Fix the store or restore to a second target and claim a new epoch. |
| Primary control node killed | A standby takes over after 40 s quiet + CAS at E+1. Agents rotate to the next address. |
| Stale primary returns | It sees the higher epoch, fences; after 5 s with the holder stable and its replica current it may rejoin as a standby, but a new term still needs a fresh CAS. |
| One ingress/control node partitioned | The CAS decides. The loser fences within 20 s. |
| Standby behind | `canPromote:false`; it stays a read-only human surface. |
| Arbiter has no conditional write | Everything fails closed: `/readyz` 503, agent requests 503. |

## Verification

```sh
bun run check
bun test packages/core/src/control-standby.test.ts
bun test packages/core/src/ha-control-arbiter.test.ts
bun test packages/core/src/control-plane-service.test.ts
bun test packages/core/src/control-enrolment.test.ts
bun test apps/agent/src/control-endpoints.test.ts
bun test packages/site-config/src/site-config.test.ts
bun test tests/ha/sim/w9
bun tests/ha/sim/w9/run.ts --runs 5000
```

The single-node gate (`tests/ha/scenarios/single-node-gate.ts`) needs the Docker lab and is run by
the integrator.

## Not in this lane

- Database member failover, sync/rewind and PITR (lanes B and C).
- The witness arbiter, regions and `DB_AUTO_PROMOTE` (Wave 4).
- Replica restore/follow automation: this lane consumes its status file and refuses promotion
  without it.
- A dashboard enrolment wizard; the CLI/API ceremony is complete and audited.
