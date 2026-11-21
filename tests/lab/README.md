# HA lab

The four-node lab and fault harness of [HA-PLAN](../../docs/HA-PLAN.md) W1 and
[CLUSTERING](../../docs/CLUSTERING.md) §19.3. Every HA exit criterion is measured here, never on a
live fleet.

```sh
bun tests/lab/lab.ts up                     # four nodes + s3lab (timings: "Speed" below)
bun tests/lab/lab.ts up --only lab-a        # one node, plain install: the single-node gate's lab
bun tests/lab/lab.ts up --feature ENDPOINTS_GATEWAY=1 --feature RELEASE_PHASE=1   # opt-in flags on (see Feature flags)
bun tests/lab/verify-faults.ts              # every fault verb applied, checked and auto-reverted
bun tests/ha/scenarios/kill-node.ts --node lab-b --target direct   # M1 node loss (see Scenarios)
bun tests/lab/lab.ts down                   # clears faults, removes every yoal-w0-* object, checks loop devices
bun tests/lab/vm/lab-vm.ts up --only lab-a,lab-b   # the real-VM form (Lima), see "The VM form"
```

## What it is

One definition, [`lab.config.ts`](./lab.config.ts), and two forms of it.

| Node | Address | Role | Zone | What runs |
|---|---|---|---|---|
| `lab-a` | 172.30.147.11 | control | `cloud-a` | Full install: control plane, edge agent, Caddy, helper; overlay hub |
| `lab-b` | 172.30.147.12 | worker | `cloud-b` | `install --join`: agent, helper, Caddy, Podman |
| `lab-c` | 172.30.147.13 | worker | `home` | as lab-b |
| `lab-ctl` | 172.30.147.14 | worker | `ctl` | as lab-b; reserved for later control-plane standby and injection work |
| `s3lab` | 172.30.147.20 (MinIO behind it at .21) | — | — | S3 with fault injection: the arbiter and backup target of later waves |

Every node runs the real control plane, agent and helper built from this checkout by the real
installer (`scripts/install/main.ts`), and the four join one fleet over the managed WireGuard
overlay (10.47.0.0/22). The helper on every node is then replaced by its fault-injection test build
(`bun run --cwd apps/helper build:faults`, entry `apps/helper/src/main-faults.ts`) through a lab-only
systemd drop-in.

**The container form** (this directory; what CI runs). Each node is a Debian 13 container with
systemd as PID 1, privileged, with a private cgroup v2 namespace, on the `yoal-w0-net` bridge. Lab
images, containers, volumes and the network are all named `yoal-w0-*` and labelled `yoal-w0=lab`;
`lab down` removes only those (and the MinIO image only if `lab up` pulled it).

Built and verified on OrbStack (Docker 29, arm64, kernel 7.2) on macOS; `ha-integration` runs the
same on `ubuntu-24.04`. OrbStack did not need the Lima fallback: systemd, nftables, `tc netem`,
WireGuard, loop devices and nested Podman all work in a privileged container. One adjustment is
baked into [`node.Dockerfile`](./node.Dockerfile):

- `/` is made `rshared` before `sysinit.target`. Docker starts containers with private mount
  propagation, and systemd 257 mounts each unit's credentials in a child namespace; without this the
  control plane cannot read its sealed master key (`LoadCredentialEncrypted=`). Still needed: it is a
  property of running systemd in a Docker container, not of the installer.

Wave 0 also pre-wrote the installer's bootstrap Caddyfile into the image, because the installer
kept the package's stock file (admin API on TCP) when Caddy was preinstalled. Since F12
(`ha/w1-fixes`, `scripts/install/caddyfile.ts`) the installer writes its own file in that case too,
so the image no longer carries one; a lab built without F12 cannot drive Caddy.

**Joining.** `install --join` refuses a control URL that is not `https`, and the lab has no domain or
ACME. `lab up` runs [`node/tls-front.ts`](./node/tls-front.ts) on lab-a for the duration of the
joins: a lab CA, a certificate for 172.30.147.11, and a forwarder from `:8443` to the platform.
Workers trust the CA for the join only (`NODE_EXTRA_CA_CERTS`); the agents then use the platform's
own `http://172.30.147.11` origin.

