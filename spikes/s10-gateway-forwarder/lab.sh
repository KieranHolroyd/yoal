#!/bin/sh
# S10 lab, inside the VM as root. Phases: setup | reach | bench | soak <min> | lifecycle | rootless | stop
# Rig in /opt/yoal-w0-s10 (copied by run.sh), output in /var/lib/yoal-w0-s10/out.
set -eu
RIG=/opt/yoal-w0-s10
VAR=/var/lib/yoal-w0-s10
OUT=$VAR/out
RUN=/run/yoal-w0-s10
QD=/etc/containers/systemd
PG_IMAGE=docker.io/library/postgres:18-trixie
BUN_IMAGE=docker.io/oven/bun:1.4.4-alpine
OVERLAY=10.47.0.1
TARGETS="asis-tls=db-s10:21000,asis-plain=db-s10:21001,fix-tls=db-s10:21200,fix-plain=db-s10:21201,caddy=db-s10:21500,direct=pg-direct:5432"
mkdir -p "$OUT"
say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$OUT/lab.log"; }
gw_of() { podman network inspect "$1" --format '{{range .Subnets}}{{.Gateway}}{{end}}'; }
subnet_of() { podman network inspect "$1" --format '{{range .Subnets}}{{.Subnet}}{{end}}'; }
bridge_of() { podman network inspect "$1" --format '{{.NetworkInterface}}'; }
probe_in() { podman exec "$1" bun /rig/load.ts probe "$2"; }
probe_net() { # a throwaway container on network $1 with the AddHost the unit would carry
	podman run --rm --network "$1" --add-host "db-s10:$GW" -v "$RIG:/rig:ro,Z" "$BUN_IMAGE" bun /rig/load.ts probe "$2"
}
record() { say "PROBE $1 -> $2"; printf '{"probe":"%s","result":"%s"}\n' "$1" "$2" >>"$OUT/reach.jsonl"; }

network_unit() {
	cat >"$QD/$1.network" <<EOF
[Unit]
Description=S10 container network $1

[Network]
NetworkName=$1
EOF
}

