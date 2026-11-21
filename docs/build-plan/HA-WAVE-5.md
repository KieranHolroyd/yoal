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
| D — W14 dashboard: **Settings → High availability** as a guided setup with the same checks as preflight | `ha/w5-d-dashboard` | `0136` spare (unused; `0136` went to A) |
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

## Report

All five lanes are merged into local `main`, along with two review-debt lanes and the prober fix.
On `main` at `5fde4db3`: `bun run check` passes, `check:migrations` passes, and `bun test` gives
7,219 pass, 74 skip, 0 fail. The docs pipeline lane (W17) has not started. M5 is not yet shown:
it needs the human-timed walkthrough and a cloud run.

### What merged

| Branch | Merge | Migrations | Review |
|---|---|---|---|
| `ha/debt-1-safety`: I16 corrupt release-command state is quarantined; a rollback cancels the held release's queued command (H25); version churn; gateway bind | `3686c374` | — | Independent; blocker fixed before merge |
| `ha/fix-dns-probe`: the `dns-failover` prober reads the 16-byte one-word health answer, not JSON | `f95038a3` | — | — |
| E: cloud-init, Terraform for Azure, Hetzner and AWS, load-balancer recipe pages | `a2f3ece6` | — | Independent |
| Foundation PR 5 | `5361507f` | `0132_regions` | Independent |
| `ha/debt-2-lab-attach`: per-project gateway marker, read endpoints, CA rotation for admins only (409 while a node is on the previous CA), lab `--feature` | `802643e4` | `0133_attachment_gateway_marker` | Independent |
| C: the §8 blueprint keys in `plan` and `apply`, `cluster.requires`, an HA section in the plan diff | `b15e20de` | — | Independent |
| B: `ha init`, `ha preflight`, `doctor`, `ha drill`, installer flags, join tokens that carry their roles, HA MCP read tools | `12c1fd85` | `0134_ha_drills`, `0135_join_token_roles` | Independent; fix round |
| A: region field and `spread: region`, a standby region, fenced region promotion with break glass, stored on the record | `5d0eea30` | `0136_region_promotion_break_glass` | Independent; rework, re-check, fixes |
| D: the guided setup, status cards, drills, admin CA rotation and attachment migration | `5fde4db3` | — | Independent; fix round, re-check, fixes |

Two lane D fixes also landed earlier, on their own: `e995890f`, where a named `node:crypto` import
in `contracts/ingress.ts` broke `vite dev` on every dashboard page, and `4460e673`, a test that
changed the shared drill catalogue. Main also gained `5741cfbe`, the D235 drill files that
`0.16.10` referenced but never committed. Without that commit, `origin/main` does not build from a
clean checkout.

### Bugs found and fixed during review

- **Region promotion:**
  - It moved databases from every region, not only the region being left.
  - It had no live-lease gate and no re-check before each step.
  - Concurrent confirms could start two runs.
- **Lease renewal:** after lane A's first version, the control plane stopped renewing a database
  lease when the primary's node was draining, even with `REGIONS` off. A drained primary then
  lost its lease, and `yoal db switchover` was refused. Renewal now stops only for an offline node,
  and only with `REGIONS` on.
- **Migrate apply:** `POST /api/v1/ha/attachments/migrate` read an empty `projects` list as
  "every app". It now answers 422.
- **Drills:** a drill could take down the control-plane node without an opt-in, and an operator
  could run a destructive scenario. Both are fixed. A destructive drill needs a platform admin and
  the resource's name typed back.
- **Join tokens:** they now carry the roles they allow.

### Known limits (stated in the docs)

- **Two primaries across regions.** Nothing prevents two writable primaries across regions until
  W11 self-fencing ships. Suppose region A is cut off from B and the arbiter but keeps running:
  its leases lapse and promotion goes ahead, while A's Postgres still takes writes. The operator
  must stop or isolate region A's database nodes. With no database arbiter there is no lease, so
  the lease check proves nothing. `self-hosting/regions.md` and OPS §3.12 say this.
- **Database failover.** Automatic database failover is still report-only (no
  `db-member-self-fencing` capability). The dashboard shows it as "Not available yet", with the
  reason.

### Where the plan is wrong

- **§8, "five commands."** The blueprint needs more than one `apply`: `sync` durability needs
  replicas that are already streaming, and automatic failover needs a passed drill.
- **An HA install needs a Cloudflare zone today.** It is the only steering and DNS-01 provider
  that is built.
- **`ha init` apply needs a dashboard session.** It is an admin action, and admin checks refuse
  API keys under the default bindings. The CLI can plan; a person applies from the dashboard. CA
  rotation and attachment-migration apply are the same.
- **`ha drill --all` runs little on a real fleet.** Destructive scenarios are skipped unless they
  are named and confirmed, and the control-plane node is skipped unless opted in.
- **"Reads from B within 3 minutes"** (W13's exit) needs an external cross-region failover: a
  balancer or DNS steering that is not in a region. Yoal's own steering runs in the control
  plane, which may be in the lost region.
- **Drill permissions.** HA-PLAN §10 says drills need a platform admin. The server lets a platform
  operator run non-destructive drills; the dashboard keeps them for admins.

### What M5 still needs

1. The §8 walkthrough on four empty machines, timed by someone who did not build it, from the
   lane E cloud-init or Terraform.
2. The W13 exit scenario on the weekly cloud run, at the owner's cost:
   - Two regions, a Cloudflare zone, and an external cross-region balancer.
   - The drill cuts region A off, checks that reads serve from B within 3 minutes, has a person run
     `yoal ha region promote`, and checks that RPO equals the measured replication lag.
   - This scenario is not built and has not run.
3. The docs pipeline lane (W17).
4. A release. Local `main` is 42 commits ahead of `origin/main` and has not been pushed.
