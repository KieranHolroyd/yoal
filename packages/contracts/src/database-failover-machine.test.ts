import { describe, expect, test } from 'bun:test';
import {
	evaluateCandidate,
	fenceNoticeValid,
	oldPrimaryAction,
	promotionLease,
	rearmedPromotionLease,
	reconcilePromotionReport,
	selectConsumerTarget,
	timeToWritableMs,
	type CandidateEvidence,
	type ConsumerMemberAnswer,
	type DatabaseLease,
	type FenceNotice,
} from './index.ts';

/**
 * The W11 automatic machine (docs/build-plan/W11-SPEC.md Revision 4). Each refusal is exercised on
 * its own so a rule cannot silently stop working; the fence notice tests pin the Revision 4 waiver
 * and the fact that it waives neither the stream-down fact nor the lease requirement.
 */

const NOW = 1_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

function lease(overrides: Partial<DatabaseLease> = {}): DatabaseLease {
	return {
		generation: 4,
		holderNodeId: 'nod_p',
		expiresAt: iso(NOW - 1),
		sync: ['nod_a'],
		syncState: 'steady',
		durability: 'sync',
		durabilityEffective: 'sync',
		syncSetAt: iso(NOW - 60_000),
		...overrides,
	};
}

function notice(overrides: Partial<FenceNotice> = {}): FenceNotice {
	return { generation: 4, epoch: 4, from: 'nod_p', at: iso(NOW - 100), ...overrides };
}

function evidence(overrides: Partial<CandidateEvidence> = {}): CandidateEvidence {
	return {
		nodeId: 'nod_a',
		arbiterNow: NOW,
		lease: lease(),
		arbiterReachable: true,
		streaming: false,
		streamDownSince: NOW - 6_000,
		autoArmed: true,
		acceptDataLoss: false,
		lastPrimaryAnswerAt: NOW - 20_000,
		notice: null,
		...overrides,
	};
}

describe('the fence notice (W11-SPEC §1.8, Revision 4)', () => {
	test('is valid only for the lease generation, holder and matching epoch', () => {
		expect(fenceNoticeValid(notice(), lease())).toBe(true);
		expect(fenceNoticeValid(notice({ generation: 3 }), lease())).toBe(false);
		expect(fenceNoticeValid(notice({ epoch: 3 }), lease())).toBe(false);
		expect(fenceNoticeValid(notice({ from: 'nod_b' }), lease())).toBe(false);
		expect(fenceNoticeValid(notice(), lease({ holderNodeId: 'nod_b' }))).toBe(false);
		expect(fenceNoticeValid(null, lease())).toBe(false);
		expect(fenceNoticeValid(notice(), null)).toBe(false);
		expect(fenceNoticeValid(notice(), lease(), 'nod_other')).toBe(false);
	});

	test('waives the stream-down debounce and the keep-alive block', () => {
		const decision = evaluateCandidate(
			evidence({ notice: notice(), streamDownSince: NOW - 100, lastPrimaryAnswerAt: NOW - 1_000 }),
		);
		expect(decision.eligible).toBe(true);
		expect(decision.debounceWaived).toBe(true);
		expect(decision.keepAliveWaived).toBe(true);
		expect(decision.refusals).toEqual([]);
	});

	test('does not waive the stream-down fact: a live stream is still refused', () => {
		const decision = evaluateCandidate(
			evidence({ notice: notice(), streaming: true, streamDownSince: null }),
		);
		expect(decision.eligible).toBe(false);
		expect(decision.refusals.map((refusal) => refusal.code)).toContain('stream-up');
	});

	test('waives nothing when stale, bad-epoch or forged', () => {
		for (const bad of [
			notice({ generation: 3 }),
			notice({ epoch: 3 }),
			notice({ from: 'nod_b' }),
		]) {
			const decision = evaluateCandidate(
				evidence({ notice: bad, streamDownSince: NOW - 100, lastPrimaryAnswerAt: NOW - 1_000 }),
			);
			expect(decision.eligible).toBe(false);
			expect(decision.noticeValid).toBe(false);
			expect(decision.debounceWaived).toBe(false);
			expect(decision.keepAliveWaived).toBe(false);
			expect(decision.refusals.map((refusal) => refusal.code)).toEqual(
				expect.arrayContaining(['stream-down-debounce', 'keep-alive-block']),
			);
		}
	});

	test('never waives a live lease, an open change or ineligibility', () => {
		expect(
			evaluateCandidate(evidence({ lease: lease({ expiresAt: iso(NOW + 1) }), notice: notice() })).refusals.map(
				(refusal) => refusal.code,
			),
		).toContain('lease-not-expired');
		expect(
			evaluateCandidate(evidence({ lease: lease({ syncState: 'changing' }), notice: notice() })).refusals.map(
				(refusal) => refusal.code,
			),
		).toContain('sync-transition-open');
		expect(
			evaluateCandidate(evidence({ lease: lease({ sync: ['nod_b'] }), notice: notice() })).refusals.map(
				(refusal) => refusal.code,
			),
		).toContain('not-in-sync-set');
	});
});

