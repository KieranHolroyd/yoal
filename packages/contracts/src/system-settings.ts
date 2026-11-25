import {
	FEATURE_FLAGS,
	FEATURE_FLAG_NAMES,
	OPT_IN_FEATURES,
	featureEnvKey,
	parseFeatureFlagValue,
	type FeatureArea,
	type FeatureName,
} from './features.ts';

/**
 * Settings → System (docs/OPS.md §4.3): every on/off setting in the control plane's
 * `/etc/yoal/yoal.env`, shown as a toggle. That is each `YOAL_FEATURE_<NAME>` flag (§2.5) plus the
 * boolean core settings below. Saving goes through the same root helper as every other platform
 * setting (`configure`, section `system`), which writes `0`/`1`, restarts the control plane and
 * puts the previous file back if it does not come up.
 *
 * Left out on purpose: agent-only switches (`YOAL_LOG_DRAIN`, `YOAL_TLS`) live in each node's
 * `agent.env`, not here; `YOAL_DEV_PASSWORD_LOGIN` is refused in production; installer and
 * restore-drill switches are read by scripts, not by the running control plane.
 */

export type SystemSettingArea = FeatureArea | 'access';

export interface SystemToggle {
	key: string;
	label: string;
	area: SystemSettingArea;
	description: string;
	/** Value when the key is unset. */
	default: boolean;
	/** `true` when turning it on is the risky direction (an opt-in flag). */
	optIn: boolean;
	/** Changing it this way weakens sign-in or data safety; the dashboard asks before saving. */
	risky: 'on' | 'off' | null;
	/** How the control plane reads the raw value (each core setting has its own rule). */
	parse: (value: string | undefined) => boolean;
}

export type SystemFeatureKey = `YOAL_FEATURE_${FeatureName}`;
export type SystemCoreKey = 'YOAL_OPEN_SIGNUP' | 'YOAL_OWNER_2FA' | 'YOAL_MCP_ALLOW_DCR';
export type SystemToggleKey = SystemFeatureKey | SystemCoreKey;

/** Feature flags whose off position removes a safety net, or whose on position copies or changes data. */
const RISKY_FEATURES: Partial<Record<FeatureName, 'on' | 'off'>> = {
	QUOTAS: 'off',
	DB_TLS: 'off',
	DB_PUBLIC_ANYWHERE: 'on',
	DB_AUTO_PROMOTE: 'on',
	REGIONS: 'on',
};

/** Core settings, in the order the page shows them. Parsing mirrors lib/server/config.ts and second-factor.ts. */
const CORE_TOGGLES: readonly (SystemToggle & { key: SystemCoreKey })[] = [
	{
		key: 'YOAL_OWNER_2FA',
		label: 'Owner second factor',
		area: 'access',
		description:
			'Org owners must prove a passkey or authenticator code each session before using the dashboard or API (D10). Turning it off makes owner sign-in single-factor.',
		default: true,
		optIn: false,
		risky: 'off',
		parse: (value) => (value === undefined ? true : value === '1'),
	},
	{
		key: 'YOAL_OPEN_SIGNUP',
		label: 'Open sign-up',
		area: 'access',
		description:
			'Anyone who can reach the dashboard can create an account. Production is invite-only (D10); turn this on only for a short, deliberate window.',
		default: false,
		optIn: true,
		risky: 'on',
		parse: (value) => value === '1',
	},
	{
		key: 'YOAL_MCP_ALLOW_DCR',
		label: 'MCP dynamic client registration',
		area: 'agents',
		description:
			'Keep legacy OAuth Dynamic Client Registration for MCP clients alongside client ID metadata documents (CIMD).',
		default: true,
		optIn: false,
		risky: null,
		parse: (value) => (value ?? '1') === '1',
	},
];

function featureLabel(name: string): string {
	const words = name.toLowerCase().split('_');
	const upper = new Set(['db', 'tls', 'pitr', 'mcp', 'slo', 'gcs']);
	return words
		.map((word, index) =>
			upper.has(word) ? word.toUpperCase() : index === 0 ? word[0]!.toUpperCase() + word.slice(1) : word,
		)
		.join(' ');
}

const FEATURE_TOGGLES: readonly (SystemToggle & { key: SystemFeatureKey })[] = FEATURE_FLAG_NAMES.map((name) => {
	const flag = FEATURE_FLAGS[name];
	return {
		key: featureEnvKey(name) as SystemFeatureKey,
		label: featureLabel(name),
		area: flag.area,
		description: flag.description,
		default: flag.default,
		optIn: OPT_IN_FEATURES.has(name),
		risky: RISKY_FEATURES[name] ?? null,
		parse: (value: string | undefined) => parseFeatureFlagValue(value) ?? flag.default,
	};
});

export const SYSTEM_TOGGLES: readonly (SystemToggle & { key: SystemToggleKey })[] = [...CORE_TOGGLES, ...FEATURE_TOGGLES];

export const SYSTEM_TOGGLE_KEYS: readonly SystemToggleKey[] = SYSTEM_TOGGLES.map((toggle) => toggle.key);

const BY_KEY = new Map<string, SystemToggle>(SYSTEM_TOGGLES.map((toggle) => [toggle.key, toggle]));

export function systemToggle(key: string): SystemToggle | undefined {
	return BY_KEY.get(key);
}

export function isSystemToggleKey(key: string): key is SystemToggleKey {
	return BY_KEY.has(key);
}

/** The value the running control plane uses for `key`, given its environment. */
export function systemToggleValue(key: SystemToggleKey, env: Record<string, string | undefined>): boolean {
	return BY_KEY.get(key)!.parse(env[key]);
}

/**
 * Turn the toggles a person changed into a `configure` request body. Only keys whose effective
 * value changes are touched; a key moved back to its default is removed from the env file rather
 * than pinned, so later releases can change the default.
 */
export function systemToggleChanges(
	desired: Partial<Record<string, boolean>>,
	env: Record<string, string | undefined>,
): { set: Partial<Record<SystemToggleKey, string>>; unset: SystemToggleKey[] } {
	const set: Partial<Record<SystemToggleKey, string>> = {};
	const unset: SystemToggleKey[] = [];
	for (const [key, value] of Object.entries(desired)) {
		const toggle = BY_KEY.get(key);
		if (!toggle || typeof value !== 'boolean') continue;
		const typed = key as SystemToggleKey;
		if (toggle.parse(env[key]) === value) continue;
		if (value === toggle.default) unset.push(typed);
		else set[typed] = value ? '1' : '0';
	}
	return { set, unset };
}
