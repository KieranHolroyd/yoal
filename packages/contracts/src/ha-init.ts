import * as z from 'zod';
import { haProfiles, type ClusterConfigUpdate, type HaProfile } from './cluster-config.ts';
import { featureEnvKey, type FeatureName } from './features.ts';
import { HA_PROFILE_REQUIRED_CHECKS, type HaCheckId, haPreflightReportSchema } from './ha-check.ts';
import { steeringDriverKinds, type SteeringDriverKind } from './ingress.ts';
import { nodeRegionSchema } from './region.ts';

/**
 * `yoal ha init --profile single|ha|ha-dr` (HA-PLAN H27, §8, W14; Wave 5 foundation). Lane B
 * (`ha/w5-b-ha-commands`) builds the command and `HaInitService`; this is the plan it applies.
 *
 * `haInitPlan` is pure and deterministic: the same profile, answers and facts always give the same
 * plan, byte for byte. It says which feature flags and cluster settings the profile sets, which
 * preflight checks must pass first, and the at most four questions (steering, arbiter,
 * certificate source, standby region), each with its default. `--profile single` reverses `ha`.
 *
 * **How `ha init` turns a flag on (decision, Wave 5 deviation D-W5-1).** Feature flags are read once
 * at start from `YOAL_FEATURE_*` in `yoal.env` (docs/OPS.md §2.5), and that stays the only flag
 * store: `ha init` never writes a flag and there is no settings-backed override. Instead:
 * - `plan` returns the exact env lines (`envLines`) for the operator to put in `yoal.env`;
 * - `apply` reads the running control plane's flags, and while any flag the profile needs differs
 *   it changes nothing and refuses with those lines and "restart the control plane";
 * - once the flags match and the required checks pass, `apply` writes the cluster settings through
 *   the existing `ClusterConfigService.update` and the profile through `HaService.setProfile`.
 * The installer's `--profile ha` (§8 step 1) writes the same lines into `yoal.env` at install time,
 * so the walkthrough still needs no hand-editing on a fresh machine.
 *
 * **Reversal.** `single` turns every HA flag the profile manages off and puts the managed cluster
 * settings back to their registry defaults (not to the values before `ha init`; deviation
 * D-W5-2). It never turns off an object-store backend flag: the platform store may depend on it.
 */

// ------------------------------------------------------------------ questions

export const haInitQuestionIds = ['steering', 'arbiter', 'certificates', 'standbyRegion'] as const;
export type HaInitQuestionId = (typeof haInitQuestionIds)[number];

/** The arbiter is the platform object store's conditional API (W9); this is its backend. */
export const haArbiterKinds = ['s3', 'azure', 'gcs'] as const;
export type HaArbiterKind = (typeof haArbiterKinds)[number];

/** `shared`: one ACME issuance distributed to every ingress (H20). `per-node`: today's behaviour. */
export const haCertificateSources = ['shared', 'per-node'] as const;
export type HaCertificateSource = (typeof haCertificateSources)[number];

/** Steering drivers `ha init` offers: every driver except `direct`, which is no steering at all. */
export const haInitSteeringDrivers = steeringDriverKinds.filter((kind) => kind !== 'direct') as Exclude<SteeringDriverKind, 'direct'>[];

export const haInitAnswersSchema = z
	.object({
		steering: z.enum(steeringDriverKinds).exclude(['direct']).optional(),
		arbiter: z.enum(haArbiterKinds).optional(),
		certificates: z.enum(haCertificateSources).optional(),
		/** `ha-dr` only. */
		standbyRegion: nodeRegionSchema.optional(),
	})
	.strict();
export type HaInitAnswers = z.infer<typeof haInitAnswersSchema>;

/** Facts the defaults depend on. The caller reads them; the plan never does I/O. */
export interface HaInitFacts {
	/** `config.platformStore.kind` (`local`, `r2`, `s3`, `azure`, `gcs`, …), or null when unset. */
	platformStoreKind?: string | null;
	/** Regions other than the control plane's that have an online data node, sorted. */
	otherRegions?: readonly string[];
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

/**
 * Every flag `ha init` manages, in the order the env lines are printed. Object-store backend flags
 * are only ever turned on (for the arbiter's backend), never off.
 */
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
	value: string | number | boolean | readonly string[];
}

export interface HaInitPlan {
	profile: HaProfile;
	questions: HaInitQuestion[];
	/** Questions without an answer or a default; `apply` refuses while any remain. */
	unanswered: HaInitQuestionId[];
	flags: HaInitFlagChange[];
	/** The patch `apply` passes to `ClusterConfigService.update`. */
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
}

