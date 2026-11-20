# Lane C hand-off — W5 rollout and release command

Branch `ha/w1-c-release`, base `ha/integration` @ `1cd872e9` (merged cleanly; no conflicts).
The interrupted work (`bf0b4626`) was inspected, kept, and finished; it is not discarded.
No migration was used (`0119_release_phase.sql` already covers `release_command_runs` and
`deployment_canaries`); `0123` is untouched.

## What ships

- `packages/core/src/release-commands.ts` — the release-command scheduler and its I16 lease.
  - `schedule()` one attempt per release id, leased to one node that holds a copy, is online and
    declares `release-phase`, with a `startBy` deadline.
  - `tick()` leases waiting runs and expires a silent lease as `timeout` after the latest moment the
    command could still be running (`startBy` + skew + timeout + grace + stop grace + margin). A
    timeout is never retried automatically.
  - `gate()` → `none | pending | succeeded | failed`; `recordResults()` accepts only the node holding
    the run, and a late result never revives a closed run; `tasksForNode()`/`releaseShasForNode()`
    feed desired state; `activation()` serves the new release's env/secrets through
    `WorkloadService.releaseActivation()`.
- `packages/core/src/workloads.ts`
  - `record()` queues a release command and holds every copy on the previous release until the gate
    succeeds (including a first deploy, whose copies desired state withholds); a failed command
    abandons the deployment by moving the pointers only (`abandonFailedRelease`), so no copy moves.
  - `rolloutTick()` gates on the command, runs the canary copies first, judges them from the edge's
    own per-upstream counters, and reverts on failure.
  - `imagePrePullsForNode()`, `recordUpstreamCounters()`, per-app `resolvedSpread` in plan, scale,
    move, balance and surge paths.
- `packages/core/src/canary-judge.ts` — errors fail at once (the existing promote-spike rule),
  latency on 2× and ≥250 ms, soak then pass, quiet app passes on readiness.
- `packages/core/src/ha-level.ts` + `topology.ts` — L0–L3 computed from current placement (G24).
- Wiring: `context.ts`/`index.ts` (service), `nodes.ts` (heartbeat results, desired-state
  `releaseCommands`/`imagePrePulls`/release shas), `failover-service.ts` (scheduler tick before the
  rollout tick), `deployments.ts` (`abandonFailedRelease`), control-plane agent route
  `release-commands/<runId>` for the activation.
- Contracts: only the already-committed `dd138b36` addition (heartbeat `upstreamCounters`,
  desired-state `imagePrePulls`, capability-gate stripping). No further contract edits.

## Verified

- `bun run check` — 0 errors (`@yoal/control-plane`: 0 errors, 1 pre-existing Svelte warning;
  `iam lint: no new role/kind checks`).
- `bun test` — **6176 pass, 73 skip, 0 fail**, 6249 tests in 562 files.
- `bun test tests/ha` — 66 pass, 0 fail; `node_modules/.bin/tsc -p tests/ha` clean.
- Focused: `release-phase.test.ts` (8), `release-commands.test.ts` (10), `canary-judge.test.ts`,
  `ha-level.test.ts`, `scaling.test.ts` (27) — all green.
- Behaviours asserted in tests:
  - a failing release command leaves every copy on the old release and moves the pointer back;
  - a first deploy with a release command renders no copy until the command succeeds;
  - a success is never rerun, a failure frees the lease (attempt 2), two releases never run at once;
  - an expired lease becomes `timeout`, and a late success under a partition neither revives the run
    nor opens the gate;
  - a canary 5xx spike fails before the other copies roll; a healthy canary passes after the soak and
    the rest roll; a failed canary reverts the pointers in the same tick;
  - `placement.spread: zone` overrides the cluster spread for one app;
  - `imagePrePulls` is present for a capability node holding a copy and absent without the capability;
  - flag-off: no release rows, today's rolling start, no `releaseCommands`/`imagePrePulls` in desired
    state, and a release-phase field is refused.

## Not verified (and why)

- **W5 lab exit** — 10,000 requests/min through a rolling deploy with zero non-2xx, and the same
  under a partition. Needs the lab; `tests/ha/scenarios` has no rolling-deploy scenario yet, and
  lane C did not run one. The authoritative run is lane lab's later job.
- **Agent execution** — lane D runs `releaseCommands`, fetches `release-commands/<runId>`, acts on
  `imagePrePulls`, and reports `releaseCommandResults`/`upstreamCounters`. This lane only proves the
  control-plane side and the I16 lease.
- **Real multi-control-plane partition** — the lease/expiry/late-result path is unit-tested with a
  moved clock, not over a partitioned network.
- **Surfaces** — no REST/CLI/dashboard views for runs were added (not in this lane's file list);
  `ReleaseCommandRunView`/`list`/`get`/`logs` exist for the next consumer.

## Deviations

- Beyond the named core files, wiring needed: `context.ts`, `index.ts`, `nodes.ts`,
  `failover-service.ts`, `deployments.ts` (a pointer-only abandon) and one control-plane agent route.
  No `apps/agent`, `apps/helper` or `packages/site-config/src/compile.ts` change.
- The interrupted attempt's `system:release` principal in `packages/contracts/src/iam/system.ts` was
  **reverted**: the audit row uses the existing `system:rollout` actor, keeping lane C out of
  `packages/contracts`.
- Canary counter windows are held in control-plane memory (bounded, 20k windows, 2 h), not in a new
  table; a restart loses in-flight windows and the judge waits for the next heartbeat. p95 across
  windows is request-weighted (an approximation that never depends on ClickHouse).
- A `timeout` run is terminal for the deployment even if the node later reports success; the outcome is
  recorded on the run, and only a person retries (new attempt).
- A failing command with `autoRollback` on abandons the deployment (pointers/spec restored, copies
  untouched); with it off the rollout pauses while desired state still renders the previous release.
- The canary baseline is the copies not in the canary set, matched to upstreams by node address (the
  reporting node for a local upstream).
- No `VERSION` change.

## Final commit

Code and tests: `ee0a09a2`. This hand-off is the commit immediately after it on
`ha/w1-c-release` (the final HEAD of the worktree).
