import * as z from 'zod';
import { nodeZoneSchema } from './cluster.ts';
import type { FeatureFlags } from './features.ts';
import type { ReplicaSpread } from './replica.ts';

/**
 * Regions (HA-PLAN H26, W13; Wave 5 foundation). Contracts only: lane A (`ha/w5-a-regions`) builds
 * the behaviour behind them.
 *
 * - A **region** groups zones. It is an optional node field whose default is one implicit region,
 *   `default`, so every existing node is in it and nothing changes until an operator names another.
 *   A zone belongs to exactly one region: every node in a zone must name the same region
 *   (`zoneRegionIssue`).
 * - `spread: 'region'` is a value of the control-plane spread enums (`replicaSpreads`): cluster
 *   `replicas.spread`, per-app `placement.spread`, project `placementSpec.spread`, database spread in
 *   blueprints. No desired-state (agent-facing) schema carries a spread, so no agent enum gains a
 *   value (HA-PLAN §9 "Mixed versions"); `region-contracts.test.ts` asserts it.
 * - A database **standby region** holds an async replica that never auto-promotes. `sync` is only
 *   offered inside one region (`syncRegionRefusal`).
 * - `yoal ha region promote <region>` is a fenced, human-confirmed promotion of everything in the
 *   standby region, in dependency order: control plane, then databases, then steering. The lease
 *   generation is the fence (`region_promotions`, migration 0132).
 *
 * Every region field is refused while `REGIONS` is off (`regionWriteIssues`), on every write path:
 * REST, MCP, dashboard, blueprint and config import (`packages/core/src/region-gate.ts`).
 *
 * **Rollback risk.** `REGIONS_DOWNGRADE_NOTE`: once a `spread: region` or a node `region` other than
 * `default` is stored, a control plane older than Wave 5 cannot parse the cluster configuration
 * (`clusterConfigSchema`) or the project's placement (`parsePlacementSpec`), because `region` is not
 * in its enums. Downgrading the control plane after that is unsupported; put the values back to
 * `node`/`zone` and `default` first.
 *
 * **A stored `spread: region` while `REGIONS` is off** (left from when it was on) is placed as
 * `zone` (`placementSpread`), never an error at placement time; the preflight's `regions` check
 * warns about it.
 */

/** Said by the `REGIONS` flag, this contract and `ha init`'s plan output. */
export const REGIONS_DOWNGRADE_NOTE =
	'Once a spread: region or a non-default node region is stored, an older control plane cannot parse the cluster configuration or project placement, so downgrading the control plane is unsupported until those values are put back.';

/**
 * The spread placement actually applies. `region` is placed as `zone` while `REGIONS` is off (the
 * closest safe constraint, never the weaker node spread), and as `region` while it is on (W13).
 * Pure; the replica planner and the workload service call it (`packages/core/src/replicas.ts`).
 */
export function placementSpread(spread: ReplicaSpread, features: Pick<FeatureFlags, 'REGIONS'>): ReplicaSpread {
	if (spread !== 'region') return spread;
	return features.REGIONS ? 'region' : 'zone';
}

/** The implicit region every node is in until an operator names another. */
export const DEFAULT_REGION = 'default';

/** A region name: the same shape as a zone (`uksouth`, `eu-west`, `ukwest`). */
export const nodeRegionSchema = nodeZoneSchema;
export type NodeRegion = z.infer<typeof nodeRegionSchema>;

/** A node's region, with the implicit default for a row or input that has none. */
export function regionOf(node: { region?: string | null }): string {
	return node.region || DEFAULT_REGION;
}

// ------------------------------------------------------------------ zone → region

/** The facts the zone→region rule reads, per node. */
export interface RegionNodeFact {
	id: string;
	name: string;
	zone: string;
	region?: string | null;
}

