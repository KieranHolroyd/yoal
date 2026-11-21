import { z } from 'zod';
import type { DatabaseLease, DatabaseMemberRole } from './database-member.ts';

/**
 * The W11 automatic-failover machine, as pure decisions (docs/build-plan/W11-SPEC.md Revision 4).
 *
 * The node member machine and the control-plane reader share this module so there is one reading of
 * §4 (candidate), §5 (promotion and the fence notice), §6 (consumer discovery) and §7 (the reader).
 * Nothing here performs I/O or decides by a local wall clock: an expiry is always compared with the
 * arbiter's clock supplied by the caller (W9-SPEC assumption 2).
 *
 * Every function is total and returns its refusals rather than throwing, so a surface can show why
 * a member is not a candidate and a test can exercise each rule in isolation (W11-SPEC §11).
 */

/** W11-SPEC §9. */
export const W11_TIMERS = {
	/** §4.1: the candidate's WAL receiver must have been down this long. */
	streamDownMs: 5_000,
	/** W9-SPEC §3 `DB_TTL`: the primary lease. */
	leaseTtlMs: 15_000,
	/** §5.0: the fencing primary sends its notice within this budget. */
	fenceNoticeBudgetMs: 2_000,
	/** §5.1: the candidate's CAS budget. */
	acquireBudgetMs: 2_000,
	/** §5.3: `pg_ctl promote`. */
	promoteBudgetMs: 5_000,
	/** §6: consumer role/generation poll. */
	discoveryMinMs: 1_000,
	discoveryMaxMs: 2_000,
} as const;

/**
 * W11-SPEC §1.8/§5.0, Revision 3. `generation` is the lease generation the sender held; `epoch` is
 * the sender's authenticated database term. W9's database lease has a generation but no separate
 * epoch, so the machine accepts a notice only when both name the generation being acquired from
 * (W11-MODEL assumption 16). `at` is diagnostics and is never used for a safety decision.
 */
export const fenceNoticeSchema = z.object({
	generation: z.number().int().nonnegative(),
	epoch: z.number().int().nonnegative(),
	from: z.string().min(1).max(64),
	at: z.string().datetime().optional(),
});
export type FenceNotice = z.infer<typeof fenceNoticeSchema>;

/** The durability in force right now (`on_sync_loss: downgrade` can make it async). */
export function effectiveDurability(lease: Pick<DatabaseLease, 'durability' | 'durabilityEffective'>): 'sync' | 'async' {
	return lease.durabilityEffective ?? lease.durability;
}

/**
 * §1.8/§4.4: a notice is usable only for the generation being acquired, from the authenticated
 * holder of that generation, with a matching epoch. A cross-generation, stale, forged (`from`) or
 * bad-epoch notice is stored/diagnosed by the caller but never authorises a waiver.
 */
export function fenceNoticeValid(
	notice: FenceNotice | null | undefined,
	lease: Pick<DatabaseLease, 'generation' | 'holderNodeId'> | null | undefined,
	expectedFrom?: string,
): boolean {
	if (!notice || !lease) return false;
	if (notice.generation !== lease.generation) return false;
	if (notice.epoch !== notice.generation) return false;
	if (notice.from !== lease.holderNodeId) return false;
	if (expectedFrom !== undefined && notice.from !== expectedFrom) return false;
	return true;
}

/** §4.1: the stream-down fact. A notice waives the duration, never the fact. */
export function streamDownObserved(input: { streaming: boolean; streamDownSince: number | null }): boolean {
	return !input.streaming && input.streamDownSince !== null;
}

/** §4.2: expiry uses the arbiter's clock. At `expiresAt` the lease is expired. */
export function leaseExpiredByArbiter(
	lease: Pick<DatabaseLease, 'expiresAt'> | null,
	arbiterNow: number,
): boolean {
	if (!lease) return true;
	const expiresAt = Date.parse(lease.expiresAt);
	return !Number.isFinite(expiresAt) || expiresAt <= arbiterNow;
}

/**
 * §3 live half (W11-MODEL assumption 9): arming is an operator action; this predicate can only
 * disable it. A `sync` database downgraded to effective `async` without `acceptDataLoss` no longer
 * meets "durability is sync, or async with acceptDataLoss", so auto turns itself off.
 */
