# Yoal — Horizontal scaling

Status: **built 2026-11-14** (D218–D224; builds on D214–D216 in [CLUSTERING.md](./CLUSTERING.md)
§3.10 and §4.6). Migrations `0114_scaling.sql` and `0115_rollback_leases_usage.sql`. User-facing guide:
`packages/docs/content/compute/scaling.md`.

Related: [CLUSTERING.md](./CLUSTERING.md) §8, [VOLUMES.md](./VOLUMES.md), [ALERTS.md](./ALERTS.md),
[API.md](./API.md).

## 1. What this is

Running an app on several of your own nodes should be one number, not a set of manifests. Yoal
already had nodes, an overlay, a planner and a failover controller; what was missing was the part a
person touches. Before this work an HTTP app was capped at one copy in the dashboard, a change to
the count only took effect on the next deploy, a deploy restarted every copy at once, and a process
app (the default runtime) could not spread at all while service endpoints were on.

Four ideas carry it:

1. **The number of copies is operational state, not part of a release.** It changes without a
   deploy, a rollback keeps it, and the copies that already run are never restarted by a scale.
2. **Copies stay where they are.** A deploy or a scale places only the copies that are missing.
3. **A release reaches a set one copy at a time,** and stops at the first copy that does not come
   up healthy.
4. **Autoscaling is a number between two bounds,** moved by one measured signal.

There is no YAML and no new object for the user to learn: a count, an optional policy, and the same
deploy as before.

## 2. Copies and modes (D218)

`WorkloadService.scalingMode` decides how an app's copies may be placed:

