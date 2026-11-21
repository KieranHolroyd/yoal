import {
	HA_CHECK_AREAS,
	HA_PROFILE_REQUIRED_CHECKS,
	featureEnvKey,
	haCheckIds,
	haDrillConfirmationIssue,
	type FeatureName,
	type HaCheck,
	type HaCheckArea,
	type HaCheckFix,
	type HaCheckStatus,
	type HaDrillScenario,
	type HaInitAnswers,
	type HaInitPlanView,
	type HaProfile
} from '@yoal/contracts';

/**
 * The guided setup on Settings → High availability, as pure functions: which step is current,
 * whether apply may be pressed, how each check and its fix read, the drill gates and the honest
 * database failover state. The Svelte components only render what these return, so the tests
 * here cover the rules the page enforces.
 */

// ------------------------------------------------------------------ profiles

export const profileChoices: ReadonlyArray<{ id: HaProfile; label: string; summary: string }> = [
	{
		id: 'single',
		label: 'Single',
		summary:
			'One edge and manual recovery. Choosing it turns off what an earlier HA setup turned on.'
	},
	{
		id: 'ha',
		label: 'HA',
		summary:
			'Several ingress nodes, steering, a control-plane standby and database replicas across zones, in one region.'
	},
	{
		id: 'ha-dr',
		label: 'HA with disaster recovery',
		summary:
			'HA, plus a standby region with async replicas that a person promotes when the primary region is lost.'
	}
];

// ------------------------------------------------------------------ questions

const OPTION_LABELS: Readonly<Record<string, string>> = {
	'external-lb': 'A load balancer you run (external-lb)',
	'dns-failover': 'DNS failover records (dns-failover)',
	vip: 'A floating IP between nodes (vip)',
	webhook: 'A webhook that updates your balancer (webhook)',
	'cloudflare-lb': 'Cloudflare Load Balancing (cloudflare-lb)',
	'cloudflare-tunnel': 'A Cloudflare Tunnel (cloudflare-tunnel)',
	shared: 'One certificate on every ingress (shared)',
	'per-node': 'Each node issues its own (per-node)'
};

/** A readable label for a question option; unknown values (a region name) read as themselves. */
export function optionLabel(value: string): string {
	return OPTION_LABELS[value] ?? value;
}

/** The answers to send: only values the operator changed from the question's default. */
export function changedAnswers(
	view: HaInitPlanView | undefined,
	answers: HaInitAnswers
): HaInitAnswers {
	if (!view) return answers;
	const out: Record<string, string> = {};
	for (const question of view.plan.questions) {
		const answer = (answers as Record<string, string | undefined>)[question.id];
		if (answer !== undefined && answer !== question.default) out[question.id] = answer;
	}
	return out as HaInitAnswers;
}

// ------------------------------------------------------------------ checks

export const checkStatusLabel: Readonly<Record<HaCheckStatus, string>> = {
	pass: 'Passes',
	warn: 'Warning',
	fail: 'Fails',
	skip: 'Not checked'
};

export const checkStatusTone: Readonly<
	Record<HaCheckStatus, 'success' | 'warning' | 'danger' | 'neutral'>
> = {
	pass: 'success',
	warn: 'warning',
	fail: 'danger',
	skip: 'neutral'
};

export const areaLabel: Readonly<Record<HaCheckArea, string>> = {
	nodes: 'Nodes',
	topology: 'Zones and regions',
	time: 'Clocks',
	network: 'Network',
	arbiter: 'Arbiter',
	certificates: 'Certificates',
	steering: 'Steering',
	data: 'Data',
	capacity: 'Capacity',
	platform: 'Platform'
};

export const fixKindLabel: Readonly<Record<HaCheckFix['kind'], string>> = {
	command: 'Run',
	setting: 'Change the setting',
	env: 'Add to yoal.env, then restart the control plane',
	manual: 'Do by hand'
};

export interface CheckRow {
	check: HaCheck;
	/** The profile needs this check to pass (or warn) before apply. */
	required: boolean;
	/** This entry stops apply: a required check that fails or did not run. */
	blocks: boolean;
}

