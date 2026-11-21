---
title: Platform administration
description: Reference for yoal ha, fleet, nodes and upgrade: failover status, capacity and rebalancing, node updates in waves, and platform upgrades.
---

These commands run the platform itself rather than an organisation's projects: the failover controller, the fleet's capacity and links, worker node updates, and upgrades of the control plane. For global options, environment variables and the general exit codes, see [the CLI overview](/clients/cli). Scaling a single app's copies is on [compute](/cli/compute#scale).

## Permissions

Most of these commands need a **platform admin**, an install-wide role separate from organisation roles (see [platform admins](/accounts/organizations-and-roles#platform-admins)).

| Commands | Who can run them |
| --- | --- |
| `ha status`, `ha attachments`, `ha migrate attachments` (without `--apply`), `ha ca`, `ha region` and the `ha region promote` plan, `nodes list`, `fleet status`, `fleet links`, `fleet rebalance` (preview), `nodes rollout plan`, `status` and `list`, `upgrade plan` | A platform admin, with any credential, including the API key the CLI uses. |
| `ha migrate attachments --apply`, `ha ca rotate`, `ha region promote --confirm`, `fleet rebalance --apply`, `fleet link-test`, `nodes set`, `nodes update`, `nodes rollout start`, `resume` and `cancel` | A platform admin signed in to the dashboard. By default an API key gets `403` for these, even a platform admin's; make the change from the dashboard instead. |
| `fleet move` | Anyone with `project:update` on the project. `--status` needs read access to the project. |
| `upgrade apply`, `upgrade rollback` | Root on the Yoal host. No API credential can do this. |

> [!NOTE]
> The dashboard has no control for `ha migrate attachments --apply` or `ha ca rotate` yet. With the default bindings, the CLI's API key gets `403` for them: call `POST /api/v1/ha/attachments/migrate` or `POST /api/v1/ha/ca/rotate` with a platform admin's dashboard session. Apps also move on their own next deploy.

## ha

```sh
yoal ha status [--events <n>] [--json]
yoal ha attachments [--json]
yoal ha migrate attachments [--project <slug>]... [--apply] [--json]
yoal ha ca [rotate] [--json]
yoal ha region [status] [--json]
yoal ha region promote <region> [--confirm <region> --plan-hash <hash> --accept-data-loss --reason <text> [--break-glass]] [--json]
```

`ha status` shows the failover controller. It only reads. See [automatic failover](/self-hosting/clustering#automatic-failover). The other commands are for [attachment endpoints](/self-hosting/clustering#attachment-endpoints).

### ha status

The output covers:

- Whether automatic failover is on. When it's off, draining a node still moves replica copies.
- The controller lease: its state, epoch, holder and expiry, and whether this control plane holds it.
- The last tick and the policy: how long before a node counts as lost, when its copies move, rate limits fleet-wide and per target, and when queued actions expire.
- How many actions ran in the last minute, are in progress and are waiting.
- Every node with its zone, status, how long it has been silent, whether it's lost, its replica copies and when they would move.
- The ingress record set: each ingress node's health, whether it's in rotation and whether it's pinned. Withdrawing and re-adding a record are manual DNS steps.
- Databases whose primary is lost, with the replica a promotion would pick, or why there is none, and whether promotion is automatic.
- Recent failover events: when, kind (`replica`, `ingress`, `database` or `lease`), status, subject, from and to nodes, and reason.

| Flag | Description |
| --- | --- |
| `--events <n>` | How many recent events to list, from 0 to 50. The default is 10; `0` leaves the events out. |
| `--json` | Print the raw status from the server. |

```sh
yoal ha status
yoal ha status --events 50
yoal ha status --json | jq '.nodes[] | select(.lost)'
```

### ha attachments

Lists every database attachment and, for each node holding a copy of the app, how that copy reaches the database: the mode (`gateway`, `endpoint`, `direct` or `none`), the host and port, the pooled and read ports, and the node the connection lands on. It only reads and never prints a credential.

### ha migrate attachments

Lists the apps with an attached database that do not use their stable endpoints yet, and whether each `will move` or is `blocked`, with the reason. Without `--apply` it changes nothing.

| Flag | Description |
| --- | --- |
| `--project <slug>` | Only this app. Repeat it for several. |
| `--apply` | Move the listed apps now. Each restarts once. Needs a platform admin signed in to the dashboard. |
| `--json` | Print the raw response. |

```sh
yoal ha migrate attachments
yoal ha migrate attachments --project shop --apply
```

### ha ca

Shows the install's certificate authority: the one that signs, a previous one still trusted after a rotation, and the node certificates (how many nodes hold one, how many are due to renew, how many were revoked, and the next expiry). `yoal ha status` shows the same lines while attachment endpoints are on.

`yoal ha ca rotate` creates a new authority. The old one stays trusted, so no node loses its connections; each node moves to the new one when it renews, within 60 days. A second rotation is refused while nodes still hold certificates the previous one signed. Needs a platform admin signed in to the dashboard.

### ha region

Lists each region with its zones, nodes, database primaries and standbys, and the open or last region promotion with its steps. Needs regions on; see [regions and disaster recovery](/self-hosting/regions).

### ha region promote

```sh
yoal ha region promote ukwest
yoal ha region promote ukwest --confirm ukwest --plan-hash <hash> --accept-data-loss --reason "uksouth unreachable"
```

Without `--confirm`, prints the plan and changes nothing: the control plane, each database with a replica in the region, then steering, with each step's fence, the data the promotion would lose, the plan hash, and any lease the old region still holds. With the region typed back, the hash, `--accept-data-loss` and `--reason`, it runs the plan on the control plane the CLI points at, which must be in that region.

| Flag | Description |
| --- | --- |
| `--confirm <region>` | The region name typed back. |
| `--plan-hash <hash>` | The hash the plan printed. A plan whose generations moved since is refused. |
| `--accept-data-loss` | Required: writes after the last replicated one are lost. |
| `--reason <text>` | Required: recorded in the audit log. |
| `--break-glass` | Promote although the old region still holds a valid lease (one that names another node and has not expired). Only once that region is known to be stopped. Stored on the promotion, so later database steps honour it too; audited. |

The command exits 1 if the promotion failed. Running it again with the same hash resumes an open promotion.

## fleet

```sh
yoal fleet <status|rebalance|move|links|link-test> [options]
```

How the fleet's capacity is used and how its nodes are connected. With no action, prints the help. See [fleet: capacity, rebalancing and links](/self-hosting/nodes-and-fleet#fleet-capacity-rebalancing-and-links). Every action takes `--json` to print the raw response.

### fleet status

```sh
yoal fleet status [--pinned] [--json]
```

The placement strategy (and whether automatic rebalancing is on), then one row per node: zone, status (`no new work` when it isn't eligible for placement), memory reserved against capacity with a bar, memory in use as the host reports it, CPU, and how many copies it runs and how many of them can move. Ends with what a rebalance would move and the command to apply it.

| Flag | Description |
| --- | --- |
| `--pinned` | Also list workloads that can't move, with their node and why. |

```sh
yoal fleet status --pinned
```

### fleet rebalance

```sh
yoal fleet rebalance [--apply] [--strategy spread|pack] [--json]
```

Without `--apply`, previews the moves that would even out the fleet and moves nothing. With `--apply`, starts them straight away, with no prompt, and lists anything it skipped. Moves finish in the background; `yoal ha status` shows them.

| Flag | Description |
| --- | --- |
| `--apply` | Make the moves. Needs a platform admin signed in to the dashboard. |
| `--strategy <strategy>` | Use `spread` (the emptiest node first) or `pack` (fill one node before the next) for this run, instead of the configured strategy. |

```sh
yoal fleet rebalance
yoal fleet rebalance --strategy pack
```

### fleet move

```sh
yoal fleet move <project> [--to <node>] [--json]
yoal fleet move <project> --with-data [--to <node>] [--json]
yoal fleet move <project> --status | --cancel [--json]
```

Moves one app to another node. Without `--to`, the scheduler picks the node. An ordinary move works for single-copy apps; it prints whether the old copy keeps serving until the new one is up, or the app stops and then starts on the new node. An app running as a spread replica set can't be moved this way; drain a node or rebalance instead. See [move an app to another node](/compute/scaling#move-an-app-to-another-node).

| Flag | Description |
| --- | --- |
| `--to <node>` | The target node, by id or name. |
| `--with-data` | Also move the app's volumes. The app is stopped while they are copied. Refused for an app with no volumes. |
| `--status` | Show the latest move with data: phase, detail, error and each volume's size and state. Ignores `--to`. |
| `--cancel` | Stop a move with data before its switch; the app starts again where it was. Ignores `--to`. |

```sh
yoal fleet move my-api --to edge-b
yoal fleet move my-db-app --with-data
yoal fleet move my-db-app --status
```

### fleet links

```sh
yoal fleet links [--json]
```

Every pair of nodes on the managed overlay: the path between them, latency, packet loss, and the last throughput test's upload and download (or its status, or error when it failed). Also prints how many tests are running and queued.

```sh
yoal fleet links
```

### fleet link-test

```sh
yoal fleet link-test [--from <node>] [--to <node>] [--seconds <n>] [--streams <n>] [--json]
```

Queues throughput tests. With neither `--from` nor `--to`, every pair is tested once; with one of them, that node is tested against all the others; with both, just that pair. A test loads the link for a few seconds in each direction, and each node takes part in one test at a time. Results appear in `yoal fleet links` as each test finishes. Needs a platform admin signed in to the dashboard.

| Flag | Description |
| --- | --- |
| `--from <node>` | One end, by id or name. |
| `--to <node>` | The other end, by id or name. |
| `--seconds <n>` | Seconds per direction, from 1 to 30. The default is 5. |
| `--streams <n>` | Parallel streams, from 1 to 8. The default is 4. |

```sh
yoal fleet link-test --from edge --to edge-b --seconds 10
```

## nodes

```sh
yoal nodes <list|set|update|rollout> [options]
```

Lists nodes, sets a node's zone or region, and updates worker nodes to the control plane's own version, one at a time or across the fleet in waves. A node never downgrades. The control-plane host itself is upgraded with [`upgrade`](#upgrade). See [worker nodes](/self-hosting/upgrades#worker-nodes).

Aliases: `node`. `rollouts` is accepted for `rollout`.

Wherever a node is named, you can use its id or its name; a name shared by several nodes is an error that lists their ids.

### nodes list

```sh
yoal nodes list [--json]
```

Every node with its status, zone, region, roles and agent version.

### nodes set

```sh
yoal nodes set <node> [--zone <zone>] [--region <region>] [--force] [--json]
```

Changes a node's zone, region or both. A zone belongs to exactly one region, so a change that would put one zone in two regions is refused. A region change is also refused while the node holds database primaries or replicas or `spread: region` copies, or while a region promotion is open; `--force` overrides that, is audited, and prints what it affected. A region other than `default` needs regions on; see [regions and disaster recovery](/self-hosting/regions#put-nodes-in-regions). Needs a platform admin signed in to the dashboard.

```sh
yoal nodes set dr-1 --zone ukwest-1 --region ukwest
```

### nodes update

```sh
yoal nodes update <node> [--json]
```

Asks one node to install the control plane's release. It records the request; the node picks it up on its next check, verifies the signed bundle, installs it and restarts its agent. Asking again after a failure retries. Needs a platform admin signed in to the dashboard.

```sh
yoal nodes update edge-b
```

### nodes rollout plan

```sh
yoal nodes rollout plan [rollout options] [--json]
```

Shows the waves a fleet update would run now, changing nothing: the target version and options, then each wave with why it's grouped that way and each node's zone, roles, redundancy groups, current version and notes (`no rollback guard`, or how many single-copy workloads it runs). Lists nodes that won't be updated and why, and any warnings.

Rollout options, shared with `start`. Any you leave out come from the node update defaults in **Settings → Clustering**, so the CLI plans what the dashboard would:

| Flag | Description |
| --- | --- |
| `--strategy <strategy>` | `availability` (the default: a canary, then waves that keep every redundant group up), `rolling` (`--batch` nodes at a time) or `parallel` (every node at once). |
| `--batch <n>` | Nodes per wave for `rolling`, from 1 to 50. The default is 1. Refused with any other `--strategy`. |
| `--drain`, `--no-drain` | Cordon each wave and move what can move off it before updating. Off by default. |
| `--canary`, `--no-canary` | Update one node on its own first. On by default, except for `parallel`. |
| `--soak <seconds>` | How long every node of a wave must stay healthy before the next wave, from 0 to 3600. The default is 60. |
| `--max-failures <n>` | Failed nodes allowed before the rollout pauses, from 0 to 50. The default is 0: pause on the first failure. |
| `--node <node>` | Only this node. Repeat for more. |

```sh
yoal nodes rollout plan
yoal nodes rollout plan --strategy rolling --batch 2 --drain
```

### nodes rollout start

```sh
yoal nodes rollout start [rollout options] [-y, --yes] [--wait] [--json]
```

Prints the plan, asks `Update N nodes to <version>? [y/N]`, then starts the rollout. When no node can be updated, it stops with an error. Needs a platform admin signed in to the dashboard.

| Flag | Description |
| --- | --- |
| Rollout options | As for [`nodes rollout plan`](#nodes-rollout-plan). |
| `-y`, `--yes` | Start without asking. Required when stdin isn't a terminal. |
| `--wait` | Follow the rollout, printing each wave, node state and phase change, until it finishes or pauses. |
| `--json` | Print the started rollout. With `--wait`, prints only the final rollout. |

Without `--wait`, exits `0` once the rollout has started. With `--wait`, exits `0` only when every node was updated, and `1` when the rollout failed, was cancelled or paused. Declining the prompt, or running off a terminal without `--yes`, exits `1` and starts nothing.

```sh
yoal nodes rollout start --yes --wait
yoal nodes rollout start --node edge-b --node edge-c --no-canary
```

### nodes rollout status

```sh
yoal nodes rollout status [id] [--json]
```

With an id, shows that rollout. Without one, shows the rollout that is running or paused, or, if there is none, says so and shows the last one. The view has the status and phase, the options, who or what triggered it, the current wave, counts of done, failed and skipped nodes, and a row per node with its wave, state, version change, attempts and notes. A paused rollout ends with the commands to resume or cancel it. `yoal nodes rollout` with no subcommand runs `status`.

`--json` prints the given rollout, or without an id, the active rollout (`null` when none is running).

```sh
yoal nodes rollout
yoal nodes rollout status nro_01J9Z3K4M5N6P7Q8R9S0T1V2W3
```

### nodes rollout list

```sh
yoal nodes rollout list [--limit <n>] [--json]
```

Recent rollouts, newest first: id, status, target version, strategy, trigger (`manual` or `auto`), start time, nodes done and nodes failed.

| Flag | Description |
| --- | --- |
| `--limit <n>` | How many, from 1 to 100. The default is 20. |

```sh
yoal nodes rollout list --limit 5
```

### nodes rollout resume

```sh
yoal nodes rollout resume <id> [--skip-failed] [--wait] [--json]
```

Continues a paused rollout. By default its failed nodes are tried again first. A paused rollout that nobody resumes or cancels fails after seven days. Needs a platform admin signed in to the dashboard.

| Flag | Description |
| --- | --- |
| `--skip-failed` | Leave the failed nodes as they are and carry on with the rest. |
| `--wait` | Follow the rollout to its end, as with `start --wait`, with the same exit codes. |

```sh
yoal nodes rollout resume nro_01J9Z3K4M5N6P7Q8R9S0T1V2W3 --wait
```

### nodes rollout cancel

```sh
yoal nodes rollout cancel <id> [--json]
```

Stops the rollout: no further waves start, and a node that is already installing finishes on its own. Needs a platform admin signed in to the dashboard.

```sh
yoal nodes rollout cancel nro_01J9Z3K4M5N6P7Q8R9S0T1V2W3
```

## upgrade

```sh
yoal upgrade [plan|apply|rollback] [options]
```

Checks, installs and rolls back the Yoal platform on a self-hosted installation. With no subcommand, `plan` runs. `apply` and `rollback` change the host, so they work only as root on the Yoal host, where the CLI hands them to the host's `yoal-update-self` command and exits with its exit code. Elsewhere they fail with `local_required` and name the command to run on the host; you can also use **Settings → Updates** in the dashboard. See [upgrades](/self-hosting/upgrades).

The CLI counts as being on the host when it runs as root and `/usr/local/sbin/yoal-update-self` exists. `YOAL_UPDATE_SELF` points it at the updater somewhere else.

### upgrade plan

```sh
yoal upgrade plan [--version <v>] [--repo <owner/name>] [--ref <ref>] [--json]
```

Runs the preflight for the next release and changes nothing. On the host as root (without `--version`), it runs `yoal-update-self plan`, which is the authoritative check. Anywhere else, or with `--version`, it asks the API, which needs a platform admin, and prints the current and target versions, `ready` or `refused`, how many migrations are pending (and whether any is destructive), and each check as `ok`, `warn` or `FAIL`.

| Flag | Description |
| --- | --- |
| `--version <v>` | Plan this target version instead of the newest release. Always goes through the API. |
| `--repo <owner/name>` | On the host: the GitHub repository the updater checks. Ignored through the API. |
| `--ref <ref>` | On the host: a branch, tag or commit to build from source. Ignored through the API. |
| `--json` | Print the plan as JSON. |

```sh
yoal upgrade plan
yoal upgrade plan --version 0.9.0 --json
```

### upgrade apply

```sh
sudo yoal upgrade apply [--repo <owner/name>] [--ref <ref>] [--force] [--with-agent] [-y, --yes]
```

Asks for confirmation, then installs the newer release: it snapshots the control database, `.env` and `APP_KEY`, switches releases, and rolls back automatically if the new release fails its health check. The confirmation comes before the host check, so off the host you're asked and then told to run it there.

| Flag | Description |
| --- | --- |
| `--repo <owner/name>` | The GitHub repository to install from. |
| `--ref <ref>` | Build this branch, tag or commit from source. |
| `--force` | Install even if the release isn't newer (a rebuild or a deliberate downgrade), or retry one that failed. |
| `--with-agent` | Restart `yoal-agent` on the new release. Current updaters already do this by default. |
| `-y`, `--yes` | Don't ask. Required when stdin isn't a terminal. |

`--version` and `--json` are accepted but not passed on: `apply` always installs the newest release (or `--ref`). For options the CLI doesn't pass, such as `--allow-destructive` or `--bake`, run `yoal-update-self` directly.

```sh
sudo yoal upgrade apply
sudo yoal upgrade apply --yes --force
```

### upgrade rollback

```sh
sudo yoal upgrade rollback [--restore-db | --keep-db] [--with-agent] [-y, --yes]
```

Asks for confirmation, then switches back to the previous release. Run it again to undo the rollback. See [roll back](/self-hosting/upgrades#roll-back).

| Flag | Description |
| --- | --- |
| `--restore-db` | Also restore the control database snapshot taken at the last switch. Writes since then are lost. |
| `--keep-db` | Run the old code against the newer schema. Safe only when the newer migrations were purely additive. |
| `--with-agent` | Restart `yoal-agent` on the previous release. Current updaters already do this by default. |
| `-y`, `--yes` | Don't ask. Required when stdin isn't a terminal. |

Declining either prompt exits `1` with `Cancelled.`

```sh
sudo yoal upgrade rollback
sudo yoal upgrade rollback --restore-db --yes
```
