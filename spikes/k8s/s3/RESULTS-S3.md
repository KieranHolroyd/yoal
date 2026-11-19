# S3 spike: multi-node k3s machines over the WireGuard-routed `yoal-k8s` network (2026-11-18)

Design under test: `docs/KUBERNETES.md` §10 (D232), as `apps/helper/src/kubernetes.ts`
(`renderK3sArgs`, `renderKubernetesUnit`, `renderMachineNetworkUnit`) and `wireguard.ts`/`network.ts`
render it. The scripts in this directory hold the exact commands. Machine flags are otherwise those
from S1/S2 (`../machine.sh`, the `userns` tier).

## Environment

| Item | Value |
|---|---|
| Node A | OrbStack `yoal-k8s-spike`, 192.168.139.136, overlay `10.47.1.1/32`, machine subnet `10.48.1.0/24` |
| Node B | OrbStack `yoal-k8s-spike2` (new), 192.168.139.19, overlay `10.47.1.2/32`, machine subnet `10.48.2.0/24` |
| OS/kernel | Debian 13 arm64, 7.2.12-orbstack (both nodes share the OrbStack kernel) |
| Podman | 5.4.2, netavark 1.14 (nftables driver), wireguard-tools, conntrack, tcpdump |
| k3s | `v1.37.2+k3s1` (image index `sha256:21ea6e0f…4332`), etcd 3.7.1-k3s3 |
| etcdctl | `quay.io/coreos/etcd:v3.6.5` (the k3s image has no etcdctl and no curl, and the etcd JSON gateway is off) |

Machines: `sa` = 10.48.1.10 (`--cluster-init`), `sb` = 10.48.2.10 (server, joins sa), `ab` = 10.48.2.11
(agent on B), `sa2` = 10.48.1.11 (third server, on A). Each machine is on `yoal-k8s` with a fixed IP,
plus a second ordinary bridge `yoal-org` (10.89.0.0/24) that stands in for the org network.

## Verdicts

| Check | Verdict | Evidence |
|---|---|---|
| Design as written: second server joins | **FAIL** | etcd on sa: `rejected connection on peer endpoint … remote-addr 10.47.1.2 … tls: "10.47.1.2" does not match any of DNSNames ["kine.sock" "sb" "localhost" "sb"]`. sb exits **0** with `etcd cluster join failed`. Cause: netavark masquerade (finding 1). |
| Design as written: agent data path | **FAIL** | `ab` advertised `flannel.alpha.coreos.com/public-ip: 10.89.0.6` (its org address), pod MTU 1450. Pod-to-pod ping and HTTP to or from `ab` got 100% loss and timeouts. sa↔sb worked. Cause: default-route order (finding 2). |
| With the fixes: all nodes Ready, etcd members | **PASS** | 3 nodes Ready, INTERNAL-IP = the routed address. `etcdctl member list`: 2 voters (`sa`, `sb`), later 3 voters (+`sa2`), all on `https://10.48.x.y:2380`, none learner. |
| Pod-to-pod across nodes | **PASS** | `xnode-check.sh`: ping sa→ab and ab→sa 0% loss, 1320-byte ping OK. HTTP pod IP sa→ab, ab→sa, sb→sa: 1300 B and 20 MiB, md5 match, 0.16–0.27 s. |
| ClusterIP Service from the other node | **PASS** | `web-ab.s3.svc` from sa and `web-sa.s3.svc` from ab, 1300 B and 20 MiB, md5 match. CoreDNS on another node resolves. |
| MTU | **PASS** | Pod MTU 1320 on every node (flannel = 1370 − 50). 20 MiB transfers finish in about 0.2 s, without stalls. wg0 shows 0 errors and 0 drops. The VXLAN outer source and destination on wg0 are the machine addresses (`10.48.2.11.50920 > 10.48.1.10.8472`), not NATed. |
| `kubectl exec`/`logs` through the other node's API | **PASS** | From sa: `exec web-ab -- hostname` and `logs web-ab` (agent on B), `exec web-sb` (server on B). It also worked from sb against `web-ab` while sa was down. |
| 2 servers, kill sa | **expected FAIL** (quorum) | sb's API: `Client.Timeout exceeded`, `/readyz`: `[-]etcd failed`. Existing pods keep serving (`wget` from sb to the web-ab pod returned 1300 B). Everything recovered on `podman start sa`. |
| 3 servers (sa, sb on different nodes, sa2 on A), kill sa | **PASS** | 20 s after the kill: `kubectl get nodes` and `/readyz` = `ok` on sb, exec and logs work, and a new pod scheduled on `ab` completed. etcd leader = sb. sa went NotReady at about 40 s. The agent LB logged `10.48.1.10:6443 PREFERRED->FAILED` and kept `[10.48.2.10, 10.48.1.11]`. |
| Restart with the `--server` target down | **PASS** | `podman restart ab sb` with sa still dead: both Ready again in 16 s. The agent reconnects from its saved LB list (`Remotedialer connected … 10.48.2.10, 10.48.1.11`). The rendered `--server=<first server>` is only needed on first join. |
| Host firewall and link leakage | **PASS** | Host nft has only `table inet netavark` and `table inet yoal`. `kube|flannel|cni|10.42.|10.43.` gives 0 matches. iptables-save and ip6tables-save are empty. No `flannel.1`, `cni0` or 10.42/10.43 routes on either host. Both hosts left with only `table inet netavark` and no wg0 after cleanup. |