**Reaching the lab.** The host does not need to route to 172.30.147.0/24 (OrbStack does not): each
node's `:80` is published on `127.0.0.1:47080`–`47083`, and the lab's scripts call the platform at
`http://127.0.0.1:47080` with `Host: 172.30.147.11`. s3lab is on `127.0.0.1:47900` (S3) and
`127.0.0.1:47901` (control). Platform-admin calls that refuse API keys go through
[`node/bootstrap.ts`](./node/bootstrap.ts) on lab-a, which signs the lab's throwaway owner in.

## Commands

```sh
bun tests/lab/lab.ts up [--only lab-a[,lab-b…]] [--upgrade] [--no-faults] [--feature NAME=0|1 …]
bun tests/lab/lab.ts status [--json]
bun tests/lab/lab.ts fault <node|all> <verb> [flags] [--observe obs.jsonl]
bun tests/lab/lab.ts fault <node|all> list | revert <id> | clear-all
bun tests/lab/lab.ts s3 rules | add '<rule json>' | clear | log [n]
bun tests/lab/lab.ts kill|stop|start <node>        # kill = power off (docker kill)
bun tests/lab/lab.ts exec <node> -- <argv…>
bun tests/lab/lab.ts logs <node> [unit]
bun tests/lab/lab.ts api <METHOD> <path> [json]
bun tests/lab/lab.ts down [--keep-image]
```

`down` first runs `clear-all` on every running node (so the helper, not a container teardown, undoes
each fault), then removes the lab's objects, then lists the Docker host's loop devices from a
throwaway privileged container of the lab image and fails if any is still backed by a lab fault disk.

`--upgrade` re-runs the installer on lab-a from the current checkout. Workers keep the agent and
helper they joined with; rebuild them with `down` and `up`.

`--only lab-a` brings up the control node alone, as a plain single-node install: no overlay
adoption, no cluster settings (failover stays off). A later `lab up` without `--only` joins the
workers and turns the cluster settings on, as an operator adding machines would; that is the order
`ha-integration` runs in (single-node gate first). Every `up` writes its phase timings to
`.out/up-timings.json`.

## Feature flags

`--feature NAME=VALUE` (repeatable; `NAME` from `packages/contracts/src/features.ts`, `VALUE` 0, 1,
true or false) sets `YOAL_FEATURE_<NAME>` on every node through the files the installer wrote:
`/etc/yoal/yoal.env` on lab-a (the control plane reads it) and `/etc/yoal/agent.env` on every node.
An existing line is replaced and a missing one appended; the installer keeps both across re-runs and
`--upgrade`. A unit whose file changed is restarted (`yoal-control-plane`, `yoal-agent`), and `up`
then waits until `GET /api/setup/status` reports every flag as asked, or fails.

The flags are kept in `.state/lab.json`, so a later `up` (growing a one-node lab, say) renders them
onto new nodes without repeating them; `--feature NAME=0` turns one back off. `status` shows what
was asked and whether the platform agrees. Scenarios never trust the file: they read the platform's
resolved flags. The single-node gate runs with every opt-in flag off, so bring its lab up without
`--feature`. The VM form (`vm/lab-vm.ts`) takes no `--feature` yet.

## Fault verbs

Fixed helper verbs in [`apps/helper/src/faults.ts`](../../apps/helper/src/faults.ts), reached on the
helper's root-only socket at `/v1/faults/*`. Only the test entry point
[`main-faults.ts`](../../apps/helper/src/main-faults.ts) imports them (`build:faults`); the release
entry `main.ts` (`build`, which the installer, `publish.yml` and node updates use) and the router
`server.ts` never mention them, so no define, preload or global can switch them on in a release
binary. [`faults-release.test.ts`](../../apps/helper/src/faults-release.test.ts) builds the release
entry with and without `--define YOAL_FAULT_INJECTION=true` and fails if any fault string survives.

Every verb takes structured fields only (CIDRs, an interface that exists, a unit from an allowlist,
bounded numbers), never a shell string; every verb that changes state has a required `durationS`
(1–3600) after which it reverts itself; `clear-all` reverts everything; a helper that starts sweeps
whatever an earlier process left (nft tables `yoal_fault_*`, qdisc handle `fa17:`, clock drop-ins,
scratch loop disks, and the faults recorded in `/run/yoal-faults/active.json`).

A fault is recorded (`status: applying`) before its first change, so a crash part-way is still found.
An apply that fails part-way is rolled back (clock-skew: drop-in removed, offset `+0`, unit restarted
clean). A revert checks its result (the nft table or qdisc is really gone, the loop device detached);
one that fails leaves the fault listed as `revert-failed` and retries it after 1, 2, 4 … 60 s, and
`revert`/`clear-all` answer 409 naming it.

