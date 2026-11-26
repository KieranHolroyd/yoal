/**
 * The journald matches behind each platform log unit key (docs/LOGS.md §5, LP5). The helper owns
 * the unit names: a caller only ever names a key of this table, so the platform log verb cannot
 * read an arbitrary unit. The key list mirrors `PLATFORM_LOG_UNIT_NAMES` in `@yoal/contracts`
 * (the agent's parity test keeps them equal); this module does not import it, like validate.ts.
 *
 * Unit names come from the installer and unit files (`scripts/systemd/*`, `scripts/install/*`).
 * Caddy runs as the release-managed `yoal-caddy.service` or a stock `caddy.service`. The registry
 * (zot) is a helper-run workload whose unit is `yoal-workload-reg_<id>.service`, so it is matched
 * by a fixed glob (`journalctl -u` accepts unit patterns).
 */
export const PLATFORM_LOG_UNITS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	'yoal-agent': ['yoal-agent.service'],
	'yoal-helper': ['yoal-helper.service'],
	'yoal-control-plane': ['yoal-control-plane.service'],
	'yoal-control-plane-standby': ['yoal-control-plane-standby.service'],
	'yoal-builder': ['yoal-builder.service'],
	caddy: ['yoal-caddy.service', 'caddy.service'],
	'yoal-mail': ['yoal-mail.service'],
	'yoal-clickhouse': ['yoal-clickhouse.service'],
	'yoal-registry': ['yoal-workload-reg_*.service'],
	'yoal-litestream': ['yoal-litestream.service'],
});

/** The journalctl `-u` matches for a key, or null when the key is not on the allow-list. */
export function platformLogMatches(unit: string): string[] | null {
	if (!Object.hasOwn(PLATFORM_LOG_UNITS, unit)) return null;
	return [...PLATFORM_LOG_UNITS[unit]!];
}
