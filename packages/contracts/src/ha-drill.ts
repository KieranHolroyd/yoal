import * as z from 'zod';
import type { HaLevel } from './cluster.ts';
import type { FeatureName } from './features.ts';

/**
 * The drill catalogue (HA-PLAN H27, §7.2, §10, W14; Wave 5 foundation). `yoal ha drill <scenario>
 * <resource>` injects one fault on one named resource, measures RTO and RPO, records the result and
 * restores; `yoal ha drill --all` runs every scenario a fleet can run. Lane B
 * (`ha/w5-b-ha-commands`) builds the runner (`HaDrillRunner`); this is the list it runs.
 *
 * **Reconciliation with the drills that exist.**
 * - `node-offline` *is* the D235 node offline drill (migration 0131, `node_drills`,
 *   `/api/v1/ha/drills`, `yoal ha drill node-offline`). The catalogue entry describes it; the
 *   runner calls `NodeDrillService` unchanged.
 * - `database-failover` *is* the W11 failover drill (migration 0130, `database_failover_drills`,
 *   `yoal ha db drill`): a real promotion of a disposable copy, never the production database.
 * - Every other scenario records in `ha_drills`, which lane B creates in its reserved migration
 *   (HA-PLAN H27 names the table). `recordsIn` says where each one lands.
 *
 * **Fleet or lab.** A release build has no fault verbs (§10), so a scenario that needs one (kill or
 * freeze a process, partition a link, skew a clock, fill a disk) runs only in the lab
 * (`tests/lab`, `tests/ha`) with the same id. `--all` runs the `fleet` ones and lists the `lab`
 * ones as skipped with that reason.
 *
 * **Safety (§10).** Drills need a platform admin and name the resource. A `destructive` scenario
 * needs the resource's name typed back (`confirmation: 'typed'`) and is refused on a resource below
 * `minHaLevel`, its declared HA level: a drill must not take down something that cannot survive it.
 */

/** §7.2's families. */
export const haDrillFamilies = ['node', 'network', 'process', 'clock', 'disk', 'arbiter', 'change', 'operator', 'region'] as const;
export type HaDrillFamily = (typeof haDrillFamilies)[number];

/** What a scenario is run against; the CLI argument after the scenario id names one. */
export const haDrillResourceKinds = ['node', 'ingress-node', 'database', 'control-plane', 'zone', 'region', 'arbiter', 'project'] as const;
export type HaDrillResourceKind = (typeof haDrillResourceKinds)[number];

/** What a scenario measures. `refusal` means "the platform refused the unsafe action, as it must". */
export const haDrillMeasures = ['rto', 'rpo', 'failed-requests', 'refusal'] as const;
export type HaDrillMeasure = (typeof haDrillMeasures)[number];

/**
 * - `none`: no confirmation beyond the request (the D235 node offline drill today);
 * - `confirm`: `confirm: true` (the W11 database failover drill today);
 * - `typed`: the resource's name typed back (§10, destructive scenarios).
 */
export const haDrillConfirmations = ['none', 'confirm', 'typed'] as const;
export type HaDrillConfirmation = (typeof haDrillConfirmations)[number];

export const haDrillScenarioIds = [
	// Fleet: a release build can run these.
	'node-offline',
	'ingress-offline',
	'database-failover',
	'control-plane-failover',
	'zone-offline',
	'region-failover',
	'release-readiness-fail',
	'release-command-fail',
	'stale-generation-promote',
	// Lab only: they need a fault verb (§10).
	'postgres-kill',
	'agent-freeze',
	'primary-arbiter-partition',
	'arbiter-unreachable',
	'clock-skew',
	'disk-full',
] as const;
export type HaDrillScenarioId = (typeof haDrillScenarioIds)[number];

export interface HaDrillScenario {
	id: HaDrillScenarioId;
	family: HaDrillFamily;
	/** The §7.2 scenario this is, in its words. */
	faultCatalogue: string;
	title: string;
	resourceKind: HaDrillResourceKind;
	/** Takes something down for real on the fleet; needs a typed confirmation (§10). */
	destructive: boolean;
	confirmation: HaDrillConfirmation;
	measures: readonly HaDrillMeasure[];
	availability: 'fleet' | 'lab';
	/** Flags that must be on, or the scenario is skipped with the flag named. */
	flags: readonly FeatureName[];
	/** Refused on a resource whose computed HA level is below this (§10); null when any level may run. */
	minHaLevel: HaLevel | null;
	/** The HA-PLAN §1.2 bound it is judged against; null where §1.2 gives none. */
	bound: { rtoSeconds: number | null; rpo: 'zero' | 'lag' | null };
	recordsIn: 'node_drills' | 'database_failover_drills' | 'ha_drills';
	/** Included in `yoal ha drill --all`. Destructive scenarios need `includeDestructive`. */
	inAll: boolean;
}

