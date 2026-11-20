#!/bin/sh
# The endpoint guard's semantics, checked on a real kernel (HA-PLAN H24, lane A).
#
# Needs Linux with nftables and iproute2 and enough privilege to make network namespaces:
#
#   docker run --rm --privileged -v "$PWD/tests/ha/scenarios/endpoint-guard-nft.sh:/t.sh" \
#     alpine:3.20 sh /t.sh
#
# It builds two container bridges and an underlay path, listens on all addresses, installs the
# exact table apps/helper/src/network.ts renders, and asserts:
#   - a container on the address's own bridge reaches the listener;
#   - a container on another bridge, routed at the gateway address, is dropped (org isolation);
#   - a host on the underlay that routes the gateway subnet is dropped (weak-host-model case);
#   - loopback still reaches it.
# Exit 0 when every case matches; 1 otherwise.
set -eu
apk add -q nftables iproute2 socat >/dev/null 2>&1

ip link add br0 type bridge; ip addr add 10.89.0.1/24 dev br0; ip link set br0 up
ip netns add same
ip link add va0 type veth peer name va1; ip link set va1 netns same
ip link set va0 master br0; ip link set va0 up
ip -n same addr add 10.89.0.2/24 dev va1; ip -n same link set va1 up; ip -n same link set lo up

ip link add br1 type bridge; ip addr add 10.99.0.1/24 dev br1; ip link set br1 up
ip netns add other
ip link add vb0 type veth peer name vb1; ip link set vb1 netns other
ip link set vb0 master br1; ip link set vb0 up
ip -n other addr add 10.99.0.2/24 dev vb1; ip -n other link set vb1 up; ip -n other link set lo up
ip -n other route add 10.89.0.0/24 via 10.99.0.1

ip link add eth9 type veth peer name eth9p
ip netns add under
ip link set eth9p netns under
ip addr add 10.0.0.1/24 dev eth9; ip link set eth9 up
ip -n under addr add 10.0.0.2/24 dev eth9p; ip -n under link set eth9p up; ip -n under link set lo up
ip -n under route add 10.89.0.0/24 via 10.0.0.1
sysctl -qw net.ipv4.ip_forward=1

socat TCP-LISTEN:21000,fork,reuseaddr SYSTEM:"echo OK" >/dev/null 2>&1 &
sleep 1

# The exact text NetworkManager#renderEndpointGuard emits.
nft -f /dev/stdin <<'RULES'
table inet yoal-endpoints
delete table inet yoal-endpoints
table inet yoal-endpoints {
	chain input {
		type filter hook input priority -10; policy accept;
		iifname "lo" accept
		ct state new tcp dport { 21000-21999, 23000-23999 } fib daddr . iif type != local drop
	}
}
RULES

status=0
reaches() { ip netns exec "$1" timeout 2 socat - TCP:10.89.0.1:21000 </dev/null 2>/dev/null | grep -q OK; }
reaches same   && echo "ok   own bridge reaches the gateway listener"       || { echo "FAIL own bridge was dropped"; status=1; }
reaches other  && { echo "FAIL another bridge reached the listener"; status=1; } || echo "ok   another bridge is dropped"
reaches under  && { echo "FAIL an underlay host reached the listener"; status=1; } || echo "ok   the underlay is dropped"
timeout 2 socat - TCP:127.0.0.1:21000 </dev/null 2>/dev/null | grep -q OK \
	&& echo "ok   loopback still reaches it" || { echo "FAIL loopback was dropped"; status=1; }
exit "$status"
