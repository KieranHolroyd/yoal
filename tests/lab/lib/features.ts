/**
 * Feature flags on the lab (`lab up --feature NAME=1`, repeatable).
 *
 * The platform reads every flag once, at start, from `YOAL_FEATURE_<NAME>` in its environment
 * (packages/contracts/src/features.ts). The installer keeps every line of `/etc/yoal/yoal.env` it
 * does not own across re-runs and `--upgrade` (scripts/install/main.ts writeSecrets), and has no
 * flag of its own for features, so the lab renders the lines into the env files the installer
 * wrote, the way an operator turns a flag on (docs/OPS.md §2.5), and restarts the unit that reads
 * each file. Agents do not read feature flags today; their `agent.env` carries the same lines so a
 * node's environment says what the fleet runs with.
 *
 * The chosen flags are kept in `tests/lab/.state/lab.json`; scenarios ask the platform itself
 * (`GET /api/setup/status` → `features`, the resolved values) rather than trusting that file.
 */
import { FEATURE_ENV_PREFIX, FEATURE_FLAGS, parseFeatureFlagValue } from '../../../packages/contracts/src/features.ts';
import type { LabRole } from '../lab.config.ts';

export type LabFeatures = Record<string, boolean>;

/** `--feature NAME=VALUE` (repeatable) → { NAME: boolean }. Names are the registry's; values 0/1/true/false. */
export function parseFeatureArgs(args: string[]): LabFeatures {
	const out: LabFeatures = {};
	for (let i = 0; i < args.length; i++) {
		if (args[i] !== '--feature') continue;
		const raw = args[i + 1];
		const eq = raw?.indexOf('=') ?? -1;
		if (!raw || raw.startsWith('--') || eq <= 0) throw new Error(`--feature takes NAME=VALUE, e.g. --feature RELEASE_PHASE=1 (got ${raw ?? 'nothing'})`);
		const name = raw.slice(0, eq).trim().toUpperCase().replace(new RegExp(`^${FEATURE_ENV_PREFIX}`), '');
		const value = raw.slice(eq + 1).trim().toLowerCase();
		if (!(name in FEATURE_FLAGS)) throw new Error(`--feature: unknown feature flag ${name} (the registry is packages/contracts/src/features.ts)`);
		if (!['0', '1', 'true', 'false'].includes(value)) throw new Error(`--feature ${name}: the value is 0, 1, true or false (got ${raw.slice(eq + 1)})`);
		out[name] = parseFeatureFlagValue(value)!;
		i++;
	}
	return out;
}

/** An earlier `up`'s flags, then this one's: a value given now wins. */
export function mergeFeatures(previous: LabFeatures | undefined, next: LabFeatures): LabFeatures {
	return { ...(previous ?? {}), ...next };
}

export function formatFeatures(features: LabFeatures): string {
	const entries = Object.entries(features).sort(([a], [b]) => a.localeCompare(b));
	return entries.length ? entries.map(([name, on]) => `${name}=${on ? 1 : 0}`).join(', ') : 'none';
}

/** The env files a node role has, and the unit that reads each one. */
export function featureEnvFiles(role: LabRole): Array<{ file: string; unit: string }> {
	return [
		...(role === 'control' ? [{ file: '/etc/yoal/yoal.env', unit: 'yoal-control-plane.service' }] : []),
		{ file: '/etc/yoal/agent.env', unit: 'yoal-agent.service' },
	];
}

/**
 * Set `YOAL_FEATURE_<NAME>=0|1` for each flag in an env file's text: an existing line is replaced
 * in place, a missing one appended; every other line is kept as it is. `changed` is false when the
 * file already says so, so `lab up` restarts nothing on a re-run.
 */
export function renderFeatureEnv(text: string, features: LabFeatures): { text: string; changed: boolean } {
	const lines = text.length ? text.replace(/\n$/, '').split('\n') : [];
	let changed = false;
	for (const [name, on] of Object.entries(features)) {
		const key = `${FEATURE_ENV_PREFIX}${name}`;
		const wanted = `${key}=${on ? 1 : 0}`;
		const index = lines.findIndex((line) => line.trim().startsWith(`${key}=`));
		if (index < 0) {
			lines.push(wanted);
			changed = true;
		} else if (lines[index] !== wanted) {
			lines[index] = wanted;
			changed = true;
		}
	}
	if (!changed) return { text, changed };
	return { text: `${lines.join('\n')}\n`, changed };
}

/** Do the platform's resolved flags match what the lab asked for? The names that do not. */
export function featureMismatches(asked: LabFeatures, platform: Record<string, boolean> | null): string[] {
	if (!platform) return Object.keys(asked);
	return Object.entries(asked)
		.filter(([name, on]) => platform[name] !== on)
		.map(([name]) => name);
}
