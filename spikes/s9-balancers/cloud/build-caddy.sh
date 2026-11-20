#!/usr/bin/env bash
# Builds the pinned ingress Caddy (as .github/workflows/release.yml builds it) for linux/amd64 into
# tmp/bin/caddy. Uses the same pins as images/ingress.Dockerfile; nothing is committed.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p tmp/bin tmp/gocache
[ -x tmp/bin/caddy ] && exit 0
docker run --rm -e GOTOOLCHAIN=auto -e CGO_ENABLED=0 \
  -v "$PWD/tmp/bin:/out" -v "$PWD/tmp/gocache:/root/go" --name yoal-w0-s9-caddybuild golang:1.24-alpine sh -c '
  apk add --no-cache git >/dev/null &&
  go install github.com/caddyserver/xcaddy/cmd/xcaddy@v0.4.7 &&
  GOOS=linux GOARCH=amd64 xcaddy build v2.11.8 --with github.com/caddy-dns/cloudflare@v0.2.4 --output /out/caddy'
