#!/usr/bin/env bash
# etcd member list + endpoint status of k3s server machines (no etcdctl in the k3s image, so run
# the upstream etcd image's etcdctl with the machine's client cert). Run as root on a server's node.
# usage: etcd-members.sh <machineName> <endpointIp>[,<endpointIp>...]
set -euo pipefail
t=/var/lib/yoal-spike/$1/k3s/server/tls/etcd
eps=$(echo "$2" | sed -E 's#([0-9.]+)#https://\1:2379#g')
run() { podman run --rm --network host -v "$t:/c:ro" quay.io/coreos/etcd:v3.6.5 etcdctl \
  --cacert /c/server-ca.crt --cert /c/client.crt --key /c/client.key --command-timeout=5s "$@"; }
run --endpoints "$eps" member list -w table || true
run --endpoints "$eps" endpoint status -w table || true
