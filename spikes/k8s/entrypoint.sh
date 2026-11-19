#!/bin/sh
# cgroup v2 nesting: move every process out of the container's root cgroup so the root can
# delegate controllers to kubepods (the "no internal processes" rule). Same as k3d's
# k3d-entrypoint-cgroupv2.sh. Without it the kubelet fails with
# "cannot enter cgroupv2 /sys/fs/cgroup/kubepods with domain controllers -- it is in an invalid state".
set -e
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  mkdir -p /sys/fs/cgroup/init
  xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs || :
  sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control
fi
exec /bin/k3s "$@"
