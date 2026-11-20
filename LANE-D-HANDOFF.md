# Lane D hand-back — W5 runtime, drain, readiness

Branch `ha/w1-d-drain` at base `1cd872e9` (`ha/integration`). No VERSION bump, no migration.

## 1. Verified

All commands run in `/Users/kieranholroyd/.t3/worktrees/private-cloud-deploys/t3-w1-d-drain`.

| Command | Result |
|---|---|
| `bun run check` | All workspace packages `tsc --noEmit` pass; the control plane's svelte-check is 0 errors / 1 pre-existing warning (`settings/registry/+page.svelte:38`); `scripts/lint-iam.ts` reports no new checks. |
| `bun test` (full suite) | **6158 pass, 73 skip, 0 fail**, 44,072 expect() calls, 559 files, 180.6 s. |
| `bun test tests/ha` | **66 pass, 0 fail**, 150 expect() calls. |
| `node_modules/.bin/tsc -p tests/ha` | Clean. |
| `bun test apps/agent/src/release-commands.test.ts` | 9 pass. Covers: new release + app activation used; success reported; failure reported and never restarted; lost start response verified by `jobStatus` rather than retried; start-deadline refusal and a backwards clock; timeout self-kill then SIGKILL with no control-plane traffic; restart from `release-commands-state.json` re-reports and never starts the same `runId`; lease loss stops the run; flag-off no-op; process task without a release refused. |
| `bun test apps/agent/src/runtime.test.ts` | Pass. Added: `drainSeconds` keeps a removed copy running (no `helper.remove`) until the deadline, and a copy that returns during its drain is not stopped; `probeWorkloadHealth` uses `readinessPath` over `healthPath`; existing converge/removal tests still pass. |
| `bun test apps/helper/src/jobs.test.ts` | Pass. Added: a release command with no running app container gets `--userns=auto:size=65536` and `:U` on writable mounts (never on read-only); normal container jobs still require and join the running app's namespace; `request.release` is boolean-or-absent. |
| `bun test apps/helper/src/units.test.ts` | Pass. `TimeoutStopSec` is 30 without `stopTimeoutSeconds`, the app's value with it; container units omit the line unless set. |
| `bun test packages/site-config/src` | 36 pass, 6 skip. Added: readiness path drives active checks (`passes:2`, `fails:3`, `timeout:2s`), a single copy is checked when readiness is set, `stream_close_delay` equals the drain window, the documented dial/header/keepalive timeouts render, and without release-phase fields the route is byte-for-byte the old shape. |
| `bun test apps/agent/src/caddy-config.test.ts` | Pass. `toSiteCompileInput` passes `readinessPath`/`drainSeconds` and leaves them absent when unset. |

The flag-off/no-op requirement is covered by the existing desired-state golden snapshot (unchanged), the site-config “without release-phase fields” test, and the release-command flag-off test.

## 2. Not verified (and why)

- **The W5 exit criteria in the lab were not run.** 10,000 requests/minute through a rolling deploy with zero non-2xx, a failed release leaving every copy on the old release, and I16 under a real partition need the lab VMs/harness. `tests/ha/scenarios` has only `kill-node-b.ts`; there is no `rolling-deploy-under-load` or `single-node-gate` scenario to run locally. The authoritative run is lane lab's later job.
- **Rollout gating is lane C.** This lane reports `releaseCommandResults` (`failed`/`timeout`/`succeeded`) and never rolls a copy; lane C's `rolloutTick`/`ReleaseCommandScheduler` must keep old copies when the result is failed. I tested the node half (failure/timeout outcome and no second attempt), not the control-plane half.
- **Caddy did not load the generated config on a real node.** The tests assert the JSON fields; a real `caddy validate`/reload is part of the lab run.
- **systemd did not execute the rendered stop timeout or the drain.** The unit text and the agent's deadline logic are unit-tested; no real unit was restarted.
- **First container deploy with a release command was not run on Podman.** The helper now runs it in its own user namespace with `:U` on writable mounts when no app container exists; that render is unit-tested, but a real first deploy should be exercised by the lab.

## 3. Deviations and dependencies

- **Contract dependency: `imagePrePulls` is not in this base.** Lane C's contract commit `dd138b36` (`heartbeatSchema.upstreamCounters`, `desiredStateSchema.imagePrePulls`) is only on `ha/w1-c-release`, not an ancestor of `1cd872e9`. I did **not** invent a parallel contract and did **not** implement image pre-pull: there is also no helper pull verb in this base. When lane C's commit lands, the agent needs a fixed helper pull action keyed by `imagePrePulls[]`; that is left for integration/another lane. The release-command contract (`releaseCommands`, `releaseCommandResults`, `startBy`, `releaseId`) **is** present and is implemented.
- **Shared desired-state module edits.** `packages/core/src/desired-state/releases.ts` now appends `readinessPath`, `drainSeconds` and `stopTimeoutSeconds` to app workloads when `RELEASE_PHASE` is on (defaults materialised so the agent never guesses: flag off = no fields, flag on = 10 s drain / 30 s stop). `packages/core/src/desired-state/routes.ts` appends `readinessPath` to routes. `HA-WAVE-1.md` says C and D share the releases module; lane C's release-command job rendering may touch the same method and needs a merge pass.
- **No `drain_timeout` in the Caddy route.** It is not a field of Caddy's reverse_proxy handler (checked against Caddy 2.10/2.11 sources); adding it would fail the whole config load. Drain-aware Caddy behaviour is `stream_close_delay = drainSeconds`, plus the agent holding the unit for `drainSeconds` after the copy leaves desired state/upstreams. `stream_close_delay` only covers upgraded streams, as Caddy documents; normal requests are already drained by Caddy's graceful config reload.
- **Helper job request gained one structured boolean, `release: true`.** A release command may run before any copy exists; normal container jobs still require the running app's container and user namespace. No shell string, no new root verb, no arbitrary fields: `parseJobRequest` rejects any other key and a non-boolean value.
- **Capability advertisement.** `apps/agent/src/main.ts` `advertisedCapabilities()` now adds `release-phase`; the contract comment says the agent build that acts on the gated fields adds the capability. I did not edit `nodeCapabilities` in contracts (avoids a wider contract change and a conflict with lane A).
- **Migration `0124` was not used.** No table was needed; `release_command_runs` (0119) is lane C's.
- **No always-on daemon.** `ReleaseCommandRunner` is one more loop in the agent process, polling desired state (`5 s` idle, `2 s` while holding a run) and using the existing helper job verbs. It works from cached desired state and its own persisted `seen` set, so a control-plane partition does not stop the timeout kill or allow a second run.
- **No new docs/operator surface.** REST/CLI/dashboard for release commands and readiness remain lane C/integration work.

## 4. Final commit

Filled in after the commit: see `git log -1 --format=%H` on `ha/w1-d-drain`; the hand-back commit contains this file.