setup() {
	say "setup: versions"
	{ podman --version; podman info --format 'netavark={{.Host.NetworkBackendInfo.Version}} firewall={{.Host.NetworkBackendInfo.Package}} rootlessNet={{.Host.RootlessNetworkCmd}}'; bun --version; "$RIG/caddy" version; } >"$OUT/versions.txt" 2>&1 || true
	mkdir -p "$VAR/certs" "$VAR/caddyhome" "$RUN"
	chown yoal:yoal "$RUN" "$VAR/caddyhome"
	# The overlay address the provider listens on (a WireGuard address on a real node).
	ip link show yoal-w0-ov >/dev/null 2>&1 || { ip link add yoal-w0-ov type dummy; ip addr add "$OVERLAY/32" dev yoal-w0-ov; ip link set yoal-w0-ov up; }
	if [ ! -s "$VAR/certs/node.fp" ]; then
		openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 -subj /CN=yoal-w0-node \
			-keyout "$VAR/certs/node.key" -out "$VAR/certs/node.crt" 2>/dev/null
		openssl x509 -in "$VAR/certs/node.crt" -noout -fingerprint -sha256 | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f' >"$VAR/certs/node.fp"
		chown -R yoal:yoal "$VAR/certs"
	fi
	for net in yoal-w0-db yoal-w0-orga yoal-w0-orgb; do network_unit "$net"; done
	systemctl daemon-reload
	systemctl start yoal-w0-db-network.service yoal-w0-orga-network.service yoal-w0-orgb-network.service
	GW=$(gw_of yoal-w0-orga)
	say "setup: orga gateway=$GW subnet=$(subnet_of yoal-w0-orga) bridge=$(bridge_of yoal-w0-orga); orgb $(subnet_of yoal-w0-orgb)"
	podman pull -q "$PG_IMAGE" "$BUN_IMAGE" >/dev/null
	podman image inspect "$PG_IMAGE" "$BUN_IMAGE" --format '{{.RepoTags}} {{.Digest}}' >>"$OUT/versions.txt"
	# Postgres 18: the "remote" database on its own network, published on loopback like a Yoal
	# database, and on orga as pg-direct for the direct baseline.
	podman rm -f yoal-w0-pg >/dev/null 2>&1 || true
	podman run -d --name yoal-w0-pg --network yoal-w0-db --network yoal-w0-orga:alias=pg-direct -p 127.0.0.1:15432:5432 \
		-e POSTGRES_HOST_AUTH_METHOD=trust "$PG_IMAGE" -c max_connections=900 -c shared_buffers=64MB >/dev/null
	until podman exec yoal-w0-pg pg_isready -q 2>/dev/null; do sleep 1; done
	sleep 2
	# The bridge exists now (a container is attached), so the gateway address can be bound.
	bun "$RIG/make-proto.ts" "$RIG/repo-endpoints.ts" "$RIG/proto" >/dev/null
	start_forwarders
	# The workload: a Yoal-shaped Quadlet with the AddHost line H24 adds.
	cat >"$QD/yoal-w0-client.container" <<EOF
[Unit]
Description=S10 workload client (Yoal container unit shape + AddHost)

[Container]
ContainerName=yoal-w0-client
Image=$BUN_IMAGE
Exec=sleep infinity
Network=yoal-w0-orga.network
AddHost=db-s10:$GW
UserNS=auto:size=65536
Volume=$RIG:/rig:ro,Z
Volume=$OUT:/out:Z,U
DropCapability=all
NoNewPrivileges=true
ReadOnly=true
Tmpfs=/tmp:rw,size=64m

[Service]
Restart=always
EOF
	systemctl daemon-reload
	systemctl restart yoal-w0-client.service
	sleep 3
	podman exec yoal-w0-client cat /etc/hosts >"$OUT/client-hosts.txt"
	say "setup: done"
}

start_forwarders() {
	GW=$(gw_of yoal-w0-orga)
	for unit in yoal-w0-fwd-asis yoal-w0-fwd-fix yoal-w0-caddy yoal-w0-caddy-load; do systemctl stop "$unit" 2>/dev/null || true; systemctl reset-failed "$unit" 2>/dev/null || true; done
	systemd-run -q --unit yoal-w0-fwd-asis --uid=yoal --gid=yoal -p WorkingDirectory=$RIG -p LimitNOFILE=65536 \
		/usr/local/bin/bun harness.ts ./proto/gw.ts 21000 25432 "$GW" "$OVERLAY" "$VAR/certs"
	systemd-run -q --unit yoal-w0-fwd-fix --uid=yoal --gid=yoal -p WorkingDirectory=$RIG -p LimitNOFILE=65536 \
		/usr/local/bin/bun harness.ts ./proto/gw-fix.ts 21200 25433 "$GW" "$OVERLAY" "$VAR/certs"
	printf '{"admin":{"listen":"unix/%s/caddy.sock"}}' "$RUN" >"$VAR/caddy-boot.json"
	systemd-run -q --unit yoal-w0-caddy --uid=yoal --gid=yoal -p LimitNOFILE=65536 -E HOME=$VAR/caddyhome -E XDG_DATA_HOME=$VAR/caddyhome -E XDG_CONFIG_HOME=$VAR/caddyhome \
		"$RIG/caddy" run --config "$VAR/caddy-boot.json"
	sleep 2
	systemd-run -q --unit yoal-w0-caddy-load --uid=yoal --gid=yoal -p WorkingDirectory=$RIG \
		/usr/local/bin/bun caddy-l4.ts "$RUN/caddy.sock" 21500 "$GW"
	sleep 3
}