export interface CheckGroup {
	area: HaCheckArea;
	label: string;
	rows: CheckRow[];
}

const statusOrder: Readonly<Record<HaCheckStatus, number>> = { fail: 0, skip: 1, warn: 2, pass: 3 };

/** One entry is blocking when the profile requires its check and it is neither `pass` nor `warn`. */
function blocks(profile: HaProfile, check: HaCheck): boolean {
	return (
		HA_PROFILE_REQUIRED_CHECKS[profile].includes(check.id) &&
		check.status !== 'pass' &&
		check.status !== 'warn'
	);
}

/**
 * Every check, grouped by area in contract order; inside an area the worst first. A required
 * check that did not appear at all is added as `skip`, so a missing check never reads as a pass.
 */
export function groupChecks(profile: HaProfile, checks: readonly HaCheck[]): CheckGroup[] {
	const all = [...checks];
	for (const id of HA_PROFILE_REQUIRED_CHECKS[profile])
		if (!all.some((check) => check.id === id))
			all.push({
				id,
				title: `${id}: not reported`,
				status: 'skip',
				evidence: ['The control plane did not report this check.'],
				fix: null,
				subject: null
			});
	const rank = (check: HaCheck) => haCheckIds.indexOf(check.id);
	const groups = new Map<HaCheckArea, CheckRow[]>();
	for (const check of all.sort(
		(a, b) => rank(a) - rank(b) || statusOrder[a.status] - statusOrder[b.status]
	)) {
		const area = HA_CHECK_AREAS[check.id];
		const rows = groups.get(area) ?? [];
		rows.push({
			check,
			required: HA_PROFILE_REQUIRED_CHECKS[profile].includes(check.id),
			blocks: blocks(profile, check)
		});
		groups.set(area, rows);
	}
	return [...groups.entries()].map(([area, rows]) => ({ area, label: areaLabel[area], rows }));
}

// ------------------------------------------------------------------ apply

export interface ApplyGate {
	enabled: boolean;
	/** Why apply is refused, one sentence each; empty when enabled. */
	reasons: string[];
}

/**
 * Whether **Apply** may be pressed. Refused while there is no plan, the plan is out of date (the
 * answers changed since it loaded), a question has no answer, a flag still differs from the plan,
 * or any check the profile requires fails or did not run. The server refuses the same cases; the
 * page never offers a button the server would refuse.
 */
export function applyGate(
	view: HaInitPlanView | undefined,
	options: { canApply: boolean; stale?: boolean; applying?: boolean }
): ApplyGate {
	const reasons: string[] = [];
	if (!options.canApply) reasons.push('Only a platform admin can apply a profile.');
	if (!view) {
		reasons.push('The plan has not loaded yet.');
		return { enabled: false, reasons };
	}
	if (options.stale) reasons.push('The plan is being checked again for your answers.');
	if (options.applying) reasons.push('Applying.');
	for (const id of view.plan.unanswered) reasons.push(`Answer the ${id} question.`);
	if (view.flagsToChange.length > 0)
		reasons.push(
			`${view.flagsToChange.length} feature flag${view.flagsToChange.length === 1 ? '' : 's'} must be set in yoal.env on every control-plane host first, then the control plane restarted.`
		);
	const failing = groupChecks(view.plan.profile, view.preflight.checks)
		.flatMap((group) => group.rows)
		.filter((row) => row.blocks);
	if (failing.length > 0)
		reasons.push(
			`${failing.length} required check${failing.length === 1 ? '' : 's'} must pass first: ${[...new Set(failing.map((row) => row.check.id))].join(', ')}.`
		);
	if (!view.preflight.ok && failing.length === 0) reasons.push('The preflight is not passing.');
	for (const blocker of view.blockers) if (!reasons.includes(blocker)) reasons.push(blocker);
	if (!view.ready && reasons.length === 0)
		reasons.push('The control plane says the plan is not ready to apply.');
	return { enabled: reasons.length === 0, reasons };
}

