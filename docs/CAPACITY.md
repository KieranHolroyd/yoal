# Yoal — Capacity: mapping hardware to projects, databases and services

Status: **plan, 2026-11-25.** Nothing here is built. The mechanisms are **proposals (RA1–RA16)**. Each one
becomes a D-number when its spike (§13) passes and it is built (the next free ID was D243 when this was written;
check the tail of DECISIONS.md first). Phases are **A0–A8** (§12). Sections describe the target design in the
present tense. "Today" means verified in the tree on 2026-11-25.

Related: [CLUSTERING.md](./CLUSTERING.md) §3 (hardware model, placement, scheduling), [STORAGE.md](./STORAGE.md)
(disks and tiers, D169), [SCALING.md](./SCALING.md) (copies, autoscaling, right-sizing), [QUOTAS.md](./QUOTAS.md)
(caps and showback), [KUBERNETES.md](./KUBERNETES.md) §5.2 (dedicated nodes, K24), [IAM.md](./IAM.md),
[HA-PLAN.md](./HA-PLAN.md) H26 (regions), [CLOUD-SHELL.md](./CLOUD-SHELL.md), [PIPELINES.md](./PIPELINES.md),
[RUNNERS.md](./RUNNERS.md). Decisions it builds on: D41, D42, D43, D47, D55, D90, D97, D129, D138, D169, D214,
D222, D225, D227, D239.