| Verb | `lab fault` flags | What it does | Revert |
|---|---|---|---|
| `partition` | `--peers lab-a,s3lab --direction in\|out\|both` | One nftables table: drop input/output/forward to and from the peers' underlay and overlay addresses | Delete the table |
| `netem` | `--device eth0 --delay 200 --jitter 20 --loss 5 [--peers lab-a]` | `tc netem` on egress; with peers, a prio qdisc steers only their traffic through it | Delete the root qdisc `fa17:` |
| `clock-skew` | `--unit yoal-agent.service --offset 60` | libfaketime on one unit: a runtime drop-in sets `LD_PRELOAD` and an offset file (re-read every second), then the unit restarts | Offset `+0` at once, drop-in removed, no restart |
| `freeze` | `--unit yoal-agent.service` | `SIGSTOP` to every process of the unit | `SIGCONT` |
| `kill-unit` | `--unit caddy.service [--signal KILL\|TERM] [--mode stop]` | `SIGKILL` to the unit (systemd's `Restart=` decides what happens), or `stop` | `stop` mode: start again |
| `fill-disk` | `[--size 64] [--path <loop-backed dir>] [--leave-kb 0]` | A fresh loopback ext4 of `--size` MiB (≤1 GiB, `mount -o loop`, so the loop device autoclears), filled with `fallocate`; or, with `--path`, at most `--size` MiB on an existing loop mount whose backing file is under the node's data roots (same inode as this node sees). At most 4 fills and 2 GiB in total | Remove the fill; unmount the scratch disk and check its loop device is gone |
| `block-arbiter` | `[--action drop\|reject]` | Drop or reset TCP to s3lab | Delete the table |
| `pause-heartbeat` | `[--endpoint <ip>:<port>]` | Drop the agent user's (`meta skuid yoal`) TCP to the control plane: by default the address and port of the agent's own `YOAL_CONTROL_URL` (`/etc/yoal/yoal.env` then `agent.env`, or `node.json`); Caddy, workloads and the forwarder keep serving | Delete the table |

Units are `yoal-agent`, `yoal-control-plane`, `yoal-control-plane-standby`, `yoal-builder`,
`yoal-caddy`, `caddy` and `yoal-workload-<id>`; never `yoal-helper` (a frozen helper could not
revert anything).

**Clock skew, and why libfaketime.** The lab's nodes share one kernel (the Docker VM's), so the
system clock cannot be skewed per node, and must never be stepped: it is the host's. A time
namespace offsets only `CLOCK_MONOTONIC` and `CLOCK_BOOTTIME`, not wall time, so it cannot fake a
skewed clock. libfaketime intercepts `clock_gettime`/`gettimeofday` in one process (Bun included;
`verify-faults.ts` checks the agent's own log clock against journald's), and the file-based offset
lets a scenario step the clock during a lease without a restart. It cannot fake a skewed kernel: the
kernel's timers, TLS validity checks in other processes and the journal keep real time. On the VM
form, a whole-VM skew is the alternative (`chronyd` off, `date -s`).

## s3lab

[`s3lab/proxy.ts`](./s3lab/proxy.ts) forwards to MinIO RELEASE.2025-09-07T16-13-09Z (pinned by
digest; MinIO no longer publishes release tags) and keeps the client's `Host`, so SigV4 still
verifies and MinIO's own `If-Match`/`If-None-Match` CAS answers pass through. Rules inject:

```sh
bun tests/lab/lab.ts s3 add '{"match":{"method":"PUT","conditional":true},"action":{"status":412},"count":3}'
bun tests/lab/lab.ts s3 add '{"match":{"keyPrefix":"yoal/ha/"},"action":{"delayMs":5000},"durationS":60}'
bun tests/lab/lab.ts s3 add '{"match":{"method":"GET"},"action":{"stale":true},"probability":0.5}'
bun tests/lab/lab.ts s3 add '{"action":{"status":501}}'       # 409, 412, 500, 501, 502, 503, 504
bun tests/lab/lab.ts s3 clear
```

A stale read serves the object's previous version with its old ETag. "Unreachable" is the
`block-arbiter` verb on a node, not an s3lab rule.

