#!/usr/bin/env bash
# Start one k3s "machine" as a rootful Podman container (the flag set the K3 helper should render).
# usage: machine.sh <name> <tier: userns|trusted> <apiPort> <ingressPort> [extra k3s args...]
# env: MEM (bytes or podman size, default 2g), RESERVE (system-reserved, default 768Mi),
#      DATA (data root, default /var/lib/yoal-spike/<name>), EXTRA_PODMAN (extra podman flags)
set -euo pipefail
IMAGE=${IMAGE:-docker.io/rancher/k3s:v1.37.2-k3s1}
here=$(cd "$(dirname "$0")" && pwd)
name=$1 tier=$2 api=$3 ing=$4; shift 4
MEM=${MEM:-2g}
RESERVE=${RESERVE:-768Mi}
EVICT=${EVICT:-200Mi}
data=${DATA:-/var/lib/yoal-spike/$name}
etc=/run/yoal-spike/$name          # helper-written, mounted read-only (prod: /run/yoal-workloads/<id>/)
mkdir -p "$data" "$etc/manifests"
install -m 0755 "$here/entrypoint.sh" "$etc/entrypoint.sh"
install -m 0644 "$here/manifests/traefik-config.yaml" "$etc/manifests/traefik-config.yaml"
if [ -f "$here/auth.yaml" ]; then install -m 0644 "$here/auth.yaml" "$etc/auth.yaml"; fi
membytes=$(numfmt --from=iec "${MEM^^}" 2>/dev/null || echo "$MEM")
"$here/meminfo.sh" "$membytes" > "$etc/meminfo"
case $tier in
  userns)  tierflags=(--privileged --userns=auto:size=65536 --cgroupns=private); U=":U" ;;
  trusted) tierflags=(--privileged --cgroupns=private); U="" ;;
  *) echo "bad tier" >&2; exit 2 ;;
esac
# The image declares VOLUMEs for these; mount them explicitly so no anonymous volumes leak.
vols=()
for d in k3s:/var/lib/rancher/k3s kubelet:/var/lib/kubelet cni:/var/lib/cni log:/var/log; do
  mkdir -p "$data/${d%%:*}"; vols+=(-v "$data/${d%%:*}:${d#*:}$U")
done
set -x
podman run -d --name "$name" --hostname "$name" \
  "${tierflags[@]}" \
  --memory "$MEM" --memory-swap "$MEM" --pids-limit 4096 --oom-score-adj=-999 \
  --tmpfs /run --tmpfs /var/run \
  "${vols[@]}" \
  -v "$etc:/etc/yoal/k8s:ro" \
  -v "$etc/manifests:/var/lib/rancher/k3s/server/manifests/yoal:ro" \
  -v "$etc/meminfo:/proc/meminfo:ro" \
  -p "127.0.0.1:$api:6443" -p "127.0.0.1:$ing:80" \
  --entrypoint /etc/yoal/k8s/entrypoint.sh \
  ${EXTRA_PODMAN:-} \
  "$IMAGE" server \
  --disable servicelb \
  --write-kubeconfig-mode 0600 \
  --tls-san 127.0.0.1 \
  --node-name "$name" \
  --kube-apiserver-arg=anonymous-auth=false \
  --kube-apiserver-arg=authentication-config=/etc/yoal/k8s/auth.yaml \
  "--kubelet-arg=system-reserved=memory=$RESERVE" \
  "--kubelet-arg=eviction-hard=memory.available<$EVICT,nodefs.available<5%,imagefs.available<5%" \
  "$@"
