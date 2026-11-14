#!/usr/bin/env bash
# Build the usage collector and its dashboard and deploy them to Yoal.
#
#   apps/usage/deploy/deploy.sh [-m message] [--no-wait]
#
# `bun build` bundles the server, Better Auth and the React dashboard into one directory with no
# node_modules (`yoal deploy` never ships those). The project's runtime settings live in
# deploy/blueprint.yaml; apply that first when they change.
set -euo pipefail

project="${YOAL_PROJECT:-yoal-analytics-engine}"
app_url="${YOAL_APP_URL:-https://yoal-analytics-engine.kierancloud.dev}"
message=""
wait=true
while [ $# -gt 0 ]; do
	case "$1" in
		-m | --message) message="$2"; shift 2 ;;
		--no-wait) wait=false; shift ;;
		-h | --help) sed -n 2,8p "$0"; exit 0 ;;
		*) echo "unknown option: $1" >&2; exit 2 ;;
	esac
done

for tool in yoal bun curl git; do
	command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool is not installed or not on PATH" >&2; exit 1; }
done

app="$(cd "$(dirname "$0")/.." && pwd)"
out="$(mktemp -d "${TMPDIR:-/tmp}/yoal-usage-release.XXXXXX")"
trap 'rm -rf "$out"' EXIT

echo "==> Building into $out"
(cd "$app" && bun build --target=bun --production --outdir "$out" src/process.ts >/dev/null)
[ -f "$out/process.js" ] || { echo "error: the build produced no process.js" >&2; exit 1; }

if [ -z "$message" ]; then
	sha="$(git -C "$app" rev-parse --short HEAD 2>/dev/null || echo unknown)"
	dirty="$(git -C "$app" status --porcelain -- . 2>/dev/null | head -1)"
	message="usage collector ${sha}${dirty:+ (dirty)}"
fi

echo "==> Deploying to $project"
yoal deploy "$out" --project "$project" --no-create -m "$message"

if $wait; then
	echo "==> Waiting for $app_url/healthz"
	for _ in $(seq 1 60); do
		if curl -fsS "$app_url/healthz" 2>/dev/null | grep -q '"ok":true'; then
			echo "==> Up: $app_url"
			exit 0
		fi
		sleep 3
	done
	echo "error: $app_url/healthz did not answer within 3 minutes; check: yoal logs $project" >&2
	exit 1
fi