export function autoEnabledFor(armed: boolean, durabilityEffective: 'sync' | 'async', acceptDataLoss: boolean): boolean {
	if (!armed) return false;
	if (durabilityEffective === 'async' && !acceptDataLoss) return false;
	return true;
}

export const candidateRefusalCodes = [
	/** The member is following/applying WAL; promotion needs the stream to be down first. */
	'stream-up',
	/** The stream has not been down for `STREAM_DOWN_MS`; only a valid fence notice waives this. */
	'stream-down-debounce',
	/** The arbiter is unreachable, so the member cannot prove expiry. Promotion always needs it. */
	'arbiter-unreachable',
	/** There is no lease to acquire. */
	'no-lease',
	/** The lease has not expired by the arbiter's clock. */
	'lease-not-expired',
	/** A sync-set change is open: non-promotable for everyone (W9-SPEC §5.5). */
	'sync-transition-open',
	/** Arming is manual, refused, or lapsed. */
	'auto-not-armed',
	/** A `sync` lease does not name this member (I12). */
	'not-in-sync-set',
	/** An `async` lease without an explicit data-loss acceptance. */
	'data-loss-not-accepted',
	/** The member answered the primary's keep-alive within one TTL (H21 failsafe agreement). */
	'keep-alive-block',
	/** Another CAS attempt for this member is still in flight. */
	'cas-in-flight',
] as const;
export type CandidateRefusalCode = (typeof candidateRefusalCodes)[number];

export interface CandidateRefusal {
	code: CandidateRefusalCode;
	message: string;
}

/**
 * Everything §4 asks. `lastPrimaryAnswerAt` is this member's own view of when it last answered the
 * primary's keep-alive (not another member's), because the model's gate is the member's own answer.
 */
export interface CandidateEvidence {
	nodeId: string;
	/** The arbiter's clock in epoch milliseconds, never the node's wall clock. */
	arbiterNow: number;
	lease: DatabaseLease | null;
	arbiterReachable: boolean;
	/** This member's WAL receiver. */
	streaming: boolean;
	/** When the receiver was first observed not streaming (arbiter/monotonic ms), or null. */
	streamDownSince: number | null;
	/** The per-database policy is armed and still holds (see `autoEnabledFor`). */
	autoArmed: boolean;
	acceptDataLoss: boolean;
	/** When this member last answered the primary's keep-alive, or null if never. */
	lastPrimaryAnswerAt: number | null;
	/**
	 * The monotonic/local clock for duration rules (the 5 s debounce and the one-TTL keep-alive
	 * age). `arbiterNow` stays authoritative for lease expiry. Defaults to `arbiterNow`.
	 */
	monotonicNow?: number;
	/** The best notice this member holds, if any. */
	notice: FenceNotice | null;
	casInFlight?: boolean;
	streamDownMs?: number;
	keepAliveTtlMs?: number;
}

export interface CandidateDecision {
	eligible: boolean;
	refusals: CandidateRefusal[];
	/** The notice waived the §4.1 debounce (it never waives the stream-down fact). */
	debounceWaived: boolean;
	/** The notice waived the §4.4 one-TTL keep-alive block. */
	keepAliveWaived: boolean;
	/** Whether this member holds a usable notice for the current lease generation. */
	noticeValid: boolean;
}

/**
 * W11-SPEC §4, all six conditions. The notice waives the debounce duration and the keep-alive block
 * only; it cannot make a live stream down, an expired lease live, an ineligible member eligible or a
 * `changing` lease promotable.
 */