/**
 * Zones mapped to their region, and every zone that is ambiguous (nodes in it name different
 * regions). A healthy fleet has no conflicts; a conflict can only come from a direct database
 * write, because `zoneRegionIssue` refuses the change that would make one.
 */
export function zoneRegions(nodes: readonly RegionNodeFact[]): {
	zones: Record<string, string>;
	conflicts: Array<{ zone: string; regions: string[]; nodes: string[] }>;
} {
	const seen = new Map<string, Map<string, string[]>>();
	for (const node of nodes) {
		const byRegion = seen.get(node.zone) ?? new Map<string, string[]>();
		const region = regionOf(node);
		byRegion.set(region, [...(byRegion.get(region) ?? []), node.name]);
		seen.set(node.zone, byRegion);
	}
	const zones: Record<string, string> = {};
	const conflicts: Array<{ zone: string; regions: string[]; nodes: string[] }> = [];
	for (const zone of [...seen.keys()].sort()) {
		const byRegion = seen.get(zone)!;
		const regions = [...byRegion.keys()].sort();
		if (regions.length === 1) zones[zone] = regions[0]!;
		else conflicts.push({ zone, regions, nodes: regions.flatMap((region) => byRegion.get(region)!) });
	}
	return { zones, conflicts };
}

/**
 * The refusal for setting a node's zone and/or region, or null. A zone belongs to exactly one
 * region, so the node's resulting (zone, region) must agree with every other node in that zone.
 * To move a whole zone, change every node in it: the first change is refused while another node
 * still names the old region, so move the zone's last-named nodes into a new zone first, or change
 * them one by one from a single-node zone.
 */
export function zoneRegionIssue(
	nodes: readonly RegionNodeFact[],
	change: { nodeId: string; zone?: string; region?: string },
): string | null {
	const node = nodes.find((item) => item.id === change.nodeId);
	const zone = change.zone ?? node?.zone;
	const region = change.region ?? (node ? regionOf(node) : DEFAULT_REGION);
	if (!zone) return null;
	const other = nodes.find((item) => item.id !== change.nodeId && item.zone === zone && regionOf(item) !== region);
	if (!other) return null;
	return `Zone "${zone}" is in region "${regionOf(other)}" (node ${other.name}); a zone belongs to exactly one region. Use another zone name for region "${region}", or move ${other.name} first.`;
}

// ------------------------------------------------------------------ the REGIONS gate

/** Every region field, by the write surface that carries it. Used in refusals and tests. */
export const REGION_FIELDS = [
	'node.region',
	'cluster.replicas.spread',
	'project.placementSpec.spread',
	'workload.placement.spread',
	'database.standbyRegion',
	'blueprint.databases.spread',
	'blueprint.databases.standbyRegion',
	/**
	 * A blueprint project's `placement: { spread }` maps to the workload's `placement.spread`
	 * (`workload.placement.spread`), gated as it is today; it never touches the project's
	 * `placementSpec`.
	 */
	'blueprint.projects.placement.spread',
] as const;
export type RegionField = (typeof REGION_FIELDS)[number];

/**
 * One write of a field that may carry a region value. `current` is the stored value; a write that
 * equals it is not a change and is never refused (a save that re-sends the stored record must keep
 * working after the flag is turned off, as `releasePhaseSpecIssues` does).
 */
export interface RegionWrite {
	field: RegionField;
	value: unknown;
	current?: unknown;
}

/** True when this write sets a region value, i.e. something `REGIONS` must allow. */
export function isRegionWrite(write: RegionWrite): boolean {
	if (write.value === undefined) return false;
	if (write.field === 'node.region') {
		// Absent and `default` are the same region. Returning to it is always allowed, as clearing a
		// standby region is: it is the way back, and needs no flag.
		const next = regionOf({ region: write.value as string | null });
		if (next === DEFAULT_REGION) return false;
		const current = regionOf({ region: write.current as string | null | undefined });
		return next !== current;
	}
	if (write.field === 'database.standbyRegion' || write.field === 'blueprint.databases.standbyRegion')
		// Clearing a standby region is the way back, so it is always allowed.
		return write.value !== null && write.value !== write.current;
	// Every other field is a spread: only the `region` value is region-gated.
	return write.value === 'region' && write.current !== 'region';
}

