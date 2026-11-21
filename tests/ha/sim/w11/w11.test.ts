import { describe, expect, test } from 'bun:test';
import { W11World } from './model.ts';
import { autoEnabledFor, defaultPolicy, evaluateArming, type ArmingInput } from './policy.ts';
import {
	arbiterAlone,
	arbiterPlusMember,
	asyncWithoutAcceptRefused,
	controlDownFixed,
	failsafeKeepaliveFixed,
	failsafeMinimalBound,
	failsafeNoticeDelayed,
	failsafeNoticeDuplicated,
	failsafeNoticeLost,
	failsafeNoticeStale,
	generateScenario,
	noDrillRefused,
	partitionArbiterOkFixed,
	partitionIsolatedFixed,
	powerOffAsync,
	powerOffSync,
	staleLeaderFixed,
	syncNamedDeadClosed,
	syncNamedDeadRefused,
	twoCandidatesFixed,
	twoDataNodesRefused,
	wallClockFence,
} from './schedules.ts';
import { FAMILIES, type Durability, type Family, type PolicyConfig, type RefusalReason } from './spec.ts';

function scenarioFor(seed: number, family?: Family) {
	return generateScenario(seed, family ?? (FAMILIES[seed % FAMILIES.length] as Family));
}

function input(overrides: Partial<PolicyConfig> & { durability?: Durability } = {}): ArmingInput {
	const durability = overrides.durability ?? 'sync';
	const { durability: _ignored, ...policy } = overrides;
	return { ...defaultPolicy(durability), ...policy, durability };
}

describe('W11 arming policy (W11-SPEC §3)', () => {
	test('a valid sync fleet arms; a valid async fleet arms only with acceptDataLoss', () => {
		expect(evaluateArming(input()).armed).toBe(true);
		expect(evaluateArming(input({ durability: 'async' })).armed).toBe(true);
		const asyncNoAccept = evaluateArming(input({ durability: 'async', acceptDataLoss: false }));
		expect(asyncNoAccept.armed).toBe(false);
		expect(asyncNoAccept.refusals).toContain('durability-async-without-accept-data-loss');
	});

	test('manual is the default mode and is not a refusal', () => {
		const decision = evaluateArming(input({ requested: 'manual' }));
		expect(decision.armed).toBe(false);
		expect(decision.mode).toBe('manual');
		expect(decision.refusals).toEqual([]);
	});

	const refusals: [RefusalReason, Partial<PolicyConfig>, Durability][] = [
		['global-flag-off', { globalFlag: false }, 'sync'],
		['durability-async-without-accept-data-loss', { acceptDataLoss: false }, 'async'],
		['fewer-than-three-data-nodes', { dataNodes: 2 }, 'sync'],
		['fewer-than-two-zones', { zones: 1 }, 'sync'],
		['no-failover-drill', { drill: 'none' }, 'sync'],
		['failover-drill-failed', { drill: 'failed' }, 'sync'],
		['failover-drill-stale', { drill: 'stale' }, 'sync'],
		['no-replica-on-another-online-node', { replicaOnAnotherOnlineNode: false }, 'sync'],
		['active-switchover', { switchoverActive: true }, 'sync'],
		['sync-transition', { syncStepping: true }, 'sync'],
		['node-not-db-member', { allDbMember: false }, 'sync'],
	];

	for (const [reason, overrides, durability] of refusals) {
		test(`refuses auto: ${reason}`, () => {
			const decision = evaluateArming(input({ ...overrides, durability }));
			expect(decision.armed).toBe(false);
			expect(decision.mode).toBe('manual');
			expect(decision.refusals).toContain(reason);
		});
	}

	test('all failing rules are reported, not just the first', () => {
		const decision = evaluateArming(
			input({ dataNodes: 2, zones: 1, drill: 'none', globalFlag: false, durability: 'async', acceptDataLoss: false }),
		);
		for (const reason of [
			'global-flag-off',
			'durability-async-without-accept-data-loss',
			'fewer-than-three-data-nodes',
			'fewer-than-two-zones',
			'no-failover-drill',
		] as RefusalReason[])
			expect(decision.refusals).toContain(reason);
	});

	test('the live rule disables auto after a sync database downgrades to async without acceptDataLoss', () => {
		expect(autoEnabledFor(true, 'sync', false)).toBe(true);
		expect(autoEnabledFor(true, 'async', false)).toBe(false);
		expect(autoEnabledFor(true, 'async', true)).toBe(true);
		expect(autoEnabledFor(false, 'sync', true)).toBe(false);
	});
});

