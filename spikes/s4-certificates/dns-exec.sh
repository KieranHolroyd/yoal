#!/bin/sh
# lego `exec` DNS provider → pebble-challtestsrv's management API (lab only; no real DNS).
# lego calls: dns-exec.sh present|cleanup <fqdn> <value>
set -eu
case "$1" in
	present) path=set-txt; body="{\"host\":\"$2\",\"value\":\"$3\"}" ;;
	cleanup) path=clear-txt; body="{\"host\":\"$2\"}" ;;
	*) exit 0 ;;
esac
exec bun -e "const r = await fetch('http://172.31.214.11:8055/$path', {method: 'POST', body: process.argv[1]}); if (!r.ok) process.exit(1)" "$body"
