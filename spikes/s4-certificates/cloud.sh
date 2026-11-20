#!/usr/bin/env bash
# S4 cloud half: DNS-01 on a real Cloudflare zone, Let's Encrypt staging only (see README).
#   S4C_CREDS=/path/to/creds.env ./cloud.sh            every step (8 orders, about 20 min)
#   S4C_CREDS=… ./cloud.sh account lego-wild           chosen steps (see cloud.ts)
# creds.env holds CF_ZONE_NAME, CF_ZONE_ID and CF_API_TOKEN (Zone:DNS:Edit on that zone). It is
# sourced only into the bun process. On exit the rig deletes every `_acme-challenge.yoal-w0-s4-*`
# TXT record left in the zone, proves none remain, and deletes the account, certificates and keys.
set -euo pipefail
cd "$(dirname "$0")"
: "${S4C_CREDS:?set S4C_CREDS to the creds.env path}"
run() { ( set -a; . "$S4C_CREDS"; set +a; exec bun cloud.ts "$@" ); }
cleanup() {
	run sweep || echo "!! sweep failed: check the zone for _acme-challenge.yoal-w0-s4-* TXT records" >&2
	run wipe
	[ "${S4_KEEP_IMAGES:-0}" = 1 ] || docker rmi -f yoal-w0-s4c-caddy >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker image inspect yoal-w0-s4c-caddy >/dev/null 2>&1 || docker build -q -t yoal-w0-s4c-caddy -f images/caddy-cf.Dockerfile images >/dev/null
steps=("$@")
[ ${#steps[@]} -gt 0 ] || steps=(account lego-wild caddy-wild lego-5b caddy-5b caddy-5a lego-5a)
rm -f results-cloud.json
run "${steps[@]}"
echo "results: $(pwd)/results-cloud.json"