/** True when applying the plan changes nothing: same profile and no setting differs. */
export function planIsNoop(view: HaInitPlanView, currentProfile: HaProfile): boolean {
	return (
		view.plan.profile === currentProfile &&
		view.settingsToChange.length === 0 &&
		view.flagsToChange.length === 0
	);
}

// ------------------------------------------------------------------ steps

export const setupStepIds = ['profile', 'plan', 'questions', 'checks', 'apply'] as const;
export type SetupStepId = (typeof setupStepIds)[number];
export type SetupStepState = 'done' | 'current' | 'todo' | 'blocked';

/** The state of each step, for the stepper at the top of the guided setup. */
export function setupSteps(input: {
	chosen: HaProfile | null;
	view: HaInitPlanView | undefined;
	gate: ApplyGate;
}): Array<{ id: SetupStepId; state: SetupStepState }> {
	const { chosen, view, gate } = input;
	if (!chosen)
		return setupStepIds.map((id, index) => ({ id, state: index === 0 ? 'current' : 'todo' }));
	if (!view)
		return setupStepIds.map((id, index) => ({
			id,
			state: index === 0 ? 'done' : index === 1 ? 'current' : 'todo'
		}));
	const questionsDone = view.plan.unanswered.length === 0;
	const checksDone = groupChecks(view.plan.profile, view.preflight.checks).every((group) =>
		group.rows.every((row) => !row.blocks)
	);
	const flagsDone = view.flagsToChange.length === 0;
	return [
		{ id: 'profile', state: 'done' },
		{ id: 'plan', state: flagsDone ? 'done' : 'blocked' },
		{ id: 'questions', state: questionsDone ? 'done' : 'current' },
		{ id: 'checks', state: checksDone ? 'done' : 'blocked' },
		{ id: 'apply', state: gate.enabled ? 'current' : 'todo' }
	];
}

export const stepLabel: Readonly<Record<SetupStepId, string>> = {
	profile: 'Choose a profile',
	plan: 'Review the plan',
	questions: 'Answer the questions',
	checks: 'Pass the checks',
	apply: 'Apply'
};

// ------------------------------------------------------------------ drills

/** Contract text without its design-plan references ("(HA-PLAN §10)"), which UI text never cites. */
export function withoutPlanRefs(text: string): string {
	return text.replace(/\s*\((?:HA-PLAN|W\d+|H\d+|D\d+)[^)]*\)/g, '').trim();
}

export interface DrillGate {
	enabled: boolean;
	/** Why the run button is off; null when it may run. */
	reason: string | null;
}

/**
 * Whether a drill may run from the dashboard. A lab-only scenario never runs here; a scenario whose
 * flags are off is refused with the env line; the resource must be named; a `typed` scenario needs
 * the resource name typed back exactly; a `confirm` scenario needs the box ticked. The confirmation
 * rule is the contract's own (`haDrillConfirmationIssue`), so the page and the runner agree.
 */
export function drillGate(
	scenario: HaDrillScenario,
	input: {
		resource: string;
		typed: string;
		confirmed: boolean;
		flags: Partial<Record<FeatureName, boolean>>;
		canRun: boolean;
		drillDatabase?: string;
	}
): DrillGate {
	if (!input.canRun) return { enabled: false, reason: 'Only a platform admin can run a drill.' };
	if (scenario.availability !== 'fleet')
		return {
			enabled: false,
			reason:
				`Runs in the lab only. ${withoutPlanRefs(scenario.fleetUnavailableReason ?? '')}`.trim()
		};
	const missing = scenario.flags.filter((name) => !input.flags[name]);
	if (missing.length > 0)
		return {
			enabled: false,
			reason: `Needs ${missing.map((name) => `${featureEnvKey(name)}=1`).join(', ')}.`
		};
	if (scenario.id === 'database-failover' && !input.drillDatabase?.trim())
		return {
			enabled: false,
			reason: 'Name a disposable copy of the database: a drill never promotes the database itself.'
		};
	const confirm =
		scenario.confirmation === 'typed'
			? input.typed
			: scenario.confirmation === 'confirm'
				? input.confirmed || undefined
				: undefined;
	const issue = haDrillConfirmationIssue(
		scenario,
		input.resource,
		confirm === true ? true : typeof confirm === 'string' ? confirm : undefined
	);
	return issue ? { enabled: false, reason: issue } : { enabled: true, reason: null };
}

