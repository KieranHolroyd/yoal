#!/usr/bin/env bash
# PITR-with-replicas restore drill (HA-PLAN W10, docs/PITR.md §Restore drill).
#
# It proves the stanza follows the primary across a promotion: write a marker, optionally promote a
# replica, write another marker on the NEW primary, then restore to a point after the promotion and
# require both markers in the copy. That fails if WAL archiving did not continue on the new primary
# (a stale stanza, a config that was never rewritten, or a restore pointed at the old node).
#
# Run it ON A NODE THAT CAN REACH THE DATABASE'S LOOPBACK URLS (the credentials URL points at
# 127.0.0.1), with curl, python3 and psql. Use a throwaway database: with YOAL_REWIND_DRILL_PROMOTE=1
# the database's primary changes, and this script does not promote it back.
#
# Required:
#   YOAL_CONTROL_URL             e.g. https://control.example.com (no trailing slash)
#   YOAL_API_TOKEN               database:read, database:create, database:credentials,
#                                database:update (promote), database:delete (cleanup)
#   YOAL_REWIND_DRILL_DATABASE  source database name (PITR on, at least one streaming replica)
#
# Optional:
#   YOAL_REWIND_DRILL_PROMOTE=1        promote a replica before the post-promotion marker
#   YOAL_REWIND_DRILL_REPLICA          replica id (default: the first promotable one)
#   YOAL_REWIND_DRILL_TARGET           new database name (default: <source>-rewind-drill-<epoch>)
#   YOAL_REWIND_DRILL_TARGET_TIME      restore to this ISO 8601 time instead of writing markers
#   YOAL_REWIND_DRILL_CANARY_SQL       SQL run against the restored copy (default SELECT 1)
#   YOAL_REWIND_DRILL_TIMEOUT          seconds to wait for the verified restore (default 3600)
#   YOAL_REWIND_DRILL_KEEP=1           keep the restored database (default: move it to the trash)
#
# Exit 0 means PASS; it prints the restore RTO and, when promoted, the promotion time.

set -euo pipefail

: "${YOAL_CONTROL_URL:?set YOAL_CONTROL_URL}"
: "${YOAL_API_TOKEN:?set YOAL_API_TOKEN}"
: "${YOAL_REWIND_DRILL_DATABASE:?set YOAL_REWIND_DRILL_DATABASE}"

SOURCE="$YOAL_REWIND_DRILL_DATABASE"
TARGET="${YOAL_REWIND_DRILL_TARGET:-${SOURCE}-rewind-drill-$(date +%s)}"
CANARY_SQL="${YOAL_REWIND_DRILL_CANARY_SQL:-SELECT 1}"
TIMEOUT="${YOAL_REWIND_DRILL_TIMEOUT:-3600}"
PROMOTE="${YOAL_REWIND_DRILL_PROMOTE:-0}"
PROMOTION_SECONDS=0
BASE="${YOAL_CONTROL_URL%/}/api/v1/databases"

for tool in curl python3 psql; do
	command -v "$tool" >/dev/null || { echo "pitr-rewind-drill: $tool is required" >&2; exit 1; }
done

say() { echo "pitr-rewind-drill: $*"; }
fail() { echo "pitr-rewind-drill: FAIL: $*" >&2; exit 1; }

enc() { python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }

api() {
	local method="$1" path="$2" body="${3:-}" extra="${4:-}"
	local args=(-sS -X "$method" -H "authorization: Bearer ${YOAL_API_TOKEN}" -w '\n%{http_code}')
	[ -n "$body" ] && args+=(-H 'content-type: application/json' --data "$body")
	[ -n "$extra" ] && args+=(-H "$extra")
	local out code
	out=$(curl "${args[@]}" "${BASE}${path}")
	code="${out##*$'\n'}"
	out="${out%$'\n'*}"
	if [ "$code" -ge 400 ]; then
		echo "pitr-rewind-drill: ${method} ${path} -> ${code}: ${out}" >&2
		return 1
	fi
	printf '%s' "$out"
}