**Contents:** [0 Summary](#0-summary) · [1 Today](#1-today) · [2 Goals](#2-goals-and-non-goals) ·
[3 Vocabulary](#3-vocabulary) · [4 The ledger](#4-the-capacity-ledger) · [5 Pools](#5-node-pools) ·
[6 Grants and quotas](#6-grants-and-quotas) · [7 Placement](#7-placement-for-every-kind) ·
[8 Devices](#8-cpu-cores-gpus-disks-and-io) · [9 Node enforcement](#9-enforcement-on-the-node) ·
[10 Surfaces](#10-surfaces) · [11 Showback](#11-showback-and-right-sizing) · [12 Phases](#12-phases) ·
[13 Spikes](#13-spikes) · [14 Proposals](#14-proposals) · [15 Alternatives](#15-alternatives-considered) ·
[16 Risks and open questions](#16-risks-and-open-questions)

---

## 0. Summary

An operator should be able to say "the AI project gets the homelab GPU", "acme's databases live on acme's two
nodes", "this Postgres gets the NVMe and two whole cores", "builds never run on the edge", and then open one page
that shows which hardware holds what. Yoal can say parts of this today, through a per-resource `placement` value,
disk tiers and node labels. It cannot say it per org or per project, it cannot guarantee capacity to anyone, and
its accounting leaves out about a third of what runs on a node.

Six ideas carry the plan:

1. **One capacity ledger** (§4, RA1). Everything that holds hardware writes one **claim** row: an app copy, a
   database, a replica, a bucket server, a broker, a Kubernetes machine, a cloud shell, a running build or
   pipeline job, a platform service, a GPU, a set of cores, or bytes on a disk. Admission, the Fleet page, quotas,
   rebalance and showback all read that one table. The scattered `reservedByNode` sums go away. This is the
   host-port ledger (D225) applied to memory, CPU, disk and devices.
2. **Resources are a vector** (§4.2, RA2). Every claim carries memory, CPU millis, disk bytes on a named disk,
   devices and an optional core set. Every kind declares every dimension, so "brokers reserve no CPU" and
   "cloud shells reserve nothing" stop being true by accident.
3. **Node pools with an owner** (§5, RA3–RA5). A node belongs to exactly one pool. A pool is `shared` (the default
   pool, which every install starts with) or `dedicated` to one org or one project. Nothing else is ever placed on
   a dedicated pool: no other tenant's apps, builds, pipelines, shells or Kubernetes machines. This generalises the
   Kubernetes-only `kubernetes=dedicated:<org>` label (K24), which generic placement does not enforce today.
4. **Grants guarantee, quotas cap** (§6, RA6–RA7). A **grant** promises an org or project an amount of a shared
   pool (memory, CPU, disk per tier, GPUs). Admission keeps the unused part of every grant free for its owner, and
   the node backs the promise with cgroup memory protection and CPU weight. Quotas stay what they are today: a
   fleet-wide ceiling that never reserves anything.
5. **Placement is inherited and uniform** (§7, RA8–RA9). A placement policy set on an org, project or environment
   applies to everything under it: apps, functions, databases, replicas, buckets, volumes, brokers, jobs, builds,
   pipelines, Kubernetes clusters and shells. Every kind goes through one `CapacityService.place(request)` with the
   same filter, the same vector admission and the same refusal format.
6. **The map is a page** (§10, RA14–RA15). A **Capacity** page shows pools → nodes → stacked bars per dimension,
   coloured by owner, with each claim one click away. A project's **Resources** tab shows where each of its pieces
   runs and what it holds. REST, CLI and read-only MCP tools give the same answer.

On top of that, three hardware classes become first-class (§8): **whole GPUs** handed to one workload through CDI
or `/dev/dri` (RA11), **dedicated cores** pinned with `AllowedCPUs` (RA10), and **disk bytes and IO weight** on a
named disk (RA12).

An install that never creates a pool or a grant behaves exactly as it does today, with better numbers.

---

## 1. Today

Verified in the tree on 2026-11-25. File references are from `packages/core/src` unless they say otherwise.

### 1.1 What maps hardware to work

| Mechanism | Where | What it can express |
|---|---|---|
| Per-node budget | `nodes.slice_memory_mb` (default 1024), `slice_cpu_weight` (200), `cpu_budget_millis` (null = no cap) | How much of a node workloads may reserve (D41, D42) |
| Placement value | `projects.placement` (`edge` / node id / `auto`), `placement_json` (`PlacementSpec`) | Pin to a node; filter by zone, roles, labels, disk tier or disk id; `spread`; `near` |
| Disk tiers | `node_volumes` (TS `disks`), `storage_defaults` | Put a kind of service on `fast`/`bulk`/`system` or a named disk (D169) |
| Derived labels | `nodes.ts:1511` | `yoal.io/gpu`, `gpu-count`, `memory-gb`, `arch`, `virt`, `cpu-model` |
| Scheduling | `scheduling-service.ts`, `rebalance.ts`, `replicas.ts` | `spread`/`pack`, overcommit, rebalance, moves (D214) |
| Quotas | `org_quotas`, `project_quotas`, `quota.ts` | Fleet-wide caps per org/project; `workloadMemoryMb` is the only compute cap |
| Dedication | `kubernetes=dedicated[:<org>]` label, `kubernetes.ts:174–312` | Only for `trusted` Kubernetes machines (D227, K24) |
| Regions | `nodes.region`, `regions.ts` | `spread: region` and a database standby region, behind `REGIONS` |

There is no pool, no ownership of a node by an org or project, no guaranteed capacity, no CPU or GPU quota, and no
"instance size". Nodes are platform-global (`nodes` has no `org_id`).

### 1.2 How each kind picks a node

| Kind | Chooser | Pin available | Counted in memory / CPU budget |
|---|---|---|---|
| App, function, compose, runner pool | `workloads.ts:181` → `resolvePlacement` (`placement.ts:206`); copies via `planReplicas` (`replicas.ts:57`) | `placement`, `placementSpec` | yes / yes |
| Database primary | `databases.ts:350` → `disks.prepare` (`disks.ts:496`) | `placement`, `storage` | yes / yes |
| Database replica | `database-replica-service.ts:191` (node required) | node | yes / **no** |
| Object storage | `storage-instances.ts:271` | `placement`, `storage` | yes / yes |
| Broker | `brokers.ts:876` | `placement` | yes / **no** |
| Kubernetes machines | `kubernetes.ts:2321`, multi-node `697–719` | `placement`, `nodes[]`, `tier` | yes / **no** |
| App volume | `app-volumes.ts:217–251` (disk's node, else app's node) | `storage` | disk reservation only |
| Cloud shell | `cloud-shells.ts:220`, `pickNode` (fewest shells) | node setting (D239) | **no** (checked ad hoc in `memoryFreeMb`, `cloud-shells.ts:589`) |
| Build | pull: `builds.ts:213` `claim(nodeId)` on `can_build` nodes | `can_build` per node | **no** (2 GiB / 200 % per build, `apps/builder/src/command.ts:115`) |
| Pipeline job | pull: `pipeline-engine.ts:1262` by `runs-on` labels | labels | **no** (`podman run --memory`, outside the workload slice) |
| App job run | the app's replica 0 node (`jobs.ts:679`) | none | **no** (runs with the app's limits beside it) |
| Registry, mail, identity | operator setting (`registry.ts:309`, `email.ts:369`, `PATCH /ha/placement`) | node | **no** |
| ClickHouse, control plane | install host, not placed | none | **no** (outside the slice) |
| Studio session | the database's node | none | **no** (256 MiB cap) |

### 1.3 Accounting gaps

- **Scattered sums.** `WorkloadService.reservedByNode` (`workloads.ts:2777`) adds workloads, spread copies, then
  calls `reservedByNode()` on databases, storage, brokers and Kubernetes. `reservedCpuByNode` (`workloads.ts:2732`)
  covers only workloads, copies, databases and storage. Each new kind has to remember to join both.
- **Inconsistent status filters.** Database and storage memory count active rows; their CPU counts every
  non-deleted row.
- **Disk.** Tier admission (`disks.ts:1028`) subtracts the request from live free bytes but not other reservations
  on the same disk; only app volumes subtract reserved bytes (`app-volumes.ts:728`). Database `storageMb` is a
  budget, never a filesystem limit.
- **Unreserved work.** Cloud shells, builds, pipeline jobs, job runs, studio sessions, the registry (256 MiB),
  mail, identity (256 MiB) and ClickHouse (768 MiB) all use memory that admission does not see.
- **Quota vs node.** `QuotaService.reservedMemoryMb` (`quota.ts:605`) is a second, different sum: it counts
  Kubernetes org-wide only and leaves cloud shells out.

### 1.4 What the node enforces

- One `yoal-workloads.slice` with `MemoryMax=<sliceMemoryMb>M` and `CPUWeight=<sliceCpuWeight>`
  (`apps/helper/src/units.ts:221`). Platform services sit outside it.
- Every workload unit gets `MemoryMax` and `CPUQuota` and nothing else (`units.ts:476`, `970`, `1268`, …).
  Kubernetes machines add `TasksMax=8192`.
- **Not set anywhere:** `MemoryLow`/`MemoryMin` (no guarantees), `MemoryHigh`, `MemorySwapMax`, `AllowedCPUs`,
  per-unit `CPUWeight`, `IOWeight`/IO bandwidth limits, `TasksMax` for normal workloads, device access of any kind
  (process units have `PrivateDevices=yes`; the only `--device` is `/dev/fuse` for pipeline builds).
- **GPU** is detection only (`apps/agent/src/hardware.ts:111–137`: name, memory, PCI id; no UUID).
- **Postgres** gets no memory tuning: `shared_buffers` and `effective_cache_size` are never set, though every other
  engine derives its cache from `memoryMb` (`units.ts:1080–1135`).
- **Usage** is `MemoryCurrent` and `CPUUsageNSec` per unit, every heartbeat (`systemd.ts:3383`), kept as the latest
  smoothed sample in `workload_usage` (D220, D222).

### 1.5 Who can see it

Nodes, the Fleet page, Topology and Settings → Storage are platform-only (`platform:read`, `platform:nodes`).
Org members cannot see nodes, with one leak: `KubernetesService.capableNodes()` (`kubernetes.ts:174`) returns node
ids, names and `dedicatedTo` to anyone with `kubernetes:read` (`GET /api/v1/kubernetes/nodes`). §10.5 fixes it.

---

## 2. Goals and non-goals

**Goals.**

- Answer two questions on one screen each: "what is on this node, and who owns it?" and "where does this
  project (or database) run, and what does it hold?".
- Let a platform admin give hardware to a tenant in three strengths: **dedicated** (whole nodes, nothing else
  there), **guaranteed** (an amount of a shared pool held for them), **capped** (a quota, as today).
- Make every kind of work that uses a node's memory, CPU, disk or devices visible to admission, including builds,
  pipelines, shells and Yoal's own services.
- Hand GPUs and whole cores to one workload at a time, and refuse rather than silently share.
- Keep one placement path, one refusal format and one set of surfaces for every kind.
- Keep the v2 seams: `RuntimeDriver`, the fixed helper verbs (D43), pull reconciliation (D23).

**Non-goals.**

- Billing. Showback stays in units (QUOTAS.md); an optional price per pool is a later display, never an invoice.
- A general scheduler (Kubernetes, Nomad). Placement stays a deploy-time choice with recorded nodes (D214).
- Fractional GPUs (MIG, time-slicing), NUMA placement and SR-IOV in the first cut. They are named in §8 so the
  model leaves room for them.
- Live resizing of a running workload's limits without a restart. A changed vector restarts the unit, as
  `memoryMb` does today.
- Provisioning hardware. Pools group nodes that already joined.

---

## 3. Vocabulary

| Term | Meaning |
|---|---|
| **Dimension** | One kind of capacity: `memory` (MiB), `cpu` (millicores), `disk` (bytes on one disk), `gpu` (whole devices), `cores` (dedicated whole cores). |
| **Vector** | A set of amounts across dimensions: what a resource asks for. |
| **Claim** | One row in the ledger: a consumer holds a vector on one node. |
| **Consumer** | Whatever holds a claim: an app copy, a database, a build, `platform:caddy`, … Identified by `(kind, id, copy)`. |
| **Owner** | The org and, where there is one, the project that a claim is charged to. Platform claims have owner `platform`. |
| **Pool** | A named set of nodes. Every node is in exactly one. |
| **Shared pool** | Any owner may place there, subject to grants and quotas. `default` is shared. |
| **Dedicated pool** | Only its owner (one org, or one project) may place there. |
| **Grant** | A guaranteed amount of one shared pool for one org or project, with an optional limit. |
| **Quota** | A fleet-wide ceiling for an org or project. Reserves nothing. Unchanged from QUOTAS.md. |
| **Placement policy** | A `PlacementSpec` plus a pool, set on an org, project, environment or resource and inherited downwards. |

---

## 4. The capacity ledger

### 4.1 Model (RA1)

```text
capacity_claims
  id              clm_<hex>
  node_id         the node that holds it (NOT NULL)
  consumer_kind   workload | workload_copy | database | database_replica | storage | broker | app_volume
                  | k8s_machine | cloud_shell | build | pipeline_job | job_run | studio | registry | mail
                  | identity | platform
  consumer_id     the row id of the consumer (`platform` claims use the service name: caddy, control, clickhouse …)
  copy_index      0 unless the consumer has copies
  org_id          NULL for platform claims
  project_id      NULL for org-level resources (databases, storage, brokers) and platform claims
  pool_id         the node's pool when the claim was made
  grant_id        the grant this claim is charged to, if any
  memory_mb       integer ≥ 0
  cpu_millis      integer ≥ 0
  disk_id         NULL = the node's system disk
  disk_bytes      integer ≥ 0
  cores_json      dedicated core ids, e.g. [2,3]  (RA10)
  devices_json    device ids from node_devices     (RA11)
  io_weight       1–10000, NULL = default          (RA12)
  state           pending | held | releasing
  transient       0 | 1  (builds, pipeline jobs, job runs, studio: released when the run ends)
  created_at, updated_at, released_at
  UNIQUE (consumer_kind, consumer_id, copy_index) WHERE released_at IS NULL
```

`capacity_claims` is the only answer to "how much of node N is reserved". `CapacityService` owns it:

- `reserve(request) → Claim | PlacementRefusal` admits and writes in one `BEGIN IMMEDIATE` transaction, so two
  control-plane requests can never both take the last 512 MiB.
- `move(claimId, nodeId)` re-admits on the target and moves the row (one path for drain, failover, rebalance and
  operator moves, as D214 already has for copies).
- `resize(claimId, vector)` re-admits the difference on the same node (memory or disk grow, scale of CPU).
- `release(claimId)` marks it `releasing` and drops it when the node stops reporting the consumer, so capacity is
  not handed out while the old unit still runs.
- `byNode()`, `byOwner()`, `byPool()` are the read models the surfaces and quotas use.

Status rules are uniform: a claim counts from `pending` until it is released. That replaces today's mix of
`pending/starting/running` for workloads, "active" for database memory and "not deleted" for database CPU.

**Why a table and not a view.** A view over the resource tables is what exists today, and it is how the gaps in
§1.3 crept in: each kind computes its own sum. A table means every kind must write a claim to run at all, the
desired-state builder can refuse to render a consumer without one, and drift is measurable (§4.5).

### 4.2 The vector (RA2)

Every kind maps its own fields to a vector. Nothing about a kind's API changes; the mapping is internal.

| Kind | memory | cpu | disk | devices / cores |
|---|---|---|---|---|
| App copy, function, compose, runner pool | `memoryMb` (per copy) | `cpus × 1000` | data dir or app volume via its own claim | `gpus`, `cpuPolicy` (§8) |
| Database primary / replica | `memoryMb` + pooler 32 (when on) | `cpus × 1000` | `storageMb` on its disk | `cpuPolicy` |
| Object storage | `memoryMb` | `cpus × 1000` | `storageMb` on its disk | — |
| Broker | `memoryMb` | `cpus × 1000` (today 0) | `storageMb` | — |
| App volume | 0 | 0 | `sizeMb` on its disk | — |
| Kubernetes machine | `memoryMb` | `cpus × 1000` (today 0) | 10 GiB per machine on its disk | `gpus` later |
| Cloud shell | `memoryMb` (D239) | `cpus × 1000` | home `diskMb` on its node (today unreserved) | — |
| Build | `buildMemoryMb` of the node (default 2048) | `buildCpuMillis` (default 2000) | build scratch estimate | — |
| Pipeline job | the job's `memoryMb` | `cpus × 1000` | workspace estimate | `gpus` via `runs-on` (§8.2) |
| Job run | the app's `memoryMb` | the app's `cpus` | 0 | inherits the app's devices? **No**: a job run gets none (§8.2) |
| Studio session | 256 | 250 | 0 | — |
| Registry, mail, identity | their configured memory | their CPU quota | their data | — |
| `platform:*` | §4.4 | §4.4 | §4.4 | — |

CPU stays a reservation of `cpus × 1000` against `hardware.cores × 1000` (or `cpu_budget_millis`), with the D214
overcommit percentage. Memory stays a reservation against `slice_memory_mb` with its overcommit. Nothing here
changes the maths; it changes how many things are in the sum.

### 4.3 Transient claims

Builds, pipeline jobs, job runs and studio sessions are short and pulled by the node, not pushed. They get
**transient** claims:

- A node's builder (or pipeline runner) calls `claim` as today; the control plane then calls
  `CapacityService.reserve` for that node before handing the work out. If it does not fit, the work stays queued
  and the next node that asks may take it. Nothing fails for lack of room; it waits, with the reason on the build.
- The claim is released when the result arrives, or by the existing lease sweep when the run is lost.
- Builds move into their own **`yoal-builds.slice`** (§9.1) with `MemoryMax` equal to the node's build budget,
  so a build can no longer take memory that admission promised to a database. Pipeline containers (today a bare
  `podman run` outside every slice, `apps/helper/src/pipeline-jobs.ts`) move into `yoal-pipelines.slice`.

A node's build budget is a standing claim of kind `platform` named `build-budget`, sized `buildMemoryMb ×
buildConcurrency`, only on `can_build` nodes. Transient build claims draw from it rather than from the workload
budget, so turning on `can_build` visibly costs capacity, and a busy build node does not refuse deploys.

### 4.4 Platform claims

Yoal's own services are written as claims too, so a node's map adds up to its hardware:

| Claim | Where | Size |
|---|---|---|
| `platform:os` | every node | `memoryBytes − sliceMemoryMb − other platform claims` (derived, shown, not admitted) |
| `platform:agent`, `platform:helper`, `platform:caddy` | every node | 50, 10, 50 MiB (CLUSTERING §3.8) |
| `platform:control` | control nodes | 350 MiB (the standby's reservation, §6.1) |
| `platform:clickhouse` | where telemetry runs | `YOAL_CLICKHOUSE_MEMORY_MB` (768) |
| `platform:identity`, `platform:registry`, `platform:mail` | their node | 256, 256, mail's limit |
| `platform:build-budget` | `can_build` nodes | §4.3 |

Platform claims live outside `slice_memory_mb` and are not admitted against it; they explain where the rest of the
host's memory goes, and they let the Capacity page suggest a slice size ("this node has 3.1 GB the slice could
use"). They do count against the host for the memory-pressure rule (D222).

### 4.5 Drift

The node already reports every unit it runs. Each heartbeat the control plane compares that list with the node's
live claims:

- **Unit without a claim** (an older control plane placed it, or a bug): a `capacity` warning naming the unit.
  After A2 the desired-state builder refuses to render a consumer without a claim, so this only covers the move.
- **Claim without a unit** for longer than the start timeout: shown as `held, not running`. It still counts,
  because the unit may be starting, failed or restarting.
- **Measured over reserved**: already advised by D222 ("raise"); the Capacity page shows the same marker.

### 4.6 Migration

Migration `01xx_capacity.sql` creates the table. A backfill builds claims from today's tables using exactly the
current sums (so the numbers match on day one), then fills the gaps (cloud shells, CPU for brokers, Kubernetes and
replicas, platform claims). During A1 the ledger is written beside the old code and every admission compares the two
answers and logs any difference; A2 switches reads to the ledger and deletes the per-service `reservedByNode`.

---

## 5. Node pools

### 5.1 Model (RA3)

```text
node_pools
  id, name                    `[a-z0-9-]{1,32}`, unique; `default` always exists and cannot be deleted
  mode                        shared | dedicated
  owner_org_id                dedicated: the owning org; NULL for shared
  owner_project_id            dedicated to one project (implies owner_org_id); NULL otherwise
  access                      shared only: `all` | `listed` (orgs in node_pool_access)
  overflow                    dedicated only: none | shared   (may its owner spill into shared pools?)
  failover_reserve            none | largest-node (default) | <percent>
  description, created_at, updated_at
node_pool_access   (pool_id, org_id)        shared pools with access = listed
nodes.pool_id      NOT NULL DEFAULT 'pool_default'
```

**One pool per node.** A pool is a capacity boundary: the sum of its nodes is what grants divide and what failover
must absorb. If a node could sit in two pools, two grants could promise the same gigabyte. Overlapping groupings
that do not promise capacity stay what they are today: zones (failure domains), regions, roles and labels. Nomad
made the same choice for node pools (one per node, metadata for the rest).

**Shared pools with listed access** let a platform admin keep a pool for a few orgs without dedicating it to one:
`cloud` open to all, `home` only for the owner's own org, for example.

### 5.2 Dedicated pools (RA4)

A dedicated pool's nodes run only work whose owner matches:

| Owner | Who may place there |
|---|---|
| Org | Any project, database, bucket, broker, volume, cluster or shell of that org; its builds and pipeline jobs |
| Project | Only that project's workloads, jobs and volumes, and databases/buckets **attached only to it** (§5.4) |
| Platform org (bare `dedicated`) | Platform services and the platform owner's org |

Rules that make the boundary real:

- **Every kind is filtered**, including pulled work. `builds.claim(nodeId)` and the pipeline engine's claim check
  the build's org against the node's pool before handing it out. Today org A's build code can run on any
  `can_build` node.
- **No foreign platform roles.** A node in a pool dedicated to an org other than the platform's may not hold
  `ingress` or `control`, and is never a hub. An ingress node terminates TLS for every tenant and holds their
  certificates (CLUSTERING §7); a control node holds every secret. On a node an org can be root on (a `trusted`
  Kubernetes tier, D227) that would hand them everyone's traffic. `PATCH /nodes/:id` refuses the combination,
  naming the role. Mail and identity are refused there for the same reason.
- **Studio, consoles and cloud shells** of other orgs never land there.
- **`trusted` Kubernetes** (K24) becomes "a pool dedicated to the org", and the label `kubernetes=dedicated:<org>`
  is read as an alias during migration: each labelled node moves to a pool `k8s-<org8>` dedicated to that org.
  K24's "runs nothing else" is then enforced by generic placement instead of only by Kubernetes code.

### 5.3 Moving a node between pools

`PATCH /nodes/:id { pool }` is a platform admin action (session only, D129). It is refused while the node holds a
claim the target pool would not admit, with the list (as role removal is refused today, CLUSTERING §3.2). The
operator drains first; D214's moves then place each copy within its own pool. The one exception is a node moving
into a pool dedicated to the org that already owns everything on it, which is accepted at once.

### 5.4 Pools and attachments

An app and the database it uses may be in different pools. Service endpoints (C2) carry the traffic over the
overlay, so a project dedicated to the homelab can still use a database in `cloud`. The Capacity page shows the
cross-pool link, and the latency is the link's measured RTT (D216). A database in a project-dedicated pool may only
be attached to that project; attaching it elsewhere is refused with the reason.

### 5.5 Pools and HA

- `spread`, failover, drain and rebalance stay inside the claim's pool. A dedicated pool of one node caps its
  resources at `L1`, and the HA card says why.
- `failover_reserve: largest-node` (today's fleet rule, CLUSTERING §3.8) is computed **per pool**: a pool keeps
  enough unclaimed capacity to absorb its own largest node. `none` is allowed for a pool the operator accepts losing.
- `overflow: shared` lets a dedicated pool's failover place into shared pools its owner has access to when its own
  nodes cannot hold the work. Off by default, because it breaks "nothing of ours on shared hardware".

---

## 6. Grants and quotas

### 6.1 Grants (RA6)

```text
capacity_grants
  id                 grt_<hex>
  pool_id            a shared pool
  org_id             NOT NULL
  project_id         NULL = the whole org; a project grant is carved from the org's grant when one exists
  memory_mb          guaranteed
  cpu_millis         guaranteed
  disk_json          { fast?: bytes, bulk?: bytes }   guaranteed per tier
  gpus               guaranteed whole devices
  limit_json         same shape, NULL per field = may burst into the pool's unreserved capacity
  created_by, created_at, updated_at
  UNIQUE (pool_id, org_id, project_id)
```

A grant is a promise about a **pool**, not a node: "acme may always place 8 GiB in `cloud`". Admission makes the
promise good:

```
admit(request, owner, node):
 1  node fit (unchanged):   claimed(node) + request ≤ budget(node) × overcommit
 2  pool reserve:           held_for_others = Σ over grants g in pool, g.owner ≠ owner:
                                              max(0, g.amount − claimed(g))
                            claimed(pool) + request + held_for_others ≤ capacity(pool) − failover_reserve(pool)
 3  own grant limit:        if owner's grant has a limit: claimed(grant) + request ≤ limit
 4  quota (unchanged):      fleet-wide org/project caps
```

So a grant's unused part is invisible to everyone else, its owner can still use free shared capacity beyond the
grant unless the grant sets a limit, and overcommit (D214) applies to the unreserved remainder only: **the sum of
guarantees in a pool may never exceed its capacity minus its failover reserve**, and saving a grant that would
break that is refused.

A grant is aggregate, so fragmentation is real: 8 GiB across two nodes with 4 GiB free each cannot host one 6 GiB
database. The Capacity page shows "largest placeable" per grant, and a refusal says so plainly ("acme's grant has
5.5 GiB free, but no single node in `cloud` has 6 GiB"). Per-node grants are §16 Q2.

**On the node** (§9.2) a grant becomes a child slice with `MemoryLow` equal to the grant's claims on that node and
a `CPUWeight` proportional to its CPU guarantee, so a noisy shared tenant cannot reclaim a guaranteed tenant's page
cache or starve its CPU under contention.

### 6.2 Quotas (RA7)

Quotas stay fleet-wide caps, enforced where they are today (`quota.ts`), but they read the ledger, so the quota
view and node admission agree. New fields, all nullable (`-1`/NULL unlimited, existing orgs unchanged):

| Field | Unit | Replaces |
|---|---|---|
| `workloadMemoryMb` | MB reserved | existing; now counts cloud shells and Kubernetes per project too |
| `workloadCpuMillis` | millicores reserved | new |
| `gpus` | whole devices claimed | new |
| `dedicatedCores` | whole cores claimed | new |
| `fastDiskBytes`, `bulkDiskBytes` | bytes claimed per tier | split of `databaseStorageBytes`/`appVolumeBytes` for tier-aware caps; the old fields stay |
| `kubernetesClusters`, `cloudShells` | count | K-plan's `maxClusters`; shells were uncapped |

A dedicated pool's owner is usually given no compute quota at all: their own hardware is the cap.

---

## 7. Placement for every kind

### 7.1 One entry point (RA8)

`CapacityService.place(request)` replaces the per-kind choosers in §1.2. They keep their own validation and call it:

```ts
interface PlacementRequest {
  consumer: { kind: ConsumerKind; id: string; copies?: number };
  owner: { orgId: string | null; projectId: string | null };
  vector: CapacityVector;              // memory, cpu, disk (tier or disk id + bytes), gpus, cores
  spec: PlacementSpec;                 // the effective spec (§7.2): pool, node, zone, roles, labels, spread, near
  requiredCapabilities?: string[];     // `broker`, `cloud-shell`, `kubernetes-userns`, `gpu-cdi`, …
  existing?: Claim[];                  // copies that stay where they are (D218)
  mode: 'all' | 'partial';             // autoscale may place fewer copies (D220)
}
```

The filter is CLUSTERING §3.4's, with three steps added and one moved:

```
 1  candidates ← online, not draining, verified
 2  pool       ← nodes in the effective pool, or (no pool) every pool the owner may use; dedicated pools of
                 other owners are always removed
 3  node / zone / roles / labels / capabilities → drop non-matches (an explicit node pin no longer skips roles)
 4  disk       ← a ready disk of the tier or id with room after *claimed* bytes, not just live free bytes
 5  devices    ← enough free GPUs matching the selector; enough unclaimed cores for `cpuPolicy: dedicated`
 6  spread     ← as today
 7  admission  ← §6.1 steps 1–4
 8  empty → PlacementRefusal, one first-failing reason per node, now including "pool", "grant" and "gpu" reasons
```

Score is unchanged (free ratio, locality, compute-only, disk, stable hash), with grants adding one rule: among
equal nodes, prefer the one where the owner already has claims, so a grant's slices stay few.

### 7.2 Inherited policy (RA9)

```text
placement_policies
  scope_kind   org | project | environment
  scope_id
  spec_json    PlacementSpec + { pool?: string }
```

The effective spec for a resource is the resource's own spec over its environment's, over its project's, over its
org's, field by field. A field set lower down wins; `node` set anywhere is a pin. Org-level resources (databases,
buckets, brokers) take the org policy and, when created from a project page, that project's policy. Builds and
pipeline jobs take their project's pool. Cloud shells take the person's org policy unless their own setting names
a node (D239).

What this lets someone say in one place:

| Want | Setting |
|---|---|
| "Everything acme has lives on acme's nodes" | org policy `pool: acme` (dedicated) |
| "This project runs at home, its database in the cloud" | project policy `pool: home`; database created with `pool: cloud` |
| "Previews never use the cloud VPSes" | environment `preview` policy `pool: home` |
| "Builds never run on the edge" | the edge's pool has no `can_build` nodes, or the project's pool excludes it |
| "This Postgres gets the NVMe" | database `storage: <disk name>` (today) plus `cpuPolicy: dedicated, cpus: 2` |

The project's `placement` shorthand (`edge` / node / `auto`) stays as the resource-level pin, so nothing existing
changes meaning.

### 7.3 Per-kind notes

- **Static sites** are served by every ingress node from the release cache (CLUSTERING §7). They hold no compute
  claim; their release cache is a `platform` disk claim per ingress node. A pool cannot restrict static sites, and
  the project page says so.
- **Functions** keep scaling mode `node` (one node per function); the node comes from `place`.
- **Database replicas** today require an explicit node. They may now use `auto` within the primary's pool with
  `spread: node` (or the standby region rule, H26).
- **App volumes** stay on their disk's node and pin their project (VOLUMES.md); their disk claim now also counts
  against tier admission for databases on the same disk (§1.3 gap).
- **Kubernetes** machines are claims; a multi-node cluster's machines may span nodes of one pool only.
- **Jobs** run where the app runs, as today, but take a transient claim; when the node cannot admit it, the run
  waits in `queued` for up to its pickup window instead of exceeding the node.
- **Registry, mail, identity** keep their operator-chosen node; the choice is checked against pool rules (§5.2).

---

## 8. CPU cores, GPUs, disks and IO

### 8.1 Dedicated cores (RA10)

`cpuPolicy: shared | dedicated` on apps, functions (no), databases, storage, brokers and Kubernetes machines.
`dedicated` needs whole `cpus` (1, 2, …). Placement picks unclaimed core ids on the node; the claim stores them in
`cores_json`, and the helper renders `AllowedCPUs=<ids>` on the unit. Every other unit in the workload slices
loses those cores: the shared slices get `AllowedCPUs=<all minus dedicated minus reserved>`.

- A node reserves core 0 (and its SMT sibling) for the platform by default (`nodes.reserved_cores`, settable),
  as the Kubernetes static CPU manager does with `reservedSystemCPUs`.
- A node advertises `cpuset` only when its probe shows the cgroup v2 `cpuset` controller is delegated to the
  workload slices (§13 S1). Without it, `dedicated` refuses with that reason; nothing silently falls back to shared.
- Sibling threads: the first cut allocates logical CPUs in sibling pairs when SMT is on, so two tenants never share
  a physical core. NUMA alignment is later (the model stores ids, so it can).
- `cpuOvercommitPercent` never applies to dedicated cores.

### 8.2 GPUs (RA11)

**Inventory.** `hardware.ts` adds `uuid` to its `nvidia-smi` query and reports DRM render nodes with their PCI
vendor. The control plane keeps one row per device:

```text
node_devices
  id            dev_<hex>
  node_id
  kind          gpu
  vendor        nvidia | amd | intel
  model, memory_mb, pci_id, uuid
  driver_path   cdi | dri          (how the node can hand it over)
  status        ready | missing    (missing when a heartbeat stops reporting it)
  claim_id      NULL = free
```

**Request.** `gpus: { count: 1, vendor?: 'nvidia', model?: string, minMemoryMb?: number }` on apps (container and
process), Kubernetes machines and pipeline jobs (`runs-on: [gpu]` or a `resources.gpus` key). Functions, compose,
static sites, databases and shells do not take GPUs. A GPU request always pins the copy to its node; a GPU
workload with more copies spreads one per GPU node.

**Hand-over.** The helper takes the device id from desired state and resolves it from its own inventory, never a
path from the wire (D43):

| Runtime | NVIDIA | AMD / Intel (`/dev/dri`) |
|---|---|---|
| Container (Quadlet) | `AddDevice=nvidia.com/gpu=<uuid>` through CDI (the node must have `nvidia-ctk cdi generate` output; capability `gpu-cdi`) | `AddDevice=/dev/dri/renderD<n>` plus the host's `render` group (S3 settles how, under `UserNS=auto`) |
| Process unit | `PrivateDevices=no`, `DeviceAllow=/dev/nvidia<n> rw`, `/dev/nvidiactl`, `/dev/nvidia-uvm`, bind-mounted read-only driver libraries | `DeviceAllow=/dev/dri/renderD<n> rw`, `SupplementaryGroups=render` |
| Pipeline job | `--device nvidia.com/gpu=<uuid>` (CDI) | `--device /dev/dri/renderD<n>` |
| Kubernetes machine | CDI device into the k3s machine plus the NVIDIA device plugin in the cluster (later) | later |

**Failure.** A device that goes `missing` (VFIO lost after a reboot, CLUSTERING §3.7) fails its workload closed
with the reason, raises a `capacity` alert and never restarts the workload without it. Failover moves the copy only
to a node with a matching free GPU.

**Not in the first cut:** MIG partitions and time-slicing (both fit `node_devices` as child devices later), GPU
memory as a dimension, sharing one GPU between two workloads.

### 8.3 Disks (RA12)

- **Claims per disk.** Disk admission subtracts *claimed* bytes on the disk, not only live free bytes. Today two
  databases created a minute apart can both fit on the same 10 % headroom.
- **Disk ownership.** `disks.pool_id` (NULL = the node's pool). A disk may be dedicated to a narrower owner: a
  project-dedicated NVMe on a shared node ("acme's databases go on `nvme-acme`"). Only that owner's claims may use
  it; the Storage page shows the owner.
- **IO weight.** A claim may carry `ioWeight` (default 100). The helper renders `IOWeight=` on the unit and on the
  grant slice (§9.2). Absolute limits (`IOReadBandwidthMax`, `IOWriteIOPSMax`) are an opt-in per resource,
  resolved by the helper from its own disk registry to a `major:minor` device, never a path from the wire.
- **Real limits.** Database `storageMb` stays a budget (Postgres has no per-database byte limit that does not
  break writes). App volumes and builds keep their admission numbers. An XFS project quota or loop image per app
  volume, as cloud shells have (D236), is §16 Q6.

### 8.4 Fitting the engine to its claim

A claim's memory already drives MySQL, MongoDB, Valkey, ClickHouse and NATS caches (`units.ts:1080–1135`).
Postgres does not, so a 4 GiB database runs with the 128 MB default `shared_buffers`. The helper's database profile
adds `shared_buffers = 25 %`, `effective_cache_size = 60 %`, `maintenance_work_mem = 5 %` (capped at 1 GiB) and
`work_mem` from `memoryMb ÷ max_connections`, and the same for replicas. Small, but it is the difference between
"this database has 4 GiB" and "this database uses 4 GiB".

---

## 9. Enforcement on the node

### 9.1 Slice tree (RA13)

```text
-.slice
├─ system.slice                          agent, helper, Caddy, control plane, ClickHouse (unchanged)
├─ yoal-workloads.slice                  MemoryMax=sliceMemoryMb, CPUWeight=sliceCpuWeight   (unchanged)
│  ├─ yoal-workloads-shared.slice        everything without a grant; AllowedCPUs = shared cores
│  ├─ yoal-workloads-g<grant8>.slice     one per grant with claims on this node:
│  │                                     MemoryLow = Σ claims of the grant here
│  │                                     CPUWeight = 100 × grant cpu share (min 1, max 10000)
│  │                                     IOWeight  = grant io weight
│  │                                     AllowedCPUs = shared cores
│  └─ yoal-workloads-pool.slice          on a dedicated node: the whole budget belongs to one owner, no grants
├─ yoal-builds.slice                     MemoryMax = buildMemoryMb × buildConcurrency, CPUWeight lower than workloads
└─ yoal-pipelines.slice                  MemoryMax = the node's pipeline budget
```

systemd builds the hierarchy from the dash-separated names, so `Slice=yoal-workloads-g1a2b3c4.slice` on a unit is
enough; ids carry no dash. A unit with dedicated cores keeps its own `AllowedCPUs` inside whichever slice it is in.

New fixed helper verbs (D43): `POST /v1/slices` takes the whole list `{ name, memoryLowMb?, cpuWeight?,
ioWeight?, allowedCpus? }[]` for the node and converges it (create, update, remove empty), validated like the
existing `POST /v1/slice`. Unit renderers gain `Slice=`, `AllowedCPUs=`, `IOWeight=`, device lines and
`TasksMax=` (a default of 4096 for every workload, which today only Kubernetes has) from validated desired-state
fields.

### 9.2 What each promise becomes in the kernel

| Promise | Admission (control plane) | Kernel (node) |
|---|---|---|
| Reservation (today) | `memoryMb` counted against the node | `MemoryMax` per unit (today) |
| Grant guarantee | unused part held back (§6.1) | `MemoryLow` on the grant slice; `CPUWeight` share |
| Grant limit | step 3 of §6.1 | none needed: the sum of unit `MemoryMax` already bounds it |
| Dedicated pool | pool filter | nothing else runs there |
| Dedicated cores | core ids claimed | `AllowedCPUs` on the unit; removed from every other slice |
| GPU | device claimed | CDI / `DeviceAllow` on that unit only |
| Disk | bytes claimed on the disk | mount verified (D76); IO weight; optional bandwidth caps |

`MemoryLow`, not `MemoryMin`: under real pressure the kernel may still reclaim a protected cgroup rather than OOM
the host, which is the right failure on a 4 GB VPS that also runs ingress. Protection only works if every ancestor
grants it, so `yoal-workloads.slice` gets `MemoryLow` equal to the sum of its children (§13 S1 verifies the
effective protection with `memory.events`).

### 9.3 Capability and rollout

Agents advertise `capacity-slices`, `cpuset`, `gpu-cdi`, `gpu-dri` and `io-weight` after a local probe (cgroup v2,
controllers delegated, systemd version, toolkit present). The control plane renders grant slices only to nodes with
`capacity-slices`; on older nodes the grant still holds at admission and the Capacity page marks the node "admission
only" for that grant. Device and cpuset requests are never placed on a node without the matching capability.
Unraid VMs and LXC containers often lack `cpuset` delegation, which is why it is a probe and not an assumption.

---

## 10. Surfaces

One service (`CapacityService` in `packages/core/src/capacity.ts`), every surface (D29, D81).

### 10.1 Dashboard

| Page | Who | Content |
|---|---|---|
| **Capacity** (`/capacity`, replaces the capacity card on Fleet) | platform `read` | Pools → nodes. Per node, one stacked bar per dimension (memory, CPU, disk per disk, GPUs, cores), segments coloured by owner, platform claims in grey, unreserved in white, measured use as a line over it. Per pool: capacity, guaranteed, claimed, failover reserve, largest placeable. Click a segment for its claims. Filters: org, project, kind. A **Where would this fit?** box takes a vector and shows the placement decision and every refusal without creating anything |
| **Pools** (Settings → Capacity) | platform admin, session | Create/edit pools, move nodes (with the blocking claims listed), access lists, overflow, failover reserve, grants per pool |
| **Org → Capacity** | org owner/admin, `capacity:read` | The org's pools (dedicated: node names, hardware, claims; shared: pool name only), grants with used/free/largest placeable, quotas, and the top consumers |
| **Project → Resources** | `project:read` | Every piece of the project (copies, databases, buckets, volumes, jobs, builds in flight) with node (or pool, for people who cannot see nodes), disk, GPU, cores, reserved vs measured, and the effective placement policy with where each field came from |
| Create and settings forms | as today | A **Pool** picker (pools the org may use; default from the policy), and where the kind supports it: GPUs, dedicated cores, IO weight. Refusals render the per-node list |
| Nodes, Topology, Fleet | platform | Pool column and filter; node detail gets a Devices tab (GPUs, core layout) |

### 10.2 REST

| Path | What |
|---|---|
| `GET /api/v1/capacity[?pool=&node=&org=&project=]` | The map: pools, nodes, dimensions, claims grouped by owner |
| `GET /api/v1/capacity/claims[?…]` | Raw claims, paged |
| `POST /api/v1/capacity/plan` | Dry-run placement for a vector and spec |
| `GET/POST/PATCH/DELETE /api/v1/pools[/:id]` | Pools; writes session-only (D129) |
| `GET/POST/PATCH/DELETE /api/v1/grants[/:id]` | Grants; writes session-only |
| `GET/PUT /api/v1/placement-policy?scope=org\|project:<slug>\|environment:<slug>/<env>` | Inherited policy; project and environment writes need `project:update` |
| `GET /api/v1/projects/:slug/resources` | The Resources tab |
| `GET /api/v1/orgs/current/capacity` | The org view |
| `PATCH /api/v1/nodes/:id` | gains `pool`, `reservedCores`, `buildMemoryMb`, `buildConcurrency` |
| Create bodies | gain `pool`, `gpus`, `cpuPolicy`, `ioWeight` where the kind supports them |

`GET /api/v1/nodes/capacity` stays as a compatibility view over the ledger.

### 10.3 CLI

`yoal capacity [--node|--pool|--org|--project] [--json]` (the map as a table, with bars), `yoal capacity plan
--memory 2G --cpus 2 --gpus 1 [--pool]`, `yoal pools list|create|update|delete|add-node`, `yoal grants
list|set|delete`, `yoal policy show|set --pool …` on org/project/environment, and `--pool`, `--gpus`,
`--dedicated-cpus`, `--io-weight` on `yoal db create`, `yoal storage create`, `yoal broker create`, `yoal workload
set`, `yoal k8s create`.

### 10.4 MCP and the assistant

Read-only tools: `get_capacity`, `get_project_resources`, `plan_placement` (dry run), `list_pools` (only pools the
caller may use). Create tools gain `pool` (within allowed pools) and `gpus`. **No pool, grant, node-pool or policy
writes over MCP** (D129, and the MCP surface rules in CLUSTERING §12.4); the catalogue in the docs lists the new
tools when they ship. The assistant can answer "where does the orders database run and why there?" from
`get_project_resources` and the placement reason stored on each claim.

### 10.5 IAM

| Permission | Who by default | Gates |
|---|---|---|
| `platform:capacity` (new platform permission) | platform admin, operator | pools, node pool moves, grants, reserved cores, build budget |
| `platform:read` | platform viewer and up | the full Capacity page |
| `capacity:read` (new org permission) | org owner, admin | Org → Capacity; node names only for the org's dedicated pools |
| `project:read` | as today | Resources tab, with nodes shown only when the caller may see them |
| `placementPolicy:update` (new org permission) | org owner, admin | org-level policy; project/environment policy needs `project:update` |

`KubernetesService.capableNodes()` stops returning nodes outside the caller's dedicated pools to org members; it
returns pool names and tiers instead (§1.5).

### 10.6 Alerts and audit

Alerts (`capacity` category, ALERTS.md): a grant at 80 % and 95 % of its guarantee (warning, once a day, like
quotas); a pool below its failover reserve (warning; critical when a node of it is offline); a sum of guarantees
above capacity after a node left (critical: a promise is now broken); claim drift (§4.5); a GPU `missing`; a node
advertising a capability its claims need going away.

Audit: `pool.create|update|delete`, `node.pool.set`, `grant.create|update|delete`, `placement.policy.update`,
`capacity.core.reserve`, `device.missing`.

### 10.7 Blueprints

```yaml
cluster:
  pools:                       # assertions, like `requires` today: the plan fails if they do not hold
    - name: acme
      mode: dedicated
      minNodes: 2
placement:
  pool: acme                   # project-level policy
projects:
  inference:
    runtime: container
    resources: { memoryMb: 8192, cpus: 4, cpuPolicy: dedicated, gpus: { count: 1, vendor: nvidia } }
databases:
  orders:
    pool: acme
    storage: fast
    cpuPolicy: dedicated
```

Blueprints never create pools or grants (they are platform writes); they assert them and fail the plan with the
missing piece.

---

## 11. Showback and right-sizing

- **Accrual.** The maintenance sweep integrates claims over time into `capacity_usage_daily` (org, project, pool,
  kind, day): MiB-hours, core-hours (shared and dedicated apart), GPU-hours, disk GiB-days per tier. Measured use
  from `workload_usage` sits beside reserved use. CSV from Settings → Usage and `yoal usage --capacity`.
- **Efficiency.** Per project, reserved vs peak (D222's "raise"/"lower" advice) summed: "acme reserves 12 GiB and
  peaks at 4.1 GiB".
- **Dedicated pools** show the whole pool as the owner's, whatever runs, because no one else may use it.
- **Price (later, optional).** A pool may carry a monthly price per node, shown as an apportioned figure on the
  org view. It is a display for the operator, never an invoice (QUOTAS.md: no billing).

---

## 12. Phases

| Phase | Builds | Exit |
|---|---|---|
| **A0** | Spikes S1–S5 (§13) | Each spike's question answered with numbers, on the real fleet where it needs one |
| **A1** | `capacity_claims` written beside today's code for every kind; backfill; shadow comparison; the accounting gaps of §1.3 fixed (CPU for brokers, Kubernetes, replicas; cloud shells; per-disk claimed bytes; registry/mail/identity; uniform status rules); platform claims; read-only Capacity page and `GET /capacity` | The ledger and the old sums agree for a week on prod, except for the gaps it is meant to close |
| **A2** | Ledger authoritative: `CapacityService.place/reserve/move/release` used by every chooser; `reservedByNode` deleted; transient claims for builds, pipeline jobs, job runs, studio; `yoal-builds.slice` and `yoal-pipelines.slice`; desired state refuses unclaimed consumers; drift detection | Every row in §1.2 says "yes / yes"; a build no longer exceeds a node's promises |
| **A3** | Pools: `node_pools`, `nodes.pool_id`, dedicated rules for every kind including pulled work, role restrictions, migration of `kubernetes=dedicated` labels, per-pool failover reserve and HA scope; Settings → Capacity; CLI/REST | An org's build, pipeline, shell or cluster can be shown never to land on another org's dedicated node |
| **A4** | Placement policies (org/project/environment), inherited spec, Resources tab, Org → Capacity, `capacity:read`, the Kubernetes node leak fixed, MCP read tools | "Project X on pool `home`" is one setting and every piece of X follows it |
| **A5** | Grants and the new quota fields; admission steps 2–3; grant alerts; grant slices with `MemoryLow`/`CPUWeight`/`IOWeight` on nodes with `capacity-slices` | A shared tenant's memory hog cannot push a guaranteed tenant's database out of page cache (S1 scenario rerun) |
| **A6** | Dedicated cores: probe, `reserved_cores`, core allocation, `AllowedCPUs` on units and shared slices; Postgres memory tuning (§8.4) | A dedicated-core database's p99 latency holds while a CPU-bound neighbour runs |
| **A7** | GPUs: inventory with UUIDs, `node_devices`, CDI and DRI hand-over for containers, processes and pipeline jobs, fail-closed on `missing`, GPU quota | An app on the homelab sees exactly its GPU; a second GPU app is refused, not co-scheduled |
| **A8** | Showback accrual and CSV, efficiency view, optional pool price, IO bandwidth caps, blueprint keys, assistant answers | Settings → Usage shows MiB-hours and GPU-hours per project |

A1–A2 are worth doing even if nothing after them is: they make every number on the Fleet page true.

---

## 13. Spikes

| # | Question | How | Decides |
|---|---|---|---|
| S1 | Do nested slices with `MemoryLow` protect a grant's database page cache from a shared neighbour on the edge's kernel and on the Hetzner worker, and does Quadlet's `Slice=` place Podman's `--cgroups=split` containers correctly under them? | Two slices, Postgres + pgbench in one, a `stress-ng --vm` hog in the other; read `memory.events` and pgbench TPS with and without `MemoryLow` | RA13, whether grants get kernel backing at all |
| S2 | Is the `cpuset` controller delegated to user slices on each fleet node (Scaleway VPS, Hetzner VPS, Unraid VM, `linux-box`), and does `AllowedCPUs` on a unit inside a slice with its own `AllowedCPUs` behave? | `cat /sys/fs/cgroup/cgroup.subtree_control` down the tree; a pinned `stress-ng --cpu` | RA10 availability per node |
| S3 | CDI on the homelab VM's passed-through NVIDIA GPU: rootless vs rootful Podman, `UserNS=auto` with CDI, and a process unit with `DeviceAllow` | `nvidia-ctk cdi generate`; run `nvidia-smi` in each runtime | RA11 hand-over table |
| S4 | Cost of the ledger on the admission path: `BEGIN IMMEDIATE` reserve under a 50-deploy burst, and the shadow comparison's overhead | Bench against a copy of the prod SQLite | RA1 transaction shape |
| S5 | Do builds still finish within their timeout inside `yoal-builds.slice` with a 2 GiB budget on the edge, and what does a pipeline job's real peak look like? | Replay the last 50 builds and 20 pipeline runs | RA2 defaults for build and pipeline vectors |

---

## 14. Proposals

| # | Proposal | Section |
|---|---|---|
| RA1 | One `capacity_claims` ledger is the only source of reserved capacity; every consumer, including platform services and short runs, holds a claim | §4 |
| RA2 | Resources are a vector (memory, CPU, disk bytes on a disk, devices, cores); every kind declares all dimensions | §4.2 |
| RA3 | Every node is in exactly one pool; `default` is shared and always exists | §5.1 |
| RA4 | A dedicated pool runs only its owner's work, pulled work included, and its nodes cannot hold `ingress`, `control`, hub, mail or identity for others; it replaces `kubernetes=dedicated` | §5.2 |
| RA5 | Spread, failover, rebalance and the failover reserve stay within a pool; overflow to shared is opt-in | §5.5 |
| RA6 | Grants guarantee an amount of a shared pool; unused guarantees are held back at admission; guarantees never exceed capacity minus reserve | §6.1 |
| RA7 | Quotas stay fleet-wide caps, read the ledger, and gain CPU, GPU, core, per-tier disk, cluster and shell fields | §6.2 |
| RA8 | One `CapacityService.place` for every kind, with the pool, disk-claim and device steps added to CLUSTERING §3.4's filter | §7.1 |
| RA9 | Placement policy is inherited org → project → environment → resource, field by field | §7.2 |
| RA10 | Dedicated cores through `AllowedCPUs`, allocated in sibling pairs, behind a `cpuset` probe; never overcommitted | §8.1 |
| RA11 | Whole GPUs claimed per workload, handed over through CDI or `/dev/dri`, failing closed when missing | §8.2 |
| RA12 | Disk admission subtracts claimed bytes; disks may be dedicated to an owner; IO weight per claim | §8.3 |
| RA13 | Grants and pools become a slice tree under `yoal-workloads.slice` with `MemoryLow`, `CPUWeight`, `IOWeight` and `AllowedCPUs`; builds and pipelines get their own slices | §9 |
| RA14 | A Capacity page, an org view and a project Resources tab show the same ledger; MCP gets read tools only | §10 |
| RA15 | `platform:capacity`, `capacity:read` and `placementPolicy:update`; org members see node names only for their own dedicated pools | §10.5 |
| RA16 | Claims accrue into daily showback in units; price is an optional display | §11 |

---

## 15. Alternatives considered

| Alternative | Why not |
|---|---|
| Labels and selectors only (today's `kubernetes=dedicated:<org>`, generalised) | A label says where something *may* go; it cannot stop anything else going there, and it cannot reserve capacity. It is also how K24 ended up enforced only by Kubernetes code |
| Kubernetes-style taints and tolerations | A general mechanism whose common use is exactly "dedicated to X". Pools say that directly, and nobody has to learn toleration semantics to read the Capacity page |
| Nodes in several pools (OpenStack host aggregates) | Two grants could promise the same memory; zones, regions and labels already cover overlapping groupings that make no promise |
| OpenStack Placement's full model (resource providers, inventories, traits, nested providers) | The right shape for thousands of hosts. Yoal borrows its vocabulary (inventory → the node's budget, allocation → claim, trait → capability) but a separate service and API would be a second scheduler |
| Keep summing per kind, just add the missing kinds | The gaps in §1.3 come from exactly that; the next kind would forget too, and drift could not be measured |
| Per-node grants only | Simplest to enforce, but an org's apps would be pinned to nodes they never chose, and failover could not keep a grant whole. Kept as §16 Q2 |
| Grants as hard cgroup limits per tenant (`MemoryMax` on the grant slice) | A limit is a quota, which already exists; the promise people want is a floor. Unit `MemoryMax` already bounds the sum |
| A VM or microVM per tenant | The real isolation boundary for hostile tenants, and `vm` is reserved in K18 for that. No fleet node has `/dev/kvm` today; pools are what makes per-tenant hardware possible now and a VM tier later |
| Fractional GPUs first | MIG needs A100-class cards and time-slicing gives no isolation; whole devices match the hardware in the fleet |
| Measured-usage placement (bin-packing on actual use) | D222 kept reservations as the admission rule on purpose; measured use advises. This plan keeps that and makes reservations complete |

---

## 16. Risks and open questions

**Risks.**

- **Fragmentation.** Aggregate grants can be "free" but unplaceable. Mitigated by "largest placeable" everywhere
  and a plain refusal; a defragmenting rebalance within a pool is the follow-up.
- **Admission becomes stricter.** Counting builds, shells and platform services means some prod nodes will show
  less free memory than today, and a deploy that fits today may be refused after A2. A1's shadow period measures
  this before anything changes, and the edge's slice may need raising (CLUSTERING §3.6 already calls the 1 GiB
  default the binding constraint).
- **Kernel features vary across the fleet** (§9.3). Capability probes keep it honest, at the cost of "admission
  only" grants on some nodes.
- **Two ways to say "this node"** (a project's `placement` pin and a policy's pool) can conflict. The rule is that a
  pin must satisfy the pool; a pin into a pool the owner may not use is a refusal, not an override.
- **Migration of the Kubernetes label** touches live `trusted` clusters. It must be a no-op move (same nodes, same
  owner), tested on a copy of prod first.

**Open questions, with a recommendation each.**

| # | Question | Recommendation |
|---|---|---|
| Q1 | One pool per node, or overlapping pools? | One (§5.1). Overlap belongs to labels, zones and regions |
| Q2 | Are grants aggregate per pool, or per node? | Aggregate first; add optional `nodeId` on a grant later for strict cases |
| Q3 | May guarantees overcommit a pool? | No. Overcommit applies to the unreserved remainder only |
| Q4 | May a dedicated node be an ingress? | Only when the pool belongs to the platform org (§5.2) |
| Q5 | Should org members see node names? | Yes, for their own dedicated pools; pool names only otherwise |
| Q6 | Real disk limits for app volumes (loop image or XFS project quota, as D236 did for shells)? | Out of scope here; worth its own decision, because a reservation that is not a limit is the weakest promise left |
| Q7 | Project-dedicated pools, or org only? | Both: a homelab owner wants "the media project owns the homelab", a multi-tenant install wants per-org |
| Q8 | Do platform claims count against the workload slice? | No: they explain the host (§4.4); the slice stays the operator's number |
| Q9 | Should builds default to the project's pool or to any build node? | The project's pool when it has a `can_build` node, else shared builders, unless the project is in a dedicated pool, where builds never leave it |
| Q10 | Size presets ("small = 512 MiB / 0.5 CPU")? | Later, as operator-defined names over the vector; nothing in the model depends on them |

### Worked example: this fleet

Illustrative only: where `cutcraft` and `cairn` run today is unchanged until someone sets a policy.

| Pool | Mode | Nodes | Use |
|---|---|---|---|
| `cloud` | shared, all orgs | `edge` (Scaleway), `edge-b` (Hetzner) | Ingress, control, small critical apps, database primaries; grant: the owner's org 1.5 GiB |
| `home` | dedicated to the owner's org, overflow none | `homelab` (Unraid VM), `linux-box` | Heavy apps, bulk storage, builds, the GPU; `cutcraft` and `cairn` set `pool: home` at project level |

`cairn`'s Postgres is created with `pool: cloud, storage: fast, cpuPolicy: shared`; `cairn` itself runs at home and
reaches it over its service endpoint. An inference project asks `gpus: { count: 1 }` and lands on `homelab`
because it is the only node with a free NVIDIA device. A second GPU project is refused with "homelab: GPU 0 is held
by inference". Builds for everything in `home` run on `linux-box`, never on the edge. The Capacity page shows
`edge` at 860 MiB platform, 1 GiB slice with the owner's grant segment, and `homelab` with its 8 GiB slice entirely
the owner's colour.
