#!/usr/bin/env bash
# S9 cloud rig: one command. Needs HCLOUD_TOKEN in the environment (for a dedicated, otherwise empty
# Hetzner project), Docker (to build the pinned Caddy once) and Bun. Checks the project and the live
# price first (aborts over €2), creates 1 LB11 + 3 servers + 1 network + 1 SSH key, all labelled
# yoal-w0=s9, runs every scenario, and deletes everything labelled on every exit path (plus a
# detached watchdog after 2.5 h). Usage: HCLOUD_TOKEN=... cloud/run-cloud.sh [step...]
set -euo pipefail
cd "$(dirname "$0")/.."
[ -n "${HCLOUD_TOKEN:-}" ] || { echo "HCLOUD_TOKEN is not set" >&2; exit 2; }
teardown() {
	local code=$?
	bun cloud/infra.ts down || echo "TEARDOWN FAILED: list resources labelled yoal-w0=s9 and delete them" >&2
	bun cloud/infra.ts cost > tmp/cloud/out/cost.json 2>/dev/null || true
	exit $code
}
./cloud/build-caddy.sh
trap teardown EXIT INT TERM HUP
bun cloud/infra.ts up
bun cloud/scenarios-cloud.ts "$@"
echo "results: $(pwd)/tmp/cloud/out/results.json"