const scenario = (entry: HaDrillScenario) => entry;

/** The catalogue, in `--all` order: cheapest and least disruptive first. */
export const HA_DRILL_CATALOGUE: readonly HaDrillScenario[] = Object.freeze([
	scenario({
		id: 'stale-generation-promote',
		family: 'operator',
		faultCatalogue: 'Promote with a stale generation',
		title: 'A promotion with an old generation is refused',
		resourceKind: 'database',
		destructive: false,
		confirmation: 'none',
		measures: ['refusal'],
		availability: 'fleet',
		flags: [],
		minHaLevel: 'L2',
		bound: { rtoSeconds: null, rpo: null },
		recordsIn: 'ha_drills',
		inAll: true,
	}),
	scenario({
		id: 'node-offline',
		family: 'node',
		faultCatalogue: 'Power off a node (simulated partition, D235)',
		title: 'One node goes dark for a bounded time',
		resourceKind: 'node',
		destructive: false,
		confirmation: 'none',
		measures: ['rto'],
		availability: 'fleet',
		flags: [],
		minHaLevel: null,
		bound: { rtoSeconds: null, rpo: null },
		recordsIn: 'node_drills',
		inAll: true,
	}),
	scenario({
		id: 'ingress-offline',
		family: 'node',
		faultCatalogue: 'Power off an ingress mid-request',
		title: 'An ingress leaves rotation and in-flight requests elsewhere are unaffected',
		resourceKind: 'ingress-node',
		destructive: false,
		confirmation: 'none',
		measures: ['rto', 'failed-requests'],
		availability: 'fleet',
		flags: ['INGRESS_SET', 'STEERING'],
		minHaLevel: null,
		bound: { rtoSeconds: 15, rpo: null },
		recordsIn: 'ha_drills',
		inAll: true,
	}),
	scenario({
		id: 'database-failover',
		family: 'node',
		faultCatalogue: 'Power off the node holding the database primary',
		title: 'A disposable copy of the database fails over',
		resourceKind: 'database',
		destructive: false,
		confirmation: 'confirm',
		measures: ['rto', 'rpo'],
		availability: 'fleet',
		flags: ['SYNC_REPLICA'],
		minHaLevel: 'L2',
		bound: { rtoSeconds: 30, rpo: 'zero' },
		recordsIn: 'database_failover_drills',
		inAll: true,
	}),
	scenario({
		id: 'release-readiness-fail',
		family: 'change',
		faultCatalogue: 'Deploy a release that fails readiness',
		title: 'A release that never becomes ready takes no traffic',
		resourceKind: 'project',
		destructive: false,
		confirmation: 'typed',
		measures: ['failed-requests'],
		availability: 'fleet',
		flags: ['RELEASE_PHASE'],
		minHaLevel: 'L3',
		bound: { rtoSeconds: null, rpo: null },
		recordsIn: 'ha_drills',
		inAll: true,
	}),
	scenario({
		id: 'release-command-fail',
		family: 'change',
		faultCatalogue: 'A release command that fails or hangs',
		title: 'A failing release command stops the rollout before any copy rolls',
		resourceKind: 'project',
		destructive: false,
		confirmation: 'typed',
		measures: ['failed-requests'],
		availability: 'fleet',
		flags: ['RELEASE_PHASE'],
		minHaLevel: 'L3',
		bound: { rtoSeconds: null, rpo: null },
		recordsIn: 'ha_drills',
		inAll: true,
	}),
	scenario({
		id: 'control-plane-failover',
		family: 'node',
		faultCatalogue: 'Power off the node holding the control-plane primary',
		title: 'The control-plane standby takes over; serving is unaffected',
		resourceKind: 'control-plane',
		destructive: true,
		confirmation: 'typed',
		measures: ['rto', 'failed-requests'],
		availability: 'fleet',
		flags: ['CONTROL_STANDBY'],
		minHaLevel: 'L2',
		bound: { rtoSeconds: 60, rpo: null },
		recordsIn: 'ha_drills',
		inAll: true,
	}),
	scenario({
		id: 'zone-offline',
		family: 'node',
		faultCatalogue: 'Power off the database primary, the synchronous replica and the control-plane primary at once (zone loss)',
		title: 'Every node in one zone goes dark at once',
		resourceKind: 'zone',
		destructive: true,
		confirmation: 'typed',
		measures: ['rto', 'rpo', 'failed-requests'],
		availability: 'fleet',
		flags: [],
		minHaLevel: 'L3',
		bound: { rtoSeconds: 45, rpo: 'zero' },
		recordsIn: 'ha_drills',
		inAll: true,
	}),
	scenario({
		id: 'region-failover',
		family: 'region',
		faultCatalogue: 'Lose region A',
		title: 'The primary region is cut off and the standby region is promoted by hand',
		resourceKind: 'region',
		destructive: true,
		confirmation: 'typed',
		measures: ['rto', 'rpo'],
		availability: 'fleet',
		flags: ['REGIONS'],
		minHaLevel: 'L2',
		bound: { rtoSeconds: 900, rpo: 'lag' },
		recordsIn: 'ha_drills',
		// A region promotion moves writes with RPO = lag: only by name, never as part of --all.
		inAll: false,
	}),
	scenario({
		id: 'postgres-kill',
		family: 'process',
		faultCatalogue: 'Kill or freeze Postgres',
		title: 'The primary Postgres process is killed',
		resourceKind: 'database',
		destructive: true,
		confirmation: 'typed',
		measures: ['rto', 'rpo'],
		availability: 'lab',
		flags: [],
		minHaLevel: 'L2',
		bound: { rtoSeconds: 30, rpo: 'zero' },
		recordsIn: 'ha_drills',
		inAll: true,
	}),
	scenario({
		id: 'agent-freeze',
		family: 'process',
		faultCatalogue: "Freeze the primary's agent for 60 s then resume (the stale-leader case)",
		title: "The primary's agent freezes and resumes",
		resourceKind: 'node',
		destructive: true,
		confirmation: 'typed',
		measures: ['rto', 'rpo'],
		availability: 'lab',
		flags: [],
		minHaLevel: 'L2',
		bound: { rtoSeconds: 30, rpo: 'zero' },
		recordsIn: 'ha_drills',
		inAll: true,
	}),
	scenario({
		id: 'primary-arbiter-partition',
		family: 'network',
		faultCatalogue: 'Partition the primary from the arbiter only',
		title: 'The primary loses the arbiter but not its replicas',
		resourceKind: 'database',
		destructive: true,
		confirmation: 'typed',
		measures: ['rto', 'rpo'],
		availability: 'lab',
		flags: [],
		minHaLevel: 'L2',
		bound: { rtoSeconds: 30, rpo: 'zero' },
		recordsIn: 'ha_drills',
		inAll: true,
	}),
	scenario({
		id: 'arbiter-unreachable',
		family: 'arbiter',
		faultCatalogue: 'Arbiter unreachable for 10 min',
		title: 'Nothing promotes and healthy primaries keep running while the arbiter is away',
		resourceKind: 'arbiter',
		destructive: false,
		confirmation: 'none',
		measures: ['failed-requests'],
		availability: 'lab',
		flags: [],
		minHaLevel: null,
		bound: { rtoSeconds: null, rpo: null },
		recordsIn: 'ha_drills',
		inAll: true,
	}),
	scenario({
		id: 'clock-skew',
		family: 'clock',
		faultCatalogue: 'Skew one node ±5 s, ±60 s',
		title: 'One node’s clock is skewed',
		resourceKind: 'node',
		destructive: false,
		confirmation: 'none',
		measures: ['refusal'],
		availability: 'lab',
		flags: [],
		minHaLevel: null,
		bound: { rtoSeconds: null, rpo: null },
		recordsIn: 'ha_drills',
		inAll: true,
	}),
	scenario({
		id: 'disk-full',
		family: 'disk',
		faultCatalogue: "Fill the primary's data disk",
		title: "The primary's data disk fills",
		resourceKind: 'database',
		destructive: true,
		confirmation: 'typed',
		measures: ['rto', 'rpo'],
		availability: 'lab',
		flags: [],
		minHaLevel: 'L2',
		bound: { rtoSeconds: null, rpo: 'zero' },
		recordsIn: 'ha_drills',
		inAll: true,
	}),
]);