export function evaluateCandidate(input: CandidateEvidence): CandidateDecision {
	const refusals: CandidateRefusal[] = [];
	const refuse = (code: CandidateRefusalCode, message: string) => refusals.push({ code, message });
	const lease = input.lease;
	const noticeValid = fenceNoticeValid(input.notice, lease);
	const down = streamDownObserved(input);
	const expiresAt = lease ? Date.parse(lease.expiresAt) : Number.NaN;
	const expired = lease !== null && Number.isFinite(expiresAt) && expiresAt <= input.arbiterNow;
	const maxAnswerAge = input.keepAliveTtlMs ?? W11_TIMERS.leaseTtlMs;
	const localNow = input.monotonicNow ?? input.arbiterNow;
	const answeredRecently =
		input.lastPrimaryAnswerAt !== null && localNow - input.lastPrimaryAnswerAt < maxAnswerAge;
	const debounceMs = input.streamDownMs ?? W11_TIMERS.streamDownMs;
	const debounceHeld =
		down && !noticeValid && localNow - (input.streamDownSince ?? localNow) < debounceMs;

	if (input.casInFlight) refuse('cas-in-flight', 'a promotion compare-and-swap is already in flight');
	if (!lease) refuse('no-lease', 'there is no database lease');
	if (!input.arbiterReachable) refuse('arbiter-unreachable', 'the arbiter cannot be reached, so expiry cannot be proved');
	if (lease && !expired)
		refuse('lease-not-expired', 'the primary lease has not expired by the arbiter clock, so it is still held');
	if (lease && lease.syncState !== 'steady')
		refuse('sync-transition-open', 'a sync-set change is open, so no member may promote automatically');
	if (!input.autoArmed) refuse('auto-not-armed', 'automatic failover is not armed for this database');
	if (lease && effectiveDurability(lease) === 'sync') {
		if (!lease.sync.includes(input.nodeId))
			refuse('not-in-sync-set', 'this member is not named in the lease’s synchronous set at this generation (I12)');
	} else if (lease && !input.acceptDataLoss) {
		refuse(
			'data-loss-not-accepted',
			'an async promotion may lose recent commits, and this database has not accepted that data loss',
		);
	}
	if (lease && !down) refuse('stream-up', 'this member is still streaming, so the primary is alive to it');
	if (lease && down && debounceHeld)
		refuse(
			'stream-down-debounce',
			`the WAL receiver has not been down for ${Math.round(debounceMs / 1000)} s and no valid fence notice waived it`,
		);
	if (lease && answeredRecently && !noticeValid)
		refuse(
			'keep-alive-block',
			'this member answered the primary’s keep-alive within one TTL, so the primary may still be serving',
		);

	return {
		eligible: refusals.length === 0,
		refusals,
		debounceWaived: noticeValid && down,
		keepAliveWaived: noticeValid && answeredRecently,
		noticeValid,
	};
}

/**
 * §5.1: the candidate's CAS body. `sync: []` and `changing` make the acquired lease non-promotable
 * until the winner re-arms it through the Revision 1 transition. `durabilityEffective` is inherited
 * so the winner knows whether it must prove RPO 0.
 */
export function promotionLease(
	from: Pick<DatabaseLease, 'generation' | 'durability' | 'durabilityEffective'>,
	nodeId: string,
	arbiterNow: number,
	ttlMs: number = W11_TIMERS.leaseTtlMs,
): DatabaseLease {
	return {
		generation: from.generation + 1,
		holderNodeId: nodeId,
		expiresAt: new Date(arbiterNow + ttlMs).toISOString(),
		sync: [],
		syncState: 'changing',
		durability: from.durability,
		durabilityEffective: from.durabilityEffective ?? from.durability,
		syncSetAt: null,
	};
}

/**
 * §5.3: after `pg_ctl promote`, the new primary clears the sync setting and re-arms the transition.
 * `async` closes at once (`steady`, nobody named). `sync` stays `changing` until a barrier names a
 * fresh set; passing `target` closes `steady` only when the caller has already proved the barrier.
 */
export function rearmedPromotionLease(
	promoted: DatabaseLease,
	options: { durability: 'sync' | 'async'; target?: string | null; arbiterNow: number },
): DatabaseLease {
	const syncState = options.durability === 'async' || options.target ? 'steady' : 'changing';
	return {
		...promoted,
		sync: options.target ? [options.target] : [],
		syncState,
		durability: options.durability,
		durabilityEffective: options.durability,
		syncSetAt: options.target ? new Date(options.arbiterNow).toISOString() : null,
	};
}

/**
 * §5.3/§8: the old primary never resumes. `promoted` means it lost the lease or a higher generation
 * exists, so it fences first; only once a higher-generation primary is reachable does it rewind as a
 * replica. A member whose own generation is ahead of the row is not made a primary by the reader.
 */
export type OldPrimaryAction = 'serve' | 'fence' | 'rewind';

