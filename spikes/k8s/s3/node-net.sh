#!/usr/bin/env bash
# S3 node networking: wg0 overlay + routed machine subnet + `yoal-k8s` Podman network, as the
# helper renders it (docs/KUBERNETES.md §10). Run as root on each node.
# usage: node-net.sh <selfOverlay> <selfSubnet> <peerOverlay> <peerSubnet> <peerEndpoint> <peerPubKey>
#   e.g. node-net.sh 10.47.1.1 10.48.1.0/24 10.47.1.2 10.48.2.0/24 192.168.139.19:51820 <key>
# The private key is /etc/wireguard/s3.key (created by keys.sh).
set -euo pipefail
self=$1 subnet=$2 peer=$3 peersub=$4 endpoint=$5 peerkey=$6
gw="${subnet%.*}.1"
set -x
ip link del wg0 2>/dev/null || true
ip link add wg0 type wireguard
wg set wg0 listen-port 51820 private-key /etc/wireguard/s3.key \
  peer "$peerkey" endpoint "$endpoint" allowed-ips "$peer/32,$peersub" persistent-keepalive 25
ip addr add "$self/32" dev wg0
ip link set wg0 mtu 1420 up
ip route replace 10.47.0.0/22 dev wg0 src "$self"
ip route replace 10.48.0.0/16 dev wg0 src "$self"
sysctl -qw net.ipv4.ip_forward=1
# S3 finding: netavark masquerades 10.48.<n>.0/24 -> anything outside its own /24, so a peer machine
# sees the node's wg0 address (10.47.x.y) and etcd's peer listener rejects the connection (remote IP
# not in the client cert's SANs). An identity SNAT in an earlier nat chain sets up the NAT binding
# first, so netavark's masquerade never runs for machine-to-machine traffic. MASQ_BYPASS=0 to disable.
bypass=""
if [ "${MASQ_BYPASS:-1}" = 1 ]; then
bypass='	chain postrouting {
		type nat hook postrouting priority srcnat - 10; policy accept;
		ip saddr 10.48.0.0/16 ip daddr 10.48.0.0/16 snat ip to ip saddr
	}
'
fi
# The helper's nft forward chain (wireguard.ts -> network.ts renderNftables).
nft -f - <<NFT
table inet yoal
delete table inet yoal
table inet yoal {
	chain forward {
		type filter hook forward priority -10; policy accept;
		iifname "wg0" ip daddr 10.48.0.0/16 accept
	}
$bypass}
NFT
# S3 finding: a machine on two networks gets two equal-metric (100) default routes in an order that
# varies per container. flannel takes the default-route interface and etcd/apiserver traffic leaves
# by it, so a machine whose first default was the org network advertised its org IP as the VXLAN
# endpoint. METRIC (default 50) makes the yoal-k8s default win; ROUTE adds 10.48.0.0/16 via the
# gateway so machine-to-machine traffic always uses it. METRIC=none / ROUTE=0 reproduce the bug.
extra=()
[ "${METRIC:-50}" != none ] && extra+=(-o "metric=${METRIC:-50}")
[ "${ROUTE:-1}" = 1 ] && extra+=(--route "10.48.0.0/16,$gw")
podman network exists yoal-k8s || podman network create yoal-k8s --driver bridge \
  --subnet "$subnet" --gateway "$gw" -o mtu=1370 --disable-dns "${extra[@]}"
# The org network a multi-node machine also joins (attachments); an ordinary bridge.
podman network exists yoal-org || podman network create yoal-org
