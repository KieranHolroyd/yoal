import * as z from 'zod';
import type { HaProfile } from './cluster-config.ts';

/**
 * The preflight and doctor check contract (HA-PLAN H27, W14; Wave 5 foundation). One shape for
 * every surface: `yoal ha preflight`, `yoal doctor`, `yoal ha init`, the REST and MCP read tools and
 * Settings → High availability all show `HaCheck`s, so a check means the same thing everywhere.
 *
 * - `id` is stable and comes from `haCheckIds`; a check that looks at several subjects (one node's
 *   clock, one zone) appears once per subject, with `subject` set.
 * - `status`: `pass`, `warn` (a fact the operator should see; never blocks), `fail` (blocks the
 *   profile) or `skip` (not applicable, or not built yet: `evidence` says which).
 * - `fix` is the exact change that clears it: a command to run, a setting to change, an env line
 *   for `yoal.env`, or a manual step. Null when the check passes or is skipped.
 *
 * The W12 platform-dependency findings (`packages/core/src/ha-preflight.ts`, `HaFinding`) keep their
 * keys as check ids and map onto this shape with `haFindingStatus`; none is dropped. Lane B
 * (`ha/w5-b-ha-commands`) builds the new checks; lane A adds the region checks.
 */

export const haCheckStatuses = ['pass', 'warn', 'fail', 'skip'] as const;
export type HaCheckStatus = (typeof haCheckStatuses)[number];

/** Grouping for display; one area per check id. */
export const haCheckAreas = ['nodes', 'topology', 'time', 'network', 'arbiter', 'certificates', 'steering', 'data', 'capacity', 'platform'] as const;
export type HaCheckArea = (typeof haCheckAreas)[number];

/**
 * Stable check ids, in display order. Never renumber or reuse one: scripts and the dashboard key
 * on them. The last five are the W12 findings (`HaFinding.key`), unchanged.
 */
export const haCheckIds = [
	/** Enough online nodes with the roles the profile needs (ingress, data, control). */
	'nodes',
	/** Every involved node runs an agent with each capability the profile's flags need (§9, §13.7). */
	'node-capabilities',
	/** Ingress, data and control nodes span enough zones that losing one zone loses no role. */
	'zones',
	/** Every zone is in exactly one region; `ha-dr` has a standby region with a data node (H26). */
	'regions',
	/** Each node's clock is within the lease skew budget of the control plane's. */
	'clocks',
	/** Every overlay link between ingress, data and control nodes is up (WireGuard handshake age). */
	'overlay-links',
	/** The arbiter store answers a conditional write (`If-None-Match`, `If-Match`) correctly (W9). */
	'arbiter-conditional-writes',
	/** Every ingress holds the certificates its routes need, from one issuance (H20). */
	'certificates',
	/** The steering driver is set, its preflight passes, and it sees every ingress (H18). */
	'steering',
	/** Databases have a verified backup or PITR on an off-node store (L1); backups can restore. */
	'backups',
	/** The fleet can lose its largest node (or zone) and still place every copy (N+1). */
	'headroom',
	/** W12: the platform object store is external, not the control host's disk (H28). */
	'platform-store',
	/** W12: registry blobs are not on one node (H28). */
	'registry-storage',
	/** W12: identity has a capable, online node and is movable. */
	'identity',
	/** W12: the mail node is online and movable. */
	'mail',
	/** W12: agents spool telemetry to disk during a control-plane outage. */
	'telemetry-spool',
	/** Every control-plane host runs the same feature flags (W9 control report, `featureFlagDrift`). */
	'flags-consistent',
	/**
	 * Nothing still depends on an HA feature (`haDependentChecks`): the gate on `--profile single`,
	 * so turning flags off can never strand a resource. One entry per dependent, each with its way back.
	 */
	'ha-dependents',
] as const;
export type HaCheckId = (typeof haCheckIds)[number];

export const HA_CHECK_AREAS: Readonly<Record<HaCheckId, HaCheckArea>> = Object.freeze({
	nodes: 'nodes',
	'node-capabilities': 'nodes',
	zones: 'topology',
	regions: 'topology',
	clocks: 'time',
	'overlay-links': 'network',
	'arbiter-conditional-writes': 'arbiter',
	certificates: 'certificates',
	steering: 'steering',
	backups: 'data',
	headroom: 'capacity',
	'platform-store': 'platform',
	'registry-storage': 'platform',
	identity: 'platform',
	mail: 'platform',
	'telemetry-spool': 'platform',
	'flags-consistent': 'platform',
	'ha-dependents': 'platform',
});

/**
 * The checks a profile requires to pass before `yoal ha init` applies it. Every other check still
 * runs and is shown; a `fail` outside this list is reported but does not block that profile.
 * `single` requires only `ha-dependents`: the way back is refused while turning the flags off would
 * strand a resource, and each refusal names that resource's own way back (HA-PLAN §9).
 */
