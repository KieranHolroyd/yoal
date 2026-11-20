# syntax=docker/dockerfile:1
#
# One HA lab node (tests/lab/README.md): Debian 13 with systemd as PID 1, run privileged with a
# private cgroup v2 namespace. Everything the Yoal installer would apt-get is baked in, so `lab up`
# spends its time building Yoal from the checkout, not downloading packages four times.
#
# Lab only. This image is never published and never runs outside a yoal-w0-* container.

ARG DEBIAN_TAG=trixie-20251117-slim
FROM debian:${DEBIAN_TAG}

ARG BUN_VERSION=1.4.4
ENV container=docker DEBIAN_FRONTEND=noninteractive

# systemd + the installer's packages (PODMAN_PACKAGES, STORAGE_TOOL_PACKAGES, OVERLAY_PACKAGES in
# scripts/install/main.ts) + what the fault verbs drive (nftables, tc, libfaketime, losetup/mkfs).
RUN apt-get update -q \
 && apt-get install -y -q --no-install-recommends \
      systemd systemd-sysv dbus ca-certificates curl unzip git gnupg debian-keyring \
      debian-archive-keyring apt-transport-https iproute2 iputils-ping procps psmisc less \
      podman uidmap passt netavark aardvark-dns nftables fuse-overlayfs \
      fio nfs-common cifs-utils wireguard-tools \
      faketime e2fsprogs util-linux openssl sqlite3 jq \
 && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
 && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list \
 && apt-get update -q && apt-get install -y -q --no-install-recommends caddy \
 && rm -rf /var/lib/apt/lists/*

# The Bun the installer expects at /opt/yoal/runtime/bin/bun (install.sh normally downloads it).
RUN arch="$(uname -m)"; case "$arch" in x86_64) a=x64 ;; aarch64) a=aarch64 ;; *) exit 1 ;; esac \
 && curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${a}.zip" \
 && unzip -q /tmp/bun.zip -d /tmp/bun && install -d /opt/yoal/runtime/bin \
 && install -m 0755 "$(find /tmp/bun -type f -name bun | head -n1)" /opt/yoal/runtime/bin/bun \
 && ln -sf /opt/yoal/runtime/bin/bun /usr/local/bin/bun && rm -rf /tmp/bun /tmp/bun.zip

# Docker starts the container with a private root mount. systemd mounts each unit's credentials
# (the control plane's sealed master key, LoadCredentialEncrypted=) in a child namespace and moves
# them into /run/credentials, which only reaches the unit when / propagates: make it rshared first.
RUN printf '%s\n' '[Unit]' 'Description=HA lab: shared mount propagation for credentials and Podman' \
      'DefaultDependencies=no' 'Before=sysinit.target local-fs.target' '[Service]' 'Type=oneshot' \
      'ExecStart=/usr/bin/mount --make-rshared /' '[Install]' 'WantedBy=sysinit.target' \
      > /etc/systemd/system/yoal-lab-rshared.service \
 && systemctl enable yoal-lab-rshared.service

# Units that make no sense in a container. Podman inside uses the node's own storage volume.
RUN systemctl mask systemd-modules-load.service systemd-udevd.service systemd-udev-trigger.service \
      getty@tty1.service console-getty.service systemd-logind.service 2>/dev/null || true \
 && printf '[storage]\ndriver = "overlay"\n[storage.options.overlay]\nmount_program = ""\n' > /etc/containers/storage.conf.lab \
 && echo 'lab node' > /etc/yoal-lab-node

# No bootstrap Caddyfile here: the installer writes its own (admin API on a unix socket) even
# when Caddy is preinstalled, as on this image (HA-PLAN Wave 1 F12, scripts/install/caddyfile.ts).

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
