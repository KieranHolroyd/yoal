#!/bin/sh
# S4 ingress: Caddy runs as `caddy` (ports 80/443 via the container's unprivileged-port sysctl);
# with S4_AGENT=1 the design-B agent runs as root beside it and owns /etc/caddy-certs.
set -eu
install -d -o root -g caddy -m 0750 /etc/caddy-certs
if [ "${S4_AGENT:-0}" = 1 ]; then bun /rig/agent.ts & fi
exec setpriv --reuid=caddy --regid=caddy --init-groups \
	env HOME=/var/lib/caddy XDG_DATA_HOME=/var/lib/caddy/data XDG_CONFIG_HOME=/var/lib/caddy/config \
	caddy run --config /etc/s4/caddy.json
