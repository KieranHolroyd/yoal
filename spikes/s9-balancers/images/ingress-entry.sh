#!/bin/sh
# keepalived (when configured) and Caddy as siblings, so either can die without the other.
mkdir -p /run/caddy /run/yoal/health
[ -f /etc/keepalived/keepalived.conf ] && keepalived -n -l -D -f /etc/keepalived/keepalived.conf &
caddy run --config /etc/caddy/config.json &
wait