json_get() {
	python3 -c '
import json, sys
d = json.load(sys.stdin)
for part in sys.argv[1].split("."):
    d = d.get(part) if isinstance(d, dict) else None
print("null" if d is None else d)
' "$1"
}

url_of() { api GET "/$(enc "$1")/credentials" | json_get 'credentials.url'; }

# 1. PITR on, archive healthy, a recoverable window.
STATUS=$(api GET "/$(enc "$SOURCE")/pitr")
[ "$(printf '%s' "$STATUS" | json_get 'pitr.enabled')" = "True" ] || fail "PITR is not enabled for ${SOURCE}."
FROM=$(printf '%s' "$STATUS" | json_get 'pitr.recoverableFrom')
[ "$FROM" != "null" ] || fail "${SOURCE} has no recoverable window yet."
ARCHIVE=$(printf '%s' "$STATUS" | json_get 'pitr.archiveStatus')
[ "$ARCHIVE" = "ok" ] || fail "WAL archive for ${SOURCE} is '${ARCHIVE}', not ok."
say "${SOURCE}: archive ok, recoverable from ${FROM}"

BEFORE="before-$(date +%s)-$$"
AFTER="after-$(date +%s)-$$"
if [ -n "${YOAL_REWIND_DRILL_TARGET_TIME:-}" ]; then
	TARGET_TIME="$YOAL_REWIND_DRILL_TARGET_TIME"
	MARKERS=0
else
	MARKERS=1
	SOURCE_URL=$(url_of "$SOURCE")
	psql "$SOURCE_URL" -X -v ON_ERROR_STOP=1 -qc \
		"CREATE TABLE IF NOT EXISTS yoal_restore_drill (marker text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now()); INSERT INTO yoal_restore_drill (marker) VALUES ('${BEFORE}')"
	say "pre-promotion marker written"
fi

# 2. Promote a replica, if asked. The database keeps its name; only its node and generation move.
if [ "$PROMOTE" = 1 ]; then
	STATE=$(api GET "/$(enc "$SOURCE")/replicas")
	GEN=$(printf '%s' "$STATE" | json_get 'primaryGeneration')
	REPLICA="${YOAL_REWIND_DRILL_REPLICA:-$(printf '%s' "$STATE" | python3 -c '
import json, sys
d = json.load(sys.stdin)
rows = [r for r in d.get("replicas", []) if r.get("status") in ("streaming", "lagging") and not r.get("sameNode")]
print(rows[0]["id"] if rows else "null")
')}"
	[ "$REPLICA" != "null" ] || fail "no promotable replica for ${SOURCE}"
	BODY='{"confirm": true}'
	say "promoting replica ${REPLICA} (generation ${GEN})"
	api POST "/$(enc "$SOURCE")/replicas/$(enc "$REPLICA")/promote" "$BODY" "if-match: ${GEN}" >/dev/null
	START_PROMOTE=$(date +%s)
	while :; do
		STATE=$(api GET "/$(enc "$SOURCE")/replicas")
		STAGE=$(printf '%s' "$STATE" | python3 -c '
import json, sys
d = json.load(sys.stdin)
rows = d.get("failovers", [])
print(rows[0].get("stage", "none") if rows else "none")
')
		case "$STAGE" in
			completed) break ;;
			failed) fail "promotion failed: $(printf '%s' "$STATE" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print((d.get("failovers") or [{}])[0].get("message", "unknown"))
')" ;;
		esac
		[ $(( $(date +%s) - START_PROMOTE )) -lt 180 ] || fail "promotion did not complete in 180 s (last stage: ${STAGE})"
		sleep 2
	done
	PROMOTION_SECONDS=$(( $(date +%s) - START_PROMOTE ))
	say "promotion completed in ${PROMOTION_SECONDS}s; the stanza follows the new primary"

	if [ "$MARKERS" = 1 ]; then
		# Write the second marker on the new primary. Use the fresh credentials URL (same name).
		SOURCE_URL=$(url_of "$SOURCE")
		psql "$SOURCE_URL" -X -v ON_ERROR_STOP=1 -qc \
			"INSERT INTO yoal_restore_drill (marker) VALUES ('${AFTER}')"
		say "post-promotion marker written"
	fi
