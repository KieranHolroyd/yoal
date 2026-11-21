---
title: Clustering and high availability
description: What Yoal's high availability does today for nodes, ingress, apps, databases and the control plane, how automatic failover works, and what is still planned.
---

Yoal can run on several nodes, but its high availability is limited today. Most apps, databases and storage instances have one copy on one node, and recovery after a failure is mostly manual. This page covers what happens when a node, the edge or the control plane fails, how to use the pieces that exist, and what is planned but not built. To add machines, see [nodes and fleet](/self-hosting/nodes-and-fleet).

> [!IMPORTANT]
> Automatic failover is off by default, and when you turn it on it only moves copies of multi-copy apps. A database replica is promoted only when you ask (or, with an extra opt-in, by the controller), and nothing moves a single-copy app or changes DNS for you: Yoal alerts and tells you what to do. Keep current backups and plan for manual recovery.

## What runs where today

- One **edge** node takes ingress for the platform and content domains and serves every static site. The first node you join becomes the edge.
- Each app, function, database and storage instance runs on one node. An app can run several copies on different nodes, but only when the `MULTI_NODE_REPLICAS` feature flag is on (see [multi-node replicas](#multi-node-replicas)).
- The control plane is a single instance. Each node caches the last desired state it received on disk, so existing sites and apps keep running if the control plane stops.

## When something fails

The diagram summarises what keeps serving when each part fails. The sections below give the detail.

```mermaid
flowchart LR
  W["Worker goes offline"] --> W1["Single-copy apps and functions stop"]
  W --> W2["Multi-copy apps keep answering"]
  W2 --> W4["Copies move after 2 min, if failover is on"]
  W --> W3["Databases and storage unavailable"]
  E["Edge goes offline"] --> E1["Sites and routed apps unreachable"]
  C["Control plane goes offline"] --> C1["Dashboard, API and deploys stop"]
  C --> C2["Nodes serve last cached state"]
```

### A worker node goes offline

An agent that stops sending heartbeats is marked **offline** after 30 seconds. An alert follows after the delay set in **Alerts → System alerts**.

- **Single-copy apps and functions** on that node stop answering. They are not moved automatically. Bring the node back, or move the app (see [moving services](#move-services)).
- **Multi-copy apps** keep answering from their other copies. The edge stops sending requests to a copy that fails. If [automatic failover](#automatic-failover) is on, the copies on that node are started on healthy nodes once it has been silent for 2 minutes. If it is off, they stay where they are until the node returns or you drain it.
- **Managed databases and storage instances** on that node are unavailable until it returns. For a PostgreSQL database with a [read replica](/data/databases#read-replicas) on another node, Yoal raises a critical **Failover** alert after 2 minutes and shows which replica a promotion would use on **Settings → High availability**. You then [promote it](/data/databases#promote-a-replica) with `yoal db replica promote`; because the old node cannot confirm it stopped, the promotion needs `--accept-data-loss`. Without a replica, if the node is gone for good, you can move a database from its latest backup, but writes made since that backup are lost.

### The edge node goes offline

Every site and every app routed through the edge is unreachable, because no other node takes over its traffic. Either bring the edge back, or make another node the edge and point DNS at it:

1. In **Nodes**, open the menu for an online node and choose **Make this the edge**.
2. Type the node's name to confirm. The previous edge becomes a worker and keeps the apps and databases on it.
3. Yoal changes only the roles. If the new edge is a different machine, point the platform and content domains at it, and give its agent the TLS settings an edge needs. See [installation](/self-hosting/installation).

If `YOAL_EDGE_NODE_ID` is set in the control plane's environment, the edge is pinned and the dashboard refuses the change. Change the variable and restart the control plane instead.

### The control plane goes offline

The dashboard, REST API, CLI and MCP stop, and so do deploys and configuration changes. Nodes keep serving the last desired state from their disk cache, so sites and apps stay up while it is down. There is no standby control plane. To recover, restore the control plane from a platform backup, as described in [platform backups](/self-hosting/platform-backups).

### Disk failure

Yoal does not mirror a node's disks. A failed drive loses that node's data unless you have backups. For redundancy on one node, set up an mdadm array or a ZFS mirror in the OS and add it as a disk. See [disks](/self-hosting/nodes-and-fleet#disks) and [backups and point-in-time recovery](/data/backups-and-pitr).

## Set up what exists

### Zones

A zone is a failure domain: nodes in one zone share power, network and provider. Set a zone on each node so that replicas can be spread across zones. In **Nodes**, open **Actions for** the node, choose **Edit node** and set **Zone**. A node that never has a zone is in `default`.

The **Topology** page shows each node's roles and its blast radius: what would be affected if that node were lost, computed from current placement.

### Multi-node replicas

Replicas are copies of one app running on different nodes. The feature is on by default. To turn it off, set `YOAL_FEATURE_MULTI_NODE_REPLICAS=0` in the control plane's environment, see [configuration](/self-hosting/configuration), and restart it. While `SERVICE_ENDPOINTS` is on, process apps are not spread across nodes.

With the flag on:

- An app with more than one replica that serves HTTP is placed with one copy per node. An app pinned to a specific node, or attached to a database or storage instance on another node, stays on one node.
- A deploy is refused if there are not enough online nodes with free memory. The error names the reason for each node.
- The number of copies is capped by `replicas.max` in [Settings → Clustering](#settings--clustering), which defaults to 20.
- By default no two copies share a node. Set `replicas.spread` to `zone` to prevent two copies sharing a zone.
- Requests are balanced across copies by fewest connections. If the app declares a health path, the edge checks it every 5 seconds (`replicas.healthIntervalSeconds`) and skips any copy that fails the check. A copy that fails a request is skipped for 30 seconds.

With the flag off, copies still run, but all on one node.

### Drain a node

In **Nodes**, choose **Drain node** to stop new placements on a node. Existing single-copy apps and databases keep running there. With the flag on, replica copies on a draining node are moved to other nodes, whether or not automatic failover is on, under the same rate limits (see [automatic failover](#automatic-failover)). Choose **Resume placements** to undo the drain. Copies that already moved stay on their new nodes.

### Move services

You can move an app, a database or a storage instance to another node. The data handling differs for each.

**Apps** move by repointing them at the new node. The old node stops the app and the new node starts it on its next reconcile. A move is refused for a static site, an app attached to a database or storage instance on another node, an app with app volumes, and an app with a persistent data directory. Use the **Move** action on the app's page, or:

```sh
curl -X POST https://control.example.com/api/v1/projects/my-site/move \
  -H "Authorization: Bearer yoal_…" \
  -H "Content-Type: application/json" \
  -d '{"node": "<node-id>"}'
```

An app move repoints the app at the new node. The old node stops it, and the new node starts it on its next reconcile:

```mermaid
sequenceDiagram
  participant U as Operator
  participant CP as Control plane
  participant Old as Old node
  participant New as New node
  U->>CP: POST move to node
  CP->>CP: Repoint app, status pending
  Old->>CP: Poll desired state
  CP-->>Old: App no longer desired here
  Old->>Old: Stop app
  New->>CP: Poll desired state
  CP-->>New: Start app
```

**Databases** move in stages: attached apps stop, a final backup is taken, the backup is restored on the target, and the old copy is purged. The `from` field chooses the data source:

- `dump` (default) takes a final backup of a running database.
- `latest-backup` restores the newest good backup. Use it when the database is down or its node is offline. Writes since that backup are lost.
- `empty` starts the database fresh and discards its data. Engines without backups can only use this.

```sh
curl -X POST https://control.example.com/api/v1/databases/my-db/move \
  -H "Authorization: Bearer yoal_…" \
  -H "Content-Type: application/json" \
  -d '{"node": "<node-id>", "from": "dump"}'
```

The response's `move.operationId` identifies the run driving the move. Follow it with `GET /api/v1/operations/<operationId>?wait=25&steps=1`, or ask your agent to call `get_task`. Until the final backup has been taken, you can cancel the move with `POST /api/v1/operations/<operationId>/cancel` (or `cancel_task`). The apps start again on the old node and nothing moves. Once the backup is being restored on the target, the move can no longer be cancelled. It finishes, or it rolls back to the old node if the restore fails.

**Storage instances** must be moved with `from` set to `empty`. Objects are not copied. The instance starts empty on the target, and the old copy is deleted. Buckets, access keys and attachments are kept.

> [!WARNING]
> Moving a storage instance deletes its objects. Copy them out first.

Moves are available from the dashboard and over REST. Storage instances can also be moved with `yoal storage move <name> --node <node-id>`; apps and databases have no CLI command for it yet.

### Automatic failover

The failover controller runs inside the control plane and checks the fleet every 5 seconds. Turn it on in [Settings → Clustering](#settings--clustering) by setting `"failover": { "enabled": true }`. It needs `YOAL_FEATURE_MULTI_NODE_REPLICAS=1`, because only copies of multi-copy apps can move.

When a node has sent no heartbeat for `replicas.failoverGraceSeconds` (120 seconds by default), the controller moves each copy on it to another node that passes the normal placement checks, with the same spread rules as a deploy:

- Copies of HTTP apps move first, then workers, lowest copy number first.
- At most `failover.maxPerMinute` moves a minute across the fleet (6 by default), 2 a minute onto any one node, and one copy of an app at a time.
- A node that lost copies, or was withdrawn from ingress, in the last 30 minutes is never chosen as a target, so a flapping node does not pull work back and forth.
- A move that cannot start within 10 minutes is dropped with an alert, and is not tried again from the same node for 30 minutes. If the node comes back first, the waiting move is cancelled.
- A move is complete when the new node reports the copy running. If it does not within 10 minutes, the move is marked failed and alerts.
- Nothing moves back when the node returns. The copy stays on its new node.

A node whose agent still heartbeats but reports Caddy down does not count as lost.

```mermaid
stateDiagram-v2
  [*] --> queued: node silent past the grace, or draining
  queued --> blocked: no node can take the copy
  blocked --> queued: a node has room again
  queued --> in_progress: target chosen, copy moved
  queued --> cancelled: node came back
  queued --> expired: waited 10 minutes
  in_progress --> completed: copy running on the new node
  in_progress --> failed: not running within 10 minutes
```

Only one control plane acts at a time. The controller holds a lease (`controlPlane.leaseTtlSeconds`, 30 seconds by default) and renews it on every check, and every change it makes re-checks the lease first. During an update, the new control plane takes over once the old one stops renewing; a control plane started with `YOAL_STANDBY=1` never acts.

For **databases** with replicas, the controller decides. When the primary's node has been silent for `failover.graceSeconds` (120 seconds), it picks the replica a promotion would use (the most caught-up one within `database.maxLagBytes` and `database.maxLagSeconds`, never a pending one or one on a silent node), records it, and raises a critical alert asking you to promote by hand.

Automatic database promotion is not available yet. `YOAL_FEATURE_DB_AUTO_PROMOTE` is off by default, and setting it has no effect in this release: the control plane logs a warning and keeps promotion manual. Automatic promotion needs a primary that stops itself when it is cut off, and Yoal does not have that yet. Without it, a primary on a node the control plane cannot reach would keep taking writes from apps on that node while a replica was promoted elsewhere.

For **ingress**, with the `dns-failover` or `cloudflare-lb` driver, the controller keeps the set of ingress nodes that should be in DNS. A node is withdrawn after twice the withdraw hold-down in **Settings → High availability** (at least 2 minutes) without heartbeats, and added back after the re-add hold-down, at most once every 10 minutes. A node withdrawn twice in 30 minutes stays out for 30 minutes. Yoal does not change DNS records itself: each withdrawal or re-add is a **Failover** alert and a history entry telling you which record to change.

Every move writes one `ha.failover` entry to the audit log, with the source and target node, and raises a **Failover** system alert (see [alerts](/observe/alerts)). The state and the last 50 actions are on **Settings → High availability**, and from the CLI, REST and MCP:

```sh
yoal ha status
yoal ha status --events 25 --json
curl https://control.example.com/api/v1/ha/status -H "Authorization: Bearer yoal_…"
```

The MCP tool is `get_ha_status`. All three need a platform admin. None of them can change placement or trigger a failover.

### Disaster drills

A disaster drill takes one node off the control plane for a few minutes, so you can see the failover setup above work before a real outage. Start one from **Settings → High availability → Disaster drill**, or from the CLI:

```sh
yoal ha drill node-offline --wait               # a random eligible node, 5 minutes, then the report
yoal ha drill node-offline --node worker-2 --minutes 10
yoal ha drill list                              # which nodes can be drilled, and recent results
yoal ha drill cancel drl_…                      # end it early
```

While the drill runs, the node's agent sends no heartbeats, takes no new desired state and fails its ingress health check. To the rest of the platform it looks like a lost node: it is marked offline after about 30 seconds, the failover controller moves its copies after the grace period, ingress steering withdraws it, run-leased workloads on it stop themselves, and you get the usual **Node offline** alert after 2 minutes, with a note that it is a drill. Its other workloads keep running, as they would on a machine that is cut off but still powered.

The node comes back by itself when the time is up, and **End drill now** or `yoal ha drill cancel` brings it back within about 5 seconds. Restarting the agent on the node also ends the drill. When it is back, the drill records how long the control plane took to mark it offline, how long it took to heartbeat again, and every failover action in between.

Rules:

- One drill at a time, from 1 to 30 minutes (5 by default). Choose longer than `replicas.failoverGraceSeconds` if you want copies to actually move.
- A random drill picks among nodes that are online, run an agent with drill support, and are not the control plane's node. Tick **Allow the control-plane node**, or pass `--include-control`, to include it. The dashboard and API stay up, but ingress through that node is withdrawn.
- The last online node is never drilled.
- A drill fails if the node heartbeats in the middle of it (for example, its agent restarted) or does not come back within 3 minutes of the end.

Drills need a platform admin. The REST endpoints are `GET` and `POST /api/v1/ha/drills`, `GET /api/v1/ha/drills/{id}` and `POST /api/v1/ha/drills/{id}/cancel`.

### Database and storage replicas

A PostgreSQL database can have streaming [read replicas](/data/databases#read-replicas), and a storage instance can have replication targets. Use the **Replicas** section on the database or storage page, `yoal db replica add`, or the REST endpoints `POST /api/v1/databases/{name}/replicas` and `POST /api/v1/storage/{name}/replicas`.

A storage replication target is a real copy: the source's node copies every bucket to the target, then copies changes every `storage.syncIntervalMinutes` (15 by default). See [object storage replication](/data/object-storage#replication). Nothing promotes a target; if the source's node is lost, attach your apps to the target. A Postgres replica copies the primary with `pg_basebackup`, then streams over the overlay through the primary node's mTLS listener; its lag is sampled every 30 seconds. A replica on another node needs both nodes on the managed overlay, and both agents must be recent enough to advertise replica support. The limits are `database.maxReplicas` and `storage.maxTargets`, both 2 by default.

> [!NOTE]
> Not available yet: synchronous Postgres replicas, replicas of a database with point-in-time recovery, cascading replicas, rewinding the old primary after a promotion (its copy is deleted instead), and replicas for other engines.

### Attachment endpoints

By default an app with an attached database runs next to it, and a process app on another node
reaches it through a loopback port. With `YOAL_FEATURE_ENDPOINTS_GATEWAY=1` in the control plane's
environment (see [configuration](/self-hosting/configuration#feature-flags)), every attachment goes
through a stable endpoint on the app's own node, containers included: `127.0.0.1:<port>` for a
process app, `db-<id>:<port>` for a container. A container app can then run its copies on any node,
and promoting a replica changes no app's environment and restarts nothing. An app also gets a
pooled port when the database runs a pooler, and a read URL from its first deploy (see
[read replicas](/data/databases#read-replicas)). Every involved node's agent must be recent enough
to support it.

Turning the flag on moves no running app. Each app moves to its endpoints on its own next deploy,
or when you attach a database to it. To move every app at once:

```sh
yoal ha migrate attachments            # lists what would move and what cannot, changes nothing
yoal ha migrate attachments --apply    # moves them; each app restarts once
```

Anyone who can read the HA status can run the first command. `--apply` needs a platform admin, and with the default bindings an API key gets `403`: move them from **Settings → High availability → Move apps to their endpoints** instead, where the dry run is shown first and you type `move` to confirm.

An app listed as `blocked` runs a copy on a node whose agent does not support endpoints yet. Update
that node, then run the command again.

To see how every app reaches its databases, run `yoal ha attachments`, or use the MCP tool
`get_attachment_endpoints`. For each app, database and node holding a copy it shows the mode, the
host and port the app connects to, the pooled and read ports, and the node the connection lands on.
The modes are:

| Mode | Meaning |
|---|---|
| `gateway` | Through the app's stable endpoint |
| `endpoint` | A process app on another node, through a loopback port |
| `direct` | On the database's node, straight to its port |
| `none` | No connection URL: a container on another node without endpoints. Run `yoal ha migrate attachments --apply` or redeploy it |

Nodes authenticate each other's endpoint traffic with certificates from the install's own
certificate authority. `yoal ha ca` shows it and the node certificates; `yoal ha ca rotate` replaces
it (a platform admin only; with the default bindings, rotate it from **Settings → High
availability → Install CA**, typing `rotate` to confirm). The old authority stays trusted while each
node renews its certificate, within 60 days. A second rotation is refused until no node holds a
certificate the previous one signed; `yoal ha ca` and the dashboard show how many still do, and the
dashboard keeps the button off until the count is 0.

## Settings → Clustering

**Settings → Clustering** is a JSON editor for cluster tunables. It is available to platform owners only. The JSON is validated against the schema. An unknown section is rejected; an unknown key inside a section is ignored. Changes apply to the next join, placement, failover check or maintenance sweep.

These are the keys that code reads today:

| Key | Default | Effect |
|---|---|---|
| `overlay.cidr` | `10.47.0.0/22` | Address range for the managed WireGuard network between nodes |
| `overlay.mtu` | `1420` | MTU of the WireGuard interface |
| `overlay.listenPort` | `51820` | UDP port WireGuard listens on |
| `endpoints.portMin`, `endpoints.portMax` | `21000`, `21999` | Local port range for cross-node service endpoints; `portMin` must be below `portMax` |
| `replicas.max` | `20` | Most copies one app may run |
| `replicas.spread` | `node` | `node` or `zone` |
| `replicas.healthIntervalSeconds` | `5` | Seconds between the edge's health checks of each copy, when the app declares a health path |
| `replicas.failoverGraceSeconds` | `120` | Seconds without a heartbeat before automatic failover moves a node's copies |
| `failover.enabled` | `false` | Turn automatic failover on (see [automatic failover](#automatic-failover)); a drain moves copies either way |
| `failover.graceSeconds` | `120` | Seconds without a heartbeat before a node counts as lost for databases and ingress |
| `failover.maxPerMinute` | `6` | Most automatic moves a minute across the fleet |
| `controlPlane.leaseTtlSeconds` | `30` | How long the failover lease lasts without renewal: the longest a stopped control plane holds up the next one |
| `controlPlane.renewSeconds` | `5` | How often the controller checks the fleet and renews its lease (at most a third of the TTL) |
| `database.maxLagBytes`, `database.maxLagSeconds` | `67108864`, `60` | A replica further behind than either is never picked for promotion |
| `database.maxReplicas` | `2` | Replicas allowed per database (0 to 5) |
| `storage.maxTargets` | `2` | Replication targets allowed per storage instance |
| `storage.syncIntervalMinutes` | `15` | Minutes between bucket replication passes |

> [!NOTE]
> Earlier releases also accepted `overlay.maxHubs`, `endpoints.requireMtls`, `endpoints.forwarder`, `database.defaultMode` and `shares.mountRoot`, but nothing read them. They are no longer part of the configuration. A saved document that still has them at their old defaults saves as before, and the keys are dropped. Any other value is rejected with the reason.

## Settings → High availability

**Settings → High availability** is available to platform owners only. It starts with a guided setup, the dashboard's form of `yoal ha init`:

1. Choose a profile: **Single**, **HA**, or **HA with disaster recovery**.
2. Review the plan: the `YOAL_FEATURE_*` lines the profile needs and the cluster settings it changes. Flags are read from `yoal.env` when the control plane starts, so add the lines on every control-plane host and restart before you apply.
3. Answer at most three questions (how traffic reaches the ingress nodes, where certificates come from and, for disaster recovery, the standby region). Each has a default.
4. Check the preflight: every check with its status, what was seen and the exact fix, the same list as `yoal ha preflight`. A check marked **Blocks apply** must pass first; warnings never block.
5. Apply. The button stays off while a flag differs from the plan or a required check fails, and says why.

To undo, choose **Single**: it turns off what the HA profile turned on and puts back the settings it changed. It is refused while anything still depends on an HA feature, such as a synchronous database, and each refusal names its own way back.

Below the setup, **What is in force** shows the profile, the ingress nodes and steering driver, the arbiter and control-plane standby, databases with their durability and automatic failover state, regions and recent drills. Automatic database failover reads **Not available yet**, with the reason, until every data node can fence itself; until then the controller only reports which replica it would promote.

**Drills** lists every drill scenario, which runs on a fleet and which only in a lab, and what each measures. A platform admin can run a fleet scenario on a named resource; a destructive one needs the resource's name typed back. Results show the measured recovery time and data loss against each scenario's bound.

**Install CA** and **Move apps to their endpoints** are the dashboard controls for `yoal ha ca rotate` and `yoal ha migrate attachments --apply`. Anyone with HA access sees the status and the dry run; only a platform admin sees the controls.

The page also refreshes every 10 seconds and shows:

- the failover controller: whether automatic failover is on, who holds the lease and at which epoch, when it last ran, and its limits
- every node, how long since its last heartbeat, how many replica copies it holds, and when they would move
- databases with replicas, whether the primary is lost, and the replica a promotion would use
- the ingress driver and the withdraw and re-add hold-downs, which are set on this page, and every node with the ingress role, whether it is ready and whether it is in the DNS record set
- the [disaster drill](#disaster-drills): start one, follow it, and the results of recent ones
- the failover history: every move, ingress withdrawal or re-add, database decision and lease change, newest first

**Settings → Clustering** shows a short summary of the same state above the JSON editor.

The page is for status. Only the `direct` driver, which is today's single edge, changes traffic. The other drivers (`dns-failover`, `cloudflare-lb` and `cloudflare-tunnel`) can be selected, but they do not change DNS or probe nodes; with `dns-failover` and `cloudflare-lb`, the controller tells you which record to change.

## Planned, not built

> [!NOTE]
> Not available yet. Do not plan around these:
>
> - A standby control plane, and automatic control-plane promotion.
> - Self-fencing of a database primary that is cut off from the control plane, which automatic promotion needs to be safe.
> - DNS-based or Cloudflare ingress failover with health probing.
> - A second ingress node that takes over traffic when the edge fails.
> - Rolling deploys, and a drain that moves every app off a node.
> - Mirrored node disks.
> - Bucket replication to another node.
> - One share used by apps on several nodes at once. Each node mounts a share as its own disk. See [network shares](/self-hosting/nodes-and-fleet#network-shares).
> - Replicas for engines other than Postgres.
