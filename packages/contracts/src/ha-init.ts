import * as z from 'zod';
import { haProfiles, type ClusterConfigUpdate, type HaProfile, type HaProfileApplied } from './cluster-config.ts';
import { FEATURE_FLAGS, featureEnvKey, type FeatureName } from './features.ts';
import { HA_PROFILE_REQUIRED_CHECKS, type HaCheckId, haPreflightReportSchema } from './ha-check.ts';
import { steeringDriverKinds, type SteeringDriverKind } from './ingress.ts';
import { REGIONS_DOWNGRADE_NOTE, nodeRegionSchema } from './region.ts';

/**
 * `yoal ha init --profile single|ha|ha-dr` (HA-PLAN H27, §8, W14; Wave 5 foundation). Lane B
 * (`ha/w5-b-ha-commands`) builds the command and `HaInitService`; this is the plan it applies.
 *
 * `haInitPlan` is pure and deterministic: the same profile, answers and facts always give the same
 * plan, byte for byte. It says which feature flags and cluster settings the profile sets, which
 * preflight checks must pass first, and the at most three questions (steering, certificate source,
 * standby region), each with its default.
 *
 * **No arbiter question.** The arbiter is the platform object store's conditional API (W9,
 * `arbiterStore(ctx.objectStore)`), chosen by `YOAL_OBJECT_STORE` in `yoal.env`. There is no
 * cluster setting for it, so `ha init` does not ask; the `platform-store` and
 * `arbiter-conditional-writes` checks verify it and print the env fix.
 *
 * **How `ha init` turns a flag on (Wave 5 deviation D-W5-1).** Feature flags are read once at start
 * from `YOAL_FEATURE_*` in `yoal.env` (docs/OPS.md §2.5), and that stays the only flag store: `ha
 * init` never writes a flag and there is no settings-backed override. Instead:
 * - `plan` returns the exact env lines (`envLines`) for the operator to put in `yoal.env` on every
 *   control-plane host;
 * - `apply` reads the running control plane's flags, and while any flag the profile needs differs
 *   it changes nothing and refuses with those lines and "restart the control plane"; the
 *   `flags-consistent` check refuses while the control-plane hosts disagree;
 * - once the flags match and the required checks pass, `apply` makes **one**
 *   `ClusterConfigService.update(cluster)` call, with `ha.profile` and `ha.applied` inside it (not a
 *   separate `HaService.setProfile`), so the profile and its settings change together or not at all.
 * The installer's `--profile ha` (§8 step 1) writes the same lines into `yoal.env` at install time.
 *
 * **What `single` reverses.** `ha.applied` (`haProfileAppliedSchema`) records the flags the applied
 * profile turns on and each setting it changed, with its value before the first profile. `single`
 * turns off only those flags and puts back only those settings; a setting set before any profile
 * (such as `failover.enabled`) is never touched. Flags live in env, so a flag the operator had on
 * before `ha init` cannot be told apart from one the profile turned on: `single` prints `=0` for the
 * profile's whole set and the operator keeps any line they want. Without a record, `single`
 * changes only the profile. `single` is refused while anything still depends on an HA feature
 * (`ha-dependents`), each with its own way back.
 *
 * **Two writers of `cluster.steering`.** `ha init` and blueprint apply (`cluster.steering`) both
 * write through `ClusterConfigService.update`, so the last write wins; each one's plan shows its
 * diff against the live value before it applies.
 *
 * **Rollback.** `ha-dr` turns on `REGIONS`; its notes carry `REGIONS_DOWNGRADE_NOTE`.
 */

// ------------------------------------------------------------------ questions

export const haInitQuestionIds = ['steering', 'certificates', 'standbyRegion'] as const;
export type HaInitQuestionId = (typeof haInitQuestionIds)[number];

/** `shared`: one ACME issuance distributed to every ingress (H20). `per-node`: today's behaviour. */
export const haCertificateSources = ['shared', 'per-node'] as const;
export type HaCertificateSource = (typeof haCertificateSources)[number];

/** Steering drivers `ha init` offers: every driver except `direct`, which is no steering at all. */
export const haInitSteeringDrivers = steeringDriverKinds.filter((kind) => kind !== 'direct') as Exclude<SteeringDriverKind, 'direct'>[];

export const haInitAnswersSchema = z
	.object({
		steering: z.enum(steeringDriverKinds).exclude(['direct']).optional(),
		certificates: z.enum(haCertificateSources).optional(),
		/** `ha-dr` only. */
		standbyRegion: nodeRegionSchema.optional(),
	})
	.strict();
export type HaInitAnswers = z.infer<typeof haInitAnswersSchema>;

/** The cluster settings `ha init` manages, in the order they are recorded and shown. */
export const HA_INIT_SETTINGS = ['steering.driver', 'steering.stacked', 'failover.enabled', 'replicas.spread'] as const;
export type HaInitSettingPath = (typeof HA_INIT_SETTINGS)[number];
type SettingValue = string | number | boolean | readonly string[];

