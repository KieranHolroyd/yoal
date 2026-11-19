# K0 spikes: k3s machines under rootful Podman (2026-11-18)

Plan: `docs/KUBERNETES.md` §5 and §12. Scripts in this directory are the exact commands used.

## Environment and versions

| Item | Value |
|---|---|
| Host | OrbStack machine `yoal-k8s-spike` (left in place), Debian 13 trixie, **arm64** |
| Kernel | 7.2.12-orbstack (OrbStack VM kernel, shared by all OrbStack machines), cgroup v2 (`cpuset cpu io memory pids`) |
| Podman | 5.4.2 (Debian), crun 1.21, netavark 1.14.0, passt 2025-05-03, aardvark-dns, uidmap |
| iptables on host | 1.8.11 (nf_tables backend); host ruleset empty before the spikes |
| subids | `containers:2147483647:2147483648` in /etc/subuid and /etc/subgid (same as `apps/helper/src/userns.ts`) |
| k3s | `v1.37.2+k3s1` (the stable and latest channel on 2026-11-18). containerd `2.3.7-k3s1`. |
| Image | `docker.io/rancher/k3s:v1.37.2-k3s1`, index `sha256:21ea6e0fac4e3930c2ce8aa40ddd41a8b18cb3e9a0222c030dc005e7e88c4332` (arm64 `sha256:d5223fcc…6dd3`, amd64 `sha256:bc340b84540f351ae23a1cef63b93d05bab20e12318d8186d60ce127c10d2124`) |

All commands ran as root via `orb -m yoal-k8s-spike sudo …`.

## Verdicts

| Spike | Verdict | One line |
|---|---|---|
| S1 `userns` tier | **PASS** | Ready node, all system pods, Ingress through `127.0.0.1:<port>`, hostPath escape lands as host uid 2147483647. Needs a cgroup-v2 entrypoint shim. Sonobuoy `--mode quick` passed. |
| S1 `trusted` tier | **PASS** (works) | Same flags minus `--userns`. Escape writes host-uid-0 files, and the kubelet **rewrites global host sysctls**. |
| S2 memory | **PASS with flags** | Without help, capacity = host RAM (16Gi on a 2g machine). A bind-mounted `/proc/meminfo` + `system-reserved` + `eviction-hard` + `--oom-score-adj=-999` give capacity 2Gi, allocatable 1080Mi, kubelet eviction before any cgroup OOM, and k3s survives. |
| S6 firewall | **PASS** | No KUBE/flannel/CNI rules reach the host namespace in either tier. Running vs before differs only by netavark's own per-container chains; after removal the ruleset is byte-identical to before. |
| S7 SQLite snapshot/restore | **PASS** | `sqlite3 .backup` of `state.db` online + `server/token` + `server/tls` + `server/cred` restores in a new machine with a new data dir. Objects present, new node Ready, old admin kubeconfig still works. Old node lingers NotReady until deleted. |
| S5-lite structured authn | **PASS** | `--kube-apiserver-arg=authentication-config=<file>` with a JWT issuer is accepted. The API server starts even with an unreachable issuer (it retries discovery every 10s). Anonymous requests get 401 on `/api`, `/version`, `/readyz` and `/livez`. |

## The working flag sets (what the helper should render)

`machine.sh` is the reference. Per machine, with `<data>` = the machine's data root:

```
podman run -d --name <id> --hostname <id> \
  # tier userns:
  --privileged --userns=auto:size=65536 --cgroupns=private \
  # tier trusted (instead of the line above):
  # --privileged --cgroupns=private \
  --memory <M> --memory-swap <M> --pids-limit 4096 --oom-score-adj=-999 \
  --tmpfs /run --tmpfs /var/run \
  -v <data>/k3s:/var/lib/rancher/k3s:U \      # :U only for userns (all four)
  -v <data>/kubelet:/var/lib/kubelet:U \
  -v <data>/cni:/var/lib/cni:U \
  -v <data>/log:/var/log:U \
  -v /run/yoal-workloads/<id>:/etc/yoal/k8s:ro \
  -v /run/yoal-workloads/<id>/manifests:/var/lib/rancher/k3s/server/manifests/yoal:ro \
  -v /run/yoal-workloads/<id>/meminfo:/proc/meminfo:ro \
  -p 127.0.0.1:<apiPort>:6443 -p 127.0.0.1:<ingressPort>:80 \
  --entrypoint /etc/yoal/k8s/entrypoint.sh \
  docker.io/rancher/k3s@sha256:21ea6e0f… server \
  --disable servicelb \
  --write-kubeconfig-mode 0600 \
  --tls-san <host> \
  --node-name <id> \
  --kube-apiserver-arg=anonymous-auth=false \
  --kube-apiserver-arg=authentication-config=/etc/yoal/k8s/auth.yaml \
  --kubelet-arg=system-reserved=memory=768Mi \
  '--kubelet-arg=eviction-hard=memory.available<200Mi,nodefs.available<5%,imagefs.available<5%'
```