function storeKindDefault(kind: string | null | undefined): HaArbiterKind {
	if (kind === 'azure' || kind === 'gcs') return kind;
	return 's3';
}

/**
 * The plan for `profile`. Pure: no clock, no randomness, no I/O; equal inputs give equal output.
 * Unknown answers for a profile that does not ask the question are ignored (`single` asks none;
 * `ha` asks three; `ha-dr` asks four).
 */
export function haInitPlan(profile: HaProfile, answers: HaInitAnswers = {}, facts: HaInitFacts = {}): HaInitPlan {
	if (!haProfiles.includes(profile)) throw new Error(`Unknown HA profile "${profile}".`);
	const questions: HaInitQuestion[] = [];
	const ask = (question: Omit<HaInitQuestion, 'value'>, answer: string | undefined) => {
		const value = answer ?? question.default;
		questions.push({ ...question, value });
		return value;
	};

	if (profile === 'single') {
		const flags = HA_INIT_FLAGS.map((name) => flagChange(name, false));
		const cluster: ClusterConfigUpdate = {
			ha: { profile: 'single' },
			steering: { driver: 'direct', stacked: [] },
			failover: { enabled: false },
			replicas: { spread: 'node' },
		};
		return finish(profile, questions, flags, cluster);
	}

	const steering = ask(
		{
			id: 'steering',
			prompt: 'How does traffic reach the ingress nodes?',
			options: haInitSteeringDrivers,
			default: 'external-lb',
		},
		answers.steering,
	) as Exclude<SteeringDriverKind, 'direct'>;
	const arbiter = ask(
		{
			id: 'arbiter',
			prompt: 'Which object store holds the leases (the arbiter)? It must answer conditional writes.',
			options: haArbiterKinds,
			default: storeKindDefault(facts.platformStoreKind),
		},
		answers.arbiter,
	) as HaArbiterKind;
	const certificates = ask(
		{
			id: 'certificates',
			prompt: 'Where do ingress certificates come from?',
			options: haCertificateSources,
			default: 'shared',
		},
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

	const on = new Set<FeatureName>(HA_INIT_FLAGS.filter((name) => name !== 'REGIONS' && name !== 'SHARED_CERTIFICATES'));
	if (certificates === 'shared') on.add('SHARED_CERTIFICATES');
	if (profile === 'ha-dr') on.add('REGIONS');
	const flags = HA_INIT_FLAGS.map((name) => flagChange(name, on.has(name)));
	if (arbiter === 'azure') flags.push(flagChange('OBJECT_STORE_AZURE', true));
	if (arbiter === 'gcs') flags.push(flagChange('OBJECT_STORE_GCS', true));

	const cluster: ClusterConfigUpdate = {
		ha: { profile },
		steering: {
			driver: steering,
			// Between regions, DNS failover sits on top of the in-region driver (H18 stacked, W13).
			stacked: profile === 'ha-dr' && steering !== 'dns-failover' ? ['dns-failover'] : [],
		},
		failover: { enabled: true },
		replicas: { spread: 'zone' },
	};
	return finish(profile, questions, flags, cluster, standbyRegion);
}

function flagChange(name: FeatureName, value: boolean): HaInitFlagChange {
	return { name, value, env: `${featureEnvKey(name)}=${value ? '1' : '0'}` };
}

function finish(
	profile: HaProfile,
	questions: HaInitQuestion[],
	flags: HaInitFlagChange[],
	cluster: ClusterConfigUpdate,
	standbyRegion: string | null = null,
): HaInitPlan {
	const settings: HaInitSettingChange[] = [];
	for (const [section, values] of Object.entries(cluster) as [string, Record<string, unknown>][])
		for (const [key, value] of Object.entries(values))
			settings.push({ path: `${section}.${key}`, value: value as HaInitSettingChange['value'] });
	return {
		profile,
		questions,
		unanswered: questions.filter((question) => question.value === null).map((question) => question.id),
		flags,
		cluster,
		settings,
		standbyRegion,
		preflight: HA_PROFILE_REQUIRED_CHECKS[profile],
		envLines: [...flags.map((flag) => flag.env), '# then restart the control plane: systemctl restart yoal-control-plane'],
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

/** `HaInitService.apply`: what was written. Flags are never written (see the module comment). */
export interface HaInitApplyView {
	profile: HaProfile;
	applied: HaInitSettingChange[];
	auditId: string | null;
}
