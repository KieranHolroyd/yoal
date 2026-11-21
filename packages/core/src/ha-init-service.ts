import {
	HA_INIT_SETTINGS,
	featureEnvKey,
	haInitPlan,
	haInitRequestSchema,
	type ClusterConfig,
	type FeatureName,
	type HaInitApplyView,
	type HaInitFacts,
	type HaInitPlanView,
	type HaInitRequest,
	type HaInitSettingChange,
	type HaInitSettingPath,
	type Principal,
} from '@yoal/contracts';
import { nodes as nodesTable } from '@yoal/db';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, ValidationError } from './errors.ts';
import { rolesFor } from './nodes.ts';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `yoal ha init --profile single|ha|ha-dr` (HA-PLAN H27, §8, W14; Wave 5 lane B).
 *
 * - `plan` reads the facts (`HaInitFacts`: regions with data nodes, the live managed settings and
 *   `cluster_config.ha.applied`), calls the pure `haInitPlan`, diffs its flags against
 *   `ctx.config.features` and its settings against `ClusterConfigService.get()`, and runs
 *   `HaDoctorService.preflight` for the profile with the same answers. Read: `platform:ha`.
 * - `apply` refuses while a question is unanswered, a running flag differs from the plan (the
 *   message carries the `yoal.env` lines; `ha init` never writes a flag, see `ha-init.ts`), or a
 *   required check is not `pass`/`warn` (`flags-consistent` among them; `single` requires
 *   `ha-dependents`). Then it makes **one** `ClusterConfigService.update(plan.cluster)` call, with
 *   `ha.profile` and `ha.applied` inside it, and audits `ha.init`. Platform admin signed in to the
 *   dashboard, as every cluster-config write (an API key gets 403).
 *
 * The `single` plan excuses one dependent: `steering`, when the same update puts the driver back
 * to `direct` with nothing stacked. Turning the flag off first and the driver back in the apply
 * strands nothing; requiring the operator to set `direct` by hand first would only add a step.
 */
export class HaInitService {
	constructor(private readonly ctx: CoreContext) {}

	plan(principal: Principal, input: HaInitRequest): HaInitPlanView {
		if (!this.ctx.platformIam.allows(principal, 'platform:ha'))
			throw new CoreError('forbidden', 'High availability is for platform operators and admins.', 403);
		const parsed = haInitRequestSchema.safeParse(input);
		if (!parsed.success) throw new ValidationError('Invalid ha init request.', parsed.error.issues);
		const { profile, answers } = parsed.data;
		const config = this.ctx.cluster.get();
		const plan = haInitPlan(profile, answers, this.#facts(config));

		const flagsToChange = plan.flags.filter((flag) => featureEnabled(this.ctx.config, flag.name as FeatureName) !== flag.value);
		const settingsToChange = plan.settings.filter((setting) => !same(valueAt(config, setting.path), setting.value));
		const preflight = this.ctx.haDoctor.preflight(principal, profile, { answers });

		const blockers: string[] = [];
		for (const id of plan.unanswered) blockers.push(`Answer the ${id} question (--${id === 'standbyRegion' ? 'standby-region' : id}).`);
		if (flagsToChange.length > 0)
			blockers.push(
				`Set ${flagsToChange.map((flag) => flag.env).join(', ')} in yoal.env on every control-plane host, then restart each control plane.`,
			);
		const restoresDirect =
			profile === 'single' &&
			(plan.cluster.steering?.driver ?? config.steering.driver) === 'direct' &&
			(plan.cluster.steering?.stacked ?? config.steering.stacked).length === 0;
		for (const id of plan.preflight) {
			const entries = preflight.checks.filter((check) => check.id === id);
			if (entries.length === 0) {
				blockers.push(`The ${id} check did not run.`);
				continue;
			}
			for (const check of entries) {
				if (check.status === 'pass' || check.status === 'warn') continue;
				if (restoresDirect && check.id === 'ha-dependents' && check.subject?.kind === 'platform') continue;
				const why = check.status === 'skip' ? `not checked: ${check.evidence[0] ?? 'no reason given'}` : (check.fix?.value ?? check.evidence[0] ?? '');
				blockers.push(`${check.title}: ${why}`);
			}
		}
		return {
			plan,
			flagsToChange,
			settingsToChange,
			preflight,
			ready: blockers.length === 0 && settingsToChange.length > 0,
			blockers,
		};
	}

	async apply(principal: Principal, input: HaInitRequest): Promise<HaInitApplyView> {
		if (!this.ctx.platformIam.canAdminister(principal))
			throw new CoreError('forbidden', 'Only a platform admin role signed in to the dashboard can apply an HA profile.', 403);
		await this.ctx.haDoctor.probeArbiter();
		const view = this.plan(principal, input);
		const { plan } = view;
		if (view.blockers.length > 0) {
			const lines = view.flagsToChange.length > 0 ? ` yoal.env lines:\n${view.flagsToChange.map((flag) => flag.env).join('\n')}` : '';
			throw new ConflictError(`The ${plan.profile} profile is refused: ${view.blockers.join(' ')}${lines}`, view.blockers);
		}
		if (view.settingsToChange.length === 0) return { profile: plan.profile, applied: [], auditId: null };
		this.ctx.cluster.update(principal, plan.cluster);
		this.ctx.audit.record({
			principal,
			action: 'ha.init',
			resource: 'platform',
			resourceId: 'ha',
			args: {
				profile: plan.profile,
				settings: Object.fromEntries(view.settingsToChange.map((setting) => [setting.path, setting.value])),
				flags: plan.flags.map((flag) => `${featureEnvKey(flag.name as FeatureName)}=${flag.value ? 1 : 0}`),
			},
			result: 'ok',
		});
		const audit = this.ctx.sqlite
			.query<{ id: string }, []>("SELECT id FROM audit_log WHERE action = 'ha.init' ORDER BY rowid DESC LIMIT 1")
			.get();
		return { profile: plan.profile, applied: view.settingsToChange as HaInitSettingChange[], auditId: audit?.id ?? null };
	}

	#facts(config: ClusterConfig): HaInitFacts {
		const rows = this.ctx.db.select().from(nodesTable).all();
		const controlId = this.ctx.config.controlNodeId ?? this.ctx.config.edgeNodeId ?? null;
		const control = rows.find((row) => row.id === controlId) ?? rows.find((row) => rolesFor(row).includes('control'));
		const home = control?.region ?? 'default';
		const otherRegions = [
			...new Set(rows.filter((row) => row.status === 'online' && row.region !== home && rolesFor(row).includes('data')).map((row) => row.region)),
		];
		const settings = Object.fromEntries(HA_INIT_SETTINGS.map((path) => [path, valueAt(config, path)])) as HaInitFacts['settings'];
		return { otherRegions, settings, applied: config.ha.applied };
	}
}

/** `section.key` of the cluster config. */
function valueAt(config: ClusterConfig, path: string | HaInitSettingPath): unknown {
	const [section, key] = path.split('.') as [string, string];
	return (config as unknown as Record<string, Record<string, unknown> | undefined>)[section]?.[key];
}