nft_rules() { # what the helper would write for one attachment network (rendered, then nft -f)
	BR=$(bridge_of yoal-w0-orga)
	cat >"$VAR/endpoints.nft" <<EOF
table inet yoal-w0-ep
delete table inet yoal-w0-ep
table inet yoal-w0-ep {
	chain input {
		type filter hook input priority -5; policy accept;
		iifname "$BR" ip saddr $(subnet_of yoal-w0-orga) ip daddr $GW tcp dport 21000-21999 accept
		ip daddr != 127.0.0.0/8 tcp dport 21000-21999 drop
	}
	chain output {
		type filter hook output priority -5; policy accept;
		oifname "lo" tcp dport 21000-21999 meta skuid 61184-65519 accept
		oifname "lo" tcp dport 21000-21999 meta skuid "yoal" accept
		oifname "lo" tcp dport 21000-21999 reject with tcp reset
	}
}
EOF
	nft -f "$VAR/endpoints.nft"
}

ext_ns() { # a host "outside" this one that routes the container subnets via this host
	ip netns list | grep -q yoal-w0-ext && return
	ip netns add yoal-w0-ext
	ip link add yoal-w0-veh type veth peer name yoal-w0-vex
	ip link set yoal-w0-vex netns yoal-w0-ext
	ip addr add 10.200.0.1/24 dev yoal-w0-veh && ip link set yoal-w0-veh up
	ip -n yoal-w0-ext addr add 10.200.0.2/24 dev yoal-w0-vex
	ip -n yoal-w0-ext link set yoal-w0-vex up && ip -n yoal-w0-ext link set lo up
	ip -n yoal-w0-ext route add 10.89.0.0/16 via 10.200.0.1
}

