import {
	DEFAULT_REGION,
	effectiveDurability,
	type DatabaseLease,
	autoPromotionAllowedAcrossRegion,
	placementSpread,
	regionOf,
	syncRegionRefusal,
	type RegionPromotionStepView,
	type ReplicaSpread,
} from '@yoal/contracts';
import { planReplicas, type ReplicaCandidate } from './replicas.ts';
import { sha256Hex } from './util.ts';

/**
 * Pure region rules (HA-PLAN H26, W13). No database handle: every function takes the facts it
 * reads, so the rules are testable with fake nodes in two regions. The services call these:
 * `RegionService` (promotion plan, steering), `DatabaseService` (standby region),
 * `DatabaseMemberService` (sync set), `FailoverService` (automatic promotion) and the blueprint
 * lane (`planDatabaseReplicaNodes`).
 */

/** A node as the region rules read it. */
export interface RegionNode {
	id: string;
	name: string;
	zone: string;
	region?: string | null;
	status: string;
}

/** Region of a node id in a fleet; `default` for an unknown id (a row deleted since). */
export function regionOfNodeId(fleet: ReadonlyMap<string, { region?: string | null }>, nodeId: string | null | undefined): string {
	return nodeId ? regionOf(fleet.get(nodeId) ?? {}) : DEFAULT_REGION;
}

// ------------------------------------------------------------------ automatic promotion

/**
 * Why automatic promotion must not choose `replica` for this primary, or null. A replica outside
 * the primary's region (a standby region's replica in particular) never takes part in automatic
 * promotion, on the controller path or on the node (`autoPromotionAllowedAcrossRegion`); only
 * `yoal ha region promote` moves a database across regions. Stored regions are read whatever the
 * `REGIONS` flag says: a region is geography, and this rule only ever refuses.
 */
export function crossRegionPromotionRefusal(
	primary: { region?: string | null },
	replica: { name: string; region?: string | null },
): string | null {
	if (autoPromotionAllowedAcrossRegion(regionOf(primary), regionOf(replica))) return null;
	return `${replica.name} is in region "${regionOf(replica)}", not the primary's region "${regionOf(primary)}"; a replica in another region is never promoted automatically (use yoal ha region promote ${regionOf(replica)})`;
}

/** Split replicas into those automatic promotion may consider and the cross-region ones it never may. */
export function partitionByPrimaryRegion<T extends { nodeId: string }>(
	replicas: readonly T[],
	primaryNodeId: string,
	fleet: ReadonlyMap<string, { name?: string; region?: string | null }>,
): { inRegion: T[]; refused: Array<{ replica: T; reason: string }> } {
	const primary = fleet.get(primaryNodeId) ?? {};
	const inRegion: T[] = [];
	const refused: Array<{ replica: T; reason: string }> = [];
	for (const replica of replicas) {
		const node = fleet.get(replica.nodeId) ?? {};
		const reason = crossRegionPromotionRefusal(primary, { name: node.name ?? replica.nodeId, region: node.region });
		if (reason) refused.push({ replica, reason });
		else inRegion.push(replica);
	}
	return { inRegion, refused };
}

/** The sync-set refusal for a target node, as a message, or null (`syncRegionRefusal`). */
export function syncTargetRefusal(
	primary: { name: string; region?: string | null },
	target: { name: string; region?: string | null },
): string | null {
	return syncRegionRefusal({ nodeName: primary.name, region: primary.region }, { nodeName: target.name, region: target.region })?.message ?? null;
}

// ------------------------------------------------------------------ region promotion lease gate

/** What one database's lease says about promoting `candidate` in a region promotion. */
export interface RegionLeaseGate {
	/**
	 * The lease is live: held by a node other than the candidate and not expired at the arbiter's
	 * clock, so the old primary may still be serving writes. Refused unless break glass.
	 */
	live: string | null;
	/** Never promotable, break glass or not: the W10 path itself would refuse it. */
	blocker: string | null;
	/** The candidate is not in a `sync` lease's synchronous set: acknowledged commits may be lost. */
	syncSetLoss: string | null;
}

