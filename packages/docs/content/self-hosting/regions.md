---
title: Regions and disaster recovery
description: Group zones into regions, keep a database standby in another region, and promote that region by hand when the first one is lost.
---

A region groups zones: `uksouth` might hold zones `uksouth-1`, `uksouth-2` and `uksouth-3`, and `ukwest` a fourth. Regions let you keep an async copy of a database far away, spread app copies across regions, and move the whole platform to the other region with one command when the first region is lost. Inside a region, failover stays automatic. Moving between regions is always a decision a person makes.

Regions are off by default. Until you turn them on, every node is in the region `default` and nothing on this page changes how Yoal places or promotes anything.

## Turn regions on

Set `YOAL_FEATURE_REGIONS=1` in the control plane's environment and restart it (see [feature flags](/self-hosting/configuration#feature-flags)). With several control-plane hosts, set it on each of them.

> [!WARNING]
> Once a node names a region other than `default`, or a setting uses `spread: region`, an older control plane cannot read the cluster configuration. Downgrading the control plane is unsupported until you put those values back to `default` and `zone`.

With the flag off, Yoal refuses to store a new region value anywhere. Values stored while it was on stay: a `spread: region` is placed as `zone`, and the HA preflight warns about each one. Setting a node back to `default` and clearing a standby region always work.

## Put nodes in regions

Every node in one zone must name the same region, so a zone belongs to exactly one region. Name each zone after its failure domain, and the region after the place or the provider's region:

```sh
yoal nodes set edge-1 --zone uksouth-1 --region uksouth
yoal nodes set dr-1 --zone ukwest-1 --region ukwest
yoal nodes list
```

In the dashboard, open **Nodes**, choose **Edit node** and set **Zone** and **Region**. The **Region** field appears once regions are on. Over REST, send `PATCH /api/v1/nodes/:id` with `{"zone": "ukwest-1", "region": "ukwest"}`. A change that would put one zone in two regions is refused and names the node in the way. To move a whole zone, give its nodes a new zone name in the new region.

A region change is refused while the node holds a database primary or replica, or a copy of an app placed with `spread: region`, and while a region promotion is open: moving the node would move those across regions. Move them first. A platform admin can override this with `yoal nodes set --force` (`PATCH /api/v1/nodes/:id?force=1`); the change is audited with what it affected, and the command prints it.

`yoal nodes set` and the REST call need a platform admin signed in to the dashboard. With the default bindings, the CLI's API key gets `403`; use **Nodes** in the dashboard instead.

## Spread copies across regions

`spread: region` never puts two copies of an app in one region, and so never two in one zone. Set it in the same places as the zone spread: `replicas.spread` in **Settings → Clustering** for every app, or a project's `placementSpec` (see [multi-node replicas](/self-hosting/clustering#multi-node-replicas)). An app with more copies than regions is refused, and the refusal names the region that already holds a copy.

## Keep a database standby in another region

A standby region holds an async replica of a PostgreSQL database that is never promoted automatically:

```sh
yoal db update orders --standby-region ukwest
yoal db create ledger --placement edge-1 --standby-region ukwest
```

Yoal adds the replica on the online data node in that region with the most free memory, in the same change. The node needs a managed overlay address and an agent that runs replicas. If no node qualifies, nothing is saved and the error names each node and why. The standby region must differ from the primary's.

How a standby-region replica behaves:

- **It is always async.** A synchronous replica must be in the primary's region, so `sync` durability chooses only replicas in that region. Adding a `sync` replica in another region is refused, with both regions in the message.
- **Automatic failover never chooses it**, and neither does any other replica outside the primary's region. If the primary's region is lost, the database waits for a person.
- **Its lag is the data a region promotion would lose.** `yoal db replicas orders` shows it. Past 30 seconds or 256 MiB, the **Standby region replica lag** alert fires.

`yoal db update orders --no-standby-region` clears the setting and keeps the replica. Remove the replica with `yoal db replicas remove` if you no longer want it.

## Steer traffic across regions

Put a balancer in each region, and fail over between regions in DNS. In Yoal this is the `dns-failover` driver across regions, stacked on `external-lb` inside each region:

```sh
curl -X PATCH https://control.example.com/api/v1/cluster/config \
  -H "Authorization: Bearer $YOAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "steering": { "driver": "dns-failover", "stacked": ["external-lb"] } }'
```

Non-`direct` drivers also need `YOAL_FEATURE_STEERING=1`. With regions on, every driver offers traffic to the ingress nodes of the active region only. The active region is where the edge runs, until a region promotion moves it. If no ingress node in the active region is online, the drivers offer the other regions' ingress, so reads keep working from the standby region before anyone promotes it. Writes to a database whose primary is in the lost region fail until you promote.

