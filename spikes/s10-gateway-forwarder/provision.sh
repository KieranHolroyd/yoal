#!/bin/sh
# Inside the VM, as root: packages, Bun at the release pin, a workload slice and an agent-like user.
set -eu
BUN_VERSION=1.4.4
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq podman netavark aardvark-dns passt slirp4netns uidmap nftables curl unzip iproute2 jq procps >/dev/null
if ! /usr/local/bin/bun --version 2>/dev/null | grep -qx "$BUN_VERSION"; then
	curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-aarch64.zip"
	unzip -oq /tmp/bun.zip -d /tmp && install -m 0755 /tmp/bun-linux-aarch64/bun /usr/local/bin/bun && rm -rf /tmp/bun.zip /tmp/bun-linux-aarch64
fi
id yoal >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin yoal
# Per-user rootless Podman for part (d).
id rl >/dev/null 2>&1 || useradd --create-home --shell /bin/bash rl
grep -q '^rl:' /etc/subuid || usermod --add-subuids 200000-265535 --add-subgids 200000-265535 rl
loginctl enable-linger rl
# UserNS=auto needs the `containers` subordinate range (apps/helper/src/userns.ts uses its own).
id containers >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin containers
grep -q '^containers:' /etc/subuid || usermod --add-subuids 2147483647-2149483647 --add-subgids 2147483647-2149483647 containers
cat > /etc/systemd/system/yoal-workloads.slice <<'UNIT'
[Slice]
UNIT
systemctl daemon-reload && systemctl start yoal-workloads.slice
# 100k short connections leave ~2 conntrack entries each in TIME_WAIT for 120 s; the 65536 default
# fills and drops SYNs (seen on the first run). Size it like a busy node.
modprobe nf_conntrack
sysctl -qw net.netfilter.nf_conntrack_max=1048576
podman --version; bun --version; pasta --version | head -1; slirp4netns --version | head -1; nft --version; uname -r
