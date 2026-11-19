#!/usr/bin/env bash
# Cross-node data path checks, run as root on node A (kubectl through server `sa`).
# pod->pod ping, 1300 B and 20 MiB HTTP pod->pod and via ClusterIP, both directions; md5 compared.
set -uo pipefail
k() { podman exec sa kubectl "$@"; }
ip() { k -n s3 get pod "$1" -o jsonpath='{.status.podIP}'; }
sum() { k -n s3 exec "$1" -- sh -c "grep $2 /www/sums | cut -d' ' -f1"; }
fetch() { # <fromPod> <url> <file> <servingPod>
  local t0 t1 got want
  t0=$(date +%s.%N)
  got=$(k -n s3 exec "$1" -- sh -c "timeout 30 wget -q -O- $2/$3 | md5sum | cut -d' ' -f1")
  t1=$(date +%s.%N); want=$(sum "$4" "$3")
  printf '%-7s -> %-28s %-5s %s (%.2fs)\n' "$1" "$2/$3" "$([ "$got" = "$want" ] && echo PASS || echo FAIL)" "$got" "$(awk "BEGIN{print $t1 - $t0}")"
}
for p in web-sa web-sb web-ab; do echo "$p $(ip $p) mtu: $(k -n s3 exec $p -- cat /sys/class/net/eth0/mtu)"; done
echo "--- ping"
k -n s3 exec web-sa -- ping -c3 -W2 "$(ip web-ab)" | tail -2
k -n s3 exec web-ab -- ping -c3 -W2 "$(ip web-sa)" | tail -2
k -n s3 exec web-sa -- ping -c2 -W2 -s 1292 "$(ip web-ab)" 2>&1 | tail -2   # 1320-byte IP packet = pod MTU (busybox ping has no -M do)
echo "--- http pod ip"
for f in small big; do
  fetch web-sa "http://$(ip web-ab):8080" $f web-ab
  fetch web-ab "http://$(ip web-sa):8080" $f web-sa
  fetch web-sb "http://$(ip web-sa):8080" $f web-sa
done
echo "--- http ClusterIP"
for f in small big; do
  fetch web-sa "http://web-ab.s3.svc.cluster.local" $f web-ab
  fetch web-ab "http://web-sa.s3.svc.cluster.local" $f web-sa
done