/**
 * Refusals for region writes while `REGIONS` is off: one per write that changes a region value,
 * empty when the flag is on. Callers throw a `ValidationError` with the first message.
 */
export function regionWriteIssues(
	writes: readonly RegionWrite[],
	features: Pick<FeatureFlags, 'REGIONS'>,
): { field: RegionField; message: string }[] {
	if (features.REGIONS) return [];
	return writes.filter(isRegionWrite).map((write) => ({
		field: write.field,
		message: `${write.field} needs regions, which are not enabled on this platform (YOAL_FEATURE_REGIONS).`,
	}));
}

// ------------------------------------------------------------------ sync and standby regions

/** Why an operation is refused across regions. Stable codes for the CLI, MCP and the dashboard. */
export const regionRefusalCodes = [
	/** A synchronous replica, or a `sync` durability, would span two regions. */
	'sync-across-regions',
	/** The standby region is the primary's own region. */
	'standby-region-is-primary-region',
	/** No online data node in the standby region can hold the replica. */
	'standby-region-has-no-data-node',
	/** Automatic promotion may never choose a replica outside the primary's region. */
	'auto-promotion-across-regions',
	/** `spread: region` with `sync` durability would make the synchronous set cross regions. */
	'region-spread-with-sync',
] as const;
export type RegionRefusalCode = (typeof regionRefusalCodes)[number];

export const regionRefusalSchema = z.object({
	code: z.enum(regionRefusalCodes),
	message: z.string().max(1_000),
	/** The region and node names the refusal is about, for the operator. */
	regions: z.array(z.string().max(32)).max(8).default([]),
	nodes: z.array(z.string().max(120)).max(16).default([]),
});
export type RegionRefusal = z.infer<typeof regionRefusalSchema>;

/**
 * The refusal for a synchronous replica or a `sync` durability that would span regions, or null.
 * `sync` is only offered inside a region (H26): cross-region round trips make every commit wait on
 * the slowest link, and a region cut-off would block or downgrade every write. Lane A calls this
 * wherever a sync set is chosen (`DatabaseMemberService.setDurability`, replica create with
 * `mode: 'sync'`, the sync-set picker); a cross-region replica stays async.
 */
export function syncRegionRefusal(
	primary: { nodeName: string; region?: string | null },
	replica: { nodeName: string; region?: string | null },
): RegionRefusal | null {
	const from = regionOf(primary);
	const to = regionOf(replica);
	if (from === to) return null;
	return {
		code: 'sync-across-regions',
		message: `A synchronous replica must be in the primary's region: ${replica.nodeName} is in "${to}", the primary on ${primary.nodeName} is in "${from}". Keep this replica async, or add one in "${from}".`,
		regions: [from, to],
		nodes: [primary.nodeName, replica.nodeName],
	};
}

/**
 * Whether automatic promotion may choose `replica` for a primary in `primaryRegion`. A replica in
 * another region (a standby region's replica in particular) is never auto-promoted: only
 * `yoal ha region promote` moves a database across regions.
 */
export function autoPromotionAllowedAcrossRegion(primaryRegion: string | null | undefined, replicaRegion: string | null | undefined): boolean {
	return regionOf({ region: primaryRegion }) === regionOf({ region: replicaRegion });
}

/**
 * The replica mode in a standby region. Fixed: a standby region's replica is always async, never a
 * member of the synchronous set, and never chosen by automatic promotion.
 */
export const STANDBY_REGION_REPLICA_MODE = 'async' as const;