/** Registry defaults of the managed settings, used when a fact is missing. */
const SETTING_DEFAULTS: Readonly<Record<HaInitSettingPath, SettingValue>> = {
	'steering.driver': 'direct',
	'steering.stacked': [],
	'failover.enabled': false,
	'replicas.spread': 'node',
};

/** Facts the plan depends on. The caller reads them; the plan never does I/O. */
export interface HaInitFacts {
	/** Regions other than the control plane's that have an online data node. */
	otherRegions?: readonly string[];
	/** The live values of the managed settings (`ClusterConfigService.get()`); a missing one is its default. */
	settings?: Partial<Record<HaInitSettingPath, SettingValue>>;
	/** `cluster_config.ha.applied`: what an earlier `ha init` set, or null. */
	applied?: HaProfileApplied | null;
}

export interface HaInitQuestion {
	id: HaInitQuestionId;
	prompt: string;
	options: readonly string[];
	/** The default the plan uses when the question is not answered; null when there is none. */
	default: string | null;
	/** What the plan uses: the answer, else the default. Null means the question still needs an answer. */
	value: string | null;
}

// ------------------------------------------------------------------ flags and settings

/** Every flag a profile can turn on, in the order the env lines are printed. */
export const HA_INIT_FLAGS = [
	'ENDPOINTS_GATEWAY',
	'RELEASE_PHASE',
	'INGRESS_SET',
	'SHARED_CERTIFICATES',
	'STEERING',
	'CONTROL_STANDBY',
	'SYNC_REPLICA',
	'PITR_REWIND',
	'DB_AUTO_PROMOTE',
	'REGIONS',
] as const satisfies readonly FeatureName[];

export interface HaInitFlagChange {
	name: FeatureName;
	value: boolean;
	/** The exact `yoal.env` line. */
	env: string;
}

/** One cluster setting the plan writes, for display; `cluster` is the patch itself. */
export interface HaInitSettingChange {
	path: string;
	value: SettingValue;
}

