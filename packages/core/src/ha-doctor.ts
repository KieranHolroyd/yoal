import {
	FEATURE_FLAG_NAMES,
	featureEnvKey,
	featureFlagDrift,
	haCheckNotBuilt,
	haCheckIds,
	haDependentChecks,
	summarizeHaChecks,
	type HaCheck,
	type HaCheckId,
	type HaDependent,
	type HaPreflightReport,
	type HaProfile,
	type Principal,
} from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { CoreError } from './errors.ts';
import { haFindingChecks, haFindings, regionChecks } from './ha-preflight.ts';
import { parseJson } from './util.ts';

/** Check ids the W12 findings already cover. */
const W12_CHECKS: ReadonlySet<HaCheckId> = new Set(['platform-store', 'registry-storage', 'identity', 'mail', 'telemetry-spool']);
/** Check ids built here in the foundation; every other id is lane A's or lane B's to build. */
const BUILT_CHECKS: ReadonlySet<HaCheckId> = new Set([...W12_CHECKS, 'flags-consistent', 'ha-dependents', 'regions']);

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
	'flags-consistent': 'Control-plane hosts run the same flags',
	'ha-dependents': 'Nothing depends on an HA feature',
};

/** Control-plane roles that mean a standby is enrolled. */
const STANDBY_ROLES = ['joining', 'standby', 'standby-behind', 'promoting'];

/**
 * `yoal ha preflight` and `yoal doctor` (HA-PLAN H27, W14). **Owner: Wave 5 lane B
 * (`ha/w5-b-ha-commands`); lane A builds the `regions` check.** The signatures are final.
 *
 * `preflight` returns every check in the `HaCheck` shape:
 * - the W12 platform-dependency findings, mapped without loss (`haFindingChecks`);
 * - `ha-dependents` (the gate on `--profile single`) and `flags-consistent`, built here;
 * - a `regions` warning for region values stored while `REGIONS` is off (they are placed as zone);
 * - an honest `skip` for each check no lane has built yet, so `ok` stays false for `ha` and `ha-dr`
 *   until they are. Lane B replaces the skips with real checks.
 * `doctor` checks the running install against its own profile, including node-local facts; it is
 * lane B's.
 */
export class HaDoctorService {
	constructor(private readonly ctx: CoreContext) {}