/** What the run request carries as `confirm` for a scenario, given what the operator entered. */
export function drillConfirmValue(
	scenario: Pick<HaDrillScenario, 'confirmation'>,
	typed: string,
	confirmed: boolean
): true | string | undefined {
	if (scenario.confirmation === 'typed') return typed.trim() || undefined;
	if (scenario.confirmation === 'confirm') return confirmed ? true : undefined;
	return undefined;
}

/** A measured duration for the results table. */
export function formatMs(value: number | null | undefined): string {
	if (value === null || value === undefined) return '—';
	if (value < 1_000) return `${value} ms`;
	if (value < 120_000) return `${(value / 1_000).toFixed(1)} s`;
	return `${Math.round(value / 60_000)} min`;
}

/** RPO as the results table shows it: lost commits where measured, else the lag at the fault. */
export function formatRpo(measured: {
	lostCommits: number | null;
	lagBytes: number | null;
}): string {
	if (measured.lostCommits !== null)
		return measured.lostCommits === 0
			? '0 lost commits'
			: `${measured.lostCommits} lost commit${measured.lostCommits === 1 ? '' : 's'}`;
	if (measured.lagBytes !== null)
		return `${measured.lagBytes.toLocaleString('en-GB')} bytes behind`;
	return '—';
}

// ------------------------------------------------------------------ database failover

export interface DatabaseFailoverFacts {
	/** `YOAL_FEATURE_DB_AUTO_PROMOTE`. */
	autoPromoteFlag: boolean;
	/** `failover.enabled` in the cluster settings. */
	controllerEnabled: boolean;
	/** The automatic promotion path is installed on this control plane. */
	handlerInstalled: boolean;
	/** Whether every involved data node can fence itself, and why not. */
	selfFencing: { active: boolean; reason: string };
}

export interface DatabaseFailoverState {
	/** Never "On" unless a promotion would really happen automatically. */
	label: 'Manual' | 'Not available yet' | 'Automatic';
	tone: 'neutral' | 'warning' | 'success';
	reason: string;
}

/**
 * The honest automatic database failover state. With the flag on but no data node able to fence
 * itself, the controller only reports what it would promote: that reads "Not available yet" with
 * the reason, never as on. "Automatic" needs the promotion path installed and failover enabled.
 */
export function databaseFailoverState(
	facts: DatabaseFailoverFacts,
	database?: { automatic: boolean }
): DatabaseFailoverState {
	if (!facts.autoPromoteFlag)
		return {
			label: 'Manual',
			tone: 'neutral',
			reason: 'Automatic database failover is off. Promote a replica by hand.'
		};
	if (!facts.selfFencing.active)
		return {
			label: 'Not available yet',
			tone: 'warning',
			reason: `${facts.selfFencing.reason} Until then the controller only reports which replica it would promote; a person promotes it.`
		};
	if (!facts.handlerInstalled)
		return {
			label: 'Not available yet',
			tone: 'warning',
			reason:
				'The automatic promotion path is not installed on this control plane. Restart it to install the path; until then a person promotes.'
		};
	if (!facts.controllerEnabled)
		return {
			label: 'Manual',
			tone: 'neutral',
			reason:
				'The failover controller is off (failover.enabled is false), so nothing promotes automatically.'
		};
	if (database && !database.automatic)
		return {
			label: 'Manual',
			tone: 'neutral',
			reason: 'This database is not armed for automatic failover.'
		};
	return {
		label: 'Automatic',
		tone: 'success',
		reason: 'A lost primary is promoted automatically, within the controller’s limits.'
	};
}