export interface HaInitPlan {
	profile: HaProfile;
	questions: HaInitQuestion[];
	/** Questions without an answer or a default; `apply` refuses while any remain. */
	unanswered: HaInitQuestionId[];
	/** The flags the profile turns on (`ha`, `ha-dr`) or off (`single`); no other flag is touched. */
	flags: HaInitFlagChange[];
	/** The one patch `apply` passes to `ClusterConfigService.update`, `ha.profile` and `ha.applied` included. */
	cluster: ClusterConfigUpdate;
	settings: HaInitSettingChange[];
	/**
	 * `ha-dr` only: the region the `regions` check verifies has an online data node, and the default
	 * standby region lane A offers when a database is given one. Not a cluster setting; null otherwise.
	 */
	standbyRegion: string | null;
	/** Checks that must be `pass` or `warn` before `apply` changes anything. */
	preflight: readonly HaCheckId[];
	/** The `yoal.env` lines for `flags`, then the restart; the only way `ha init` turns a flag on. */
	envLines: string[];
	/** Things the operator must know before applying (rollback limits, a missing record). */
	notes: string[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The plan for `profile`. Pure: no clock, no randomness, no I/O; equal inputs give equal output.
 * Answers to a question the profile does not ask are ignored.
 */
export function haInitPlan(profile: HaProfile, answers: HaInitAnswers = {}, facts: HaInitFacts = {}): HaInitPlan {
	if (!haProfiles.includes(profile)) throw new Error(`Unknown HA profile "${profile}".`);
	if (profile === 'single') return singlePlan(facts.applied ?? null);

	const questions: HaInitQuestion[] = [];
	const ask = (question: Omit<HaInitQuestion, 'value'>, answer: string | undefined) => {
		const value = answer ?? question.default;
		questions.push({ ...question, value });
		return value;
	};
	const steering = ask(
		{ id: 'steering', prompt: 'How does traffic reach the ingress nodes?', options: haInitSteeringDrivers, default: 'external-lb' },
		answers.steering,
	) as Exclude<SteeringDriverKind, 'direct'>;
	const certificates = ask(
		{ id: 'certificates', prompt: 'Where do ingress certificates come from?', options: haCertificateSources, default: 'shared' },
		answers.certificates,
	) as HaCertificateSource;
	let standbyRegion: string | null = null;
	if (profile === 'ha-dr') {
		const regions = [...(facts.otherRegions ?? [])].sort();
		standbyRegion = ask(
			{
				id: 'standbyRegion',
				prompt: 'Which region holds the standby (async replicas, manual promotion)?',
				options: regions,
				default: regions.length === 1 ? regions[0]! : null,
			},
			answers.standbyRegion,
		);
	}

	const onFlags = HA_INIT_FLAGS.filter(
		(name) => (name !== 'REGIONS' || profile === 'ha-dr') && (name !== 'SHARED_CERTIFICATES' || certificates === 'shared'),
	);
	const desired: Record<HaInitSettingPath, SettingValue> = {
		'steering.driver': steering,
		// Between regions, DNS failover sits on top of the in-region driver (H18 stacked, W13).
		'steering.stacked': profile === 'ha-dr' && steering !== 'dns-failover' ? ['dns-failover'] : [],
		'failover.enabled': true,
		'replicas.spread': 'zone',
	};
	const recorded: HaProfileApplied['settings'] = [];
	for (const path of HA_INIT_SETTINGS) {
		const earlier = facts.applied?.settings.find((item) => item.path === path);
		if (earlier) {
			recorded.push(earlier);
			continue;
		}
		const live = facts.settings?.[path] ?? SETTING_DEFAULTS[path];
		if (!same(live, desired[path])) recorded.push({ path, previous: live as HaProfileApplied['settings'][number]['previous'] });
	}
	const cluster: ClusterConfigUpdate = {
		ha: { profile, applied: { profile, flags: [...onFlags], settings: recorded } },
		steering: { driver: steering, stacked: desired['steering.stacked'] as SteeringDriverKind[] },
		failover: { enabled: true },
		replicas: { spread: 'zone' },
	};
	return finish({
		profile,
		questions,
		flags: onFlags.map((name) => flagChange(name, true)),
		cluster,
		standbyRegion,
		notes: profile === 'ha-dr' ? [REGIONS_DOWNGRADE_NOTE] : [],
	});
}

function singlePlan(applied: HaProfileApplied | null): HaInitPlan {
	if (!applied)
		return finish({
			profile: 'single',
			questions: [],
			flags: [],
			cluster: { ha: { profile: 'single', applied: null } },
			standbyRegion: null,
			notes: ['There is no record of what ha init set on this install, so only the profile changes. Check the YOAL_FEATURE_* lines and cluster settings by hand.'],
		});
	const flags = applied.flags.filter((name): name is FeatureName => name in FEATURE_FLAGS).map((name) => flagChange(name, false));
	const cluster: Record<string, Record<string, unknown>> = { ha: { profile: 'single', applied: null } };
	for (const { path, previous } of applied.settings) {
		const [section, key] = path.split('.') as [string, string];
		cluster[section] = { ...(cluster[section] ?? {}), [key]: previous };
	}
	return finish({ profile: 'single', questions: [], flags, cluster: cluster as ClusterConfigUpdate, standbyRegion: null, notes: [] });
}

function flagChange(name: FeatureName, value: boolean): HaInitFlagChange {
	return { name, value, env: `${featureEnvKey(name)}=${value ? '1' : '0'}` };
}

function finish(input: Omit<HaInitPlan, 'unanswered' | 'settings' | 'preflight' | 'envLines'>): HaInitPlan {
	const settings: HaInitSettingChange[] = [];
	for (const [section, values] of Object.entries(input.cluster) as [string, Record<string, unknown>][])
		for (const [key, value] of Object.entries(values))
			if (!(section === 'ha' && key === 'applied')) settings.push({ path: `${section}.${key}`, value: value as SettingValue });
	return {
		profile: input.profile,
		questions: input.questions,
		unanswered: input.questions.filter((question) => question.value === null).map((question) => question.id),
		flags: input.flags,
		cluster: input.cluster,
		settings,
		standbyRegion: input.standbyRegion,
		preflight: HA_PROFILE_REQUIRED_CHECKS[input.profile],
		envLines: [
			...input.flags.map((flag) => flag.env),
			'# on every control-plane host, then restart its control plane: systemctl restart yoal-control-plane',
		],
		notes: input.notes,
	};
}

// ------------------------------------------------------------------ requests and views

/** `POST /api/v1/ha/init` and `yoal ha init`. Without `apply: true` it only plans. */
export const haInitRequestSchema = z
	.object({
		profile: z.enum(haProfiles),
		answers: haInitAnswersSchema.default({}),
		/** Apply the plan. Refused while flags differ, a question is unanswered or a check fails. */
		apply: z.boolean().default(false),
	})
	.strict();
export type HaInitRequest = z.input<typeof haInitRequestSchema>;

/** `HaInitService.plan`: the plan, what differs from the running install, and the preflight. */
export interface HaInitPlanView {
	plan: HaInitPlan;
	/** Flags whose running value differs from the plan: set these lines and restart first. */
	flagsToChange: HaInitFlagChange[];
	/** Cluster settings whose stored value differs from the plan. */
	settingsToChange: HaInitSettingChange[];
	preflight: z.infer<typeof haPreflightReportSchema>;
	/** True when `apply` would change the install now. */
	ready: boolean;
	/** Why `apply` would refuse now, one sentence each. */
	blockers: string[];
}

/** `HaInitService.apply`: what the one `ClusterConfigService.update` wrote. Flags are never written. */
export interface HaInitApplyView {
	profile: HaProfile;
	applied: HaInitSettingChange[];
	auditId: string | null;
}