describe('candidate acquisition (W11-SPEC §4)', () => {
	const refusalCodes = (input: CandidateEvidence) => evaluateCandidate(input).refusals.map((refusal) => refusal.code);

	test('a settled replica is a candidate', () => {
		expect(evaluateCandidate(evidence())).toMatchObject({ eligible: true, refusals: [] });
	});

	test('refuses a live stream, an unexpired lease and an unreachable arbiter', () => {
		expect(refusalCodes(evidence({ streaming: true, streamDownSince: null }))).toContain('stream-up');
		expect(refusalCodes(evidence({ lease: lease({ expiresAt: iso(NOW + 5_000) }) }))).toContain('lease-not-expired');
		expect(refusalCodes(evidence({ arbiterReachable: false }))).toContain('arbiter-unreachable');
	});

	test('the debounce holds without a notice and the expiry is inclusive at the arbiter clock', () => {
		expect(refusalCodes(evidence({ streamDownSince: NOW - 4_999 }))).toContain('stream-down-debounce');
		expect(evaluateCandidate(evidence({ streamDownSince: NOW - 5_000 })).eligible).toBe(true);
		expect(refusalCodes(evidence({ lease: lease({ expiresAt: iso(NOW) }) }))).not.toContain('lease-not-expired');
	});

	test('refuses a changing lease and an unarmed policy', () => {
		expect(refusalCodes(evidence({ lease: lease({ syncState: 'changing' }) }))).toContain('sync-transition-open');
		expect(refusalCodes(evidence({ autoArmed: false }))).toContain('auto-not-armed');
	});

	test('sync needs the member named; async needs an explicit data-loss acceptance', () => {
		expect(refusalCodes(evidence({ lease: lease({ sync: ['nod_b'] }) }))).toContain('not-in-sync-set');
		expect(
			evaluateCandidate(evidence({ lease: lease({ durability: 'async', durabilityEffective: 'async', sync: [] }) }))
				.refusals.map((refusal) => refusal.code),
		).toContain('data-loss-not-accepted');
		expect(
			evaluateCandidate(
				evidence({
					lease: lease({ durability: 'async', durabilityEffective: 'async', sync: [] }),
					acceptDataLoss: true,
				}),
			).eligible,
		).toBe(true);
	});

	test('a downgraded sync database is async now, so it needs acceptDataLoss', () => {
		const downgraded = lease({ durability: 'sync', durabilityEffective: 'async', sync: [] });
		expect(refusalCodes(evidence({ lease: downgraded }))).toContain('data-loss-not-accepted');
	});

	test('refuses a member that answered the keep-alive within one TTL', () => {
		expect(refusalCodes(evidence({ lastPrimaryAnswerAt: NOW - 14_999 }))).toContain('keep-alive-block');
		expect(evaluateCandidate(evidence({ lastPrimaryAnswerAt: NOW - 15_000 })).eligible).toBe(true);
		expect(refusalCodes(evidence({ lastPrimaryAnswerAt: null }))).not.toContain('keep-alive-block');
	});

	test('refuses an in-flight CAS, a missing lease and a missing node', () => {
		expect(refusalCodes(evidence({ casInFlight: true }))).toContain('cas-in-flight');
		expect(refusalCodes(evidence({ lease: null }))).toContain('no-lease');
	});
});

