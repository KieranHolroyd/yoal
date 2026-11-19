#!/usr/bin/env bash
# usage: watch-mem.sh <machine> <pod> <seconds>
n=$1 pod=$2 secs=$3
for i in $(seq 10 10 "$secs"); do
  sleep 10
  podman inspect -f '{{.State.Running}}' "$n" | grep -q true || { echo "t=$i MACHINE DOWN"; break; }
  st=$(podman exec "$n" kubectl get pod "$pod" --no-headers 2>&1 | awk '{print $3}')
  cur=$(podman exec "$n" cat /sys/fs/cgroup/memory.current); kp=$(podman exec "$n" cat /sys/fs/cgroup/kubepods/memory.current)
  av=$(podman exec "$n" kubectl get --raw "/api/v1/nodes/$n/proxy/stats/summary" | jq .node.memory.availableBytes)
  echo "t=$i pod=$st machine=$((cur>>20))Mi kubepods=$((kp>>20))Mi available=$((av>>20))Mi"
  case $st in Running|ContainerCreating|Pending) ;; *) break;; esac
done
podman exec "$n" kubectl get pod "$pod" -o jsonpath='{.status.phase} {.status.reason} {.status.message}{"\n"}' 2>&1
podman exec "$n" sh -c 'grep -E "^(max|oom|oom_kill) " /sys/fs/cgroup/memory.events | tr "\n" " "; echo'
podman ps -a --format '{{.Names}} {{.Status}}' -f name="$n"
