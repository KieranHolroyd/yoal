/**
 * Constants and shared types for the W11 model (W11-SPEC.md §2, §3, §9).
 *
 * Everything here is transcribed from docs/build-plan/W11-SPEC.md, which extends W9-SPEC §5. The
 * production implementation of automatic failover was not read.
 */

/** W11-SPEC §9 plus the W9-SPEC §3 timers the member machine already uses. */
export const SPEC = {
	db: {
		ttlMs: 15_000,
		renewMs: 5_000,
		acquireBudgetMs: 2_000,
		promoteBudgetMs: 5_000,
		/** W11-SPEC §4.1: the candidate's own WAL receiver must be down this long. */
		streamDownMs: 5_000,
	},
	keepAliveMs: 5_000,
	discoveryMinMs: 1_000,
	discoveryMaxMs: 2_000,
	syncChangeTimeoutMs: 30_000,
	syncDowngradeAfterMs: 30_000,
	/** W11-SPEC §2, "New": median ≤ 25 s, worst ≤ 30 s from the last successful lease renew. */
	timeToWritable: { medianMs: 25_000, worstMs: 30_000 },
	/** W11-SPEC §3. */
	policy: { minDataNodes: 3, minZones: 2, drillMaxAgeDays: 30 },
} as const;

export type MemberId = 'p' | 'a' | 'b';
export type Durability = 'sync' | 'async';
export type SyncState = 'steady' | 'changing';
export type SyncLossPolicy = 'downgrade' | 'block';

/**
 * Pieces of W11-SPEC that are deliberately varied to show the checker has teeth.
 *
 * None of these is part of the 5,000-schedule normal run.
 */
export type Mutant =
	| 'none'
	/** Ignore the arming decision and let a replica acquire (breaks W11 §3 / the refusal contract). */
	| 'arm-anyway'
	/** Ignore I12 and let a replica not in the sync set acquire. */
	| 'ignore-eligibility'
	/** Ignore W11 §4.4 and acquire although the member answered a keep-alive within one TTL. */
	| 'ignore-keepalive'
	/** CAS at the same generation (breaks I3 by construction). */
	| 'cas-same-generation'
	/** Promote from an async lease without `acceptDataLoss`. */
	| 'async-without-accept'
	/** The arbiter accepts a second holder at one generation (breaks I3). */
	| 'cas-second-holder'
	/** The primary fences on the node's wall clock instead of the monotonic proof window. */
	| 'fence-wall-clock';

export interface DbLease {
	generation: number;
	holderNodeId: MemberId;
	expiresAt: number;
	/** W11 §5.1: a candidate CASes this as `[]`; the new primary re-arms a fresh set. */
	sync: MemberId[];
	syncState: SyncState;
	durability: Durability;
	/** Effective durability actually in force (the spec's `durability_effective`). */
	durabilityEffective: Durability;
	syncSetAt: number;
}

export type FaultKind =
	| 'edge-down'
	| 'freeze'
	/** `durationMs: 0` is a power-off for the rest of the run. */
	| 'crash'
	| 'kill-primary'
	| 'clock-step'
	| 'lag'
	| 'sync-change'
	| 'kill-after-open'
	| 'kill-after-barrier'
	/** The control plane is unreachable. It never decides, so this must not stop failover (I11). */
	| 'control-down';

export interface Fault {
	id: number;
	at: number;
	kind: FaultKind;
	node?: string;
	from?: string;
	to?: string;
	mode?: 'refuse' | 'drop';
	symmetric?: boolean;
	target?: string;
	durationMs?: number;
	value?: number;
}

/**
 * The per-database policy and fleet facts W11-SPEC §3 checks when `auto` is armed. The model keeps
 * them as data so the refusal rules can be evaluated in isolation and in schedules.
 */
export interface PolicyConfig {
	requested: 'manual' | 'auto';
	globalFlag: boolean;
	acceptDataLoss: boolean;
	/** Count of nodes that have role data and capability `db-member`. */
	dataNodes: number;
	/** Distinct zones of those nodes. */
	zones: number;
	drill: 'passed' | 'failed' | 'stale' | 'none';
	replicaOnAnotherOnlineNode: boolean;
	switchoverActive: boolean;
	syncStepping: boolean;
	allDbMember: boolean;
}

