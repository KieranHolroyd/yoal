/**
 * Constants and shared types for the W9 model (W9-SPEC.md §3, §7).
 *
 * Everything here is transcribed from docs/build-plan/W9-SPEC.md. The model is written from that
 * text, not from packages/core/src/ha-lease.ts or the database member implementation.
 */

/** W9-SPEC §3. */
export const SPEC = {
	control: {
		ttlMs: 30_000,
		renewMs: 10_000,
		takeoverQuietMs: 40_000,
		fenceAfterMs: 20_000,
	},
	db: {
		ttlMs: 15_000,
		renewMs: 5_000,
		acquireBudgetMs: 2_000,
		promoteBudgetMs: 5_000,
	},
	keepAliveMs: 5_000,
	discoveryMinMs: 1_000,
	discoveryMaxMs: 2_000,
	syncDowngradeAfterMs: 30_000,
	successorQuietMs: 5_000,
} as const;

export type MemberId = 'p' | 'a' | 'b';
export type ControlId = 'c0' | 'c1' | 'c2';
export type Durability = 'sync' | 'async';
export type SyncState = 'steady' | 'changing';
export type SyncLossPolicy = 'downgrade' | 'block';

/** Pieces of W9-SPEC that are deliberately varied to show the checker has teeth. */
export type Mutant =
	| 'none'
	/** The primary fences after 25 s, past the 15 s TTL (breaks §5.3). */
	| 'fence-25s'
	/** The fence timer reads the node's wall clock; a step back extends it. */
	| 'fence-wall-clock'
	/** A replica promotes although the lease's sync set does not name it (breaks I12). */
	| 'ignore-eligibility'
	/** A replica promotes although it answered a keep-alive within one TTL (breaks §5.3). */
	| 'ignore-keepalive'
	/** The candidate CASes at the same generation (breaks I3 by construction). */
	| 'cas-same-generation'
	/** A buggy member that promotes while `syncState: 'changing'` (Revision 1's forbidden case). */
	| 'promote-while-changing';

export interface DbLease {
	generation: number;
	holderNodeId: MemberId;
	expiresAt: number;
	sync: MemberId[];
	syncState: SyncState;
	durability: Durability;
	/** Effective durability actually in force (the spec's `durability_effective`). */
	durabilityEffective: Durability;
	syncSetAt: number;
}

export interface ControlLease {
	epoch: number;
	holderNodeId: ControlId;
	expiresAt: number;
}

export type FaultKind =
	| 'edge-down'
	| 'freeze'
	| 'crash'
	| 'clock-step'
	| 'sync-change'
	| 'lag'
	| 'kill-primary'
	| 'kill-after-open'
	| 'kill-after-barrier'
	| 'control-crash'
	| 'master-key';

export interface Fault {
	id: number;
	at: number;
	kind: FaultKind;
	/** For one-end faults: the node (member/control id). */
	node?: string;
	/** edge-down: the sender. */
	from?: string;
	/** edge-down: the receiver. `from`/`to` name either members, control ids, "arb" or "consumer". */
	to?: string;
	/** edge-down: refuse (fast error) or drop (black hole, request times out). */
	mode?: 'refuse' | 'drop';
	/** edge-down: apply both directions. */
	symmetric?: boolean;
	/** lag / sync-change: the member the primary is talking about. */
	target?: string;
	durationMs?: number;
	/** clock-step: signed milliseconds. */
	value?: number;
}

export interface Expectation {
	/** The control plane cannot reach the arbiter here; I11 is judged in this window. */
	controlOutage?: { from: number; to: number };
	/** A database primary is lost at `after`; a new primary must be up by `after + withinMs`. */
	failover?: { after: number; withinMs: number };
	/** At least `min` writes must be acknowledged inside the window (traffic continues). */
	requireAcks?: { from: number; to: number; min: number };
	/** No database promotion may complete inside the window (the arbiter is away). */
	noPrimary?: { from: number; to: number };
}

export interface Scenario {
	name: string;
	family: Family;
	durationMs: number;
	faults: Fault[];
	expect: Expectation;
	/** Initial durability. The sync set is always {b} unless overridden. */
	durability?: Durability;
	sync?: MemberId[];
	syncLoss?: SyncLossPolicy;
	writes?: boolean;
}

export const FAMILIES = [
	'renew-loss',
	'cas-race',
	'arbiter-outage',
	'asymmetric',
	'clock-step',
	'stale-leader',
	'sync-change',
	'keepalive-acquire',
	'control-outage',
	'mixed',
] as const;

export type Family = (typeof FAMILIES)[number];

/** I13's two readings: at promotion, and an ack lost to an already-existing higher generation. */
export type ViolationKind =
	| 'two-primary-same-generation'
	| 'two-control-primary-same-epoch'
	| 'promotion-not-in-sync-set'
	| 'promotion-during-sync-change'
	| 'missing-ack-at-promotion'
	| 'ack-lost-to-higher-primary'
	| 'end-primary-missing-ack'
	| 'failover-too-slow'
	| 'no-traffic-during-control-outage'
	| 'primary-during-arbiter-outage'
	| 'acquired-too-early-after-keepalive'
	| 'lease-generation-decreased'
	| 'lease-epoch-decreased'
	| 'lease-holder-change-not-plus-one';

export type Property = 'I3' | 'I12' | 'I13' | 'I11' | 'support';

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
	controlTakeovers: number;
	acks: number;
	writes: number;
	rejectedWrites: number;
	failClosedPolls: number;
	strictOverlapMs: number;
	controlStrictOverlapMs: number;
	controlOutageAcks: number;
	failoverLatencyMs: number | null;
	controlPromotions: number;
	syncChangesOpened: number;
	syncChangesClosed: number;
	syncChangesFellBack: number;
	syncChangesDowngraded: number;
	primaryKilledChanging: number;
}

export interface RunResult {
	seed: number;
	family: Family;
	scenario: string;
	violations: Violation[];
	stats: RunStats;
	trace: TraceEvent[];
	events: number;
	durationMs: number;
}
