# HA Wave 4 — unplanned failure is survivable (M4)

Plan: [HA-PLAN.md](../HA-PLAN.md) §5 wave 4, §6.4, §6.5. Base: `main` after Wave 3 (`0.16.8`).
Wave 4 is the second safety-critical wave. It opens with a spec and a model, not code.

**M4:** kill the primary's node: writable in ≤ 30 s, RPO 0, 20 times per scenario.

## Gate: the §6.4 procedure

1. **[W11-SPEC.md](./W11-SPEC.md) approved** (decisions are in the document; the owner delegated
   them, as in Wave 3). It extends W9-SPEC §5 with the automatic-failover policy; the member machine
   itself is already implemented.
2. An independent model, from the spec alone, checks I3, I11, I12, I13 and the time-to-writable
   bound. Counterexamples go back to the spec.
3. One author implements W11 against the spec, with the model in CI.
4. Three prosecutors who never saw the reasoning try one invariant each, with a different fault
   family. A violation goes back to step 1.
5. 20 repetitions of each §7.2 database-kill scenario in the lab, then the 24 h soak, before
   `auto` can be enabled by an operator.

## Opening

- Foundation PR 4 (one agent): per-database failover policy and refusal contracts, drill/arbiter
  evidence fields, desired-state and heartbeat shapes, flags, reserved migrations, stubs.
- W15 (observability) is independent and can run in parallel after the foundation.

## Worktrees and assignments

| Plan | Worktree | Branch | Migration reservation |
|---|---|---|---|
| Opening: foundation PR 4 | `ha/w4-foundation` | `ha/w4-foundation` | **`0129_db_failover_policy.sql`, `0130_drills_slo.sql` used** |
| A — W11 automatic database failover (single author, §6.4) | agent worktree | `ha/w4-a-auto-failover` | `0131` spare |
| B — W15 observability and SLOs | agent worktree | `ha/w4-b-observability` | `0132` spare |
| Prosecutors ×3 (after A) | read-only | — | — |
| Lab scenarios | agent worktree | `ha/w4-lab` | — |

## Flags

| Workstream | Flag | Capability |
|---|---|---|
| W11 automatic failover | `DB_AUTO_PROMOTE` (exists, default off; Wave 4 wires the handler) | `db-member` |
| W11 per-database policy | none: additive `failoverMode`, default `manual` | — |
| W15 observability | `SLO_OBJECTS` (new, opt-in) | — |
| W15 external prober | `EXTERNAL_PROBER` (new, opt-in) | — |

`DB_AUTO_PROMOTE` stays off until the M4 evidence is recorded. A per-database `auto` is refused
while the global flag is off, on fewer than three data nodes, without a tested arbiter, or without
the W11 drill.

## Merge order

1. `ha/w4-foundation`.
2. The model PR (spec + schedules) before implementation.
3. A (W11) alone.
4. B (W15) anytime after the foundation.
5. Lab scenarios and the soak.

## Verification

- `bun run check`, `bun test`, the single-node gate, the model in CI.
- Lab: kill the database primary's node 20 times; writable ≤ 30 s, RPO 0 in `sync`; arbiter outage
  alone causes no failover and no stop; a two-data-node fleet refuses `auto`.
- Prosecutors: network, process, and clock/disk families.
- 24 h random-fault soak with the checker before the flag may be on by default.

## Deferred

- Region failover (W13).
- Witness arbiter (trigger-gated).
- Automatic failover for engines other than Postgres.
