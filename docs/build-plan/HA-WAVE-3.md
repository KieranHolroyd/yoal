# HA Wave 3 — planned work is invisible (M3)

Plan: [HA-PLAN.md](../HA-PLAN.md) §5 wave 3, §6.4, §6.5. Base: `main` after Wave 2 (`0.16.x`).
No lane merges to `main`; the integrator merges. Wave 3 is the safety-critical wave: its opening is a
**spec**, not code.

**M3:** switchover ≤ 5 s with no lost commit; manual control-plane promote; 24 h with the control
plane down and traffic unaffected.

## Gate: the §6.4 procedure

Wave 3 lanes A–C touch H21–H23 and do not start until:

1. **[W9-SPEC.md](./W9-SPEC.md) is approved by the owner.** The spec covers the control-plane lease
   and epoch, the database member machine, failsafe and the synchronous set. No implementation
   before approval.
2. A second agent, given only the approved spec, writes the model (the W1 simulator) and the
   properties I3, I12, I13. Counterexamples go back to the spec, not to a patch.
3. One author implements each machine against the spec, with the model in CI.
4. Three prosecutors who never saw the reasoning try one invariant each, with different fault
   families, before the flag is enabled anywhere.
5. 24 h soak with the checker before the flag can be on by default (§7.3).

Lanes D (W12) and E (remaining W8 drivers) are independent of the spec and can start after the
foundation.

## Opening (one agent, merges alone)

1. Foundation PR 3: control role/epoch and standby contracts, database member and synchronous-set
   contracts, agent desired-state fields (control address list, epoch, member roles), flags, the
   reserved migration block, and empty services with signatures.
2. The desired-state split already exists; the foundation edits the modules, not `nodes.ts`.

## Worktrees and assignments

| Plan | Worktree | Branch | Migration reservation |
|---|---|---|---|
| Opening: foundation PR 3 | `ha/w3-foundation` | `ha/w3-foundation` | **`0125_control_epoch.sql`, `0126_replica_durability.sql` used** |
| A — W9 control-plane standby and arbiter (single author, per §6.4) | agent worktree | `ha/w3-a-control-standby` | `0127` spare |
| B — W10 sync, switchover, rewind, replica PITR | agent worktree | `ha/w3-b-sync-switchover` | `0128` spare |
| C — W10 PITR/rewind and backup from replicas | agent worktree | `ha/w3-c-pitr-rewind` | `0129` spare |
| D — W12 platform dependencies (pre-pull, registry storage, telemetry spool, movable identity/mail) | agent worktree | `ha/w3-d-platform-deps` | `0130` spare |
| E — remaining W8 drivers (`vip`, `webhook`) | agent worktree | `ha/w3-e-drivers` | `0131` spare |

Renumber at merge time; a spare is a claim, not a number.

## Flags

| Workstream | Flag | Capability |
|---|---|---|
| W9 control standby | `CONTROL_STANDBY` (new, opt-in) | `ha-epoch` |
| W10 synchronous replication | `SYNC_REPLICA` (new, opt-in) | `db-member` |
| W10 rewind/PITR with replicas | `PITR_REWIND` (new, opt-in) | `db-member` |
| W8 `vip`/`webhook` | reuse `STEERING` (already opt-in) | — |
| W12 platform dependencies | none: additive, defaults unchanged | — |

Every flag is in `OPT_IN_FEATURES`. `DB_AUTO_PROMOTE` stays off and keeps its F1 guard (refuse the
handler unless self-fencing is active).

## Merge order

1. `ha/w3-foundation`.
2. The model PR (spec + simulator properties) before any implementation lane.
3. A (W9) alone while it touches the lease/epoch model.
4. B, then C (C consumes B's replica image and stanza).
5. D and E anytime after the foundation.
6. Lab scenarios last, including the 24 h soak job.

## Known integration conflicts

- `packages/core/src/ha-lease.ts` and `lease.ts`: A only.
- `packages/core/src/database-replica-service.ts`: B and C.
- `apps/helper/src/replication.ts` and `apps/agent/src/database-member.ts`: A (member keep-alive)
  and B (`sync` rendering).
- `packages/site-config/src/compile.ts`: E (`vip`/`webhook` do not touch it) and D (registry storage).
- `packages/core/src/nodes.ts`: foundation only; desired-state modules after.

## Verification

Each lane: `bun run check`, `bun test`, the single-node gate (flags off), the model in CI where it
owns one, a review by an agent that has not seen the author's reasoning, and its exit scenario.
After integration: 100 switchovers under load, a 24 h control-plane outage with traffic unaffected,
and the fault catalogue families A–E at 20 repetitions for the auto paths.

## Deferred out of Wave 3

- W11 automatic database failover (Wave 4, after S8 passes and the spec is extended to H22).
- Regions (W13).
- Cloud balancer drivers (after M5).
