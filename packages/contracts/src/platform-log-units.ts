/**
 * Yoal's own systemd units whose journald output is shipped as `platform` log records
 * (docs/LOGS.md §5 "Platform logs", LP5). This is a fixed allow-list of keys: the agent iterates
 * it, the helper maps each key to fixed `journalctl -u` matches (`apps/helper/src/platform-logs.ts`,
 * which owns the unit names because the helper never imports this package), and the control plane
 * refuses any other key. A node never names an arbitrary unit.
 *
 * A key travels as `target.unit` and becomes the stream `unit:<key>`.
 */
export const PLATFORM_LOG_UNIT_NAMES = [
	'yoal-agent',
	'yoal-helper',
	'yoal-control-plane',
	'yoal-control-plane-standby',
	'yoal-builder',
	'caddy',
	'yoal-mail',
	'yoal-clickhouse',
	'yoal-registry',
	'yoal-litestream',
] as const;

export type PlatformLogUnit = (typeof PLATFORM_LOG_UNIT_NAMES)[number];

const UNITS: ReadonlySet<string> = new Set(PLATFORM_LOG_UNIT_NAMES);

export function isPlatformLogUnit(value: unknown): value is PlatformLogUnit {
	return typeof value === 'string' && UNITS.has(value);
}