/**
 * The region promotion's live-lease gate for one database (W13 review). Pure.
 * - **live**: `holderNodeId !== candidate` and `expiresAt` is after the arbiter's clock
 *   (`serverDate`, else this process's). An unreadable arbiter counts as live: the old region may
 *   be serving and nothing proves otherwise.
 * - **blocker**: an open sync-set change (non-promotable, W9-SPEC §5.5), a lease past the planned
 *   generation (someone else acted), or a `sync` database with no lease at all.
 * - **syncSetLoss**: a `sync` lease that does not name the candidate. Reported on its own: a region
 *   promotion always accepts losing the replica's lag, and H26 keeps `sync` inside a region, so a
 *   standby region's replica is never in the set.
 */
export function regionLeaseGate(input: {
	record: { lease: DatabaseLease; serverDate?: number | null } | null;
	error?: string | null;
	durability: 'async' | 'sync';
	candidateNodeId: string;
	expectedGeneration: number;
	now: number;
	nodeName: (id: string) => string;
}): RegionLeaseGate {
	const gate: RegionLeaseGate = { live: null, blocker: null, syncSetLoss: null };
	if (input.error) {
		gate.live = `the lease could not be read (${input.error}), so the old primary may still hold it`;
		return gate;
	}
	const lease = input.record?.lease;
	if (!lease) {
		if (input.durability === 'sync') gate.blocker = 'there is no database lease, so a synchronous database cannot prove which replica may take over';
		return gate;
	}
	if (lease.syncState !== 'steady')
		gate.blocker = 'a sync-set change is open on the lease, so no replica may be promoted until it closes or falls back';
	else if (lease.generation > input.expectedGeneration)
		gate.blocker = `the lease is at generation ${lease.generation}, past the planned ${input.expectedGeneration}: someone else acted`;
	const clock = input.record?.serverDate ?? input.now;
	const expiresAt = Date.parse(lease.expiresAt);
	if (lease.holderNodeId !== input.candidateNodeId && (!Number.isFinite(expiresAt) || expiresAt > clock))
		gate.live = `the lease is held by ${input.nodeName(lease.holderNodeId)} at generation ${lease.generation} until ${lease.expiresAt}`;
	if (effectiveDurability(lease) === 'sync' && !lease.sync.includes(input.candidateNodeId))
		gate.syncSetLoss = `${input.nodeName(input.candidateNodeId)} is not in the synchronous set${lease.sync.length ? ` (${lease.sync.map(input.nodeName).join(', ')})` : ''}, so commits acknowledged after its replay position are lost`;
	return gate;
}

// ------------------------------------------------------------------ standby region

/** A node that could hold a database's standby replica. */
export interface StandbyCandidate extends RegionNode {
	roles: readonly string[];
	/** Has a managed overlay address, so it can stream from another node. */
	overlay: boolean;
	/** Advertises `database-replicas`. */
	replicaCapable: boolean;
	freeMemoryMb: number;
}

/**
 * The node a standby region's async replica goes on: an online data node in that region with an
 * overlay address, the replica capability and room for the database's memory; the most free memory
 * wins, then the name. Null with the first-failing reason per node when none can.
 */
export function pickStandbyNode(input: {
	region: string;
	primaryNodeId: string;
	memoryMb: number;
	candidates: readonly StandbyCandidate[];
}): { node: StandbyCandidate; reasons: string[] } | { node: null; reasons: string[] } {
	const reasons: string[] = [];
	const eligible: StandbyCandidate[] = [];
	for (const candidate of input.candidates) {
		if (regionOf(candidate) !== input.region) continue;
		const why =
			candidate.id === input.primaryNodeId
				? 'it holds the primary'
				: candidate.status !== 'online'
					? `it is ${candidate.status}`
					: !candidate.roles.includes('data')
						? 'it has no data role'
						: !candidate.overlay
							? 'it has no managed overlay address'
							: !candidate.replicaCapable
								? 'its agent does not run database replicas'
								: candidate.freeMemoryMb < input.memoryMb
									? `only ${Math.max(0, candidate.freeMemoryMb)} MB free`
									: null;
		if (why) reasons.push(`${candidate.name}: ${why}`);
		else eligible.push(candidate);
	}
	eligible.sort((a, b) => b.freeMemoryMb - a.freeMemoryMb || a.name.localeCompare(b.name));
	const node = eligible[0];
	return node ? { node, reasons } : { node: null, reasons };
}

