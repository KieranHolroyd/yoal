#!/usr/bin/env bash
# Create a WireGuard key on a node (once) and print its public key. Run as root.
set -euo pipefail
umask 077; mkdir -p /etc/wireguard
[ -f /etc/wireguard/s3.key ] || wg genkey > /etc/wireguard/s3.key
wg pubkey < /etc/wireguard/s3.key