export const HA_PROFILE_REQUIRED_CHECKS: Readonly<Record<HaProfile, readonly HaCheckId[]>> = Object.freeze({
	single: ['ha-dependents'],
	ha: [
		'flags-consistent',
		'nodes',
		'node-capabilities',
		'zones',
		'clocks',
		'overlay-links',
		'arbiter-conditional-writes',
		'certificates',
		'steering',
		'backups',
		'headroom',
		'platform-store',
		'registry-storage',
	],
	'ha-dr': [
		'flags-consistent',
		'nodes',
		'node-capabilities',
		'zones',
		'regions',
		'clocks',
		'overlay-links',
		'arbiter-conditional-writes',
		'certificates',
		'steering',
		'backups',
		'headroom',
		'platform-store',
		'registry-storage',
	],
});

export const haCheckFixKinds = [
	/** A command to run as written, e.g. `yoal nodes update node-b --zone uksouth-2`. */
	'command',
	/** A dashboard or cluster setting, e.g. `Settings → Registry → Storage: platform store`. */
	'setting',
	/** An exact line for `yoal.env`, followed by a control-plane restart. */
	'env',
	/** Something outside Yoal: a firewall rule, an NTP server, a balancer probe. */
	'manual',
] as const;
export type HaCheckFixKind = (typeof haCheckFixKinds)[number];

export const haCheckFixSchema = z.object({
	kind: z.enum(haCheckFixKinds),
	/** The exact command, setting, env line or step. */
	value: z.string().min(1).max(1_000),
});
export type HaCheckFix = z.infer<typeof haCheckFixSchema>;

export const haCheckSubjectSchema = z.object({
	kind: z.enum(['platform', 'node', 'zone', 'region', 'database', 'project', 'ingress']),
	id: z.string().min(1).max(100),
	name: z.string().max(120),
});
export type HaCheckSubject = z.infer<typeof haCheckSubjectSchema>;

export const haCheckSchema = z.object({
	id: z.enum(haCheckIds),
	title: z.string().min(1).max(200),
	status: z.enum(haCheckStatuses),
	/** What was observed, one fact per entry, with the numbers. Never a secret or a credential. */
	evidence: z.array(z.string().max(1_000)).max(50),
	/** The exact fix; null on `pass` and `skip`. */
	fix: haCheckFixSchema.nullable(),
	/** The node, zone, region, database or project this entry is about; null for the platform. */
	subject: haCheckSubjectSchema.nullable().default(null),
});
export type HaCheck = z.infer<typeof haCheckSchema>;

/** `yoal ha preflight`, `yoal doctor`, `GET /api/v1/ha/preflight?profile=`. */
export const haPreflightReportSchema = z.object({
	/** The profile the report was checked against. */
	profile: z.enum(['single', 'ha', 'ha-dr']),
	/** `preflight` checks a profile before `init`; `doctor` checks the running install. */
	mode: z.enum(['preflight', 'doctor']),
	/**
	 * True when every required check (`HA_PROFILE_REQUIRED_CHECKS[profile]`) ran and is `pass` or
	 * `warn`. A required check that is missing or `skip` makes it false (`summarizeHaChecks`).
	 */
	ok: z.boolean(),
	counts: z.object({
		pass: z.number().int().nonnegative(),
		warn: z.number().int().nonnegative(),
		fail: z.number().int().nonnegative(),
		skip: z.number().int().nonnegative(),
	}),
	checks: z.array(haCheckSchema).max(1_000),
	generatedAt: z.string(),
});
export type HaPreflightReport = z.infer<typeof haPreflightReportSchema>;

/** A check entry for an id that no lane has built yet: honest `skip`, never a silent pass. */
export function haCheckNotBuilt(id: HaCheckId, title: string, lane: string): HaCheck {
	return { id, title, status: 'skip', evidence: [`Not checked yet: this check is built by ${lane}.`], fix: null, subject: null };
}

/** `HaFinding.severity` (W12) as a check status. */
export function haFindingStatus(severity: 'blocker' | 'warning' | 'info'): HaCheckStatus {
	return severity === 'blocker' ? 'fail' : severity === 'warning' ? 'warn' : 'pass';
}

/** Counts and `ok` for a list of checks against a profile. Pure. */
export function summarizeHaChecks(
	profile: HaProfile,
	checks: readonly HaCheck[],
): { ok: boolean; counts: HaPreflightReport['counts'] } {
	const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
	for (const check of checks) counts[check.status] += 1;
	// A required check must have run and not failed: `skip` (not built, not applicable) is not a pass.
	const ok = HA_PROFILE_REQUIRED_CHECKS[profile].every((id) => {
		const entries = checks.filter((check) => check.id === id);
		return entries.length > 0 && entries.every((check) => check.status === 'pass' || check.status === 'warn');
	});
	return { ok, counts };
}

// ------------------------------------------------------------------ flags-consistent

