#!/bin/sh
# The cloud shell container's main process (D236): seed a fresh home disk, then wait. Shells are
# started next to it by the console (`podman exec`), never by this script.
set -eu

home="${HOME:-/home/yoal}"
# A brand-new disk holds only lost+found: give it the usual dotfiles once. Existing files are kept.
if [ ! -e "$home/.bashrc" ]; then
	cp -Rn /etc/skel/. "$home/" 2>/dev/null || true
fi
mkdir -p "$home/.local/bin" 2>/dev/null || true

exec sleep infinity