/** The refusal for a database's standby region, or null when it is acceptable. Pure. */
export function standbyRegionRefusal(input: {
	primaryRegion: string | null | undefined;
	standbyRegion: string;
	/** Online data nodes in the standby region that could hold the replica. */
	candidateNodes: readonly string[];
}): RegionRefusal | null {
	const primary = regionOf({ region: input.primaryRegion });
	if (input.standbyRegion === primary)
		return {
			code: 'standby-region-is-primary-region',
			message: `The standby region must differ from the primary's region "${primary}".`,
			regions: [primary],
			nodes: [],
		};
	if (input.candidateNodes.length === 0)
		return {
			code: 'standby-region-has-no-data-node',
			message: `No online data node is in region "${input.standbyRegion}". Enrol one with --region ${input.standbyRegion} and the data role first.`,
			regions: [input.standbyRegion],
			nodes: [],
		};
	return null;
}

/** The refusal for `spread: region` together with `sync` durability, or null. */
export function regionSpreadSyncRefusal(spread: ReplicaSpread | undefined, durability: 'async' | 'sync' | undefined): RegionRefusal | null {
	if (spread !== 'region' || durability !== 'sync') return null;
	return {
		code: 'region-spread-with-sync',
		message: 'spread: region puts replicas in other regions, and sync is only offered inside a region. Use spread: zone with sync, or durability: async with a standby region.',
		regions: [],
		nodes: [],
	};
}

// ------------------------------------------------------------------ region promotion

/**
 * `yoal ha region promote <region>`: a fenced, human-confirmed promotion of everything in the
 * standby region, in dependency order (H26).
 *
 * **Where it runs and where the record lives.** The promotion runs on the control plane in the
 * surviving region: the W9 standby there. Its plan (`regionPromote` without `confirm`) is computed
 * from fresh arbiter reads and never stored, because that standby is not primary yet. On
 * confirmation its first step promotes itself (the control-plane step, fenced on the control
 * epoch); only then, under the new epoch, does it write the `region_promotions` record and its
 * steps (migration 0132) to the platform database it now owns. A crash between the two is
 * recovered by re-running: the control step is idempotent (below), so it finds its epoch already
 * written and records itself done.
 *
 * **Stages.** A stored promotion is in `control-plane` (written as that step finishes), then
 * `databases`, then `steering`, then `completed`. `failed` stops where it is: nothing is rolled back
 * automatically, and the steps say what ran. `cancelled` stops between steps.
 *
 * **Fences, per step.** Every step names the generation it was planned at and the one it wrote:
 * - `control-plane`: the W9 control lease epoch; the promote is a CAS at `expectedGeneration` and
 *   writes `fencedGeneration` = epoch + 1;
 * - `database`: that database's lease generation (W9-SPEC §5.1), the same way;
 * - `steering`: no lease of its own. Its writes are fenced by the new control epoch: only the holder
 *   of that epoch writes, so `expectedGeneration` is that epoch and `fencedGeneration` stays null.
 *
 * **Idempotent, keyed on the fenced generation.** Re-running a step whose `fencedGeneration` is
 * already the lease's generation (and this runner's) is a no-op that marks it done; a lease at any
 * other generation fails the step with "someone else acted". A step is never run twice.
 *
 * **Runner lease.** One runner at a time holds `runnerId` until `leaseExpiresAt` and renews it
 * between steps; another control plane takes over a crashed run only once the lease has expired
 * (`regionPromotionLeaseFree`), with a conditional update on the old values.
 */
export const regionPromotionStages = ['control-plane', 'databases', 'steering', 'completed', 'failed', 'cancelled'] as const;
export type RegionPromotionStage = (typeof regionPromotionStages)[number];

/** The dependency order of the promotion's steps. Fixed (H26). */
export const REGION_PROMOTION_ORDER = ['control-plane', 'databases', 'steering'] as const;
export type RegionPromotionStep = (typeof REGION_PROMOTION_ORDER)[number];