/**
 * Flags that differ between control-plane hosts, and hosts that did not report theirs. A flag a
 * host omits counts as `null` (unknown), which differs from any value. Pure.
 */
export function featureFlagDrift(hosts: ReadonlyArray<{ name: string; flags: Readonly<Record<string, boolean>> | null }>): {
	differences: Array<{ flag: string; values: Record<string, boolean | null> }>;
	unreported: string[];
} {
	const reported = hosts.filter((host) => host.flags !== null) as Array<{ name: string; flags: Readonly<Record<string, boolean>> }>;
	const names = [...new Set(reported.flatMap((host) => Object.keys(host.flags)))].sort();
	const differences: Array<{ flag: string; values: Record<string, boolean | null> }> = [];
	for (const flag of names) {
		const values = Object.fromEntries(reported.map((host) => [host.name, host.flags[flag] ?? null])) as Record<string, boolean | null>;
		if (new Set(Object.values(values)).size > 1) differences.push({ flag, values });
	}
	return { differences, unreported: hosts.filter((host) => host.flags === null).map((host) => host.name) };
}

// ------------------------------------------------------------------ ha-dependents

/** What can still depend on an HA feature, and so blocks `--profile single`. */
export const haDependentKinds = [
	/** A database with `durability: sync` (`SYNC_REPLICA`). */
	'sync-database',
	/** A database with `failover_mode: auto` (`DB_AUTO_PROMOTE`). */
	'armed-database',
	/**
	 * A workload whose attachments go through the endpoints gateway (`ENDPOINTS_GATEWAY`). Read from
	 * `workloads.endpoints_gateway`, which the Wave 5 review-debt lane adds; until that column exists
	 * there is nothing to read and no entry.
	 */
	'gateway-attachment',
	/** An enrolled control-plane standby (`CONTROL_STANDBY`). */
	'control-standby',
	/** A node in a region other than `default` (`REGIONS`). */
	'region',
	/** A steering driver other than `direct` (`STEERING`). */
	'steering',
] as const;
export type HaDependentKind = (typeof haDependentKinds)[number];

export interface HaDependent {
	kind: HaDependentKind;
	id: string;
	name: string;
}

/** The per-resource way back (HA-PLAN §9 "Turning it off"), as the exact fix. */
export function haDependentFix(dependent: HaDependent): HaCheckFix {
	switch (dependent.kind) {
		case 'sync-database':
			return { kind: 'command', value: `yoal db durability ${dependent.name} --async` };
		case 'armed-database':
			return { kind: 'command', value: `yoal db failover ${dependent.name} --disarm` };
		case 'gateway-attachment':
			return {
				kind: 'manual',
				value: `Keep YOAL_FEATURE_ENDPOINTS_GATEWAY=1 until ${dependent.name} no longer reaches its database through the gateway: redeploy it once its database is on its own node.`,
			};
		case 'control-standby':
			return {
				kind: 'manual',
				value: `Demote the control-plane standby on ${dependent.name}: stop its control plane and remove it from the standby set (docs/OPS.md, control-plane standby).`,
			};
		case 'region':
			return { kind: 'setting', value: `PATCH /api/v1/nodes/${dependent.id} {"region": "default"} (node ${dependent.name})` };
		case 'steering':
			return { kind: 'setting', value: 'cluster_config steering.driver = direct (Settings → High availability → Steering)' };
	}
}

const DEPENDENT_TITLES: Readonly<Record<HaDependentKind, string>> = {
	'sync-database': 'A database is synchronous',
	'armed-database': 'A database has automatic failover armed',
	'gateway-attachment': 'An app reaches its database through the endpoints gateway',
	'control-standby': 'A control-plane standby is enrolled',
	region: 'A node is in a named region',
	steering: 'A steering driver is in use',
};

const DEPENDENT_SUBJECTS: Readonly<Record<HaDependentKind, HaCheckSubject['kind']>> = {
	'sync-database': 'database',
	'armed-database': 'database',
	'gateway-attachment': 'project',
	'control-standby': 'node',
	region: 'node',
	steering: 'platform',
};

/** The `ha-dependents` check: one `fail` per dependent with its way back, or one `pass`. Pure. */
export function haDependentChecks(dependents: readonly HaDependent[]): HaCheck[] {
	if (dependents.length === 0)
		return [
			{
				id: 'ha-dependents',
				title: 'Nothing depends on an HA feature',
				status: 'pass',
				evidence: ['No sync or armed database, gateway attachment, control standby, region or steering driver.'],
				fix: null,
				subject: null,
			},
		];
	return dependents.map((dependent) => ({
		id: 'ha-dependents',
		title: DEPENDENT_TITLES[dependent.kind],
		status: 'fail',
		evidence: [`${dependent.name} still depends on an HA feature; turning the flags off would strand it.`],
		fix: haDependentFix(dependent),
		subject: { kind: DEPENDENT_SUBJECTS[dependent.kind], id: dependent.id, name: dependent.name },
	}));
}