reach_round() {
	tag=$1
	for t in "asis:db-s10:21001" "fix:db-s10:21201" "caddy:db-s10:21500" "asis-tls:db-s10:21000"; do
		record "$tag orga-container(AddHost) ${t%%:*}" "$(probe_in yoal-w0-client "${t#*:}")"
	done
	record "$tag orgb-container gw:21001" "$(probe_net yoal-w0-orgb "$GW:21001")"
	record "$tag orgb-container gw:21500(caddy)" "$(probe_net yoal-w0-orgb "$GW:21500")"
	record "$tag host-nobody gw:21001" "$(setpriv --reuid=nobody --regid=nogroup --clear-groups bun "$RIG/load.ts" probe "$GW:21001")"
	record "$tag host-root gw:21001" "$(bun "$RIG/load.ts" probe "$GW:21001")"
	record "$tag host-nobody 127.0.0.1:21001" "$(setpriv --reuid=nobody --regid=nogroup --clear-groups bun "$RIG/load.ts" probe 127.0.0.1:21001)"
	record "$tag host-workload-slice 127.0.0.1:21001" "$(systemd-run -q --wait --pipe --slice=yoal-workloads.slice -p DynamicUser=yes /usr/local/bin/bun "$RIG/load.ts" probe 127.0.0.1:21001)"
	record "$tag outside(netns via host) gw:21001" "$(ip netns exec yoal-w0-ext bun "$RIG/load.ts" probe "$GW:21001")"
	record "$tag outside(netns via host) gw:21500(caddy)" "$(ip netns exec yoal-w0-ext bun "$RIG/load.ts" probe "$GW:21500")"
	record "$tag outside(netns) host-eth0:21001" "$(ip netns exec yoal-w0-ext bun "$RIG/load.ts" probe "$(ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1):21001")"
}

reach() {
	GW=$(gw_of yoal-w0-orga)
	: >"$OUT/reach.jsonl"
	sysctl -qw net.ipv4.ip_forward=1
	ext_ns
	ss -ltn | awk 'NR>1 {print $4}' | grep -E ':(21000|21001|21200|21500)$' | sort >"$OUT/listeners.txt"
	nft delete table inet yoal-w0-ep 2>/dev/null || true
	reach_round no-rule
	nft_rules
	reach_round with-rule
	nft list table inet yoal-w0-ep >"$OUT/endpoints.nft.applied"
}

sample() { # RSS (kB) and fd count of each forwarder, one JSON line
	line="{\"at\":\"$(date -u +%FT%TZ)\""
	for unit in yoal-w0-fwd-asis yoal-w0-fwd-fix yoal-w0-caddy; do
		pid=$(systemctl show -p MainPID --value "$unit")
		rss=$(awk '/VmRSS/ {print $2}' "/proc/$pid/status" 2>/dev/null || echo 0)
		fds=$(ls "/proc/$pid/fd" 2>/dev/null | wc -l)
		line="$line,\"$unit\":{\"rssKb\":$rss,\"fds\":$fds}"
	done
	echo "$line}"
}

bench() {
	say "bench: idle sample"; sample >>"$OUT/samples.jsonl"
	bun -e 'setInterval(() => {}, 1000)' & BASE=$!; sleep 3
	say "bench: bare bun RSS kB $(awk '/VmRSS/ {print $2}' /proc/$BASE/status)"; kill $BASE
	say "bench: 100k short connections per target (reloads running)"
	drops=$(dmesg | grep -c 'table full' || true)
	podman exec yoal-w0-client bun /rig/load.ts short "$TARGETS" 100000 32 | tee -a "$OUT/short.jsonl"
	say "bench: conntrack table-full drops during short: $(( $(dmesg | grep -c 'table full' || true) - drops )) (max $(sysctl -n net.netfilter.nf_conntrack_max))"
	sample >>"$OUT/samples.jsonl"
	say "bench: latency (sequential, interleaved)"
	podman exec yoal-w0-client bun /rig/load.ts latency "$TARGETS" 5000 | tee -a "$OUT/latency.jsonl"
	sample >>"$OUT/samples.jsonl"
}

soak() {
	minutes=$1
	say "soak: $minutes min"
	systemctl stop yoal-w0-soak yoal-w0-sampler 2>/dev/null || true
	systemctl reset-failed yoal-w0-soak yoal-w0-sampler 2>/dev/null || true
	systemd-run -q --unit yoal-w0-soak podman exec yoal-w0-client bun /rig/load.ts soak "$TARGETS" "$minutes" 50 5 /out/soak.jsonl
	systemd-run -q --unit yoal-w0-sampler sh -c "while true; do sh $RIG/lab.sh sample >>$OUT/samples.jsonl; sleep 60; done"
}

lifecycle() {
	GW=$(gw_of yoal-w0-orga); BR=$(bridge_of yoal-w0-orga)
	L="$OUT/lifecycle.log"; : >"$L"
	note() { say "LIFE $*"; echo "$*" >>"$L"; }
	note "before: gw=$GW bridge=$BR; $(ip -4 -br addr show "$BR" 2>&1)"
	note "listeners on gw before: $(ss -ltn | grep -c "$GW:" )"
	systemctl stop yoal-w0-client.service
	podman network disconnect yoal-w0-orga yoal-w0-pg
	sleep 2
	note "all containers off orga: bridge $(ip link show "$BR" >/dev/null 2>&1 && echo present || echo removed); listeners on gw: $(ss -ltn | grep -c "$GW:")"
	systemctl restart yoal-w0-fwd-fix.service 2>/dev/null || true
	sleep 3
	note "fix forwarder restarted while bridge absent: $(journalctl -u yoal-w0-fwd-fix --since -10s --no-pager | grep -c 'could not listen') listen errors; gw listeners now $(ss -ltn | grep "$GW:" | grep -c ':212')"
	systemctl start yoal-w0-client.service; sleep 4
	note "bridge back: $(ip -4 -br addr show "$BR" 2>&1)"
	note "after bridge back: asis(old listener, restarted every poll) gw:21001 -> $(probe_in yoal-w0-client db-s10:21001); fix(restarted while absent) gw:21201 -> $(probe_in yoal-w0-client db-s10:21201); caddy gw:21500 -> $(probe_in yoal-w0-client db-s10:21500)"
	sleep 70
	note "after one more caddy load + asis converge: asis -> $(probe_in yoal-w0-client db-s10:21001); fix -> $(probe_in yoal-w0-client db-s10:21201); caddy -> $(probe_in yoal-w0-client db-s10:21500)"
	# Bind before the address exists, with ip_nonlocal_bind.
	systemctl stop yoal-w0-client.service; sleep 2
	sysctl -qw net.ipv4.ip_nonlocal_bind=1
	systemctl restart yoal-w0-fwd-fix.service; sleep 3
	note "nonlocal_bind=1, fix restarted while bridge absent: gw listeners $(ss -ltn | grep "$GW:" | grep -c ':212')"
	systemctl start yoal-w0-client.service; sleep 4
	note "nonlocal_bind=1, bridge back: fix gw:21201 -> $(probe_in yoal-w0-client db-s10:21201)"
	sysctl -qw net.ipv4.ip_nonlocal_bind=0
	# Recreate the network after another org's network was created in between.
	systemctl stop yoal-w0-client.service; sleep 2
	podman network rm -f yoal-w0-orga >/dev/null
	podman network create yoal-w0-orgc >/dev/null
	systemctl restart yoal-w0-orga-network.service
	note "recreated orga after orgc: orga $(subnet_of yoal-w0-orga) gw $(gw_of yoal-w0-orga) bridge $(bridge_of yoal-w0-orga); orgc $(subnet_of yoal-w0-orgc)"
	podman network rm -f yoal-w0-orgc yoal-w0-orga >/dev/null
	systemctl restart yoal-w0-orga-network.service
	note "recreated orga alone: orga $(subnet_of yoal-w0-orga) gw $(gw_of yoal-w0-orga)"
	cat /etc/containers/networks/yoal-w0-orga.json >"$OUT/orga-network.json"
	systemctl start yoal-w0-client.service; sleep 4
	note "AddHost after recreate (unit still says $GW): $(probe_in yoal-w0-client db-s10:21500)"
}

rootless() {
	R="$OUT/rootless.log"; : >"$R"
	ETH=$(ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1)
	# A forwarder bound to loopback and eth0 (no host gateway address exists for rootless bridges).
	# Raw reachability on 23701 (outside the endpoint range, so the endpoint nft table does not apply),
	# and 21701 inside the range to show what that table does to pasta's host-side connections.
	for base in 23700 21700; do
		systemctl stop yoal-w0-fwd-rl$base 2>/dev/null || true; systemctl reset-failed yoal-w0-fwd-rl$base 2>/dev/null || true
		systemd-run -q --unit yoal-w0-fwd-rl$base --uid=yoal --gid=yoal -p WorkingDirectory=$RIG \
			/usr/local/bin/bun harness.ts ./proto/gw-fix.ts $base $((base + 3000)) "$ETH" "$OVERLAY" "$VAR/certs" 2
	done
	sleep 2
	cat >/tmp/yoal-w0-rl.sh <<EOF
set -u
cd ~
echo "rootless net cmd: \$(podman info --format '{{.Host.RootlessNetworkCmd}}') pasta: \$(pasta --version 2>&1 | head -1)"
podman pull -q $BUN_IMAGE >/dev/null
podman network exists rl-net || podman network create rl-net >/dev/null
echo "rl-net: \$(podman network inspect rl-net --format '{{range .Subnets}}{{.Subnet}} gw {{.Gateway}}{{end}}'); host has it: \$(ip -4 addr | grep -c "\$(podman network inspect rl-net --format '{{range .Subnets}}{{.Gateway}}{{end}}')")"
for net in pasta "pasta:--map-host-loopback=169.254.1.3" "slirp4netns:allow_host_loopback=true" rl-net; do
	for dst in host.containers.internal 169.254.1.2 169.254.1.3 10.0.2.2 $ETH 10.89.0.1; do
		printf '%s -> %s:23701 = ' "\$net" "\$dst"
		podman run --rm --network "\$net" -v /opt/yoal-w0-s10:/rig:ro $BUN_IMAGE bun /rig/load.ts probe \$dst:23701 2>&1 | tail -1
	done
	echo "\$net hosts: \$(podman run --rm --network "\$net" $BUN_IMAGE grep host.containers.internal /etc/hosts)"
done
echo "in-range with endpoint nft table: pasta -> 169.254.1.2:21701 = \$(podman run --rm --network pasta -v /opt/yoal-w0-s10:/rig:ro $BUN_IMAGE bun /rig/load.ts probe 169.254.1.2:21701 2>&1 | tail -1); slirp4netns -> 10.0.2.2:21701 = \$(podman run --rm --network slirp4netns:allow_host_loopback=true -v /opt/yoal-w0-s10:/rig:ro $BUN_IMAGE bun /rig/load.ts probe 10.0.2.2:21701 2>&1 | tail -1)"
echo "uid rl = \$(id -u)"
EOF
	chmod 0644 /tmp/yoal-w0-rl.sh
	su - rl -c 'sh /tmp/yoal-w0-rl.sh' >>"$R" 2>&1 || true
	nft list table inet yoal-w0-ep >/dev/null 2>&1 && echo "(endpoint nft table present during rootless run)" >>"$R"
	cat "$R"
	systemctl stop yoal-w0-fwd-rl23700 yoal-w0-fwd-rl21700
}

after_reboot() { # run once after `limactl stop/start`: is the gateway the same, and does the path come back?
	B="$OUT/reboot.log"
	echo "after reboot: orga $(subnet_of yoal-w0-orga) gw $(gw_of yoal-w0-orga) bridge $(bridge_of yoal-w0-orga) (before: $(cat "$VAR/gw-before-reboot" 2>/dev/null))" >>"$B"
	echo "bridge present before any container starts: $(ip link show "$(bridge_of yoal-w0-orga)" >/dev/null 2>&1 && echo yes || echo no)" >>"$B"
	podman start yoal-w0-pg >/dev/null; until podman exec yoal-w0-pg pg_isready -q 2>/dev/null; do sleep 1; done
	ip link show yoal-w0-ov >/dev/null 2>&1 || { ip link add yoal-w0-ov type dummy; ip addr add "$OVERLAY/32" dev yoal-w0-ov; ip link set yoal-w0-ov up; }
	mkdir -p "$RUN"; chown yoal:yoal "$RUN"
	start_forwarders
	systemctl start yoal-w0-client.service; sleep 4
	echo "after reboot, AddHost path: asis $(probe_in yoal-w0-client db-s10:21001) fix $(probe_in yoal-w0-client db-s10:21201) caddy $(probe_in yoal-w0-client db-s10:21500) tls $(probe_in yoal-w0-client db-s10:21200)" >>"$B"
	cat "$B"
	stop_all
}

stop_all() {
	for unit in yoal-w0-soak yoal-w0-sampler yoal-w0-fwd-asis yoal-w0-fwd-fix yoal-w0-caddy-load yoal-w0-caddy yoal-w0-client; do systemctl stop "$unit" 2>/dev/null || true; done
	for unit in yoal-w0-fwd-asis yoal-w0-fwd-fix yoal-w0-caddy-load yoal-w0-caddy; do journalctl -u "$unit" --no-pager >"$OUT/$unit.journal" 2>/dev/null || true; done
}

case "${1:-}" in
	setup) setup ;;
	forwarders) start_forwarders ;;
	reach) reach ;;
	sample) sample ;;
	bench) bench ;;
	soak) soak "${2:-120}" ;;
	lifecycle) lifecycle ;;
	rootless) rootless ;;
	stop) stop_all; echo "$(subnet_of yoal-w0-orga) gw $(gw_of yoal-w0-orga) bridge $(bridge_of yoal-w0-orga)" >"$VAR/gw-before-reboot" ;;
	after-reboot) after_reboot ;;
	*) echo "usage: lab.sh setup|reach|bench|soak <min>|lifecycle|rootless|stop" >&2; exit 2 ;;
esac