export const REGION_PROMOTION_TERMINAL: ReadonlySet<RegionPromotionStage> = new Set(['completed', 'failed', 'cancelled']);

/** Seconds a runner holds the promotion before another control plane may resume it. */
export const REGION_PROMOTION_RUNNER_LEASE_SECONDS = 60;

/** The stage after `stage` on success, or null for a terminal stage. Pure. */
export function nextRegionPromotionStage(stage: RegionPromotionStage): RegionPromotionStage | null {
	switch (stage) {
		case 'control-plane':
			return 'databases';
		case 'databases':
			return 'steering';
		case 'steering':
			return 'completed';
		default:
			return null;
	}
}

/** Whether a runner may take the promotion now: nobody holds it, or the holder's lease expired. */
export function regionPromotionLeaseFree(lease: { runnerId: string | null; leaseExpiresAt: number | null }, now: number): boolean {
	return lease.runnerId === null || lease.leaseExpiresAt === null || lease.leaseExpiresAt <= now;
}

export const regionPromotionStepKinds = ['control-plane', 'database', 'steering'] as const;
export type RegionPromotionStepKind = (typeof regionPromotionStepKinds)[number];

/** Which generation fences each kind of step (see the module comment). */
export const REGION_PROMOTION_STEP_FENCES: Readonly<Record<RegionPromotionStepKind, 'control-epoch' | 'database-lease'>> = Object.freeze({
	'control-plane': 'control-epoch',
	database: 'database-lease',
	steering: 'control-epoch',
});

export const regionPromotionStepStatuses = ['pending', 'running', 'done', 'skipped', 'failed'] as const;
export type RegionPromotionStepStatus = (typeof regionPromotionStepStatuses)[number];

/** One step, one resource, one fence (`region_promotion_steps`). */
export const regionPromotionStepSchema = z
	.object({
		/** Order within the promotion; control plane first, then databases, then steering. */
		position: z.number().int().nonnegative(),
		step: z.enum(REGION_PROMOTION_ORDER),
		kind: z.enum(regionPromotionStepKinds),
		/** `control-plane`, a database id, or the steering driver kind. */
		resourceId: z.string().min(1).max(100),
		name: z.string().max(120),
		/** The node that becomes primary in the target region, when there is one. */
		targetNodeId: z.string().max(100).nullable().default(null),
		/** The generation the plan read; the step's CAS is at this value. */
		expectedGeneration: z.number().int().nonnegative(),
		/** The generation the step wrote; strictly greater. Null until done, and always for steering. */
		fencedGeneration: z.number().int().nonnegative().nullable().default(null),
		status: z.enum(regionPromotionStepStatuses).default('pending'),
		/** Replication lag when the plan was made: the RPO the operator accepts. Null when unknown. */
		lagBytes: z.number().int().nonnegative().nullable().default(null),
		lagSeconds: z.number().nonnegative().nullable().default(null),
		startedAt: z.string().nullable().default(null),
		finishedAt: z.string().nullable().default(null),
		/** Why the step is skipped or failed. */
		message: z.string().max(1_000).nullable().default(null),
	})
	.refine((step) => step.fencedGeneration === null || step.fencedGeneration > step.expectedGeneration, {
		message: 'A fence only moves forward: fencedGeneration must be greater than expectedGeneration.',
		path: ['fencedGeneration'],
	});
export type RegionPromotionStepView = z.infer<typeof regionPromotionStepSchema>;

/** The computed plan `promote` returns without `confirm`. Never stored. */
export interface RegionPromotionPlan {
	toRegion: string;
	fromRegion: string;
	steps: RegionPromotionStepView[];
	/** sha256 over `toRegion` and each step's kind, resource and expected generation; pass it back. */
	planHash: string;
	/** Writes after the last replicated one are lost: the largest planned lag. */
	maxLagSeconds: number | null;
}