## Findings and the changes the design needs

### 1. netavark masquerades machine-to-machine traffic, and etcd rejects it (blocker)

The netavark rules for `yoal-k8s` (default, managed bridge) are:

```
chain POSTROUTING { … ip saddr 10.48.1.0/24 jump nv_…_10_48_1_0_nm24 }
chain nv_…_10_48_1_0_nm24 { ip daddr 10.48.1.0/24 accept; ip daddr != 224.0.0.0/4 masquerade }
chain FORWARD { … ip daddr 10.48.1.0/24 ct state established,related accept; ip saddr 10.48.1.0/24 accept }
```

Traffic from 10.48.1.10 to 10.48.2.10 leaves wg0 with the source 10.47.1.1, because the
`ip route … src` sets it. Ping, TCP and VXLAN all still work, because the peer's /32 is in
AllowedIPs. **etcd's peer listener checks the remote IP against the client certificate's SANs** and
closes the connection, so a server cannot join. The apiserver (6443) and etcd client (2379)
listeners do not check the source, so agents and the supervisor work NATed.

The fix that was tested is an identity SNAT in an earlier nat hook. It sets up the NAT binding, so
netavark's masquerade chain is skipped. A plain `accept` is **not** enough, because every nat base
chain is still evaluated.

```
table inet yoal {
	chain postrouting {
		type nat hook postrouting priority srcnat - 10; policy accept;
		ip saddr 10.48.0.0/16 ip daddr 10.48.0.0/16 snat ip to ip saddr
	}
}
```

With it, conntrack shows `src=10.48.2.10 dst=10.48.1.10 … dport=2380` with no reply rewrite, and
wg0 carries the machine addresses. Egress to the internet (image pulls) is still masqueraded by
netavark. **Design change:** the helper must render this rule on every node with the K8s
component, **whatever the firewall backend**. Today `inet yoal` exists only on the plain-nftables
backend, and only as a filter forward chain. Under ufw or firewalld it needs its own small nft
table. One alternative was not tested: a helper-owned bridge with `-o mode=unmanaged`, which gets
no netavark NAT, filter or DNAT rules at all.

### 2. Two networks give two equal default routes, in random order (blocker)

netavark gives every network a `default via <gw> metric 100`. The first one installed wins, and
which one that is varied between containers: sa and sb had `yoal-k8s` first, `ab` had `yoal-org`
first. k3s/flannel **ignores `--node-ip` when it picks the VXLAN interface**, and logs `The interface
eth1 with ipv4 address 10.89.0.6 will be used by flannel`. It takes the default-route interface.
All non-local traffic, 10.48/16 included, also leaves by that route. So:

- An agent advertised its org address as its VTEP. Every cross-node pod path to it broke.
- A server whose default was the org network sent etcd traffic from 10.89.0.x. The org network's
  masquerade then rewrites it to 10.47.x, so etcd rejects it as in finding 1. The bypass rule does
  not apply, because the source is not 10.48/16. The first retry after the bypass rule was added
  failed this way.

Fixes, all tested together:

- `yoal-k8s` network: `Options=metric=50` (Quadlet `.network`) and `Route=10.48.0.0/16,<gw>`. The
  machine then has `default via 10.48.n.1 dev k8s0 metric 50`, ahead of the org network's metric
  100, and an explicit `10.48.0.0/16 via 10.48.n.1`.
- Machine: name the interface (`Network=yoal-k8s.network:ip=<ip>,interface_name=k8s0`) and add
  `--flannel-iface=k8s0` to the k3s args (server and agent). An agent started **without**
  `--flannel-iface`, with only the metric fix, also chose `k8s0`. The metric is therefore the
  essential part. `--flannel-iface` makes the choice explicit and costs nothing.

