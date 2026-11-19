#!/usr/bin/env bash
# usage: fw-snap.sh <label>  -> writes snapshots under /root/fw/<label>.{nft,ipt,ip6t}
set -eu
mkdir -p /root/fw
nft list ruleset > /root/fw/$1.nft
iptables-save | grep -v '^#' | sed -E 's/\[[0-9]+:[0-9]+\]/[0:0]/' > /root/fw/$1.ipt
ip6tables-save | grep -v '^#' | sed -E 's/\[[0-9]+:[0-9]+\]/[0:0]/' > /root/fw/$1.ip6t
wc -l /root/fw/$1.*
