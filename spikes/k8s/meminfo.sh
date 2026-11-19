#!/usr/bin/env bash
# Render a static /proc/meminfo whose MemTotal is the machine's cgroup limit, so cAdvisor/kubelet
# report node capacity = MemoryMax instead of the host's RAM. Bind-mounted over /proc/meminfo.
# usage: meminfo.sh <limitBytes> > file
set -eu
kb=$(( $1 / 1024 ))
awk -v kb="$kb" '
  /^(MemTotal|MemFree|MemAvailable):/ { printf "%-16s%8d kB\n", $1, kb; next }
  /^(SwapTotal|SwapFree):/            { printf "%-16s%8d kB\n", $1, 0; next }
  { print }' /proc/meminfo
