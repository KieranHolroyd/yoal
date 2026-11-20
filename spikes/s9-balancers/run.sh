#!/usr/bin/env bash
# S9 rig: build the pinned Caddy image, run every scenario, print the numbers, remove everything.
# Needs Docker (OrbStack on the Mac) and Bun; creates only `yoal-w0-s9-*` containers, one network
# and one image, all removed at the end. No cloud resource, no host port.
set -euo pipefail
cd "$(dirname "$0")"
IMAGE=yoal-w0-s9-ingress:2.11.8
cleanup() {
	bun run scenarios.ts down >/dev/null 2>&1 || true
	[ "${S9_KEEP_IMAGE:-0}" = 1 ] || docker rmi -f "$IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker build -q -t "$IMAGE" -f images/ingress.Dockerfile images >/dev/null
bun run scenarios.ts "$@"
echo "results: $(pwd)/tmp/out/results.json"
