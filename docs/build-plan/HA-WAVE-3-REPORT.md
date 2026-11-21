# HA Wave 3 report — planned work is invisible (M3)

Plan: [HA-PLAN.md](../HA-PLAN.md) §5 wave 3, §6.4, §6.5. Base: `main` after Wave 2. All lanes are
merged to `main`; releases are listed below. `VERSION` is `0.16.8`.

## Branches

| Lane | Branch | Tip | Release |
|---|---|---|---|
| Opening: foundation PR 3 | `ha/w3-foundation` | `e121237f` | `0.16.4` |
| Model (W9 spec Rev 1) | `ha/w3-model` | `76a5400c` | docs/tests |
| A — W9 control standby (single author) | `ha/w3-a-control-standby` | `8394e9bd` | `0.16.6` |
| B — W10 sync, switchover, rewind | `ha/w3-b-sync-switchover` | `0b8c903a` | `0.16.8` |
| C — W10 PITR/rewind | `ha/w3-c-pitr-rewind` | `9ebb899c` | `0.16.7` |
| D — W12 platform dependencies | `ha/w3-d-platform-deps` | `e70ece03` | `0.16.5` |
| E — `vip` and `webhook` drivers | `ha/w3-e-drivers` | `ecb3dab6` | `0.16.5` |
| Model (W9 spec Rev 2) | `ha/w3-model` | `18619260` | docs/tests |

## Gates

- `bun run check`: 0 errors (one pre-existing control-plane Svelte warning).
- `bun test`: **6684 pass / 74 skip / 0 fail** on the integrated tree.
- Migrations: `0125` control epoch, `0126` replica durability, `0127` replica rewind, `0128`
  sync/switchover/rewind. Additive; contiguous.
- Flag-off desired state: byte-identical golden throughout.
- W9 model: 5,000 schedules over 13 families, **0 violations** of I3/I11/I12/I13; Revision 2 adds
  control-outage sync loss and stale-CAS reconciliation, and the negative control that records sync
  from a stale ETag loses commits (caught).

## What landed

- **A (W9/C6):** arbiter lease with real CAS on S3/Azure/GCS, the control state machine and
  30/10/40/20 timers, epoch fencing, agent address list and epoch, standby enrolment with step-up,
  `/api/v1/ha/control/*`, `yoal ha control enrol|promote|status`, heartbeat `control` reports,
  `unavailable` on arbiter loss, monotonic durable epoch.
- **B (W10):** durability settings; the Rev-1 three-step sync transition (open `changing`, switch
  with a target-side barrier, close `steady`); 5 s member tick and renewal; switchover with
  checkpoint/quiesce/promote/re-point; promotion latched so a post-promote failure never resumes the
  old primary; rewind hand-over; lease reconciliation; `If-Match`; a shipped-drain commit-loss
  harness with a failing negative control.
- **C (W10/PITR):** replica image with pgBackRest and the database stanza carried/validated on the
  verb; full PITR with Azure/GCS repositories behind flags; `pg_rewind` verb and marker; failed
  rewind → purge/rebuild; post-promotion restore drill. Base backups stay **primary-only**: pgBackRest
  cannot back up from a standby-only configuration.
- **D (W12):** registry storage on the platform object store, bounded agent telemetry spool with gap
  bands, `ha` profile preflight, movable identity/mail, real pre-pull reserve.
- **E (W8):** `vip` (restart-safe, unicast-only, IPv6) and `webhook` (HMAC, narrowing acks) through
  the shared conformance suite.

## Reviews

Every lane was independently reviewed, many over several rounds. The safety-critical ones found real
defects that were fixed, not waived:

- W9: standby background writers, replica-evidence fallback, tick wedge, operator-promote expiry,
  static-role auto-takeover, enrolment half, code leak, dead `control` reports, epoch rollback.
- W10: barrier proved against the primary itself, async reload, fallback setting mismatch,
  in-flight writes, resume-after-promote, rewind id mismatch, expired leases, promotion
  reconciliation, historical-failover replay, async lease expiry, post-promote latch.
- PITR: replica readiness never passed, orphan stanza, dead `wal_log_hints`.
- W12: inert pre-pull, fleet-wide gap leak, bucket double-count.
- W8: stale VRRP holder after restart, empty-set withdrawal, multicast fallback, ack widening.

## M3 evidence still owed (not ticked)

1. **100 switchovers under load** in the lab, with zero lost commits and each ≤ 5 s. The current pass
   is a deterministic harness around the shipped drain (including a negative control), not a real
   Postgres fleet.
2. **24 h control-plane outage** with traffic unaffected (CLUSTERING C6), and the control-plane
   failover itself in the lab.
3. **Post-promotion PITR restore** via `scripts/pitr-rewind-drill.sh` against a real promotion.
4. **Single-node gate** on the four-node lab with every Wave 3 flag off.

## Residual gaps

- B's database lease is still CASed by the control plane at the ETag the node reports; a fully
  node-owned lease needs a shared arbiter client (lane A's) — recorded, not silently claimed.
- Replica base backups are deferred until a two-host `pg1`/`pg2` pgBackRest config exists.
- A's break-glass ceremony audits the successful path; the §18.14 log file/reason confirmation is a
  follow-up.
- D ships REST + dashboard + OPS; `yoal fleet move` / MCP read surfaces remain W14.
- E's keepalived and webhook have no live lab/operator run yet.

## Wave 4 opening (proposed)

Spec and model for W11 (H21 failsafe, H22, H23 extension) under §6.4, then one author for W11, with
W15 observability as the parallel lane. No implementation before the S8 spec is approved; the W9
model and its schedules are the starting point.
