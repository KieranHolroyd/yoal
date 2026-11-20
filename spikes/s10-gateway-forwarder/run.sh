#!/bin/sh
# S10, one command from a Mac with Lima and Go:
#
#   spikes/s10-gateway-forwarder/run.sh [soakMinutes]     # default 120
#
# Creates the Debian 13 VM yoal-w0-s10, builds the pinned Caddy with caddy-l4 for linux/arm64,
# copies the repo's apps/agent/src/endpoints.ts in (the prototypes are generated from it), runs
# every phase and copies the results to $TMPDIR/yoal-w0-s10-out-<timestamp>/ (outside the repo).
# KEEP_VM=1 leaves the VM running.
set -eu
SOAK_MIN="${1:-120}"
VM=yoal-w0-s10
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
CADDY_VERSION=2.11.8         # .github/workflows/release.yml
CADDY_DNS_CLOUDFLARE=v0.2.4  # same
XCADDY_VERSION=v0.4.7        # same
CADDY_L4=v0.1.3              # github.com/mholt/caddy-l4, newest tag on 2026-11-20
WORK=$(mktemp -d)
OUT="${TMPDIR:-/tmp}/yoal-w0-s10-out-$(date -u +%Y%m%dT%H%M%SZ)"
trap 'rm -rf "$WORK"' EXIT
vm() { limactl shell "$VM" -- sudo "$@"; }

echo "== build caddy $CADDY_VERSION + caddy-l4 $CADDY_L4 (linux/arm64)"
GOBIN="$WORK/bin" go install "github.com/caddyserver/xcaddy/cmd/xcaddy@$XCADDY_VERSION"
(cd "$WORK" && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 "$WORK/bin/xcaddy" build "v$CADDY_VERSION" \
	--with "github.com/caddy-dns/cloudflare@$CADDY_DNS_CLOUDFLARE" --with "github.com/mholt/caddy-l4@$CADDY_L4" --output caddy)

echo "== VM $VM"
if ! limactl list --format '{{.Name}}' | grep -qx "$VM"; then
	limactl create --name "$VM" --cpus 4 --memory 4 --disk 15 --mount-none --tty=false template:debian-13
fi
# Detach the host agent into its own session: when the calling shell's session ends, a host agent
# in it dies and takes the VM (and a running soak) with it. That cut two of three soaks here.
perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' limactl start "$VM" </dev/null >/dev/null 2>&1 || true
limactl copy "$HERE/provision.sh" "$VM:/tmp/provision.sh"
vm sh /tmp/provision.sh

echo "== stage rig"
mkdir -p "$WORK/stage"
cp "$HERE"/*.ts "$HERE/lab.sh" "$WORK/stage/"
cp "$REPO/apps/agent/src/endpoints.ts" "$WORK/stage/repo-endpoints.ts"
cp "$WORK/caddy" "$WORK/stage/caddy"
COPYFILE_DISABLE=1 tar -C "$WORK/stage" -czf "$WORK/stage.tgz" .
limactl copy "$WORK/stage.tgz" "$VM:/tmp/stage.tgz"
vm sh -c 'rm -rf /opt/yoal-w0-s10 && mkdir -p /opt/yoal-w0-s10 && tar -C /opt/yoal-w0-s10 -xzf /tmp/stage.tgz 2>/dev/null && chmod -R a+rX /opt/yoal-w0-s10'

echo "== phases"
vm sh /opt/yoal-w0-s10/lab.sh setup
vm sh /opt/yoal-w0-s10/lab.sh reach
vm sh /opt/yoal-w0-s10/lab.sh bench
vm sh /opt/yoal-w0-s10/lab.sh soak "$SOAK_MIN"
echo "   soak running for $SOAK_MIN min"
sleep $((SOAK_MIN * 60 + 120))
vm sh /opt/yoal-w0-s10/lab.sh lifecycle
vm sh /opt/yoal-w0-s10/lab.sh rootless
vm sh /opt/yoal-w0-s10/lab.sh stop
limactl stop "$VM" && perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' limactl start "$VM" </dev/null >/dev/null 2>&1
vm sh /opt/yoal-w0-s10/lab.sh after-reboot

echo "== results -> $OUT"
mkdir -p "$OUT"
vm tar -C /var/lib/yoal-w0-s10/out -czf /tmp/out.tgz .
limactl copy "$VM:/tmp/out.tgz" "$WORK/out.tgz"
tar -C "$OUT" -xzf "$WORK/out.tgz"
bun "$HERE/report.ts" "$OUT"

if [ "${KEEP_VM:-0}" != "1" ]; then
	limactl stop "$VM" >/dev/null 2>&1 || true
	limactl delete --force "$VM"
fi
