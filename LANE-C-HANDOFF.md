# Lane C hand-off — W5 rollout and release command

Branch `ha/w1-c-release`, based on `ha/integration` `1cd872e9`.

## What this lane ships

- `packages/core/src/release-commands.ts`: the release-command scheduler and its I16 lease.
  - `schedule()` queues one attempt per release id and hands it to one eligible node
    (holds a copy, online, declares `release-phase`) with a `startBy` deadline.
  - `gate()` for the rollout: `none` / `pending` / `succeeded` / `failed`.
  - `tick()` leases what waits and expires lost leases as `timeout` (unknown outcome, never
    auto-retried).
  - `tasksForNode()` / `releaseShasForNode()` feed desired state; a queued run past `startBy`
    is not served, a running one still is.
  - `recordResults()` accepts only the node holding the run; a late result never revives a
    closed run.
  - `activation()` serves the new release's env/secrets to the node holding the run through
    `WorkloadService.releaseActivation()`.
- `packages/core/src/workloads.ts`: rollout gating (`awaitingRelease`), release command
  queueing on deploy, superseded-attempt cancellation, canary windows from heartbeat counters,
  `imagePrePullsForNode()`, `releaseActivation()`.
- `packages/core/src/canary-judge.ts`: errors fail at once, latency on 2× and ≥250 ms, soak then
  pass, quiet app passes on readiness.
- `packages/core/src/ha-level.ts` + `topology.ts`: HA level from current placement (L0–L3).
- `packages/contracts/src/release-phase.ts`/`agent.ts` (commit `dd138b36`): per-upstream
  heartbeat counters and `imagePrePulls`; `system:release` principal.
- Desired-state wiring in `nodes.ts` (already present at the base) now has its scheduler.

## Verified

- `bun run check`: 0 errors.
- `bun test`: 6167 pass, 73 skip, 0 fail (28 new tests in
  `release-commands.test.ts`, `canary-judge.test.ts`, `ha-level.test.ts`).
- Flag-off single-node path: the release-phase write tests still pass; the golden desired-state
  test passes unchanged with `RELEASE_PHASE` off.

## Not verified

- The W5 lab exit (10k requests/min through a rolling deploy; failing release command keeps every
  copy on the old release) needs the lab lane; lane C did not run it.
- The agent side that actually executes `releaseCommands` and acts on `imagePrePulls` is lane D.

## Deviations

- Added `system:release` to `packages/contracts/src/iam/system.ts` (needed for the audit row).
- `IActivation` extraction in `workloads.ts`: `activation()` now delegates to
  `activationPayload()`; behaviour unchanged, `releaseActivation()` reuses it.
- Fixed the WIP's `.run().changes` to `.returning()` (this drizzle version types `run()` as void).
- No migration used (0119 already covers `release_command_runs`).