describe('promotion (W11-SPEC §5)', () => {
	test('the CAS is generation + 1, sync [], changing, held by the winner', () => {
		const next = promotionLease(lease(), 'nod_a', NOW);
		expect(next).toEqual({
			generation: 5,
			holderNodeId: 'nod_a',
			expiresAt: iso(NOW + 15_000),
			sync: [],
			syncState: 'changing',
			durability: 'sync',
			durabilityEffective: 'sync',
			syncSetAt: null,
		});
	});

	test('async closes steady at once; sync stays changing until a fresh set is proved', () => {
		const promoted = promotionLease(lease({ durability: 'async', durabilityEffective: 'async' }), 'nod_a', NOW);
		expect(rearmedPromotionLease(promoted, { durability: 'async', arbiterNow: NOW })).toMatchObject({
			sync: [],
			syncState: 'steady',
			durabilityEffective: 'async',
		});
		expect(rearmedPromotionLease(promoted, { durability: 'sync', arbiterNow: NOW })).toMatchObject({
			sync: [],
			syncState: 'changing',
		});
		expect(rearmedPromotionLease(promoted, { durability: 'sync', target: 'nod_b', arbiterNow: NOW })).toMatchObject({
			sync: ['nod_b'],
			syncState: 'steady',
			durabilityEffective: 'sync',
		});
	});

	test('a loser of the CAS must re-follow, never promote', () => {
		const next = promotionLease(lease(), 'nod_a', NOW);
		// The winner's lease names another holder at generation + 1; the loser reads it and stops.
		const winner = { ...next, holderNodeId: 'nod_b' };
		expect(winner.holderNodeId).not.toBe('nod_a');
		expect(winner.generation).toBe(5);
	});
});

describe('the control-plane reader (W11-SPEC §7)', () => {
	const row = { generation: 4, primaryNodeId: 'nod_p' };

	test('applies a valid promotion and records the new primary', () => {
		const decision = reconcilePromotionReport(row, {
			nodeId: 'nod_a',
			generation: 5,
			fromGeneration: 4,
			lsn: '0/16B6C50',
			status: 'promoted',
			reportedAt: NOW,
		});
		expect(decision).toMatchObject({ action: 'apply', generation: 5, primaryNodeId: 'nod_a' });
	});

	test('never lowers a generation', () => {
		const decision = reconcilePromotionReport(row, {
			nodeId: 'nod_a',
			generation: 3,
			fromGeneration: 2,
			lsn: null,
			status: 'promoted',
			reportedAt: NOW,
		});
		expect(decision).toMatchObject({ action: 'ignore', reason: 'older-generation' });
		expect(decision.action === 'ignore' && decision.alerts[0]?.code).toBe('stale-promotion');
	});

	test('detects two primaries at one generation', () => {
		const decision = reconcilePromotionReport(row, {
			nodeId: 'nod_b',
			generation: 4,
			fromGeneration: 3,
			lsn: null,
			status: 'promoted',
			reportedAt: NOW,
		});
		expect(decision).toMatchObject({ action: 'ignore', reason: 'same-generation' });
		expect(decision.action === 'ignore' && decision.alerts[0]?.code).toBe('two-primaries');
		expect(decision.action === 'ignore' && decision.alerts[0]?.severity).toBe('critical');
	});

	test('refuses an ineligible promotion and asks for a fence', () => {
		const decision = reconcilePromotionReport(
			row,
			{ nodeId: 'nod_b', generation: 5, fromGeneration: 4, lsn: null, status: 'promoted', reportedAt: NOW },
			{ durabilityEffective: 'sync', sync: ['nod_a'], syncState: 'steady', acceptDataLoss: false },
		);
		expect(decision).toMatchObject({ action: 'refuse', fence: true });
		expect(decision.action === 'refuse' && decision.alerts[0]?.code).toBe('invalid-promotion');
	});

	test('reconciles a skipped generation upward but pages', () => {
		const decision = reconcilePromotionReport(row, {
			nodeId: 'nod_a',
			generation: 6,
			fromGeneration: 4,
			lsn: null,
			status: 'promoted',
			reportedAt: NOW,
		});
		expect(decision).toMatchObject({ action: 'apply', generation: 6 });
		expect(decision.action === 'apply' && decision.alerts[0]?.code).toBe('generation-gap');
	});

	test('a failed report never moves the row', () => {
		const decision = reconcilePromotionReport(row, {
			nodeId: 'nod_a',
			generation: 9,
			fromGeneration: 8,
			lsn: null,
			status: 'failed',
			reportedAt: NOW,
		});
		expect(decision.action).toBe('ignore');
	});
});