export type RefusalReason =
	| 'global-flag-off'
	| 'durability-async-without-accept-data-loss'
	| 'fewer-than-three-data-nodes'
	| 'fewer-than-two-zones'
	| 'no-failover-drill'
	| 'failover-drill-stale'
	| 'failover-drill-failed'
	| 'no-replica-on-another-online-node'
	| 'active-switchover'
	| 'sync-transition'
	| 'node-not-db-member';

export interface ArmDecision {
	/** True only when the operator asked for `auto` and every W11 §3 rule holds. */
	armed: boolean;
	mode: 'auto' | 'manual';
	refusals: RefusalReason[];
}

export interface Expectation {
	/** A database primary is lost at `after`; a new primary must be writable within `withinMs`. */
	failover?: { after: number; withinMs: number };
	/** No database promotion may complete inside the window. */
	noPrimary?: { from: number; to: number };
	/** At least `min` writes must be acknowledged inside the window (traffic continues). */
	requireAcks?: { from: number; to: number; min: number };
	/** `node` must stay primary with no fence event inside the window. */
	primaryStays?: { node: MemberId; from: number; to: number };
	/** The control plane is unreachable; failover and traffic must continue and the row never falls. */
	controlDown?: { from: number; to: number; minAcks?: number; requirePromotion?: boolean };
	/** `auto` was refused; no automatic promotion may happen. */
	autoRefused?: RefusalReason;
	/**
	 * Whether W11 §9's time-to-writable bound applies to this schedule. It does not when the
	 * arbiter is unreachable for the candidate too: §10 says no promotion is possible then, so a
	 * post-outage recovery is not a failover under the working-arbiter budget.
	 */
	ttf?: boolean;
}

export interface Scenario {
	name: string;
	family: Family;
	durationMs: number;
	faults: Fault[];
	expect: Expectation;
	durability: Durability;
	sync: MemberId[];
	syncLoss: SyncLossPolicy;
	writes: boolean;
	policy: PolicyConfig;
}

export const FAMILIES = [
	'power-off',
	'freeze',
	'partition-arbiter-ok',
	'partition-isolated',
	'arbiter-outage',
	'two-candidates',
	'stale-leader',
	'clock-step',
	'sync-named-dead',
	'failsafe-keepalive',
	'control-down',
	'refusal',
	'mixed',
] as const;

export type Family = (typeof FAMILIES)[number];

export type ViolationKind =
	| 'two-primary-same-generation'
	| 'promotion-not-in-sync-set'
	| 'promotion-during-sync-change'
	| 'promotion-not-armed'
	| 'promotion-without-accept-data-loss'
	| 'missing-ack-at-promotion'
	| 'ack-lost-to-higher-primary'
	| 'end-primary-missing-ack'
	| 'time-to-writable-exceeded'
	| 'no-promotion-when-expected'
	| 'promotion-when-forbidden'
	| 'primary-fenced-unexpectedly'
	| 'no-traffic-during-outage'
	| 'control-reader-lowered-generation'
	| 'acquired-too-early-after-keepalive'
	| 'lease-generation-decreased'
	| 'lease-holder-change-not-plus-one';

export type Property = 'I3' | 'I12' | 'I13' | 'I11' | 'bound' | 'policy' | 'support';

export interface Violation {
	property: Property;
	kind: ViolationKind;
	t: number;
	message: string;
}

export interface TraceEvent {
	t: number;
	actor: string;
	text: string;
}

export interface RunStats {
	promotions: number;
	acks: number;
	writes: number;
	rejectedWrites: number;
	failClosedPolls: number;
	strictOverlapMs: number;
	primaryLosses: number;
	fences: number;
	syncChangesOpened: number;
	syncChangesClosed: number;
	syncChangesFellBack: number;
	syncChangesDowngraded: number;
	primaryKilledChanging: number;
	candidateAttempts: number;
	candidateLostCas: number;
	controlDownPromotions: number;
	controlDownAcks: number;
	controlRowGeneration: number;
	staleResumes: number;
	asyncLostAcks: number;
	ttfExempt: number;
}

export interface RunResult {
	seed: number;
	family: Family;
	scenario: string;
	violations: Violation[];
	stats: RunStats;
	/** Time-to-writable samples, in ms, from the lost primary's last applied lease write. */
	failoverLatenciesMs: number[];
	trace: TraceEvent[];
	events: number;
	durationMs: number;
}
