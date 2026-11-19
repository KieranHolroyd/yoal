#!/bin/sh
#
# Function-suite e2e, node side. Runs as root on a disposable Debian/Ubuntu machine (a CI runner, a
# Lima VM): installs Yoal from a checkout with the real installer, claims the instance, provisions
# and deploys examples/function-suite with the real CLI, and runs its black-box suite. Usually
# started by tests/e2e/function-suite.e2e.ts, which also ships the checkout to a VM.
#
#   sudo sh tests/e2e/function-suite/node.sh <checkout> [suite.ts args...]
#
# A second run on the same machine upgrades the install from the checkout (installer --upgrade)
# and reuses the owner key, so code changes can be re-tested without a new machine.
#
# Environment:
#   E2E_OUT=/var/tmp/yoal-e2e       report, journals and unit dumps (always written)
#   E2E_INSTALL_FLAGS="..."         extra flags for a first install
#   E2E_NO_CLICKHOUSE=1             skip ClickHouse (Analytics Engine then has no store)
#   E2E_SKIP_INSTALL=1              use the installed release as it is
#   E2E_SLICE_MB=3072               workload slice for the node (the 1024 MB default is too small)
#
# Never run this on a machine you care about: it installs Yoal system-wide.
set -eu

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ $# -ge 1 ] || { echo "usage: node.sh <checkout> [suite args...]" >&2; exit 2; }
SRC=$(cd "$1" && pwd)
shift
OUT=${E2E_OUT:-/var/tmp/yoal-e2e}
STATE=/etc/yoal-e2e
BUN=/opt/yoal/runtime/bin/bun
EXAMPLE="$SRC/examples/function-suite"
STARTED=$(date -u '+%Y-%m-%d %H:%M:%S')

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }

mkdir -p "$OUT" "$STATE"
chmod 0700 "$STATE"
rm -f "$OUT"/*.txt "$OUT"/*.json

# Diagnostics on every exit: journals since this run started, the workload units, Caddy.
collect() {
	rc=$?
	set +e
	say "collecting diagnostics in $OUT"
	journalctl --since "$STARTED" --no-pager -u 'yoal-*' >"$OUT/journal-yoal.txt" 2>&1
	journalctl --since "$STARTED" --no-pager -u caddy >"$OUT/journal-caddy.txt" 2>&1
	systemctl list-units --all --no-pager 'yoal-*' >"$OUT/units.txt" 2>&1
	for unit in $(systemctl list-units --all --no-legend --plain 'yoal-workload-*' | awk '{print $1}'); do
		{
			echo "### $unit"
			systemctl cat "$unit"
			systemctl status --no-pager "$unit"
			echo
		} >>"$OUT/workload-units.txt" 2>&1
	done
	podman ps -a --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' >"$OUT/containers.txt" 2>&1
	ls -la /run/yoal-workloads >"$OUT/runtime-dir.txt" 2>&1
	cp "$EXAMPLE/.suite-report.json" "$OUT/suite-report.json" 2>/dev/null
	chmod -R a+rX "$OUT"
	exit "$rc"
}
trap collect EXIT

# An upgrade restarts the agent, which re-renders and restarts every function host a few seconds
# later, and a deploy restarts the host too. Stopping workerd can take the unit's whole 30 s stop
# timeout, and a request caught in that window waits and then gets a 503. Wait until no function
# unit has started or stopped for 30 s (at most 3 minutes) so the suite measures the node, not
# the restart.
settle() {
	say "waiting for function hosts to settle"
	i=0
	while [ "$i" -lt 36 ]; do
		changes=$(journalctl --since "-30s" --no-pager -o cat -u 'yoal-workload-wld_*' 2>/dev/null | grep -cE '^(Started|Stopping|Stopped) ' || true)
		busy=$(systemctl list-units --all --no-legend --plain 'yoal-workload-wld_*.service' | awk '$3 ~ /activating|deactivating/' | wc -l)
		[ "$changes" -eq 0 ] && [ "$busy" -eq 0 ] && [ "$i" -ge 6 ] && return 0
		i=$((i + 1))
		sleep 5
	done
}


# --- install ----------------------------------------------------------------------------------
if [ "${E2E_SKIP_INSTALL:-0}" = "1" ]; then
	say "using the installed release"
elif [ -f /etc/yoal/yoal.env ]; then
	say "upgrading the install from $SRC"
	YOAL_SOURCE_DIR="$SRC" sh "$SRC/install.sh" --yes --upgrade
else
	say "installing Yoal from $SRC"
	clickhouse=--clickhouse
	[ "${E2E_NO_CLICKHOUSE:-0}" = "1" ] && clickhouse=--no-clickhouse
	# shellcheck disable=SC2086 # E2E_INSTALL_FLAGS is a flag list
	YOAL_SOURCE_DIR="$SRC" sh "$SRC/install.sh" --yes --skip-dns-check "$clickhouse" ${E2E_INSTALL_FLAGS:-}
fi

ORIGIN=$(sed -n 's/^YOAL_PLATFORM_ORIGIN=["]\{0,1\}\([^"]*\)["]\{0,1\}$/\1/p' /etc/yoal/yoal.env)
[ -n "$ORIGIN" ] || { echo "no YOAL_PLATFORM_ORIGIN in /etc/yoal/yoal.env" >&2; exit 1; }
say "control plane at $ORIGIN"
i=0
until curl -fsS -o /dev/null --max-time 5 "$ORIGIN/api/setup/status"; do
	i=$((i + 1))
	[ "$i" -lt 120 ] || { echo "the control plane did not answer within 4 minutes" >&2; exit 1; }
	sleep 2
done

# --- owner + API key --------------------------------------------------------------------------
say "claiming the instance"
# The node's workload slice defaults to 1024 MB whatever its RAM, and the suite's storage (256),
# Postgres (512) and broker (256) fill that alone: the owner raises it like an admin would.
"$BUN" "$SRC/tests/e2e/function-suite/bootstrap.ts" --out "$STATE/token" --owner "$STATE/owner.json" \
	--slice-mb "${E2E_SLICE_MB:-3072}"
YOAL_URL=$ORIGIN
YOAL_TOKEN=$(cat "$STATE/token")
export YOAL_URL YOAL_TOKEN

# The installer enrolls the edge node before it returns; provision.ts waits for every service it
# creates to run, which is the real readiness signal (GET /api/v1/nodes refuses API keys).

# --- deploy + test ----------------------------------------------------------------------------
settle

say "installing the CLI and example dependencies"
export PATH="/opt/yoal/runtime/bin:$PATH"
(cd "$SRC" && "$BUN" install --frozen-lockfile)
(cd "$EXAMPLE" && "$BUN" install --frozen-lockfile --production)

say "provisioning and deploying function-suite"
(cd "$EXAMPLE" && "$BUN" scripts/provision.ts --cli "$BUN $SRC/apps/cli/src/main.ts")

settle

say "running the suite"
cd "$EXAMPLE"
"$BUN" scripts/suite.ts "$@"