	preflight(principal: Principal, profile?: HaProfile): HaPreflightReport {
		if (!this.ctx.platformIam.allows(principal, 'platform:ha'))
			throw new CoreError('forbidden', 'High availability is for platform operators and admins.', 403);
		const target = profile ?? this.ctx.cluster.get().ha.profile;
		const checks: HaCheck[] = haCheckIds
			.filter((id) => !BUILT_CHECKS.has(id))
			.map((id) => haCheckNotBuilt(id, TITLES[id], id === 'regions' ? 'Wave 5 lane A' : 'Wave 5 lane B'));
		// Lane A (W13): the `regions` check, including stored region values while REGIONS is off.
		checks.push(...regionChecks(this.ctx, target));
		const findings = haFindingChecks(haFindings(this.ctx, target));
		checks.push(...findings);
		// A W12 check with no finding ran and found nothing to report.
		for (const id of W12_CHECKS)
			if (!findings.some((check) => check.id === id))
				checks.push({ id, title: TITLES[id], status: 'pass', evidence: ['Checked: nothing to report.'], fix: null, subject: null });
		checks.push(this.#flagsConsistent());
		checks.push(...haDependentChecks(this.haDependents()));
		const { ok, counts } = summarizeHaChecks(target, checks);
		return { profile: target, mode: 'preflight', ok, counts, checks, generatedAt: new Date(this.ctx.now()).toISOString() };
	}

	doctor(_principal: Principal): HaPreflightReport {
		throw new CoreError('not_built', '`yoal doctor` is not built yet (HA-PLAN W14, Wave 5 lane B).', 501);
	}

	/**
	 * Everything that still depends on an HA feature, in `haDependentKinds` order: what
	 * `--profile single` must refuse on. Internal facts; no permission check.
	 */
	haDependents(): HaDependent[] {
		const sqlite = this.ctx.sqlite;
		const out: HaDependent[] = [];
		const databases = sqlite
			.query<{ id: string; name: string; durability: string; failover_mode: string }, []>(
				'SELECT id, name, durability, failover_mode FROM databases WHERE deleted_at IS NULL ORDER BY name',
			)
			.all();
		for (const row of databases) if (row.durability === 'sync') out.push({ kind: 'sync-database', id: row.id, name: row.name });
		for (const row of databases) if (row.failover_mode === 'auto') out.push({ kind: 'armed-database', id: row.id, name: row.name });
		// `workloads.endpoints_gateway` lands from the Wave 5 review-debt lane; read it once it exists.
		const workloadColumns = sqlite.query<{ name: string }, []>('PRAGMA table_info(workloads)').all().map((row) => row.name);
		if (workloadColumns.includes('endpoints_gateway'))
			for (const row of sqlite
				.query<{ id: string; slug: string | null }, []>(
					"SELECT w.id AS id, p.slug AS slug FROM workloads w LEFT JOIN projects p ON p.id = w.project_id WHERE coalesce(w.endpoints_gateway, 0) NOT IN (0, '0', '') ORDER BY w.id",
				)
				.all())
				out.push({ kind: 'gateway-attachment', id: row.id, name: row.slug ?? row.id });
		for (const row of sqlite
			.query<{ id: string; name: string }, []>(
				`SELECT n.id AS id, n.name AS name FROM control_state c JOIN nodes n ON n.id = c.node_id WHERE c.role IN (${STANDBY_ROLES.map(() => '?').join(', ')}) ORDER BY n.name`,
			)
			.all(...(STANDBY_ROLES as [])))
			out.push({ kind: 'control-standby', id: row.id, name: row.name });
		for (const row of sqlite
			.query<{ id: string; name: string }, []>("SELECT id, name FROM nodes WHERE region <> 'default' ORDER BY name")
			.all())
			out.push({ kind: 'region', id: row.id, name: row.name });
		const steering = this.ctx.cluster.get().steering;
		if (steering.driver !== 'direct' || steering.stacked.length > 0)
			out.push({ kind: 'steering', id: steering.driver, name: steering.driver });
		return out;
	}

	#flagsConsistent(): HaCheck {
		const own = Object.fromEntries(FEATURE_FLAG_NAMES.map((name) => [name, featureEnabled(this.ctx.config, name)]));
		const hosts = [
			{ name: 'this control plane', flags: own as Record<string, boolean> },
			...this.ctx.sqlite
				.query<{ name: string; flags: string | null }, []>(
					'SELECT n.name AS name, c.feature_flags_json AS flags FROM control_state c JOIN nodes n ON n.id = c.node_id ORDER BY n.name',
				)
				.all()
				.map((row) => ({ name: row.name, flags: row.flags ? parseJson<Record<string, boolean> | null>(row.flags, null) : null })),
		];
		const drift = featureFlagDrift(hosts);
		const title = TITLES['flags-consistent'];
		if (drift.differences.length > 0)
			return {
				id: 'flags-consistent',
				title,
				status: 'fail',
				evidence: drift.differences.map(
					(item) => `${item.flag}: ${Object.entries(item.values).map(([host, value]) => `${host} ${value === null ? 'unset' : value ? 'on' : 'off'}`).join(', ')}`,
				),
				fix: {
					kind: 'env',
					value: `Make ${drift.differences.map((item) => featureEnvKey(item.flag as never)).join(', ')} the same in yoal.env on every control-plane host, then restart each control plane.`,
				},
				subject: null,
			};
		if (drift.unreported.length > 0)
			return {
				id: 'flags-consistent',
				title,
				status: 'warn',
				evidence: [`Cannot verify ${drift.unreported.join(', ')}: its control plane does not report its flags.`],
				fix: { kind: 'manual', value: `Update ${drift.unreported.join(', ')} to this release so it reports its flags.` },
				subject: null,
			};
		return { id: 'flags-consistent', title, status: 'pass', evidence: [`${hosts.length} control-plane host(s) agree.`], fix: null, subject: null };
	}

}