export function haDrillScenario(id: HaDrillScenarioId): HaDrillScenario {
	const found = HA_DRILL_CATALOGUE.find((entry) => entry.id === id);
	if (!found) throw new Error(`Unknown drill scenario "${id}".`);
	return found;
}

/**
 * The refusal for a confirmation, or null. `typed` needs the resource's name typed back exactly;
 * `confirm` needs `confirm: true`. Pure; lane B calls it before anything runs.
 */
export function haDrillConfirmationIssue(
	entry: Pick<HaDrillScenario, 'id' | 'confirmation'>,
	resourceName: string,
	confirm: string | boolean | undefined,
): string | null {
	if (entry.confirmation === 'none') return null;
	if (entry.confirmation === 'confirm') return confirm === true || confirm === resourceName ? null : `The ${entry.id} drill needs confirm: true.`;
	return confirm === resourceName ? null : `The ${entry.id} drill is destructive: type the ${resourceName === '' ? 'resource' : `name "${resourceName}"`} to confirm.`;
}

// ------------------------------------------------------------------ requests and views

/** `POST /api/v1/ha/drills/run` and `yoal ha drill <scenario> [resource]`. */
export const haDrillRunRequestSchema = z
	.object({
		scenario: z.enum(haDrillScenarioIds),
		/** Id or name. Omitted only for `node-offline`, which then picks an eligible node at random. */
		resource: z.string().trim().min(1).max(128).optional(),
		/** `true` for `confirmation: 'confirm'`; the resource name for `confirmation: 'typed'`. */
		confirm: z.union([z.literal(true), z.string().max(128)]).optional(),
		/** Bounded fault length where the scenario has one (node and zone offline). */
		durationSeconds: z.number().int().min(60).max(1_800).optional(),
		/** `database-failover`: the disposable copy to promote (never the production database). */
		drillDatabase: z.string().trim().min(1).max(128).optional(),
	})
	.strict();