fi

# Wait out the archive timeout and force a segment in both branches, so an explicit
# YOAL_REWIND_DRILL_TARGET_TIME is covered by archived WAL too (not just the marker path).
if [ "${MARKERS:-0}" = 1 ]; then
	TARGET_TIME=$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"))')
fi
say "restoring to ${TARGET_TIME}; waiting 150 s for the archive"
sleep 150
SOURCE_URL=$(url_of "$SOURCE")
psql "$SOURCE_URL" -X -qtAc 'SELECT pg_switch_wal()' >/dev/null
sleep 10

# 3. Restore and wait for the node to verify it.
BODY=$(python3 -c 'import json,sys; print(json.dumps({"name": sys.argv[1], "targetTime": sys.argv[2]}))' "$TARGET" "$TARGET_TIME")
START=$(date +%s)
say "restoring ${SOURCE} to ${TARGET_TIME} into ${TARGET}"
TARGET_ID=$(api POST "/$(enc "$SOURCE")/pitr/restore" "$BODY" | json_get 'database.id')
say "queued ${TARGET_ID}; waiting up to ${TIMEOUT}s for the verified restore"
while :; do
	STATUS=$(api GET "/$(enc "$SOURCE")/pitr")
	DB=$(api GET "/$(enc "$TARGET")")
	if [ "$(printf '%s' "$STATUS" | json_get 'pitr.lastRestoreDatabaseId')" = "$TARGET_ID" ] &&
		[ "$(printf '%s' "$STATUS" | json_get 'pitr.verifiedAt')" != "null" ] &&
		[ "$(printf '%s' "$DB" | json_get 'database.status')" = "running" ]; then
		break
	fi
	if [ "$(printf '%s' "$DB" | json_get 'database.status')" = "failed" ]; then
		fail "the node reported: $(printf '%s' "$DB" | json_get 'database.message')"
	fi
	[ $(( $(date +%s) - START )) -lt "$TIMEOUT" ] || fail "timed out after ${TIMEOUT}s; last status: ${STATUS}"
	sleep 5
done
RTO=$(( $(date +%s) - START ))
say "restore verified in ${RTO}s"

# 4. Contents: both markers must be present, so the target is after the promotion.
TARGET_URL=$(url_of "$TARGET")
if [ "${MARKERS:-0}" = 1 ]; then
	HAS_BEFORE=$(psql "$TARGET_URL" -X -tAc "SELECT count(*) FROM yoal_restore_drill WHERE marker = '${BEFORE}'")
	HAS_AFTER=$(psql "$TARGET_URL" -X -tAc "SELECT count(*) FROM yoal_restore_drill WHERE marker = '${AFTER}'")
	[ "$HAS_BEFORE" = 1 ] || fail "the pre-promotion marker is missing from ${TARGET}"
	[ "$HAS_AFTER" = 1 ] || fail "the post-promotion marker is missing from ${TARGET}; WAL did not follow the promotion"
	say "markers: pre-promotion and post-promotion both present"
fi
say "canary: $(psql "$TARGET_URL" -X -v ON_ERROR_STOP=1 -tAc "$CANARY_SQL")"

if [ "${YOAL_REWIND_DRILL_KEEP:-0}" != 1 ]; then
	api DELETE "/$(enc "$TARGET")" >/dev/null && say "moved ${TARGET} to the trash"
fi
PROMOTE_SUFFIX=""
if [ "$PROMOTE" = 1 ]; then
	PROMOTE_SUFFIX="; promotion ${PROMOTION_SECONDS}s"
fi
say "PASS (RTO ${RTO}s${PROMOTE_SUFFIX})"