Helper-written files, all under the read-only `/run/yoal-workloads/<id>/`:

- `entrypoint.sh`: the cgroup v2 evacuation shim (see gotcha 1). Both tiers need it.
- `meminfo`: rendered by `meminfo.sh <MemoryMax bytes>` (gotcha 4).
- `manifests/traefik-config.yaml`: a HelmChartConfig that binds Traefik `web`/`websecure` to hostPort 80/443 (gotcha 3). k3s applies files in subdirectories of `server/manifests`, so the read-only nested mount works.
- `auth.yaml`: the AuthenticationConfiguration.

No `K3S_`/kubelet feature gate was needed for userns. `KubeletInUserNamespace` was not set and is not required. The default flannel `vxlan` backend works inside the user namespace (`flannel.1` is created in the machine's netns). The default snapshotter (overlayfs) works on the bind-mounted data dir. fuse-overlayfs, `unmask=ALL`, `/dev/kmsg` handling and `--disable-network-policy` were **not needed**.

## S1 detail

Commands: `machine.sh k-final-userns userns 16451 17088`, then `s1-check.sh k-final-userns 17088` (and `trusted` on 16452/17089). Output of the final userns run:

```
k-final-userns   Ready   control-plane   26s   v1.37.2+k3s1  10.88.0.15  K3s v1.37.2+k3s1  containerd://2.3.7-k3s1
capacity/allocatable: 2Gi 1080Mi
coredns, local-path-provisioner, metrics-server, traefik: Running; hello x2 Running; escape Running
ingress via 127.0.0.1:17088 -> "Hostname: hello-5bcb568b45-mssvn"
anonymous API -> 401
escape pod: uid_map 0 2147483647 65536; /host = k3s image rootfs (bin dev etc lib proc run sys tmp usr var)
            raw disk denied; global sysctl denied
host: /yoal-escape-test absent; the file is in the container overlay upperdir owned by uid=2147483647
```

Other checks, userns tier:

- A PVC file (local-path) and a file written through `hostPath:/var/lib/rancher/k3s/x` both land under the machine's data dir as host uid 2147483647.
- From the privileged pod: `mount /dev/vda…` fails with permission denied. Opening `/dev/vda` gives EPERM. Device nodes in a userns-owned mount are not honoured, although they show as uid 0 inside. Writes to `/proc/sys/vm/drop_caches` and `kernel/sysrq` fail, and `/dev/kmsg` cannot be read. The pod can create links in the machine's own netns (`ip link add dummy0`), which is expected.
- With `hostPID`, the pod sees only the machine's processes (29 in total).
- `podman exec` into the machine shows k3s at host uid 2147483647 in `ps` on the host.

Trusted tier differences: uid_map `0 0 4294967295`. The escape file is host uid 0. `/proc/sys/vm/drop_caches` is writable, so the pod has host-kernel root. Raw `/dev/vda` was still EPERM, but that is OrbStack's own device policy and should not be relied on. The kubelet also sets **host-global sysctls** at start: we set `vm.overcommit_memory=0 kernel.panic=0 kernel.panic_on_oops=0 kernel.keys.root_maxkeys=200` first, and a trusted machine changed them to `1 / 10 / 1 / 1000000` (root_maxbytes 25000000). A userns machine started with the same non-default host values became Ready and changed nothing.

Conformance: `sonobuoy v0.57.5 run --mode quick` (1 spec, "Pods should be submitted and removed") passed on a userns machine with `MEM=4g`. The `systemd-logs` plugin never finishes, because there is no journald in the machine. Use `--plugin e2e` only. A full conformance run was not done.

## S2 detail

- With `--memory 2g` and no meminfo override: capacity and allocatable were both `16425744Ki` (host RAM). cAdvisor reads MemTotal from `/proc/meminfo`. The k3s default `evictionHard` has **no memory signal**, only `imagefs`/`nodefs` <5%.
- With the meminfo bind: capacity `2Gi`. With `system-reserved=memory=512Mi` and `eviction-hard memory.available<100Mi`, allocatable was `1436Mi` and kubepods `memory.max` was 1.5Gi. Under the tmpfs hog below, the **machine's** 2Gi limit was reached before kubepods' limit. The kernel killed coredns and other pods, then **k3s server itself** (oom_score_adj 0), and the machine exited 255. Root cause: in userns the kubelet cannot lower `oom_score_adj` (`write /proc/51/oom_score_adj: permission denied`), and k3s + containerd use about 640 MB, more than the 512Mi reserve.
- Final settings (`--oom-score-adj=-999`, `system-reserved=768Mi`, `eviction-hard memory.available<200Mi`): capacity `2Gi`, allocatable `1080Mi`. k3s server and containerd run at -999, and pods at 966/1000 (the kubelet can raise them). Test pods from `manifests/hogs.yaml`, both at 16 MiB/s:
  - tmpfs `emptyDir{medium: Memory}` hog: evicted at t≈70s ("available: 138300Ki, threshold 200Mi"), with `oom_kill 0`.
  - anonymous-memory hog (python): evicted at t≈70s ("available: 86348Ki"), with `oom_kill 0`. Machine and system pods had 0 restarts.
  - A fast hog (`tail /dev/zero`) is OOM-killed by the kernel within 10s, before kubelet housekeeping runs. Only the hog dies. k3s survives because of -999.
- Idle footprint, combined server+agent, 5 minutes after start, system pods only: `podman stats` 652 MB of 2.147 GB, 123 PIDs, about 12% CPU. cgroup `memory.current` was 1022 MB including 355 MB page cache. `k3s server` RSS was 537 MB, containerd 91 MB, `k3s init` 58 MB. The non-pod cgroups (`/init` + `/k3s`) used about 460 MB, and kubepods 244 MB.
- After the eviction, the `node.kubernetes.io/memory-pressure:NoSchedule` taint stays for the default 5m `eviction-pressure-transition-period`.
- Recommendation: minimum machine size 2 GiB. Reserve `max(768Mi, 25% of MemoryMax)`. Always render all three `eviction-hard` signals, because a partial list zeroes the others.

## S6 detail

`fw-snap.sh <label>` saves `nft list ruleset`, `iptables-save` and `ip6tables-save` to `/root/fw/` in the OrbStack machine (still there).

- Running userns machine: host nft has only `table inet netavark` chains for 10.88.0.0/16 and the two DNAT/SETMARK rules for the published loopback ports. 0 matches for `kube|flannel|cni-|10.42.|10.43.`. iptables-save is empty. Inside the machine, `iptables-save | grep -c KUBE` = 232, with its own ip/ip6 nat/filter/mangle tables.
- Running trusted machine: same result, 0 leaked rules.
- After `podman rm -f -v`: nft, ipt and ip6t are identical to the pre-start snapshot in both tiers.
- k3s logs `Failed to set sysctl … nf_conntrack_max: permission denied` in **both** tiers, because it is read-only in a non-init netns. This is harmless. kube-proxy already runs with `--conntrack-max-per-core=0`.

## S7 detail

`s7-snapshot.sh <src> <tier> <dst> <apiPort> <ingressPort>`:

1. Creates ns `s7`, configmap `marker` and a 2-replica nginx deployment.
2. Runs `sqlite3 <data>/k3s/server/db/state.db ".backup '<snap>/server/state.db'"` while k3s runs. `PRAGMA integrity_check` = ok.
3. Copies `server/token`, `server/tls` and `server/cred`, places them in a new data dir under `server/db/state.db`, and starts a new machine with a different name and ports.

Results (run twice, once per launcher layout):

- New node Ready in under 90s. ns, configmap value and deployment are present.
- The old admin kubeconfig, with the port rewritten, works against the new machine (same CA).
- Anonymous requests get 401. Ingress works on the new port.
- The old node stays listed (Ready for about 40s, then NotReady) and its pods show stale `Running`. After `kubectl delete node <old>`, pods were recreated on the new node in about 45s.
- local-path PVs are node-pinned and their data is not in `state.db`. A restore must also copy `<data>/k3s/storage/`, or it loses volumes. The restore must delete the old Node object.
- Under `userns`, `:U` re-chowns the copied files to the new machine's uid range on start.

## S5-lite detail

`auth.yaml` is an `apiserver.config.k8s.io/v1` `AuthenticationConfiguration` with:

- issuer `https://control.yoal.invalid`, audiences `[k8s:cl_spike]`;
- claim rule `claims.org_id == 'org_spike'`;
- username `'yoal:' + claims.sub`, and a user rule that rejects the `system:` prefix.

Results:

- k3s logs `Not setting kube-apiserver 'anonymous-auth' flag due to user-provided 'authentication-config' file`. It still passes our explicit `--anonymous-auth=false`, and anonymous requests get 401.
- The apiserver logs `oidc authenticator: initializing plugin: Get …: no such host` every 10s, and `/readyz` still passes with the admin cert.
- A malformed bearer token gets 401.
- An invalid file is **fatal**. A YAML error (`message:` with an unquoted `: `) made the apiserver exit and the container exit with **code 0**.

## Gotchas for the implementation

1. **cgroup v2 nesting shim is mandatory** in both tiers. Without it the kubelet fails with `cannot enter cgroupv2 "/sys/fs/cgroup/kubepods" with domain controllers -- it is in an invalid state`, and k3s exits 1 after about 60s. k3s v1.37 does not evacuate the root cgroup itself. The shim is `entrypoint.sh`, the same as k3d's: move every PID to `/init`, enable all controllers in `cgroup.subtree_control`, then `exec /bin/k3s "$@"`. Under userns, crun delegates `cgroup.procs`, `cgroup.threads`, `cgroup.subtree_control`, `memory.oom.group` and `memory.reclaim` to container root, so this works.
2. **Image VOLUMEs** (`/var/lib/kubelet`, `/var/lib/cni`, `/var/log`, `/var/lib/rancher/k3s`) become anonymous volumes and leak on `podman rm` without `-v`. Mount all four explicitly. Quadlet machines need these four `Volume=` lines.
3. **servicelb disabled means nothing listens on :80** in the machine's netns. The Traefik service stays `LoadBalancer <pending>`, which is harmless. Ingress works only after the HelmChartConfig sets `ports.web.hostPort: 80` (portmap CNI). `service.type: ClusterIP` in the same values had no effect. Client IP in `X-Forwarded-For` is the Podman gateway (10.88.0.1), because netavark DNAT hides it.
4. **Node memory = host RAM** unless `/proc/meminfo` is overridden. The static render keeps MemTotal/MemFree/MemAvailable at the limit and swap at 0. Re-render it when MemoryMax changes. lxcfs would be the dynamic option but was not needed.
5. **OOM ordering in userns**: the kubelet cannot set -999 on k3s. Set `--oom-score-adj=-999` on the container (Quadlet `PodmanArgs=--oom-score-adj=-999`), so k3s/containerd inherit it and pods are raised above it.
6. **Trusted tier rewrites host sysctls**: `vm.overcommit_memory=1`, `kernel.panic=10`, `kernel.panic_on_oops=1`, `kernel.keys.root_maxkeys=1000000`, `kernel.keys.root_maxbytes=25000000`. The only kubelet alternative, `protectKernelDefaults: true`, makes the kubelet fail if the values differ. A `kubernetes=dedicated` trusted node should preset these values, which makes it a no-op, or accept them knowingly.
7. **Kernel modules**: modprobe fails inside the machine in both tiers (`Failed to load kernel module br_netfilter / iptable_nat / iptable_filter / nft-expr-counter / nft-chain-2-nat`). The node must preload `br_netfilter overlay iptable_nat iptable_filter nf_conntrack vxlan` and the nft/xt modules, for example via `/etc/modules-load.d/yoal-k8s.conf`. OrbStack already had them loaded.
8. **Exit codes**: a fatal apiserver config error exits the container with **0**. Use `Restart=always` with the five-restart failure counter, not `on-failure`.
9. **Health probes need auth**: `/readyz` and `/livez` return 401 anonymously, so §5.3's admin-cert probe is required. Podman `HEALTHCHECK` cannot be anonymous.
10. `--tmpfs /run --tmpfs /var/run` is required (containerd/k3s sockets live in `/run/k3s`).
11. Each start under `:U` does a recursive chown of the data dir. That was fine for small dirs but may be slow for large local-path volumes. Consider an idmapped mount (`:idmap`) later.
12. Not tested: mount propagation (`rshared`) for CSI drivers, multi-node (S3), the Caddy path (S4), real JWT tokens (S5 full), etcd (S8), and amd64 or a non-OrbStack kernel. OrbStack's kernel is 7.2 and Debian 13 ships 6.12. The idmap and userns behaviour used here has existed since 5.12–6.x, but rerun `s1-check.sh` on a real Debian 13 VM before shipping.

## Files

| File | Role |
|---|---|
| `machine.sh` | Reference launcher (both tiers, final flag set) |
| `entrypoint.sh` | cgroup v2 evacuation shim |
| `meminfo.sh` | Renders the `/proc/meminfo` override |
| `manifests/traefik-config.yaml` | Traefik hostPort config |
| `auth.yaml` | Sample AuthenticationConfiguration |
| `s1-check.sh` | S1 pass checks |
| `s7-snapshot.sh` | S7 snapshot/restore |
| `fw-snap.sh` | S6 firewall snapshot |
| `watch-mem.sh`, `manifests/hogs.yaml` | S2 overrun tests |
| `manifests/smoke.yaml` | Deployment, Service, Ingress, PVC and the privileged hostPath pod |

The OrbStack machine `yoal-k8s-spike` is left in place with Podman, the subid range, the k3s/busybox/whoami/nginx/python images, `/root/sonobuoy` and the `/root/fw/*` snapshots. All test containers, volumes and data dirs are removed.