export type HaDrillRunRequest = z.input<typeof haDrillRunRequestSchema>;

/** `POST /api/v1/ha/drills/all` and `yoal ha drill --all`. */
export const haDrillAllRequestSchema = z
	.object({
		/** Also run destructive scenarios that are `inAll`. Needs `confirm: 'all'`. */
		includeDestructive: z.boolean().default(false),
		confirm: z.literal('all').optional(),
	})
	.strict()
	.refine((input) => !input.includeDestructive || input.confirm === 'all', {
		message: 'Destructive drills need confirm: "all" typed back.',
		path: ['confirm'],
	});
export type HaDrillAllRequest = z.input<typeof haDrillAllRequestSchema>;

export const haDrillRunStatuses = ['running', 'passed', 'failed', 'cancelled', 'skipped'] as const;
export type HaDrillRunStatus = (typeof haDrillRunStatuses)[number];

export interface HaDrillMeasured {
	/** Fault to recovery, as the scenario defines it. */
	rtoMs: number | null;
	/** Acknowledged commits lost (`rpo: 'zero'` must be 0). */
	lostCommits: number | null;
	/** Replication lag at the fault (`rpo: 'lag'`). */
	lagBytes: number | null;
	failedRequests: number | null;
	/** `refusal` scenarios: the platform refused the unsafe action. */
	refused: boolean | null;
}

export interface HaDrillRunView {
	id: string;
	scenario: HaDrillScenarioId;
	resource: { kind: HaDrillResourceKind; id: string; name: string };
	status: HaDrillRunStatus;
	startedAt: string | null;
	finishedAt: string | null;
	measured: HaDrillMeasured;
	bound: HaDrillScenario['bound'];
	/** The row in `recordsIn` (a `node_drills`, `database_failover_drills` or `ha_drills` id). */
	recordId: string | null;
	/** Why it failed or was skipped. */
	message: string | null;
}

export interface HaDrillAllView {
	runs: HaDrillRunView[];
	/** Scenarios `--all` did not run, and why (lab only, flag off, below its HA level, destructive). */
	skipped: Array<{ scenario: HaDrillScenarioId; reason: string }>;
	passed: boolean;
}

export interface HaDrillCatalogueView {
	scenarios: readonly HaDrillScenario[];
}
