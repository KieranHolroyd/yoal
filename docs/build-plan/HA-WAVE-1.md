# HA Wave 1 — stateful apps scale out (M1)

Plan: [HA-PLAN.md](../HA-PLAN.md) §5 wave 1, §6.5. Base: local branch `ha/integration`, which is
`main` at `83d4e469` plus every Wave 0 branch merged (6,024 tests green, migrations to `0117`).
No HA branch has merged to `main`; the owner merges. Lane branches start from `ha/integration` and
are merged back into it by the integrator, in the order below.

**M1:** a container app in three copies on three nodes uses one Postgres; a deploy with a release
command drops no request; the lab kills a node and the checker is clean.

## Worktrees and assignments

| Plan | Worktree | Branch | Migration reservation |
|---|---|---|---|
| Opening: desired-state split (§6.1 hot files) | agent worktree | `ha/w1-split` | no migration |
| Opening: foundation PR 1 (endpoints, release, object-store kinds, CA) | agent worktree | `ha/w1-foundation` | `0118_node_ca.sql`, `0119_release_phase.sql`, `0120_object_store_kinds.sql` |
| Fixes F7–F12 (Wave 0 lab findings) | agent worktree | `ha/w1-fixes` | no migration (`0126` spare) |
| W1 finish: harness and M1 scenarios (owns the lab) | agent worktree | `ha/w1-lab` | no migration |
| A — W4 agent and helper (forwarder on the gateway address, `AddHost`, CA trust on nodes) | agent worktree | `ha/w1-a-attach-agent` | `0121` spare |
| B — W4 core and placement (gate removal, same-node endpoints, pooler, read endpoints, CA issuance) | agent worktree | `ha/w1-b-attach-core` | `0122` spare |
| C — W5 rollout and release command (I16, canary judging, per-app spread, pre-pull, HA level) | agent worktree | `ha/w1-c-release` | `0123` spare |
| D — W5 runtime, drain, readiness (agent jobs, units, `compile.ts` readiness and drain) | agent worktree | `ha/w1-d-drain` | `0124` spare |
| E — W3 object-store backends (`s3` options, `azure`, `gcs`; conformance suite; spike client fixes) | agent worktree | `ha/w1-e-object-stores` | `0125` spare |

Schema for the wave lands in the foundation PR (HA-PLAN §6.1 rule 2). A lane uses its spare
number only for a table the foundation could not foresee, and says so in its hand-back; the
integrator renumbers to keep the sequence contiguous.

## Flags

Every new flag is in `OPT_IN_FEATURES` (default off), because turning it on is the risky direction.
`SERVICE_ENDPOINTS` (default on) is not reused for the new attachment behaviour: changing what it
does would change single-node installs.

| Workstream | Flag | Capability |
|---|---|---|
| W4 attachments everywhere | `ENDPOINTS_GATEWAY` (new, opt-in) | `endpoints-gateway` |
| W5 release phase, readiness, drain | `RELEASE_PHASE` (new, opt-in) | `release-phase` |
| W3 Azure Blob | `OBJECT_STORE_AZURE` (new, opt-in) | — |
| W3 GCS | `OBJECT_STORE_GCS` (new, opt-in) | — |
| W3 `s3` region and path-style options | none: additive, defaults reproduce today's `auto` region | — |

## Merge order

1. `ha/w1-split` (alone, suite green, golden snapshot unchanged).
2. `ha/w1-fixes`.
3. `ha/w1-foundation` (rebased onto 1–2 if needed).
4. Lanes in any order as they pass review and their lab scenario; E has the fewest conflicts and
   can go first. A before B when both are ready (B's desired-state fields are consumed by A).
5. `ha/w1-lab` last, so its scenarios run against everything merged.
6. `ha/w0-spike-s10` whenever S10 finishes (docs and `spikes/` only).

## Known integration conflicts

- `apps/helper/src/units.ts`: A (`AddHost`) and D (`stopTimeoutSeconds`, drain). Different
  functions; the integrator resolves.
- `packages/core/src/workloads.ts`: B (placement gate) and C (`rolloutTick`).
- `packages/site-config/src/compile.ts`: F7 (health Host header) and D (readiness path, drain).
- Desired-state modules from the split: B owns the endpoints and databases modules, C and D share
  the releases module (C the release-command job, D the drain and stop fields).

## Verification

Each lane: `bun run check`, `bun test`, the single-node gate, a review by an agent that has not
seen the author's reasoning (the diff and the exit criteria only; correctness and security), and
its exit scenario in the lab run by the harness lane. After integration: the M1 scenarios
(`attachments-three-nodes`, `rolling-deploy-under-load`, `kill-node`, `single-node-gate`) on the
integrated tree.

## Deferred out of Wave 1

- `ha-lease.ts` defects found in Wave 0 (renewal stamped on reply, no self-retake, epoch going
  backwards, MD5 ABA): W9 core, Wave 3, under the §6.4 procedure. The object-store side (identity
  reads and failing closed on weak ETags, request timeouts) is in lane E.
- S8 spec decisions D-S8-1…17: needed before Wave 4 (W11), awaiting the owner.
- K8s allowlist on `remote_ip` (W8), the Cloudflare token in Caddy JSON (W7), release.yml's Go
  version (owner).
