#!/usr/bin/env bash
# Start one multi-node k3s machine (userns tier) the way renderKubernetesUnit/renderK3sArgs render it:
# first on the routed `yoal-k8s` network with a fixed address, then the org network.
# usage: machine.sh <name> <role: init|server|agent> <ip> [apiPort] [extra k3s args...]
# env: TOKEN (required), JOIN (server address to join, default 10.48.1.10), MEM (default 2g)
set -euo pipefail
IMAGE=${IMAGE:-docker.io/rancher/k3s:v1.37.2-k3s1}
k8s=$(cd "$(dirname "$0")/.." && pwd)
name=$1 role=$2 ip=$3 api=${4:-0}; shift 3; [ $# -gt 0 ] && shift
MEM=${MEM:-2g}; JOIN=${JOIN:-10.48.1.10}
: "${TOKEN:?TOKEN required}"
data=/var/lib/yoal-spike/$name etc=/run/yoal-spike/$name
mkdir -p "$data" "$etc/manifests"
install -m 0755 "$k8s/entrypoint.sh" "$etc/entrypoint.sh"
install -m 0644 "$k8s/auth.yaml" "$etc/auth.yaml"
"$k8s/meminfo.sh" "$(numfmt --from=iec "${MEM^^}")" > "$etc/meminfo"
vols=()
for d in k3s:/var/lib/rancher/k3s kubelet:/var/lib/kubelet cni:/var/lib/cni log:/var/log; do
  mkdir -p "$data/${d%%:*}"; vols+=(-v "$data/${d%%:*}:${d#*:}:U"); done
common=(--node-name="$name"
  --kubelet-arg=system-reserved=memory=768Mi
  '--kubelet-arg=eviction-hard=memory.available<200Mi,nodefs.available<5%,imagefs.available<5%'
  --kubelet-arg=fail-swap-on=false
  --node-ip="$ip")
# S3 finding: flannel ignores --node-ip and uses the default-route interface; name the routed
# interface and pin flannel to it (FLANNEL_IFACE=0 to omit).
[ "${FLANNEL_IFACE:-1}" = 1 ] && common+=(--flannel-iface=k8s0)
srv=(--tls-san="$ip" --advertise-address="$ip" --disable=servicelb --write-kubeconfig-mode=0600
  --tls-san="$name" --tls-san=127.0.0.1
  --kube-apiserver-arg=anonymous-auth=false
  --kube-apiserver-arg=authentication-config=/etc/yoal/k8s/auth.yaml)
case $role in
  init)   args=(server --cluster-init "${srv[@]}" "${common[@]}") ;;
  server) args=(server "--server=https://$JOIN:6443" "${srv[@]}" "${common[@]}") ;;
  agent)  args=(agent "--server=https://$JOIN:6443" "${common[@]}") ;;
  *) echo "bad role" >&2; exit 2 ;;
esac
ports=(); [ "$api" != 0 ] && ports=(-p "127.0.0.1:$api:6443")
set -x
podman run -d --name "$name" --hostname "$name" \
  --privileged --userns=auto:size=65536 --cgroupns=private \
  --memory "$MEM" --memory-swap "$MEM" --pids-limit 4096 --oom-score-adj=-999 \
  --tmpfs /run --tmpfs /var/run \
  --network "yoal-k8s:ip=$ip,interface_name=k8s0" --network yoal-org --network-alias "$name" \
  -e "K3S_TOKEN=$TOKEN" \
  "${vols[@]}" \
  -v "$etc:/etc/yoal/k8s:ro" -v "$etc/meminfo:/proc/meminfo:ro" \
  "${ports[@]}" \
  --entrypoint /etc/yoal/k8s/entrypoint.sh \
  "$IMAGE" "${args[@]}" "$@"
