#!/usr/bin/env bash
# S4 rig: build the pinned Caddy images, run the scenarios, print where the numbers are, remove
# every container and image it made. Needs Docker (OrbStack on the Mac) and Bun. Creates only
# `yoal-w0-s4-*` containers, one network and three images; no host ports, no cloud resource.
#   ./run.sh                 every scenario (about 45 min with the default 240 s lifetime)
#   ./run.sh a b-hot         chosen scenarios (see run.ts)
set -euo pipefail
cd "$(dirname "$0")"
cleanup() {
	bun run.ts down >/dev/null 2>&1 || true
	[ "${S4_KEEP_IMAGES:-0}" = 1 ] || docker rmi -f yoal-w0-s4-ingress:lock yoal-w0-s4-ingress:nolock yoal-w0-s4-cp >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker build -q -t yoal-w0-s4-ingress:lock --build-arg STORAGE_MODULE=github.com/techknowlogick/certmagic-s3@v1.5.0 -f images/ingress.Dockerfile images >/dev/null
docker build -q -t yoal-w0-s4-ingress:nolock --build-arg STORAGE_MODULE=github.com/ss098/certmagic-s3@8af482af5f392bcd01b5f3e72653dc24e0b96012 -f images/ingress.Dockerfile images >/dev/null
docker build -q -t yoal-w0-s4-cp -f images/cp.Dockerfile images >/dev/null
rm -f results.json
bun run.ts "$@"
echo "results: $(pwd)/results.json"
