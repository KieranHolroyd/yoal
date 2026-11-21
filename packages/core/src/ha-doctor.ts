import {
	haCheckNotBuilt,
	haCheckIds,
	summarizeHaChecks,
	type HaCheck,
	type HaCheckId,
	type HaPreflightReport,
	type HaProfile,
	type Principal,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { CoreError } from './errors.ts';
import { haFindingChecks, haFindings } from './ha-preflight.ts';

/** Check ids the W12 findings already cover; every other id is lane A's or lane B's to build. */
const W12_CHECKS: ReadonlySet<HaCheckId> = new Set(['platform-store', 'registry-storage', 'identity', 'mail', 'telemetry-spool']);

const TITLES: Readonly<Record<HaCheckId, string>> = {
	nodes: 'Nodes and roles',
	'node-capabilities': 'Agent capabilities',
	zones: 'Zones',
	regions: 'Regions',
	clocks: 'Clocks',
	'overlay-links': 'Overlay links',
	'arbiter-conditional-writes': 'Arbiter conditional writes',
	certificates: 'Certificates',
	steering: 'Steering',
	backups: 'Backups',
	headroom: 'Headroom',
	'platform-store': 'Platform object store',
	'registry-storage': 'Registry storage',
	identity: 'Identity',
	mail: 'Mail',
	'telemetry-spool': 'Telemetry spool',
};

/**
 * `yoal ha preflight` and `yoal doctor` (HA-PLAN H27, W14). **Owner: Wave 5 lane B
 * (`ha/w5-b-ha-commands`); lane A adds the `regions` check.** The signatures are final.
 *
 * `preflight` already returns every check in the `HaCheck` shape: the W12 platform-dependency
 * findings, mapped without loss (`haFindingChecks`), and an honest `skip` for each check id no lane
 * has built yet, so `ok` stays false for `ha` and `ha-dr` until they are. Lane B replaces the
 * skips with real checks. `doctor` checks the running install against its own profile, including
 * node-local facts; it is lane B's.
 */
export class HaDoctorService {
	constructor(private readonly ctx: CoreContext) {}

	preflight(principal: Principal, profile?: HaProfile): HaPreflightReport {
		if (!this.ctx.platformIam.allows(principal, 'platform:ha'))
			throw new CoreError('forbidden', 'High availability is for platform operators and admins.', 403);
		const target = profile ?? this.ctx.cluster.get().ha.profile;
		const checks: HaCheck[] = [
			...haCheckIds
				.filter((id) => !W12_CHECKS.has(id))
				.map((id) => haCheckNotBuilt(id, TITLES[id], id === 'regions' ? 'Wave 5 lane A' : 'Wave 5 lane B')),
		];
		const findings = haFindingChecks(haFindings(this.ctx, target));
		checks.push(...findings);
		// A W12 check with no finding ran and found nothing to report.
		for (const id of W12_CHECKS)
			if (!findings.some((check) => check.id === id))
				checks.push({ id, title: TITLES[id], status: 'pass', evidence: ['Checked: nothing to report.'], fix: null, subject: null });
		const { ok, counts } = summarizeHaChecks(target, checks);
		return { profile: target, mode: 'preflight', ok, counts, checks, generatedAt: new Date(this.ctx.now()).toISOString() };
	}

	doctor(_principal: Principal): HaPreflightReport {
		throw new CoreError('not_built', '`yoal doctor` is not built yet (HA-PLAN W14, Wave 5 lane B).', 501);
	}
}
