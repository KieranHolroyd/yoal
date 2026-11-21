---
title: Platform administration
description: Reference for yoal ha, doctor, fleet, nodes and upgrade: HA setup and drills, failover status, capacity, node updates in waves, and upgrades.
---

These commands run the platform itself rather than an organisation's projects: the failover controller, the fleet's capacity and links, worker node updates, and upgrades of the control plane. For global options, environment variables and the general exit codes, see [the CLI overview](/clients/cli). Scaling a single app's copies is on [compute](/cli/compute#scale).

## Permissions

Most of these commands need a **platform admin**, an install-wide role separate from organisation roles (see [platform admins](/accounts/organizations-and-roles#platform-admins)).

| Commands | Who can run them |
| --- | --- |
| `ha status`, `ha preflight`, `ha init` (until it applies), `ha drill`, `doctor`, `ha attachments`, `ha migrate attachments` (without `--apply`), `ha ca`, `fleet status`, `fleet links`, `fleet rebalance` (preview), `nodes rollout plan`, `status` and `list`, `upgrade plan` | A platform admin, with any credential, including the API key the CLI uses. |
| `ha init` when it applies, `ha migrate attachments --apply`, `ha ca rotate`, `fleet rebalance --apply`, `fleet link-test`, `nodes enrol`, `nodes update`, `nodes rollout start`, `resume` and `cancel` | A platform admin signed in to the dashboard. By default an API key gets `403` for these, even a platform admin's; make the change from the dashboard instead. |
| `fleet move` | Anyone with `project:update` on the project. `--status` needs read access to the project. |
| `upgrade apply`, `upgrade rollback` | Root on the Yoal host. No API credential can do this. |

> [!NOTE]
> The dashboard has no control for applying `ha init` yet. With the default bindings the CLI's API key gets `403` when it applies: call `POST /api/v1/ha/init` with `"apply": true` and a platform admin's dashboard session. The plan and the preflight work with the API key.

> [!NOTE]
> The dashboard has no control for `ha migrate attachments --apply` or `ha ca rotate` yet. With the default bindings, the CLI's API key gets `403` for them: call `POST /api/v1/ha/attachments/migrate` or `POST /api/v1/ha/ca/rotate` with a platform admin's dashboard session. Apps also move on their own next deploy.

## ha

```sh
yoal ha init --profile <ha|ha-dr|single> [--steering <driver>] [--certificates <shared|per-node>] [--standby-region <region>] [--yes] [--json]
yoal ha preflight [--profile <ha|ha-dr|single>] [--steering <driver>] [--certificates <shared|per-node>] [--json]
yoal ha drill <scenario> --resource <id|name> [--confirm <name>] [--yes] [--minutes <n>] [--drill-database <copy>] [--json]
yoal ha drill --all [--node <name>]... [--ingress-node <name>]... [--database <db>[:<copy>]]... [--project <slug>]... [--target <kind>:<resource>]... [--yes] [--json]
yoal ha drill catalogue|runs [--json]
yoal ha status [--events <n>] [--json]
yoal ha attachments [--json]
yoal ha migrate attachments [--project <slug>]... [--apply] [--json]
yoal ha ca [rotate] [--json]
```

`ha init`, `ha preflight` and `ha drill` set up and prove high availability; see [high availability setup](/self-hosting/clustering#high-availability-setup). `ha status` shows the failover controller. It only reads. See [automatic failover](/self-hosting/clustering#automatic-failover). The other commands are for [attachment endpoints](/self-hosting/clustering#attachment-endpoints).

### ha init

Turns high availability on as one profile, or off again with `--profile single`. It first shows the plan:

- The answers it uses: how traffic reaches the ingress nodes (`--steering`, default `external-lb`), where certificates come from (`--certificates`, default `shared`), and for `ha-dr` the standby region (`--standby-region`, the default when exactly one other region has a data node). In a terminal it asks each question no flag answered; `--yes` takes the defaults.
- The `YOAL_FEATURE_*` lines the profile needs in `/etc/yoal/yoal.env`. `ha init` never writes them: put them in `yoal.env` on every control-plane host and restart each control plane (`systemctl restart yoal-control-plane`). The lines you still need to change are marked.
- The cluster settings it sets: the profile, the steering driver, automatic failover on, and app copies spread across zones.
- The preflight, and every reason it would refuse to apply now.

It changes nothing while a flag line differs, a question has no answer, or a check the profile requires fails. Otherwise it asks before applying (or applies with `--yes`) and sets everything in one change, recorded in the audit log. It also records each setting's earlier value, so `--profile single` puts back exactly those values and nothing else. `single` is refused while something still depends on an HA feature, such as a synchronous or armed database, an enrolled standby, or a node in a named region; each refusal says how to undo that one first. The `ha` profile includes `DB_AUTO_PROMOTE`, but no database fails over on its own until you arm it.

| Flag | Description |
| --- | --- |
| `--profile <p>` | `ha`, `ha-dr` (adds a standby region) or `single`. Required. |
| `--steering <driver>` | `external-lb`, `dns-failover`, `vip`, `cloud-lb`, `cloudflare-tunnel` or `webhook`. |
| `--certificates <source>` | `shared` (one issuance on every ingress) or `per-node`. |
| `--standby-region <region>` | `ha-dr` only. |
| `--yes` | Take the defaults and apply without asking. |
| `--json` | Print the plan; with `--yes`, the applied result. |

```sh
yoal ha init --profile ha --steering external-lb
yoal ha init --profile single
```

### ha preflight

Runs every HA check and prints each with `ok`, `WARN`, `FAIL` or `SKIP`, what it found and the exact fix: a command, a setting, a `yoal.env` line or a manual step. It changes nothing. Without `--profile` it checks the install's own profile, or `ha` on a single-node install, so you see what is missing. The exit status is 1 when the profile's required checks do not all pass.

| Check | What it looks at |
| --- | --- |
| `nodes` | At least two online ingress, compute, data and control nodes. Two data nodes warn: a lost primary is not promoted automatically until there are three. |
| `node-capabilities` | Each node's agent supports what the profile's flags need. The fix is `yoal nodes update <node>`. |
| `zones` | Ingress, data and control nodes are not all in one zone. |
| `clocks` | Each node's clock against the control plane's, from its heartbeats. More than 2.5 s warns; more than 5 s fails. |
| `overlay-links` | Every link between ingress, data and control nodes answered in the last 5 minutes: WireGuard handshakes on the managed overlay, round-trip samples elsewhere. |
| `arbiter-conditional-writes` | The platform object store wins and loses conditional writes correctly. The check writes and deletes one small object under `yoal/ha/`. |
| `certificates` | Every ingress serves the same certificate (with shared certificates). |
| `steering` | The steering driver's own checks pass. |
| `backups` | Every database has an off-node backup from the last 48 hours, or point-in-time recovery. An unverified or mutable backup warns. |
| `headroom` | The other nodes can take the memory of the largest node, and of the largest zone. |
| `platform-store`, `registry-storage`, `identity`, `mail`, `telemetry-spool` | Nothing the platform needs lives only on one node. |
| `flags-consistent` | Every control-plane host runs the same flags. |
| `ha-dependents` | Nothing still depends on an HA feature; this is what `--profile single` requires. |
| `regions` | Not checked yet: it is reported as `SKIP`. |

A check that cannot be worked out, for example a node whose agent does not report its clock yet, is `SKIP` with the reason, never `ok`. A required check that is skipped keeps the profile from applying.

```sh
yoal ha preflight
yoal ha preflight --profile ha-dr --json | jq '.checks[] | select(.status == "fail")'
```

### ha drill

Injects one fault on one resource you name, measures how long recovery takes and how much data was lost, and records the result. `yoal ha drill catalogue` lists every scenario: what it is run against, whether it runs on a fleet or only in a test lab, how it is confirmed, the lowest HA level it accepts, and the bound it is judged by. `yoal ha drill runs` lists recent results, and `yoal ha drill show <id>` shows one.

- A drill never picks a resource for you: name it with `--resource`.
- A scenario that takes something down for real (such as `node-offline`) needs the resource's name typed back, with `--confirm <name>` or at the prompt. The database failover drill asks for a yes and promotes a disposable copy you name with `--drill-database`, never the database itself.
- A drill is refused on a resource whose declared HA level is below the scenario's minimum, and on a resource that is already below its own declared level.
- Scenarios that need a fault only a test lab can inject (killing a process, a network partition, a skewed clock, a full disk) are refused with the reason. So are `zone-offline`, `control-plane-failover` and `region-failover`.
- `release-readiness-fail` and `release-command-fail` are recorded as skipped: there is no way yet to run them on a live project.

`--all` runs every scenario that is safe on a fleet (nothing taken down, nothing to type) against the resources you name, one at a time, and lists each scenario it skipped with the reason. `--yes` adds the ones that need a confirmation. A database is named as `main`, or `main:main-copy` to include its failover drill on the copy.

| Flag | Description |
| --- | --- |
| `--resource <id\|name>` | The node, database or project to drill. |
| `--confirm <name>` | The resource's name, for a scenario that takes it down. |
| `--minutes <n>` | How long a node stays dark, from 1 to 30. The default is 5. |
| `--drill-database <copy>` | The disposable copy a database failover drill promotes. |
| `--node`, `--ingress-node`, `--database`, `--project`, `--target <kind>:<resource>` | With `--all`: the resources to drill. Repeat each as needed. |
| `--yes` | Confirm without a prompt. With `--all`, include the scenarios that need a confirmation. |
| `--json` | Print the raw response. |

```sh
yoal ha drill catalogue
yoal ha drill node-offline --resource worker-b --confirm worker-b
yoal ha drill --all --database main:main-copy --project shop --yes
```

`yoal ha drill node-offline` without `--resource` is the older node offline drill, which can pick an eligible node at random; see [disaster drills](/self-hosting/clustering#disaster-drills).

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

## doctor

```sh
yoal doctor [--json]
```

Checks the running install against its own profile, then each node: whether it is sending heartbeats, whether Caddy applied its configuration, whether it is behind the desired state, whether its agent matches the control plane's version, and how full its data disk is (85% warns, 95% fails). It prints the same lines as `ha preflight`, each problem with its fix, and changes nothing. On a single-node install the checks only an HA fleet needs are skipped. The exit status is 1 when anything fails.

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
yoal nodes <enrol|update|rollout> [options]
```

`nodes enrol` creates a join token for a new machine. The other actions update worker nodes to the control plane's own version, one at a time or across the fleet in waves. A node never downgrades. The control-plane host itself is upgraded with [`upgrade`](#upgrade). See [worker nodes](/self-hosting/upgrades#worker-nodes).

Aliases: `node`. `rollouts` is accepted for `rollout`.

Wherever a node is named, you can use its id or its name; a name shared by several nodes is an error that lists their ids.

### nodes enrol

```sh
yoal nodes enrol [--name <name>] [--roles <role,...>] [--json]
```

Creates a single-use join token that expires after an hour, and prints the `node.sh` line to run on the new machine. `--roles` lists the roles a join with this token may take: `ingress`, `control`, `compute`, `data`, `build`. The join can ask for some or all of them, never more; a join that asks for more is refused and the token stays unused. A token without `--roles` allows none, and the node joins as `compute` and `data`. An ingress receives the shared certificate and session secrets, so a token that allows `ingress` deserves the same care as those secrets.

```sh
yoal nodes enrol --name node-b --roles ingress,compute,data,control
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
