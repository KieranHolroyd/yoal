#!/usr/bin/env bash
# Remove S3 machines, data dirs and networks on this node (keeps wg0 unless ALL=1). Run as root.
set -u
podman rm -f -v sa sb ab sa2 ab2 probe 2>/dev/null
rm -rf /var/lib/yoal-spike/{sa,sb,ab,sa2,ab2} /run/yoal-spike/{sa,sb,ab,sa2,ab2}
podman network rm yoal-k8s yoal-org 2>/dev/null
conntrack -F 2>/dev/null
if [ "${ALL:-0}" = 1 ]; then ip link del wg0 2>/dev/null; nft delete table inet yoal 2>/dev/null; fi
true