## Scenarios and the checker

The scenarios live in [`tests/ha/scenarios/`](../ha/scenarios/) and are documented in
[tests/ha/README.md](../ha/README.md#scenarios): `single-node-gate`, `kill-node` (and its
`kill-node-b` alias), `freeze-agent`, `attachments-three-nodes` and `rolling-deploy-under-load`,
on a shared library (`tests/ha/scenarios/lib/`). Each writes `scenario.json`, `summary.md` and the
checker's `report.json` into `tests/lab/.out/<scenario>-<time>/` with a verdict: pass, fail,
invalid, skip or error.

## The VM form

[`vm/lab-vm.ts`](./vm/lab-vm.ts) builds the same lab from [`vm/lab-node.lima.yaml`](./vm/lab-node.lima.yaml):
one Lima VM per node (Debian 13, VZ), named `yoal-w1-lab-a` … `yoal-w1-lab-ctl`, with each node's
CPUs and memory from `lab.config.ts`, the same installer flags, the same bootstrap, TLS-front join and
fault-injection helper. Differences: addresses come from Lima's `user-v2` network (192.168.104.0/24)
instead of 172.30.147.0/24; each node has its own kernel, clock, WireGuard and nftables; losing a
node is a real VM stop (`limactl stop -f`); every guest port forward is disabled, so nothing binds on
the host; there is no s3lab yet.

```sh
bun tests/lab/vm/lab-vm.ts up [--only lab-a,lab-b]          # default: all four
bun tests/lab/vm/lab-vm.ts status
bun tests/lab/vm/lab-vm.ts fault lab-b partition --peers lab-a --duration 60   # checks it from inside
bun tests/lab/vm/lab-vm.ts fault lab-b freeze --unit yoal-agent.service --duration 60
bun tests/lab/vm/lab-vm.ts fault lab-b clear-all
bun tests/lab/vm/lab-vm.ts kill lab-b && bun tests/lab/vm/lab-vm.ts start lab-b
bun tests/lab/vm/lab-vm.ts down                              # deletes every yoal-w1-lab-* VM
```

The scenarios run on the container form only (they drive nodes with `docker exec`); the VM form is
for the node-loss and kernel-level faults the container form cannot fake. Timings: "Speed" below.

Verified 2026-11-20 on this Mac (Lima 2.3.0, VZ, arm64), two nodes (`--only lab-a,lab-b`, to stay
within a machine shared with other lanes): `up` 176 s (VM create and boot 98, ship 2, control
install 52, worker join 20, fault helper 4); a partition of lab-b from lab-a applied in 2 s, checked
from inside (ping to lab-a fails) and cleared; a power-off (`kill lab-b`) marked offline by the
control plane after 31 s, back online 10 s after `start`; `down` 1.4 s, no `yoal-w1-lab-*` VM left.
The Debian cloud image stays in Lima's own download cache (`~/Library/Caches/lima`).

## Speed

Measured 2026-11-20 on this Mac (OrbStack, 11 CPUs shared with other lanes; every `up` writes
`.out/up-timings.json`):

| Path | Time | Phases |
|---|---|---|
| Node image, `docker build --no-cache` (apt, Caddy, Bun) | 32 s | — |
| `up`, four nodes, from nothing (image cached, fresh volumes and Bun cache) | 62–88 s | control install 31, worker joins 23 (parallel) |
| `up --only lab-a`, from nothing | 51 s | control install 39 |
| `up` growing that one-node lab to four | 33 s | worker joins 25 |
| `up` when already up (re-ships the checkout) | 6 s | ship 2, fault helper 3 |
| `up --upgrade` (lab-a rebuilt from the tree) | 59 s | control 54 |
| `down` | 6 s | — |

`--upgrade` is far under the five minutes that would call for a faster path, so there is none. It
rebuilds lab-a only; a branch that changes the agent or helper is loaded onto every node with
`down && up` (under two minutes).

## Limits of the container form

- One kernel for all nodes: no per-node kernel clock, and a kernel panic or OOM is the host's.
- `docker kill` is a power cut of the processes, but the page cache and disks are the host's, so
  it is not a disk failure. A hypervisor stop is not a provider partition either (CLUSTERING §19.3).
- Node memory and CPU are cgroup limits, not hardware; the numbers are the lab's, not production's.
- `pause-heartbeat` on lab-a is refused: its agent reaches the control plane on a unix socket.