| Mode | When | Placement |
|---|---|---|
| `spread` | HTTP process or container app, nothing pinning it | One copy per node (its port or socket is the node's); `replicas.spread` may also require distinct zones |
| `stack` | Worker (`ingress: none`), nothing pinning it | Spread across nodes first, then sharing them, so copies may exceed nodes |
| `node` | Function, runner pool, or a pinned worker | Every copy on the app's one node (D90) |
| `single` | Compose stack, or a pinned HTTP app | One copy; `blocker` says why |

"Pinned" means the app's data or addresses live on one node: a persistent data directory, an app
volume, a placement that names a node, a broker (D111), or a container app attached to a same-node
database (D56). A process app with a database or private storage attached over service endpoints
(C2) is **not** pinned: each node that holds a copy gets its own loopback endpoints, and a copy is
activated with the environment of the node that asks for it.

An HTTP app asked for more copies than `single` allows is refused with the reason, at scale and at
deploy. Before, such a deploy was accepted and its copies collided on the node's port.

**Rows.** A set (`spread` or `stack` with two or more copies) has one `workload_replicas` row per
copy. One copy has no rows: it is the plain single-copy shape, so every install that never scales
reads exactly as before. Copy 0 keeps the workload's own id, so a single copy becoming a set keeps
its unit: no restart. A scale-down removes the highest indices.

## 3. Scaling without a deploy

`POST /projects/:slug/scale { replicas }` → `ScalingService.scale` → `WorkloadService.scaleCopies`.

- `planReplicas` is given the copies that exist; those on an online node keep their node and index,
  and only the difference is placed (`existing`, `kept`, `placed`).
- Nothing is written when the fleet cannot take the copies. The refusal names each node and its
  reason, and the view reports `capacity`: how many copies would fit right now.
- The live spec, the configured spec (`projects.workload_json`, which the next deploy plans from)
  and the reservation are updated together. `replicas` is outside the activation version, so no
  running copy restarts.
- `setSpec` no longer writes a new count behind the rows: a changed `replicas` on a deployed app
  is routed through `scaleCopies`, so the CLI's `workload --replicas` and MCP's `set_workload`
  behave like `scale`.
- A promote or rollback (`syncDeployment`) restores a release and keeps the live count.
- **Sticky placement.** A deploy passes the existing copies to the planner, and a single copy
  placed by `auto` stays on its node while that node still admits it. A redeploy is not a reason to
  move; Rebalance is (D214).

## 4. Rolling deploys (D219)

When a deployment changes for an app with two or more copy rows, every copy that keeps its node is
marked with the deployment it still runs (`workload_replicas.deployment_id`) and the workload goes
`rollout_status = 'rolling'`. Desired state and activation render such a copy from that deployment's
release and the spec snapshot taken when it was made, so it keeps running untouched.

`WorkloadService.rolloutTick` runs under the failover controller's lease and advances each rollout
by at most one copy:

1. If a copy already on the new release has failed, or has not been confirmed within
   `scheduling.rolloutTimeoutSeconds` (300), the rollout becomes `paused` with a message and a
   `rollout` alert. Nothing else is touched: the copies not yet reached keep serving the previous
   release.
2. If any copy on the new release is not yet confirmed running, wait.
3. Otherwise restart the next waiting copy on the new release: copies that are not serving go first
   (so a fix reaches the broken copy before a healthy one is taken down), then the lowest index.
4. When none is waiting, the rollout is over.

**Confirmation.** A restarted copy records the desired-state version of the change
(`applied_version`). Its `running` report counts only from a heartbeat whose `actualStateVersion`
has reached it; until then the node is still describing the old unit, and counting it would let the
rollout run through every copy at once. The agent sets that version only after its workloads
converged, which includes waiting for the health path.

**Readiness.** The agent used to report `running` from systemd alone on every heartbeat, which
overwrote a failed health probe within seconds. It now remembers which HTTP workloads failed their
last probe and re-probes them before each heartbeat, so an app that is up but not answering stays
`starting`. This is what makes the gate above, and the surge move of D214, mean something.

**Traffic.** An ingress lists only copies that are `running` and not awaiting confirmation, so a
copy leaves the upstreams in the same desired-state version that restarts it. Because the ingress
and the node pull independently, a request can still reach a copy as it stops; the proxy retries a
refused connection on another copy for up to 3 s (`load_balancing.try_duration`).

A paused rollout is resumed by a new deploy, a rollback (the updated copy rolls back to the release
the others never left), or `POST /projects/:slug/rollout/resume`.
`scheduling.rollingDeploys: false` updates every copy in place at once, as before.

### 4.1 Deploying a single copy (D223)

One copy has nothing to roll to, so a deploy used to mean a gap while it restarted. With
`scheduling.surgeDeploys` (on), `record` starts a **surge** instead when the app is HTTP, is
serving, may run on another node (`spread` mode) and another node has room:

1. Two copy rows are written: the app's own copy, marked as still on the release it runs, and a
   temporary copy on another node on the new release. The workload reserves two copies for the
   length of the rollout, so both nodes account for theirs.
2. The rollout controller waits for the temporary copy to be healthy. It then takes the traffic.
3. The app's own copy is restarted on the new release, confirmed as in §4.
4. The rows are removed: one copy again, on the node it was on, having never stopped serving.

The app keeps its node, which is the point of doing it this way rather than moving it. An app that
is not serving (never started, or idle-stopped), pinned to its node, or alone on a one-node fleet
restarts in place. A deploy that arrives mid-surge undoes it first and starts again from what the
app's own copy actually runs.

### 4.2 Automatic rollback (D223)

With `scheduling.autoRollback` (on), the failure in step 1 of §4 does not pause: the controller
puts back the release the rollout started from (`workloads.rollout_from_deployment_id`).
`DeploymentService.revertFailedRelease` moves the production pointer back when the failed deployment
held it, so routes, the environment and the workload agree; a deployment that was never promoted
only has the workload returned. The copies that never left the old release are not touched, and for
a surge the temporary copy is dropped and the app's own copy was never restarted at all.

It happens **once**. The rollback is itself a rollout (`rollout_auto`); if it fails as well, the
release was not the problem, and it pauses for a person rather than bouncing between two releases.
The Scaling tab keeps a note of what was undone and why until the next deploy.

## 5. Usage and autoscaling (D220)

**Usage.** The helper reads `CPUUsageNSec` beside `MemoryCurrent`; the agent reports both per copy;
`ScalingService.applyUsage` keeps the latest sample per copy in `workload_usage` with a smoothed
value (weight 0.4 for the newest). CPU is a running total, so the rate is the difference between
two samples, and a total that went backwards (a restart) yields no rate that round. There is no
history in this table on purpose: it is a control input, not a metrics store.

**Policy.** One row per project in `workload_scaling`: `enabled`, `min`, `max`, `metric`, `target`,
`scaleDownMinutes`. It is deliberately outside the workload spec: changing a policy must never
change an activation version.

| Metric | Value compared with `target` |
|---|---|
| `cpu` | Mean over fresh samples (≤ 90 s old) of smoothed CPU ÷ the copy's CPU limit, in percent |
| `memory` | The same for memory ÷ `memoryMb` |
| `requests` | Requests in the last two whole minutes ÷ 120 ÷ copies, from `traffic_1m`; needs telemetry |

**Decision** (`autoscaleTick`, every `scheduling.autoscaleIntervalSeconds`, under the lease):

- Inside ±10% of the target: no change.
- Otherwise `desired = ceil(copies × observed ÷ target)`, clamped to the bounds.
- **Up:** immediately, at most doubling in one step, then a 60 s cooldown. Placement is `partial`: if
  fewer fit, that many run and a `scaling` alert names the shortfall.
- **Down:** only after the signal has stayed below for `scaleDownMinutes`, and one copy at a time;
  each further copy needs its own quiet window.
- No measurement, a rollout in progress, or telemetry missing for `requests`: no decision, and the
  reason is stored for the Scaling tab.
- The bounds apply when the policy is saved, and a manual scale must stay inside them.

Scale events (`workload_scale_events`) record every change with its reason and, for the autoscaler,
the measurement that caused it.

### 5.1 Right-sizing and memory pressure (D222)

Reservations admit work; measurements advise and guard.

- **Peaks.** `workload_usage` keeps each copy's highest memory and CPU for today and yesterday
  (UTC). The Scaling tab says "raise" as soon as a copy reaches 90% of its memory limit, and "lower"
  only once a full day exists and the peak plus a quarter, rounded up to 32 MB, is under 60% of the
  reservation. Yoal never changes a reservation itself: a limit is the app owner's call.
- **Pressure.** A node whose host memory (from its heartbeat) is at or above
  `scheduling.memoryPressurePercent` (90) is the last choice for a new copy and receives nothing
  from a rebalance. It still takes work when no other node can. This is the guard that makes memory
  overcommit usable: reservations stop being a promise, so the host's own reading has a say.

## 6. Links: history and alerts (amends D216)

`node_link_history` keeps one round-trip point a minute per ordered pair for a day; the Fleet page
draws the last hour, with a gap where a minute was lost. `node_links.down_since` starts when a link
stops answering. A link silent for three minutes between two nodes that are themselves reporting
raises a `link` alert, and a resolved alert when it answers; a node that is offline has its own
alert, so its links stay quiet.

## 7. Moving an app with its data (D221)

`RelocationService` moves a single-copy app together with its app volumes. It is a move with
downtime, started by a person (`POST /projects/:slug/relocate`, `yoal fleet move <app> --with-data`).

| Phase | What happens | If it fails |
|---|---|---|
| `stopping` | The project is quiesced (the same set a database move uses); the source node stops the app and stops reporting its units | After 10 min: failed; the app starts again in place |
| `snapshotting` | Each volume is archived to the backup target (no freeze needed: nothing is writing). The snapshots are pinned for the move | Failed; the app starts again in place |
| `restoring` | A replacement volume per source volume is created on the target node, under a temporary name, and filled from the snapshot with its checksum verified | Failed; the half-made volumes go to the trash; the app starts again in place |
| switch | One transaction: the replacements take the names and the attachments, the old volumes go to the trash for the usual retention, the workload and its deployments move to the target | — |

Until the switch nothing on the source changes, which is the whole safety argument. The controller
advances the phase from what the nodes have reported, so a restarted control plane carries on.
Deploys are refused while a move is active. `system:relocation` is the principal for the steps the
controller takes.

Not covered: a persistent data directory (`spec.data`) has no snapshot path, so it still pins its
app; and there is no node-to-node stream, so the copy goes through the backup target.

## 8. Run leases for single workers (D224)

A lone worker on a node that went silent may still be running there, so D214 leaves it alone. A run
lease removes the doubt (CLUSTERING §8.4, the worker half of H15).

- **Who gets one.** With `scheduling.workerRunLeases` on and failover enabled: a single-copy worker
  that could move, on an agent that declares `run-leases`, on a fleet with two compute nodes. Its
  desired state carries `runLease.ttlSeconds` (`scheduling.runLeaseSeconds`, 60).
- **The node's side.** The agent records each answer from the control plane on disk as wall-clock
  time. A leased workload whose lease has run out is treated as not wanted on the node: its units
  are removed, not just stopped, so a reboot cannot start them. A stale timestamp found at start-up
  fences before anything converges; a fresh one touches nothing, so an agent restart does not
  restart the worker. When contact returns the units come back.
- **The fleet's side.** The failover controller re-places the worker after
  `replicas.failoverGraceSeconds` of silence. No lease is given unless that grace exceeds the TTL
  by 30 s, so the node has stopped the worker before another copy starts.

The cost is the reason it is opt-in: a node cannot tell a partition from a control-plane outage, so
leased workers also stop when the control plane itself is down for longer than the TTL, and start
again when it returns. An HTTP app never carries a lease; two copies of it for a moment do no harm.

## 9. Surfaces

| Surface | Scaling | Fleet |
|---|---|---|
| Dashboard | Project → **Scaling**: copies with usage, the stepper, the rollout, autoscaling, node and history | **Fleet**: capacity, rebalance, link map |
| REST | `GET`/`PUT /projects/:slug/scaling`, `POST …/scale`, `POST …/rollout/resume`, `POST …/relocate`, `GET …/relocation`, `POST …/relocation/cancel` | `GET /scheduling`, `POST /scheduling/rebalance`, `GET /links`, `POST /links/test` |
| CLI | `yoal scale` | `yoal fleet status\|rebalance\|move\|links\|link-test` |
| MCP | `get_scaling`, `scale_project`, `set_autoscaling` | `get_fleet`, `get_node_links` (read-only) |
| Alerts | `rollout`, `scaling`, `relocation` | `link`, `failover` |

## 10. Mixed versions

Every addition is additive. An older agent ignores `linkProbes` and `linkTests`, sends no `cpuNanos`
(CPU autoscaling then reports "no CPU usage reported yet") and reports `running` from systemd, so a
rollout across old agents is gated on restart and the state version but not on the health path. An
agent without `run-leases` is given no lease, so its lone workers keep the old rule. An older
control plane ignores the new heartbeat fields.

## 11. Not built

- **Moving a persistent data directory** (`spec.data`). The helper derives every data path from
  validated ids and has snapshot and restore only for app volumes; a data directory has a different
  layout and ownership, and that root-side code needs a real Linux host to prove. Until then the
  way to make such an app movable is to keep its data in an app volume.
- Scale to zero for a set (a single process app already has `idleStopSeconds`, D121).
- A surge for a single-copy app that must stay on its node: there is nowhere else to run the
  second copy, so it restarts in place.
- Admission by measured usage. Measurements advise and guard (§5.1); they do not replace
  reservations.
- Named singletons with a lease table for workloads other than single-copy workers (the rest of H15).
- A direct node-to-node copy; a move with data goes through the backup target.
