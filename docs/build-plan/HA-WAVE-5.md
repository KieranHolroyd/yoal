# HA Wave 5 — five commands (M5)

Plan: [HA-PLAN.md](../HA-PLAN.md) §5 wave 5, §6.5, §8, H26 (regions), H27 (profile), W13, W14, W17.
Base: `main` at `5741cfbe` (`0.16.11` plus the D235 drill files that `0.16.10` referenced but did
not commit). Lanes branch from `main` after the foundation merges, and merge back into `main`.

**M5:** a new HA cluster from four empty machines in under 30 minutes (§8, timed by someone who did
not build it), and the region failover drill passes in the weekly cloud run.

## Opening (one agent, merges alone before the lanes)

Foundation PR 5: region contracts (node `region`, `spread: region`, database `standbyRegion`, the
region-promotion record), the `ha init` profile plan contract (which flags and cluster settings each
profile sets), the preflight/doctor check contract (check id, status, the exact fix), the drill
catalogue contract (`yoal ha drill <scenario>` / `--all`), the new blueprint keys (§8) as schema
only, the `REGIONS` flag, migration `0132`, and empty services. Extends what already exists:
`ha-service.ts` (`profile`), `ha-preflight.ts`, `/api/v1/ha/*`, `yoal ha` (`status`, `failover`,
`control`, `drill node-offline`), `0130` drills/SLO, `0131` node drills.

## Worktrees and assignments

| Plan | Branch | Migration reservation |
|---|---|---|
| Opening: foundation PR 5 | `ha/w5-foundation` | `0132_regions.sql` |
| A — W13 regions and DR: region field and `spread: region`, `sync` only inside a region, standby-region async replica that never auto-promotes, `yoal ha region promote` (fenced, human-confirmed, control plane → databases → steering), stacked steering | `ha/w5-a-regions` | `0133` spare |
| B — W14 commands: `yoal ha init --profile`, `yoal ha preflight`, `yoal doctor`, `yoal ha drill <scenario>\|--all` with REST and MCP read tools | `ha/w5-b-ha-commands` | `0134` spare |
| C — W14 blueprint: the §8 keys in `plan`/`apply`, `cluster.requires` assertions, an HA section in the plan diff | `ha/w5-c-blueprint` | `0135` spare |
| D — W14 dashboard: **Settings → High availability** as a guided setup with the same checks as preflight | `ha/w5-d-dashboard` | `0136` spare |
| E — W14 provisioning (outside the core): cloud-init template, Terraform module for Azure first (then Hetzner, AWS), balancer recipe pages | `ha/w5-e-provisioning` | none |
| Docs pipeline (W17), after the lanes | `ha/w5-docs` | none |

Renumber at merge time; a spare is a claim, not a number.

## Flags

| Workstream | Flag | Capability |
|---|---|---|
| W13 regions | `REGIONS` (new, opt-in) | none: control-plane placement and promotion |
| W14 commands, blueprint, dashboard | none: surfaces over existing flags; `ha init` sets flags only through the existing settings paths | — |

## Merge order

1. Foundation. 2. A (regions: the other lanes show region data). 3. B. 4. C and D (consume B's
services). 5. E any time. 6. Docs last.

## Known integration conflicts

- `apps/cli/src/commands/ha.ts`: A (`region promote`) and B (`init`, `preflight`, `drill`).
- `packages/core/src/ha-preflight.ts`: A (region checks) and B (doctor).
- `packages/contracts/src/blueprint.ts` and `packages/core/src/blueprints*.ts`: C only.
- The HA settings page: D only; it consumes B's REST.

## Verification

Each lane: `bun run check`, `bun test`, flag-off golden byte-identical, an independent review of its
diff against its brief. M5 itself is human evidence: the timed §8 walkthrough on four empty
machines, and the region failover drill on a cloud run (owner's spend).