export function oldPrimaryAction(input: {
	/** This member's last reported generation. */
	generation: number;
	/** The highest generation the member has seen (lease, report or consumer poll). */
	highestGenerationSeen: number;
	/** The authoritative lease holder, when the member could read it. */
	leaseHolderNodeId: string | null;
	nodeId: string;
	role: DatabaseMemberRole;
	/** A primary at a strictly higher generation answers role discovery. */
	higherPrimaryReachable: boolean;
}): OldPrimaryAction {
	if (input.role !== 'primary' && input.role !== 'promoting') return 'serve';
	if (input.generation < input.highestGenerationSeen) return 'fence';
	if (input.leaseHolderNodeId !== null && input.leaseHolderNodeId !== input.nodeId) return 'fence';
	if (input.higherPrimaryReachable) return 'fence';
	return 'serve';
}

/** §6: one member's answer to the consumer's role/generation poll. */
export interface ConsumerMemberAnswer {
	nodeId: string;
	role: DatabaseMemberRole;
	generation: number;
	reachable: boolean;
}

export const consumerSelectionReasons = ['ok', 'no-primary', 'two-primaries', 'no-answer'] as const;
export type ConsumerSelectionReason = (typeof consumerSelectionReasons)[number];

export interface ConsumerSelection {
	/** The node to forward to; null means fail closed (refuse writes). */
	target: string | null;
	generation: number | null;
	reason: ConsumerSelectionReason;
	/** I3 violation: two reachable primaries at one generation. The consumer must alert and stop. */
	twoPrimaries: boolean;
}

/**
 * §6: forward only to a `primary` at the highest generation. No answer or two primaries at that
 * generation fails closed rather than guessing. A fenced/stale primary is never a target even if it
 * answers; the role is the member's own report.
 */
export function selectConsumerTarget(answers: readonly ConsumerMemberAnswer[]): ConsumerSelection {
	const primaries = answers.filter((answer) => answer.reachable && answer.role === 'primary');
	if (primaries.length === 0)
		return {
			target: null,
			generation: null,
			reason: answers.some((answer) => answer.reachable) ? 'no-primary' : 'no-answer',
			twoPrimaries: false,
		};
	const highest = Math.max(...primaries.map((answer) => answer.generation));
	const atHighest = primaries.filter((answer) => answer.generation === highest);
	if (atHighest.length > 1)
		return { target: null, generation: highest, reason: 'two-primaries', twoPrimaries: true };
	return { target: atHighest[0]!.nodeId, generation: highest, reason: 'ok', twoPrimaries: false };
}

/** §7: what a member reports about a promotion it performed or observed. */
export interface PromotionReportView {
	nodeId: string;
	generation: number;
	/** The generation the promotion acquired from; null when the report does not say. */
	fromGeneration: number | null;
	lsn: string | null;
	status: 'promoted' | 'failed';
	reportedAt: number;
}

/** The reader's row state: a display cache, never the authority (the lease is). */
export interface ReaderRowState {
	generation: number;
	primaryNodeId: string | null;
}

export const readerAlertCodes = [
	/** A report older than the row: never lower a generation. */
	'stale-promotion',
	/** Two primaries at one generation: an I3 violation, page and fence. */
	'two-primaries',
	/** A promotion from a lease that did not make the member eligible (I12). */
	'invalid-promotion',
	/** A report skipped generations; reconcile upward, but page so a lost step is visible. */
	'generation-gap',
	/** The report itself is malformed (wrong node, failed status with a promotion claim). */
	'malformed-report',
] as const;
export type ReaderAlertCode = (typeof readerAlertCodes)[number];

export interface ReaderAlert {
	code: ReaderAlertCode;
	message: string;
	severity: 'warning' | 'critical';
}

/** What the member claims it acquired from, so the reader can refuse an ineligible promotion. */
export interface PromotionEligibilityEvidence {
	durabilityEffective: 'sync' | 'async';
	sync: readonly string[];
	syncState: 'steady' | 'changing';
	acceptDataLoss: boolean;
}

export type ReaderDecision =
	| { action: 'apply'; generation: number; primaryNodeId: string; lsn: string | null; alerts: ReaderAlert[] }
	| { action: 'ignore'; reason: 'not-a-promotion' | 'older-generation' | 'same-generation' | 'invalid'; alerts: ReaderAlert[] }
	| { action: 'refuse'; alerts: ReaderAlert[]; fence: boolean };