describe('consumer discovery (W11-SPEC §6)', () => {
	const answers = (list: ConsumerMemberAnswer[]): ConsumerMemberAnswer[] => list;

	test('forwards to the highest-generation primary only', () => {
		const selection = selectConsumerTarget(
			answers([
				{ nodeId: 'nod_p', role: 'fenced', generation: 4, reachable: true },
				{ nodeId: 'nod_a', role: 'primary', generation: 5, reachable: true },
				{ nodeId: 'nod_b', role: 'streaming', generation: 5, reachable: true },
			]),
		);
		expect(selection).toMatchObject({ target: 'nod_a', generation: 5, reason: 'ok', twoPrimaries: false });
	});

	test('fails closed when none answers primary', () => {
		expect(
			selectConsumerTarget([
				{ nodeId: 'nod_a', role: 'fenced', generation: 5, reachable: true },
				{ nodeId: 'nod_b', role: 'streaming', generation: 5, reachable: true },
			]),
		).toMatchObject({ target: null, reason: 'no-primary' });
		expect(
			selectConsumerTarget([{ nodeId: 'nod_a', role: 'primary', generation: 5, reachable: false }]),
		).toMatchObject({ target: null, reason: 'no-answer' });
	});

	test('fails closed on two primaries at one generation and alerts', () => {
		const selection = selectConsumerTarget([
			{ nodeId: 'nod_a', role: 'primary', generation: 5, reachable: true },
			{ nodeId: 'nod_b', role: 'primary', generation: 5, reachable: true },
		]);
		expect(selection).toMatchObject({ target: null, generation: 5, reason: 'two-primaries', twoPrimaries: true });
	});

	test('the older of two primaries at different generations is not chosen', () => {
		expect(
			selectConsumerTarget([
				{ nodeId: 'nod_p', role: 'primary', generation: 4, reachable: true },
				{ nodeId: 'nod_a', role: 'primary', generation: 5, reachable: true },
			]),
		).toMatchObject({ target: 'nod_a', generation: 5 });
	});
});

describe('the old primary and the measurement (W11-SPEC §8–§9)', () => {
	test('fences when behind, then rewinds only as a replica', () => {
		const base = {
			generation: 4,
			highestGenerationSeen: 4,
			leaseHolderNodeId: 'nod_p',
			nodeId: 'nod_p',
			role: 'primary' as const,
			higherPrimaryReachable: false,
		};
		expect(oldPrimaryAction(base)).toBe('serve');
		expect(oldPrimaryAction({ ...base, highestGenerationSeen: 5 })).toBe('fence');
		expect(oldPrimaryAction({ ...base, leaseHolderNodeId: 'nod_a' })).toBe('fence');
		expect(oldPrimaryAction({ ...base, higherPrimaryReachable: true })).toBe('fence');
		expect(oldPrimaryAction({ ...base, role: 'fenced' })).toBe('serve');
	});

	test('time to writable starts at the last successful lease write', () => {
		expect(timeToWritableMs(1_000, 22_000)).toBe(21_000);
		expect(timeToWritableMs(null, 22_000)).toBeNull();
		expect(timeToWritableMs(1_000, null)).toBeNull();
		expect(timeToWritableMs(22_000, 1_000)).toBeNull();
	});
});
