---
title: Scaling
description: Run more copies of an app across your nodes, let Yoal add and remove them with load, and ship new releases to them one at a time.
---

An app starts as one copy on one node. This page covers running more copies, having Yoal change the number for you, and what a deploy does to an app that has several. None of it needs a config file: you set a number, or two bounds and a target, and Yoal places the copies.

Scaling applies to **process** and **container** projects. A static site is served by the edge and has nothing to scale. Functions scale per node and are covered in [functions](/compute/functions).

## Run more copies

Open the project and choose **Scaling**, set the number, and select **Scale**. Or from a terminal:

```sh
yoal scale shop 3
```

The change takes effect at once. There is no deploy, and copies that are already running are not restarted. The first copy stays exactly as it is and the new ones start beside it on other nodes.

Where the copies go depends on the kind of app:

| App | Placement |
|---|---|
| HTTP app | One copy per node. Requests are balanced across the copies that are up |
| Worker (`ingress: none`) | Spread across the nodes first, then sharing them, so a worker can run more copies than you have nodes |
| App that must stay on one node | One copy only if it serves HTTP. A worker can still run several copies on that node |

An HTTP app needs a node per copy because each copy owns its node's port or socket. So with three nodes that have room, an HTTP app can run three copies. The Scaling tab shows how many your fleet has room for right now. To run more, [add a node](/self-hosting/nodes-and-fleet).

An app must stay on one node when its data or addresses live there: a persistent data directory, an [app volume](/compute/volumes), a placement that names one node, or a container app attached to a database on that node. The Scaling tab says which of these applies.

Run `yoal scale shop` with no number to see the copies, the node each runs on, and each copy's memory and CPU as a share of its limit.

> [!TIP]
> Two copies on two nodes is the smallest setup that survives a node going down. With one copy, a lost node means the app is down until it is moved.

## Autoscaling

Autoscaling changes the number of copies between two bounds to keep one signal near a target. Turn it on in **Scaling → Autoscaling**, or:

```sh
yoal scale shop --auto --min 2 --max 6 --cpu 60
```

| Signal | Target means | Notes |
|---|---|---|
| `--cpu` | Percent of each copy's CPU limit, averaged over the copies | The default, at 70 |
| `--memory` | Percent of each copy's memory limit | Use for apps whose memory grows with load |
| `--rps` | Requests per second per copy | Needs [telemetry](/observe/metrics) to be installed |

How it behaves:

- **Scaling up is immediate.** When the signal is more than 10% over the target, Yoal adds copies, at most doubling in one step, then waits a minute for them to take load.
- **Scaling down is slow.** A copy is removed only after the signal has stayed low for the scale-down window (5 minutes by default), and only one copy at a time.
- **The bounds apply at once.** Turning autoscaling on with a minimum of 2 starts a second copy straight away.
- **It never guesses.** With no measurement yet, it does nothing and says so under **Last check**.

If Yoal wants more copies than the fleet has room for, it runs as many as fit and raises an alert that names the shortfall.

While autoscaling is on, a manual `yoal scale` must stay inside the bounds. Turn it off with `yoal scale shop --off`; the app keeps the copies it has.

## Deploys roll one copy at a time

When an app has two or more copies, a deploy does not restart them together. Yoal updates one copy, waits until it is healthy on the new release, then moves to the next. The copies that have not been reached keep serving the previous release, and the copy being restarted is taken out of the load balancer first. A request that hits a copy mid-restart is retried on another copy.

A copy counts as healthy when its node has applied the change and the app answers its health path. An app that starts but never answers is not healthy.

A promote or a rollback rolls the same way. Both keep the number of copies the app runs now: rolling back a release never removes capacity you added since.

### An app with one copy

One copy has nothing to roll to, so Yoal borrows a node. It starts a temporary second copy on another node on the new release. When that copy is healthy it takes the traffic, the app's own copy restarts on the new release, and the temporary copy is removed. The app ends on the node it started on and never stops serving.

This needs another node with room and an app that may run there. An app pinned to its node by its data, or a fleet of one node, restarts in place with a short gap.

### When a release fails

If a copy fails on the new release, or does not become healthy within 5 minutes, **Yoal puts the previous release back**. Copies that had not been reached were never touched, and for a single-copy app the running copy was never restarted. The production pointer moves back too, the Scaling tab says what was undone and why, and an alert is raised. The failed deployment stays in **Deployments** with its logs.

It rolls back once. If the previous release fails as well, the release was not the problem, and the rollout pauses for you:

```sh
yoal rollback shop        # go back a release yourself
yoal scale shop --resume  # try the failed copy again, then carry on
```

Deploying a fix also works. It starts with the copy that is already broken, so a healthy copy is never taken down while a broken one is waiting.

To have a failed rollout always pause instead, turn off `scheduling.autoRollback` in **Settings → Clustering**.

## Right-sizing

Each copy reserves `memoryMb` on its node whether it uses it or not. The Scaling tab records the busiest moment of the last day and tells you when the reservation is far from it:

- **Close to its memory limit**: a copy reached 90% of its limit. At the limit it is killed and restarted, so raise `memoryMb`.
- **Reserves more memory than it uses**: after a full day, the peak plus a quarter of headroom is still well under the reservation. Lowering `memoryMb` frees the difference for other apps.

Yoal only advises. The limit is yours to set, on the **Runtime** tab.

## Move an app to another node

A single-copy app can be moved from **Scaling → Node**, or with:

```sh
yoal fleet move shop            # Yoal picks a node with room
yoal fleet move shop --to edge-b
```

An HTTP app with nothing attached moves without downtime: the new copy starts first and the route switches once it is healthy. If it never becomes healthy, the app stays where it was.

An app with [app volumes](/compute/volumes) can move too, but its data has to be copied:

```sh
yoal fleet move vault --with-data
yoal fleet move vault --status
```

Yoal stops the app, snapshots each volume to your backup target, restores the snapshots on the target node and checks them, then switches the app and its volumes over together. **The app is down for the length of the copy.** Until the switch, nothing on the source node changes, so a failure at any point starts the app again where it was. After the switch, the old volumes stay in the trash for the usual retention.

Both nodes need a current agent, and the move needs a backup target with room for the archives. A persistent data directory (`data` in the spec) cannot be moved this way yet.

## Reference

| Setting | Default | Where |
|---|---|---|
| Copies | 1 | **Scaling**, `yoal scale <project> <n>`, `POST /api/v1/projects/:slug/scale` |
| Most copies per app | 20 | **Settings → Clustering**, `replicas.max` |
| Autoscaling bounds | 1 to 3 | **Scaling → Autoscaling**, `PUT /api/v1/projects/:slug/scaling` |
| Scale-down window | 5 minutes | Same |
| Rolling deploys | on | **Settings → Clustering**, `scheduling.rollingDeploys` |
| No-gap deploys for one copy | on | **Settings → Clustering**, `scheduling.surgeDeploys` |
| Automatic rollback | on | **Settings → Clustering**, `scheduling.autoRollback` |
| Rollout timeout per copy | 300 seconds | **Settings → Clustering**, `scheduling.rolloutTimeoutSeconds` |

Over MCP, an agent can read scaling with `get_scaling` and change it with `scale_project` and `set_autoscaling`.
