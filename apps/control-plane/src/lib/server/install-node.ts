export interface NodeScriptSource {
	/** GitHub `owner/name` the control plane was installed from (its release meta.json). */
	repo: string;
	/** Release channel the control plane follows; a fresh worker installs the same one. */
	channel: 'stable' | 'canary';
}

/**
 * The small public installer served at `/install/node.sh` (docs/CLUSTERING.md §4.1, C1).
 *
 * It is intentionally a POSIX script rather than a second installer implementation. On a machine
 * that already has `yoal-agent`/`yoal-helper` it only starts the helper, exchanges the single-use
 * token for a node identity, writes the environment file and enables the units. On a fresh
 * machine it hands over to the repository's `install.sh --join` (the worker install), from the
 * control plane's own repo and channel, which builds the agent/helper and joins in one go.
 * The control plane never runs code on the node.
 */
export function renderNodeScript(platformOrigin: string, source: NodeScriptSource): string {
	const origin = shellQuote(platformOrigin.replace(/\/+$/, ''));
	const repo = shellQuote(source.repo);
	const channel = shellQuote(source.channel);
	return `#!/bin/sh
# Yoal node installer (managed overlay, C1). One token, one machine; the token is consumed by
# yoal-agent join. Without yoal-agent, the worker install (install.sh --join) runs first.
set -eu

ORIGIN=${origin}
REPO=${repo}
CHANNEL=${channel}
TOKEN=''
NAME=''
ENDPOINT=''

usage() {
	echo "usage: node.sh --token <join-token> --name <node-name> [--endpoint <host[:port]>]" >&2
	exit 2
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--token) [ "$#" -ge 2 ] || usage; TOKEN=$2; shift 2 ;;
		--name) [ "$#" -ge 2 ] || usage; NAME=$2; shift 2 ;;
		--endpoint) [ "$#" -ge 2 ] || usage; ENDPOINT=$2; shift 2 ;;
		-h|--help) usage ;;
		*) echo "unknown argument: $1" >&2; usage ;;
	esac
done

[ -n "$TOKEN" ] || usage
[ -n "$NAME" ] || usage
[ "$(id -u)" = "0" ] || { echo "run as root (sudo sh -s -- ...)" >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "systemd is required" >&2; exit 1; }

if ! command -v yoal-agent >/dev/null 2>&1; then
	# Fresh machine: the worker install builds agent + helper, joins and starts the units.
	command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
	echo "yoal-agent is not installed; installing Yoal ($CHANNEL) as a worker of $ORIGIN."
	TMP=$(mktemp -d)
	trap 'rm -rf "$TMP"' EXIT
	curl -fsSL "https://raw.githubusercontent.com/$REPO/main/install.sh" -o "$TMP/install.sh" || {
		echo "could not download install.sh from $REPO" >&2
		exit 1
	}
	set -- --yes --join "$ORIGIN" --name "$NAME"
	[ -z "$ENDPOINT" ] || set -- "$@" --endpoint "$ENDPOINT"
	# The token travels in the environment, not on the installer's command line.
	YOAL_JOIN_TOKEN=$TOKEN YOAL_REPO=$REPO YOAL_CHANNEL=$CHANNEL sh "$TMP/install.sh" "$@"
	exit 0
fi

mkdir -p /etc/yoal
chmod 700 /etc/yoal
systemctl start yoal-helper >/dev/null 2>&1 || true

# Keep whatever environment file existed; a rerun repairs rather than destroys.
if [ -f /etc/yoal/agent.env ]; then
	cp /etc/yoal/agent.env "/etc/yoal/agent.env.bak.$(date +%s)"
fi

set -- join "$ORIGIN" --token "$TOKEN" --name "$NAME" --network-mode yoal
[ -z "$ENDPOINT" ] || set -- "$@" --public-address "$ENDPOINT"
yoal-agent "$@" > /etc/yoal/agent.env
chmod 600 /etc/yoal/agent.env

systemctl enable --now yoal-helper >/dev/null 2>&1 || true
systemctl enable --now yoal-agent
echo "Node '$NAME' joined. It appears in Nodes after its first heartbeat."
`;
}

function shellQuote(value: string): string {
	if (!/^[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$/.test(value)) return `'${value.replaceAll("'", `'\\''`)}'`;
	return value;
}