/**
 * `POST /api/v1/ha/regions/:region/promote` and `yoal ha region promote <region>`. Without
 * `confirm` it returns the plan. With it, the human confirmation is the region name typed back,
 * the `planHash` the plan showed (any generation that moved since changes the hash, so a stale plan
 * is refused), `acceptDataLoss: true` (RPO is the measured lag) and a reason for the audit log.
 * Never exposed as an MCP write tool.
 */
export const regionPromoteRequestSchema = z
	.object({
		/** The region name typed back exactly. */
		confirm: nodeRegionSchema.optional(),
		planHash: z.string().regex(/^[a-f0-9]{64}$/, 'Use the 64-character plan hash the plan showed.').optional(),
		/** Required with `confirm`: writes after the last replicated one are lost (RPO = lag). */
		acceptDataLoss: z.boolean().default(false),
		/** Recorded in the audit log and the promotion record. */
		reason: z.string().trim().min(1).max(500).optional(),
		/**
		 * Break glass: promote even though the old region still holds a valid lease generation (its
		 * control-plane lease or a database lease has not expired). Only after the old region is
		 * known to be stopped; audited. Without it such a promotion is refused.
		 */
		breakGlass: z.boolean().default(false),
	})
	.strict()
	.superRefine((input, ctx) => {
		if (input.confirm === undefined) return;
		if (input.planHash === undefined) ctx.addIssue({ code: 'custom', path: ['planHash'], message: 'Pass the plan hash the plan showed.' });
		if (!input.acceptDataLoss)
			ctx.addIssue({ code: 'custom', path: ['acceptDataLoss'], message: 'A region promotion loses writes after the last replicated one; pass acceptDataLoss: true.' });
		if (!input.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Say why, for the audit log.' });
	});
export type RegionPromoteRequest = z.input<typeof regionPromoteRequestSchema>;

/** One stored region promotion, from `region_promotions` and its steps. */
export const regionPromotionViewSchema = z.object({
	id: z.string().regex(/^rgp_[a-f0-9]{32}$/),
	/** The region traffic and writes move to. */
	toRegion: nodeRegionSchema,
	/** The region believed lost. */
	fromRegion: nodeRegionSchema,
	stage: z.enum(regionPromotionStages),
	planHash: z.string().regex(/^[a-f0-9]{64}$/),
	steps: z.array(regionPromotionStepSchema).max(500),
	// Runner lease.
	runnerId: z.string().max(100).nullable(),
	leaseExpiresAt: z.string().nullable(),
	attempt: z.number().int().min(1),
	// Human confirmation (always present: a promotion is stored only once confirmed).
	acceptDataLoss: z.literal(true),
	reason: z.string().max(500),
	confirmedBy: z.string().max(200),
	confirmedAt: z.string(),
	// Audit.
	startedAt: z.string(),
	finishedAt: z.string().nullable(),
	/** The step that failed, and why. */
	error: z.string().max(2_000).nullable(),
});
export type RegionPromotionView = z.infer<typeof regionPromotionViewSchema>;

/** One region in `RegionService.view`. */
export interface RegionView {
	name: string;
	zones: string[];
	nodes: Array<{ id: string; name: string; zone: string; online: boolean; roles: string[] }>;
	/** True when the control-plane primary is in this region. */
	primary: boolean;
	/** Databases whose primary is here, and those whose standby region is this one. */
	databases: { primaries: number; standbys: number };
}

/** `GET /api/v1/ha/regions`: the regions, ambiguous zones, and the promotion history. */
export interface RegionsView {
	enabled: boolean;
	regions: RegionView[];
	/** Zones whose nodes name different regions (only possible from a direct database write). */
	conflicts: Array<{ zone: string; regions: string[]; nodes: string[] }>;
	/** The running promotion, if any; at most one at a time. */
	active: RegionPromotionView | null;
	recent: RegionPromotionView[];
	/** `REGIONS_DOWNGRADE_NOTE` while any region value is stored. */
	notes: string[];
}