describe('W11 automatic promotion (W11-SPEC §4-§5)', () => {
	test('power off, sync: one promotion, I13 holds, time to writable within the bound', () => {
		const result = new W11World({ seed: 1, scenario: powerOffSync(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.promotions).toBe(1);
		expect(result.failoverLatenciesMs).toHaveLength(1);
		expect(result.failoverLatenciesMs[0] as number).toBeLessThanOrEqual(30_000);
		const trace = result.trace.map((e) => e.text).join('\n');
		expect(trace).toContain('won the CAS at generation 2');
		expect(trace).toContain('PRIMARY at generation 2');
		expect(trace).toContain('re-armed: barrier');
		expect(trace).toContain('close: sync');
	});

	test('power off, async + acceptDataLoss: one promotion; missing async acks are reported, not failed', () => {
		const result = new W11World({ seed: 1, scenario: powerOffAsync(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.promotions).toBe(1);
		expect(result.stats.asyncLostAcks).toBeGreaterThanOrEqual(0);
	});

	test('a freeze expires the lease by the arbiter clock; the stale leader fences on resume', () => {
		const result = new W11World({ seed: 1, scenario: staleLeaderFixed(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.promotions).toBe(1);
		expect(result.stats.staleResumes).toBeGreaterThanOrEqual(1);
		expect(result.stats.fences).toBeGreaterThanOrEqual(1);
		const trace = result.trace.map((e) => e.text).join('\n');
		expect(trace).toContain('resume found the lease unprovable');
	});

	test('the primary keeps renewing through a partition that spares the arbiter: no failover', () => {
		const result = new W11World({ seed: 1, scenario: partitionArbiterOkFixed() }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.promotions).toBe(0);
		expect(result.stats.acks).toBeGreaterThan(0);
	});

	test('an isolated primary fences and a replica with arbiter access promotes', () => {
		const result = new W11World({ seed: 1, scenario: partitionIsolatedFixed(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.promotions).toBe(1);
		expect(result.stats.fences).toBeGreaterThanOrEqual(1);
		expect(result.failoverLatenciesMs[0] as number).toBeLessThanOrEqual(30_000);
		const trace = result.trace.map((e) => e.text).join('\n');
		expect(trace).toContain('fencing at generation 1');
	});

	test('an arbiter outage alone: no failover and no stop', () => {
		const result = new W11World({ seed: 1, scenario: arbiterAlone() }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.promotions).toBe(0);
		expect(result.stats.fences).toBe(0);
		expect(result.stats.acks).toBeGreaterThan(0);
	});

	test('an arbiter outage plus an unreachable member: the primary fences; any promotion is after the outage', () => {
		const result = new W11World({ seed: 1, scenario: arbiterPlusMember() }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.promotions).toBeLessThanOrEqual(1);
		expect(result.stats.ttfExempt).toBe(1);
	});

	test('two candidates: one CAS wins, the loser re-follows, I3 stays clean', () => {
		let sawLostCas = false;
		for (let seed = 1; seed <= 20; seed++) {
			const result = new W11World({ seed, scenario: twoCandidatesFixed() }).run();
			expect(result.violations).toEqual([]);
			expect(result.stats.promotions).toBe(1);
			if (result.stats.candidateLostCas > 0) sawLostCas = true;
		}
		expect(sawLostCas).toBe(true);
	});

	test('sync names b, b and the primary die: a (unnamed) must not promote', () => {
		const result = new W11World({ seed: 1, scenario: syncNamedDeadRefused(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.promotions).toBe(0);
		expect(result.stats.candidateAttempts).toBe(0);
		expect(result.trace.some((e) => e.actor === 'a' && e.text.includes('candidate'))).toBe(false);
	});

	test('sync names b, b dies, a is closed as the new sync set, then the primary dies: a promotes', () => {
		const result = new W11World({ seed: 1, scenario: syncNamedDeadClosed(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.promotions).toBe(1);
		expect(result.stats.syncChangesOpened).toBeGreaterThanOrEqual(1);
		expect(result.stats.syncChangesClosed).toBeGreaterThanOrEqual(1);
		expect(result.trace.map((e) => e.text).join('\n')).toContain('close: sync {a}, syncState steady');
	});

	test('control plane down through a failover: promotion and traffic continue; the row never falls', () => {
		const result = new W11World({ seed: 1, scenario: controlDownFixed(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.promotions).toBe(1);
		expect(result.stats.controlDownPromotions).toBe(1);
		expect(result.stats.controlRowGeneration).toBeGreaterThanOrEqual(2);
		const trace = result.trace.map((e) => e.text).join('\n');
		expect(trace).toContain('control plane returned');
		expect(trace).toContain('reconciled the database row to generation 2');
	});

	test('refusals: no drill, two data nodes, async without acceptDataLoss are manual and do not promote', () => {
		const cases: [() => ReturnType<typeof noDrillRefused>, RefusalReason][] = [
			[noDrillRefused, 'no-failover-drill'],
			[twoDataNodesRefused, 'fewer-than-three-data-nodes'],
			[asyncWithoutAcceptRefused, 'durability-async-without-accept-data-loss'],
		];
		for (const [factory, reason] of cases) {
			const world = new W11World({ seed: 1, scenario: factory() });
			const result = world.run();
			expect(result.violations).toEqual([]);
			expect(world.armDecisionForTest().armed).toBe(false);
			expect(world.armDecisionForTest().refusals).toContain(reason);
			expect(result.stats.promotions).toBe(0);
		}
	});

	test('the H21 keep-alive gate blocks every candidate while the primary keeps answering', () => {
		const result = new W11World({ seed: 1, scenario: failsafeKeepaliveFixed(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.promotions).toBe(0);
		expect(result.stats.candidateAttempts).toBe(0);
		expect(result.stats.acks).toBeGreaterThan(0);
	});
});

describe('W11 Revision 3: the fence notice', () => {
	test('the canonical two-fault case with the notice delivered is within the bound at ordinary seeds', () => {
		for (const seed of [9, 15, 33]) {
			const result = new W11World({ seed, scenario: failsafeMinimalBound(), trace: true }).run();
			expect(result.violations).toEqual([]);
			expect(result.stats.promotions).toBe(1);
			expect(result.stats.fenceNoticesDelivered).toBeGreaterThanOrEqual(1);
			expect(result.stats.fenceNoticePromotions).toBe(1);
			expect(result.stats.fenceNoticeSlowPath).toBe(0);
			expect(result.failoverLatenciesMs[0] as number).toBeLessThanOrEqual(30_000);
			const trace = result.trace.map((e) => e.text).join('\n');
			expect(trace).toContain('received fence notice for generation 1');
			expect(trace).toContain('permits acquisition despite the keep-alive');
		}
	});

	test('the remaining Rev-3 counterexample: with the notice delivered, the tail still exceeds 30 s', () => {
		const result = new W11World({ seed: 3752, scenario: failsafeMinimalBound(), trace: true }).run();
		expect(result.stats.promotions).toBe(1);
		expect(result.stats.fenceNoticePromotions).toBe(1);
		expect(result.stats.fenceNoticeSlowPath).toBe(0);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0]?.kind).toBe('time-to-writable-exceeded');
		expect(result.failoverLatenciesMs[0] as number).toBeGreaterThan(30_000);
		const trace = result.trace.map((e) => e.text).join('\n');
		expect(trace).toContain('received fence notice for generation 1');
		expect(trace).toContain('permits acquisition despite the keep-alive');
		expect(trace).toContain('candidate at generation 2');
		expect(trace).toContain('time to writable');
	});

	test('without delivery the one-TTL block holds; the slower path is reported and alerted, not a bound violation', () => {
		const result = new W11World({ seed: 3541, scenario: failsafeNoticeLost(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.promotions).toBe(1);
		expect(result.stats.fenceNoticesDelivered).toBe(0);
		expect(result.stats.fenceNoticeMisses).toBe(1);
		expect(result.stats.fenceNoticeSlowPath).toBe(1);
		expect(result.stats.fenceNoticeAlerts).toBeGreaterThanOrEqual(1);
		expect(result.stats.fenceNoticePromotions).toBe(0);
		expect(result.failoverLatenciesMs).toEqual([]);
		expect(result.slowPathLatenciesMs[0] as number).toBeGreaterThan(30_000);
		const trace = result.trace.map((e) => e.text).join('\n');
		expect(trace).toContain('one-TTL block applied; alert');
	});

	test('duplicate delivery is idempotent', () => {
		const result = new W11World({ seed: 15, scenario: failsafeNoticeDuplicated(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.fenceNoticeDuplicates).toBeGreaterThanOrEqual(1);
		expect(result.stats.fenceNoticesDelivered).toBeGreaterThanOrEqual(2);
		expect(result.stats.fenceNoticePromotions).toBe(1);
	});

	test('a delayed notice is used when it arrives before the promotion', () => {
		const result = new W11World({ seed: 15, scenario: failsafeNoticeDelayed(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.fenceNoticesDelivered).toBeGreaterThanOrEqual(1);
		expect(result.stats.fenceNoticePromotions).toBe(1);
	});

	test('a stale notice is stored but never authorises the generation; the block holds', () => {
		const result = new W11World({ seed: 3752, scenario: failsafeNoticeStale(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.fenceNoticeStaleIgnored).toBeGreaterThanOrEqual(1);
		expect(result.stats.fenceNoticePromotions).toBe(0);
		expect(result.stats.fenceNoticeSlowPath).toBe(1);
		expect(result.slowPathLatenciesMs[0] as number).toBeGreaterThan(30_000);
	});

	test('trust-stale-notice: a cross-generation notice is trusted and the early acquisition is caught', () => {
		const result = new W11World({
			seed: 3752,
			scenario: failsafeNoticeStale(),
			mutant: 'trust-stale-notice',
		}).run();
		expect(result.violations.some((v) => v.kind === 'acquired-too-early-after-keepalive')).toBe(true);
	});
});

describe('W11 broad sweep', () => {
	test('the 300-schedule sweep has no I3/I11/I12/I13 violation', () => {
		const latencies: number[] = [];
		for (let seed = 1; seed <= 300; seed++) {
			const result = new W11World({ seed, scenario: scenarioFor(seed) }).run();
			const other = result.violations.filter((v) => v.kind !== 'time-to-writable-exceeded');
			expect(other.map((v) => `${v.property}/${v.kind}`)).toEqual([]);
			latencies.push(...result.failoverLatenciesMs);
		}
		const sorted = [...latencies].sort((a, b) => a - b);
		const median = sorted[Math.floor((sorted.length - 1) / 2)] as number;
		expect(median).toBeLessThanOrEqual(25_000);
	});

	test('a seed replays exactly', () => {
		const a = new W11World({ seed: 7, scenario: powerOffSync(), trace: true }).run();
		const b = new W11World({ seed: 7, scenario: powerOffSync(), trace: true }).run();
		expect(a.violations).toEqual(b.violations);
		expect(a.trace).toEqual(b.trace);
		expect(a.stats).toEqual(b.stats);
	});
});

describe('W11 checker validation (deliberately wrong variants)', () => {
	test('I3: the checker is not vacuous', () => {
		const world = new W11World({ seed: 1, scenario: powerOffSync() });
		world.forcePrimaryForTest('a', 1);
		world.forcePrimaryForTest('b', 1);
		const violations = world.checkNowForTest();
		expect(violations.some((v) => v.kind === 'two-primary-same-generation')).toBe(true);
	});

	test('arm-anyway: a refused policy promotes and is caught as promotion-not-armed', () => {
		const result = new W11World({ seed: 1, scenario: twoDataNodesRefused(), mutant: 'arm-anyway' }).run();
		expect(result.stats.promotions).toBeGreaterThan(0);
		expect(result.violations.some((v) => v.kind === 'promotion-not-armed')).toBe(true);
	});

	test('ignore-eligibility: an unnamed member promotes and is caught as I12', () => {
		const result = new W11World({ seed: 1, scenario: syncNamedDeadRefused(), mutant: 'ignore-eligibility' }).run();
		expect(result.violations.some((v) => v.kind === 'promotion-not-in-sync-set')).toBe(true);
	});

	test('ignore-keepalive: an answering member acquires early and is caught', () => {
		const result = new W11World({ seed: 1, scenario: failsafeKeepaliveFixed(), mutant: 'ignore-keepalive' }).run();
		expect(result.violations.some((v) => v.kind === 'acquired-too-early-after-keepalive')).toBe(true);
	});

	test('cas-same-generation: two primaries at one generation are caught as I3', () => {
		const result = new W11World({ seed: 1, scenario: failsafeKeepaliveFixed(), mutant: 'cas-same-generation' }).run();
		expect(result.violations.some((v) => v.property === 'I3')).toBe(true);
	});

	test('async-without-accept: an async promotion without acceptDataLoss is caught', () => {
		const result = new W11World({ seed: 1, scenario: asyncWithoutAcceptRefused(), mutant: 'async-without-accept' }).run();
		expect(result.violations.some((v) => v.kind === 'promotion-without-accept-data-loss')).toBe(true);
	});

	test('fence-wall-clock: the wall-clock fence overlaps two primaries; the monotonic one does not', () => {
		const normal = new W11World({ seed: 1, scenario: wallClockFence() }).run();
		expect(normal.violations).toEqual([]);
		expect(normal.stats.strictOverlapMs).toBe(0);
		const mutant = new W11World({ seed: 1, scenario: wallClockFence(), mutant: 'fence-wall-clock' }).run();
		expect(mutant.stats.strictOverlapMs).toBeGreaterThan(1_000);
	});
});
