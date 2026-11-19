#!/usr/bin/env bash
# S1 pass checks against a running machine. usage: s1-check.sh <machine> <ingressPort>
set -u
n=$1 ing=$2
here=$(cd "$(dirname "$0")" && pwd)
k() { podman exec -i "$n" kubectl "$@"; }
for i in $(seq 1 30); do k get node "$n" 2>/dev/null | grep -q ' Ready' && break; sleep 5; done
k apply -f - < "$here/manifests/smoke.yaml" >/dev/null
k -n kube-system rollout status deploy/traefik --timeout=180s >/dev/null
k rollout status deploy/hello --timeout=120s >/dev/null
k wait --for=condition=Ready pod/escape --timeout=120s >/dev/null
echo "== node"; k get node -o wide --no-headers
echo "== capacity/allocatable"; k get node "$n" -o jsonpath='{.status.capacity.memory} {.status.allocatable.memory}{"\n"}'
echo "== pods"; k get pods -A --no-headers | grep -v Completed
sleep 5
echo "== ingress via 127.0.0.1:$ing"; curl -s -m5 -H 'Host: hello.test' "http://127.0.0.1:$ing/" | head -1
echo "== anonymous API"; podman port "$n" 6443/tcp | xargs -I{} curl -sk -o /dev/null -w '%{http_code}\n' https://{}/api
echo "== escape pod"
k exec escape -- sh -c 'echo "uid_map: $(cat /proc/self/uid_map)"; echo "host / : $(ls /host | tr "\n" " ")"; head -c1 /dev/vda >/dev/null 2>&1 && echo "raw disk READABLE" || echo "raw disk denied"; (echo 1 > /proc/sys/vm/drop_caches) 2>/dev/null && echo "global sysctl WRITABLE" || echo "global sysctl denied"'
up=$(podman inspect "$n" --format '{{.GraphDriver.Data.UpperDir}}')
echo "== host side: /yoal-escape-test on host: $(ls /yoal-escape-test 2>&1 | head -1)"
echo "== host side: file written via hostPath lands at $(ls -ln "$up/yoal-escape-test" | awk '{print "uid="$3, "gid="$4, $NF}')"