Pod MTU came out at 1320 everywhere, because flannel derives it from the interface MTU of 1370.
`--flannel-iface` is the only flannel flag needed. `--node-external-ip`,
`--flannel-external-ip` and `--flannel-backend` were **not** needed.

### 3. Other observations

- A failed etcd join exits the container with **code 0** (as in S1 gotcha 8), so `Restart=always` is
  right. A failed join leaves a learner member on the first server. k3s replaced it automatically
  when the machine rejoined with a wiped data dir.
- Agents (`ab`) can register before the second server (`sb`). Order does not matter.
- The rendered `--server=https://<first server>:6443` is fine for HA. Agents and servers persist the
  full server list, so restarts with that server down work (see the verdict table).
- `--tls-san=<ip>` and `--advertise-address=<ip>` work as rendered. No `--node-external-ip` was
  needed. The agent's load balancer learned all three server addresses on its own.
- The helper's `iifname "wg0" ip daddr 10.48.0.0/16 accept` forward rule was not exercised as a
  necessity, because OrbStack's forward policy is accept and netavark's FORWARD policy is accept.
  An `accept` in `inet yoal` does **not** override a `drop` in another table's forward base chain.
  On a host whose own nft forward chain drops, that chain needs the allowance itself (ufw: `route
  allow`, as rendered).
- `rp_filter`: wg0 = 2 (loose) and all = 0 here. Strict mode would also pass, because the reply
  route to 10.48.<peer>/24 is wg0.
- Not tested: a forward-drop host firewall, amd64 or a non-OrbStack kernel, WireGuard across a
  real WAN with an overlay MTU of 1280, local-path PVs across nodes, and kube-proxy
  `externalTrafficPolicy: Local` (the source IP is preserved now, so it should behave).

## Exact working flags

Node, once per node (`node-net.sh`):

```
wg0: address 10.47.1.<n>/32, mtu 1420, peer allowed-ips <peer>/32,10.48.<peer>.0/24
ip route replace 10.47.0.0/22 dev wg0 src 10.47.1.<n>
ip route replace 10.48.0.0/16 dev wg0 src 10.47.1.<n>
sysctl net.ipv4.ip_forward=1
nft: inet yoal forward  iifname "wg0" ip daddr 10.48.0.0/16 accept
nft: inet yoal postrouting (nat, srcnat-10)  ip saddr 10.48.0.0/16 ip daddr 10.48.0.0/16 snat ip to ip saddr   # NEW
podman network create yoal-k8s --driver bridge --subnet 10.48.<n>.0/24 --gateway 10.48.<n>.1 \
  -o mtu=1370 --disable-dns -o metric=50 --route 10.48.0.0/16,10.48.<n>.1                        # metric+route NEW
```

Machine (`machine.sh`), on top of the S1/S2 set:

```
--network yoal-k8s:ip=<ip>,interface_name=k8s0 --network <org>      # interface_name NEW
-e K3S_TOKEN=<token>
first server: server --cluster-init --tls-san=<ip> --advertise-address=<ip> --node-ip=<ip> --flannel-iface=k8s0 …
other server: server --server=https://<first ip>:6443 --tls-san=<ip> --advertise-address=<ip> --node-ip=<ip> --flannel-iface=k8s0 …
agent:        agent  --server=https://<first ip>:6443 --node-ip=<ip> --flannel-iface=k8s0 …
```

## Files

| File | Role |
|---|---|
| `keys.sh` | WireGuard key per node |
| `node-net.sh` | wg0, routes, nft, `yoal-k8s` and `yoal-org` networks. `MASQ_BYPASS=0`, `METRIC=none`, `ROUTE=0` reproduce the failures |
| `machine.sh` | One multi-node machine (`init`, `server` or `agent`). `FLANNEL_IFACE=0` omits the flag |
| `etcd-members.sh` | `etcdctl member list` and `endpoint status` with the machine's client cert |
| `pods.yaml`, `xnode-check.sh` | Cross-node pods and services, and the data-path checks |
| `teardown.sh` | Removes machines, data and networks (`ALL=1` also removes wg0 and `inet yoal`) |

Cleanup: all S3 containers, data dirs, networks, wg0 and `inet yoal` were removed on both nodes, and
the leaked anonymous volumes from a k3s-image probe container were pruned. Both VMs are left
running. `yoal-k8s-spike2` has Podman, wireguard-tools, tcpdump, conntrack, the subid range and the
k3s and etcd images. Both nodes keep `/etc/wireguard/s3.key`.