Each region's own balancer probes its ingress nodes as described in [load balancers](/self-hosting/load-balancers); Yoal writes nothing to it. If you prefer a provider's DNS failover, see [Azure Traffic Manager in front of a regional balancer](/self-hosting/load-balancers#azure-traffic-manager-in-front-of-a-regional-balancer).

> [!NOTE]
> Not available yet: `dns-failover` publishes the ingress nodes' own addresses, not a regional balancer's address.

## Promote a region

When a region is lost, promote the other one. The promotion runs on the control plane in the surviving region, so enrol a control-plane standby there beforehand (`yoal ha control enrol`). Point the CLI at that control plane, for example with a [profile](/clients/cli) whose URL is the standby's own address.

First show the plan. It changes nothing:

```sh
yoal ha region promote ukwest
```

The plan lists every step in the order it runs:

1. **The control plane.** This standby promotes itself, at the control-plane epoch the plan read.
2. **Each database with a replica in the region**, those whose standby region it is first. Each is promoted through the same path as `yoal db failover`, at the generation the plan read. A database with no replica there is listed as skipped and stays where it is.
3. **Steering.** The region becomes the active region, and each driver offers its ingress nodes on its next run.

The plan also shows the data each database would lose (its replica's lag), a plan hash, anything that blocks the promotion, and any lease the old region still holds. To run it, type the region back with the hash:

```sh
yoal ha region promote ukwest --confirm ukwest --plan-hash <hash> \
  --accept-data-loss --reason "uksouth unreachable since 09:40"
```

If any generation moved since the plan, the hash no longer matches and the promotion is refused: show the plan again.

A lease is still held when it names a node other than the one being promoted and has not expired by the arbiter's clock: the old primary may still be serving writes. While the old region holds its control-plane lease or any database lease, the promotion is refused. When a region is really lost its leases expire within seconds, because nothing renews them; Yoal also stops renewing a lease on behalf of a primary whose node is offline or whose database a promotion is moving. Wait for the leases to expire, or add `--break-glass` once you know the old region is stopped. Break glass is stored on the promotion and recorded in the audit log.

Each database is checked again when its turn comes, whichever control plane runs it. If its old primary holds a valid lease again, the promotion stops at that database and promotes nothing more, unless you broke glass. Two other things are reported in the plan on their own lines:

- **A sync-set change is open** on a database's lease: it cannot be promoted until the change closes or falls back, break glass or not.
- **A synchronous database's replica is not in its synchronous set.** That is always the case for a standby region, because `sync` stays inside a region. Commits acknowledged after the replica's position are lost; that is the data loss you accept.

When a database's promotion finishes, the region it left becomes its standby region, so a promotion back plans it first. The HA preflight then asks for a replica in that region: rebuild one once the region is back with `yoal db replicas add`.

The command returns once the control plane is promoted and the first database has started. The rest continues on its own as each database finishes; follow it with `yoal ha region` or on **Settings → High availability**. A step that fails stops the promotion and names the step and the reason; nothing is rolled back. Fix the cause and run `yoal ha region promote ukwest` again for a new plan: finished steps are not repeated, because each database is already in the region.

If the control plane running the promotion dies, another control plane in the region resumes it about a minute later, and no step runs twice. You can also resume it yourself by running the confirm command again with the same hash.

Only a platform admin can promote a region, and by default only from a dashboard session: with the default bindings the CLI's API key gets `403`, as it does for `yoal ha control promote`. The dashboard shows regions but has no promote control, so call `POST /api/v1/ha/regions/:region/promote` with a platform admin's dashboard session, or give the CLI's key a platform admin binding without the session condition. The route takes `{}` for the plan, and `{"confirm", "planHash", "acceptDataLoss": true, "reason", "breakGlass"}` to run it. The MCP server can read regions through `get_ha_status`, but it cannot promote one.

## Check a region setup

```sh
yoal ha region        # each region's zones, nodes and databases, and the last promotion
yoal ha status        # the same, under the failover controller
```

**Settings → High availability** shows a **Regions** card with the same table and the steps of the open or last promotion; `GET /api/v1/ha/regions` returns the same data. The HA preflight includes a `regions` check. It fails when a zone names two regions or when a database's standby region holds no replica, and warns when a standby replica lags more than 30 seconds or ingress spans regions without `dns-failover` or `webhook` steering. For the `ha-dr` profile it also fails when no online data node is outside the active region, and warns when no control-plane standby is outside it or no database has a standby region.

> [!NOTE]
> Not available yet: setting a node's region when it joins. Set it with `yoal nodes set` or in **Nodes** after the node joins.