/** What the status cards show, assembled by the page from its load data. */
export interface StatusCardsInput {
	profile: HaProfile;
	steering: { driver: string; stacked: string[]; flag: boolean };
	ingress: { nodes: number; ready: number; inRotation: number | null; setFlag: boolean };
	arbiter: { kind: string; detail: string; external: boolean };
	control: {
		flag: boolean;
		members: Array<{ name: string; role: string; canPromote: boolean; lagSeconds: number | null }>;
	};
	databases: Array<{
		id: string;
		name: string;
		durability: { configured: string; effective: string } | null;
		standbyRegion: string | null;
		automatic: boolean;
	}>;
	failover: DatabaseFailoverFacts;
	regionsFlag: boolean;
	recentDrills: Array<{
		id: string;
		at: number | string;
		label: string;
		status: string;
		detail: string | null;
	}>;
}

// ------------------------------------------------------------------ admin actions

/** The word an admin types to rotate the CA. */
export const CA_ROTATE_CONFIRM = 'rotate';

export interface CaFacts {
	inUse: boolean;
	authorities: number;
	onPreviousCa: number;
}

/**
 * Whether **Rotate the CA** is offered and may be pressed. Hidden for anyone but a platform admin;
 * off while the CA is not in use, or while a node still holds a certificate the previous CA
 * signed (rotating again would cut it off), and until the confirmation word is typed.
 */
export function caRotateGate(
	ca: CaFacts | undefined,
	input: { isAdmin: boolean; typed: string }
): { visible: boolean; enabled: boolean; reason: string | null } {
	if (!input.isAdmin) return { visible: false, enabled: false, reason: null };
	if (!ca) return { visible: true, enabled: false, reason: 'The CA status has not loaded yet.' };
	if (!ca.inUse || ca.authorities === 0)
		return {
			visible: true,
			enabled: false,
			reason: 'There is no CA to rotate: nodes use it only while the endpoints gateway is on.'
		};
	if (ca.onPreviousCa > 0)
		return {
			visible: true,
			enabled: false,
			reason: `${ca.onPreviousCa} node${ca.onPreviousCa === 1 ? ' still holds a certificate' : 's still hold certificates'} from the previous CA. Rotating again would cut ${ca.onPreviousCa === 1 ? 'it' : 'them'} off from every peer; wait until each has renewed.`
		};
	if (input.typed.trim() !== CA_ROTATE_CONFIRM)
		return { visible: true, enabled: false, reason: `Type ${CA_ROTATE_CONFIRM} to confirm.` };
	return { visible: true, enabled: true, reason: null };
}

/** The word an admin types to move apps to their endpoints. */
export const MIGRATE_CONFIRM = 'move';

export interface MigrationFacts {
	gateway: boolean;
	projects: Array<{ status: 'will-move' | 'moved' | 'blocked' }>;
}

/** Whether **Move apps** is offered and may be pressed: admin only, with apps to move and the word typed. */
export function migrationGate(
	plan: MigrationFacts | undefined,
	input: { isAdmin: boolean; typed: string }
): { visible: boolean; enabled: boolean; reason: string | null } {
	if (!input.isAdmin) return { visible: false, enabled: false, reason: null };
	if (!plan) return { visible: true, enabled: false, reason: 'The dry run has not loaded yet.' };
	if (!plan.gateway)
		return {
			visible: true,
			enabled: false,
			reason: 'Turn on YOAL_FEATURE_ENDPOINTS_GATEWAY and YOAL_FEATURE_SERVICE_ENDPOINTS first.'
		};
	const moving = plan.projects.filter((item) => item.status === 'will-move').length;
	if (moving === 0) return { visible: true, enabled: false, reason: 'No app can move now.' };
	if (input.typed.trim() !== MIGRATE_CONFIRM)
		return { visible: true, enabled: false, reason: `Type ${MIGRATE_CONFIRM} to confirm.` };
	return { visible: true, enabled: true, reason: null };
}