// ------------------------------------------------------------------ database spread

/**
 * Nodes for a database's missing replicas under a spread (`node`, `zone` or `region`): the primary
 * and the existing replicas keep their nodes and count as copies, so `spread: region` puts each new
 * replica in a region that holds no copy yet. `region` is placed as `zone` while `REGIONS` is off.
 * For blueprints (`databases.<name>.spread`) and any caller that places replicas without naming a
 * node. Pure; the caller adds each replica through `DatabaseReplicaService.add`.
 */
export function planDatabaseReplicaNodes(input: {
	primaryNodeId: string;
	replicaNodeIds: readonly string[];
	/** Replicas wanted in total, existing ones included. */
	replicas: number;
	memoryMb: number;
	spread: ReplicaSpread;
	regions: boolean;
	candidates: readonly ReplicaCandidate[];
}): { ok: true; nodeIds: string[] } | { ok: false; message: string } {
	const existing = [input.primaryNodeId, ...input.replicaNodeIds].map((nodeId, index) => ({ index, nodeId }));
	const decision = planReplicas({
		count: 1 + input.replicas,
		memoryMb: input.memoryMb,
		spread: placementSpread(input.spread, { REGIONS: input.regions }),
		regions: input.regions,
		existing,
		candidates: [...input.candidates],
		reason: 'database replica',
	});
	if (!decision.ok) return { ok: false, message: decision.message.replace(/copies/g, 'database copies') };
	// The primary is copy 0: if its node is not a usable candidate the planner would "place" it
	// again, which is a move, not a replica.
	if (!decision.kept.includes(0)) return { ok: false, message: "The primary's node is not an online candidate, so replicas cannot be planned around it." };
	return {
		ok: true,
		nodeIds: decision.plan.assignments.filter((copy) => decision.placed.includes(copy.index)).map((copy) => copy.nodeId),
	};
}

// ------------------------------------------------------------------ promotion plan

/**
 * sha256 over the target region and each step's kind, resource and expected generation (the
 * contract's `planHash`). Any generation that moved since the plan was shown changes the hash, so
 * a stale plan is refused.
 */
export function regionPlanHash(toRegion: string, steps: readonly Pick<RegionPromotionStepView, 'kind' | 'resourceId' | 'expectedGeneration'>[]): string {
	return sha256Hex(JSON.stringify([toRegion, ...steps.map((step) => [step.kind, step.resourceId, step.expectedGeneration])]));
}

/** The largest planned lag in seconds, or null when no step knows its lag. */
export function maxPlannedLag(steps: readonly Pick<RegionPromotionStepView, 'lagSeconds'>[]): number | null {
	const known = steps.map((step) => step.lagSeconds).filter((value): value is number => value !== null);
	return known.length ? Math.max(...known) : null;
}

// ------------------------------------------------------------------ steering

/**
 * The ingress nodes a steering driver should offer traffic when the fleet spans regions (H18
 * stacked steering): those in the active region; when none of them is online, every other region's
 * ingress, so reads keep serving from the standby region until a human promotes it. With one region
 * (every install before W13) the set is unchanged. Never empty while any ingress exists.
 */
export function regionSteeringSet<T extends { region?: string | null; status: string }>(ingress: readonly T[], activeRegion: string | null): T[] {
	if (activeRegion === null) return [...ingress];
	const regions = new Set(ingress.map((node) => regionOf(node)));
	if (regions.size < 2) return [...ingress];
	const home = ingress.filter((node) => regionOf(node) === activeRegion);
	if (home.some((node) => node.status !== 'offline')) return home;
	return ingress.filter((node) => regionOf(node) !== activeRegion);
}