/**
 * §7: the control plane reads a promotion report, records it and alerts, but never decides and never
 * lowers a generation. A promotion from an ineligible lease is refused (the live node must fence);
 * the reader cannot undo it, so `fence: true` tells the caller to page and fence.
 *
 * `evidence` is optional: when the reader has the from-lease it can check I12. When it does not, a
 * report is reconciled but the caller must not treat that as proof of eligibility.
 */
export function reconcilePromotionReport(
	row: ReaderRowState,
	report: PromotionReportView,
	evidence?: PromotionEligibilityEvidence | null,
): ReaderDecision {
	if (report.status !== 'promoted')
		return {
			action: 'ignore',
			reason: 'not-a-promotion',
			alerts: [
				{
					code: 'malformed-report',
					message: `Member ${report.nodeId} reported a failed promotion; nothing is recorded.`,
					severity: 'warning',
				},
			],
		};
	if (!Number.isInteger(report.generation) || report.generation < 0)
		return {
			action: 'refuse',
			fence: true,
			alerts: [
				{
					code: 'malformed-report',
					message: 'A promotion report carried no valid generation; the member must fence and page.',
					severity: 'critical',
				},
			],
		};
	if (report.generation < row.generation)
		return {
			action: 'ignore',
			reason: 'older-generation',
			alerts: [
				{
					code: 'stale-promotion',
					message: `Member ${report.nodeId} reported generation ${report.generation} while the row is at ${row.generation}; a generation is never lowered.`,
					severity: 'warning',
				},
			],
		};
	if (report.generation === row.generation) {
		if (row.primaryNodeId === report.nodeId || row.primaryNodeId === null)
			return {
				action: 'apply',
				generation: row.generation,
				primaryNodeId: report.nodeId,
				lsn: report.lsn,
				alerts: [],
			};
		return {
			action: 'ignore',
			reason: 'same-generation',
			alerts: [
				{
					code: 'two-primaries',
					message: `Two members claim to be primary at generation ${report.generation}: ${row.primaryNodeId} and ${report.nodeId}. I3 is violated; both must be fenced and paged.`,
					severity: 'critical',
				},
			],
		};
	}
	if (evidence) {
		const invalid =
			evidence.syncState !== 'steady'
				? 'a sync-set change was open'
				: evidence.durabilityEffective === 'sync' && !evidence.sync.includes(report.nodeId)
					? 'the member was not in the synchronous set'
					: evidence.durabilityEffective === 'async' && !evidence.acceptDataLoss
						? 'the database had not accepted data loss'
						: null;
		if (invalid)
			return {
				action: 'refuse',
				fence: true,
				alerts: [
					{
						code: 'invalid-promotion',
						message: `Member ${report.nodeId} promoted at generation ${report.generation}, but ${invalid}. The promotion is live; fence the member and page (I12).`,
						severity: 'critical',
					},
				],
			};
	}
	const gap: ReaderAlert[] = [];
	if (report.generation !== row.generation + 1)
		gap.push({
			code: 'generation-gap',
			message: `Generation ${row.generation} → ${report.generation} skipped steps; the row is reconciled upward but a lost report or an unauthorised promotion must be explained.`,
			severity: 'warning',
		});
	return {
		action: 'apply',
		generation: report.generation,
		primaryNodeId: report.nodeId,
		lsn: report.lsn,
		alerts: gap,
	};
}

/**
 * §9: the time-to-writable measurement. The clock starts at the primary's last successful lease
 * write; a sample is only judgeable when that baseline is known. Returns null when it cannot be
 * measured (the caller records an unmeasured drill, which refuses arming).
 */
export function timeToWritableMs(lastLeaseWriteAt: number | null, writableAt: number | null): number | null {
	if (lastLeaseWriteAt === null || writableAt === null) return null;
	const value = writableAt - lastLeaseWriteAt;
	return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** §9: the bound, and whether a sample is within it (strictly greater than 30 s fails). */
export function withinTimeToWritable(value: number | null): boolean {
	return value !== null && value <= 30_000;
}

/** Whether a fencing primary is inside §5.0's 2 s notice budget. */
export function fenceNoticeWithinBudget(decidedAt: number, sentAt: number): boolean {
	return sentAt - decidedAt <= W11_TIMERS.fenceNoticeBudgetMs;
}
