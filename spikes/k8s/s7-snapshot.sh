#!/usr/bin/env bash
# S7: online snapshot of a single-server SQLite machine and restore into a NEW machine.
# usage: s7-snapshot.sh <srcMachine> <tier> <dstMachine> <apiPort> <ingressPort>
set -euxo pipefail
src=$1 tier=$2 dst=$3 api=$4 ing=$5
here=$(cd "$(dirname "$0")" && pwd)
k() { podman exec -i "$src" kubectl "$@"; }
k create namespace s7 --dry-run=client -o yaml | k apply -f -
k -n s7 create configmap marker --from-literal=at="$(date -Is)" --dry-run=client -o yaml | k apply -f -
k -n s7 create deployment nginx --image=docker.io/library/nginx:1.29-alpine --replicas=2 --dry-run=client -o yaml | k apply -f -
k -n s7 rollout status deploy/nginx --timeout=120s
srcdata=/var/lib/yoal-spike/$src/k3s
snap=/var/lib/yoal-spike/snap-$src-$(date +%s)
mkdir -p "$snap/server"
# online, consistent copy while k3s keeps writing (sqlite backup API; WAL-safe)
sqlite3 "$srcdata/server/db/state.db" ".backup '$snap/server/state.db'"
cp -a "$srcdata/server/token" "$srcdata/server/tls" "$snap/server/"
[ -f "$srcdata/server/cred/passwd" ] && mkdir -p "$snap/server/cred" && cp -a "$srcdata/server/cred" "$snap/server/" || true
sqlite3 "$snap/server/state.db" 'PRAGMA integrity_check;'
ls -la "$snap/server"
# restore into a brand new data dir
dstroot=/var/lib/yoal-spike/$dst; dstdata=$dstroot/k3s
rm -rf "$dstroot"; mkdir -p "$dstdata/server/db"
cp -a "$snap/server/token" "$snap/server/tls" "$dstdata/server/"
[ -d "$snap/server/cred" ] && cp -a "$snap/server/cred" "$dstdata/server/" || true
cp "$snap/server/state.db" "$dstdata/server/db/state.db"
DATA=$dstroot "$here/machine.sh" "$dst" "$tier" "$api" "$ing"
