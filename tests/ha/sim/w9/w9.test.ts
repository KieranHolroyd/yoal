import { describe, expect, test } from 'bun:test';
import { W9World } from './model.ts';
import {
	generateScenario,
	minimalControlOutage,
	minimalSyncChange,
	syncChangeAfterBarrier,
	syncChangeAfterClose,
	syncChangeCloseRace,
	syncChangeDowngrade,
	syncChangeFallback,
	syncControlLoss,
	syncControlSameEtage,
	syncControlStaleReopen,
	syncControlStaleSync,
	syncControlTransient,
	wallClockFenceScenario,
} from './schedules.ts';
import { FAMILIES, type Family } from './spec.ts';

function scenarioFor(seed: number, family?: Family) {
	return generateScenario(seed, family ?? (FAMILIES[seed % FAMILIES.length] as Family));
}

describe('W9 model, Revision 1 (W9-SPEC §5.5, §7)', () => {
	test('the old counterexample is now safe: dying before the barrier does not promote', () => {
		const result = new W9World({ seed: 1, scenario: minimalSyncChange(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.promotions).toBe(0);
		const trace = result.trace.map((e) => e.text).join('\n');
		expect(trace).toContain('open: sync [], syncState changing');
		expect(trace).toContain('kills the primary inside the open transition');
	});

	test('dying after the barrier but before the close does not promote either', () => {
		const result = new W9World({ seed: 1, scenario: syncChangeAfterBarrier(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.promotions).toBe(0);
		const trace = result.trace.map((e) => e.text).join('\n');
		expect(trace).toContain('barrier #');
		expect(trace).toContain('barrier acknowledged; schedule kills the primary before the close');
	});

	test('after the close, the new sync standby promotes with every acknowledged commit', () => {
		const result = new W9World({ seed: 1, scenario: syncChangeAfterClose(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.promotions).toBe(1);
		expect(result.trace.some((e) => e.actor === 'a' && e.text.includes('PRIMARY'))).toBe(true);
		expect(result.trace.map((e) => e.text).join('\n')).toContain('close: sync {a}, syncState steady');
	});

	test('the barrier timeout falls back to the healthy old standby, steady', () => {
		const result = new W9World({ seed: 1, scenario: syncChangeFallback(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.promotions).toBe(0);
		expect(result.trace.map((e) => e.text).join('\n')).toContain('fallback: sync {b}, syncState steady');
	});

	test('the barrier timeout with no healthy old member downgrades, steady', () => {
		const result = new W9World({ seed: 1, scenario: syncChangeDowngrade(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.promotions).toBe(0);
		expect(result.trace.map((e) => e.text).join('\n')).toContain(
			'downgraded: durability_effective = async recorded in the lease',
		);
	});

	test('a close whose response is lost is adopted; the new standby promotes safely', () => {
		const result = new W9World({ seed: 1, scenario: syncChangeCloseRace(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.promotions).toBe(1);
		expect(result.trace.map((e) => e.text).join('\n')).toContain(
			're-read shows the transition closed; adopting steady',
		);
	});

	test('Rev 2: a control outage with the sync standby lost applies async locally and alerts', () => {
		const result = new W9World({ seed: 1, scenario: syncControlLoss(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.localSyncLossApplied).toBe(1);
		expect(result.stats.syncStaleReconciled).toBe(1);
		expect(result.stats.syncAlerts).toBeGreaterThan(0);
		expect(result.stats.syncReopens).toBe(0);
		const trace = result.trace.map((e) => e.text).join('\n');
		expect(trace).toContain('applied on_sync_loss async locally');
		expect(trace).toContain('never recording sync');
		expect(trace).toContain('recorded async: sync [], steady');
	});

	test('Rev 2: a transient control outage with no sync loss does not disturb traffic', () => {
		const result = new W9World({ seed: 1, scenario: syncControlTransient(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.syncReports).toBe(0);
		expect(result.stats.syncAlerts).toBe(0);
		expect(result.stats.acks).toBeGreaterThan(0);
	});

	test('Rev 2: a stale report re-opens a fresh barrier to a healthy named member', () => {
		const result = new W9World({ seed: 1, scenario: syncControlStaleReopen(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.syncReopens).toBeGreaterThan(0);
		expect(result.stats.syncAlerts).toBeGreaterThan(0);
		const trace = result.trace.map((e) => e.text).join('\n');
		expect(trace).toContain('re-opening a fresh barrier');
		expect(trace).toContain('close: sync {b}, syncState steady');
	});

	test('Rev 2: an ETag-equal or stale report records the outcome and alerts', () => {
		const result = new W9World({ seed: 1, scenario: syncControlSameEtage(), trace: true }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.syncReports).toBe(1);
		expect(result.stats.syncAlerts).toBeGreaterThan(0);
		expect(result.stats.syncSameEtags + result.stats.syncStaleReconciled).toBe(1);
	});

	test('Rev 2: the normal reconciler refuses a sync report from a stale ETag', () => {
		const result = new W9World({
			seed: 1,
			scenario: syncControlStaleSync(),
			mutant: 'node-applies-sync',
			trace: true,
		}).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.syncStaleReconciled).toBe(1);
		expect(result.stats.syncReopens).toBe(0);
		expect(result.stats.promotions).toBe(1);
		expect(result.trace.map((e) => e.text).join('\n')).toContain('never recording sync');
	});

	test('Rev 2: recording sync from a stale report loses acknowledged commits (checker)', () => {
		const result = new W9World({
			seed: 1,
			scenario: syncControlStaleSync(),
			mutant: 'record-sync-on-stale',
			trace: true,
		}).run();
		expect(result.violations.some((v) => v.kind === 'stale-sync-recorded')).toBe(true);
		expect(result.violations.some((v) => v.kind === 'missing-ack-at-promotion')).toBe(true);
	});

	test('I11: a control-plane outage keeps traffic and completes the database failover', () => {
		const result = new W9World({ seed: 1, scenario: minimalControlOutage() }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.failoverLatencyMs).not.toBeNull();
		expect(result.stats.failoverLatencyMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(35_000);
		expect(result.stats.controlOutageAcks).toBeGreaterThan(0);
	});

	test('the 300-schedule normal run has no violations', () => {
		for (let seed = 1; seed <= 300; seed++) {
			const result = new W9World({ seed, scenario: scenarioFor(seed) }).run();
			expect(result.violations.map((v) => `${v.property}/${v.kind}`)).toEqual([]);
		}
	});

	test('checker: a promotion while syncState is changing is caught as I12', () => {
		const result = new W9World({
			seed: 1,
			scenario: minimalSyncChange(),
			mutant: 'promote-while-changing',
		}).run();
		expect(result.violations.some((v) => v.kind === 'promotion-during-sync-change')).toBe(true);
		expect(result.violations.some((v) => v.property === 'I3')).toBe(false);
	});

	test('checker: an ineligible promotion is caught as I12', () => {
		let caught = false;
		for (let seed = 1; seed <= 50 && !caught; seed++) {
			const result = new W9World({ seed, scenario: scenarioFor(seed, 'sync-change'), mutant: 'ignore-eligibility' }).run();
			caught = result.violations.some((v) => v.kind === 'promotion-not-in-sync-set');
		}
		expect(caught).toBe(true);
	});

	test('checker: a member that answered a keep-alive cannot acquire early', () => {
		let caught = false;
		for (let seed = 1; seed <= 50 && !caught; seed++) {
			const result = new W9World({
				seed,
				scenario: scenarioFor(seed, 'keepalive-acquire'),
				mutant: 'ignore-keepalive',
			}).run();
			caught = result.violations.some((v) => v.kind === 'acquired-too-early-after-keepalive');
		}
		expect(caught).toBe(true);
	});

	test('checker: a CAS at the same generation is caught as I3', () => {
		let caught = false;
		for (let seed = 1; seed <= 80 && !caught; seed++) {
			const result = new W9World({
				seed,
				scenario: scenarioFor(seed, 'keepalive-acquire'),
				mutant: 'cas-same-generation',
			}).run();
			caught = result.violations.some((v) => v.property === 'I3');
		}
		expect(caught).toBe(true);
	});

	test('checker: the I3 pass is not vacuous', () => {
		const world = new W9World({ seed: 1, scenario: minimalSyncChange() });
		world.forcePrimaryForTest('a', 1);
		world.forcePrimaryForTest('b', 1);
		const violations = world.checkNowForTest();
		expect(violations.some((v) => v.kind === 'two-primary-same-generation')).toBe(true);
	});

	test('a wall-clock fence crosses two primaries; the monotonic machine does not', () => {
		const normal = new W9World({ seed: 1, scenario: wallClockFenceScenario() }).run();
		expect(normal.violations).toEqual([]);
		expect(normal.stats.strictOverlapMs).toBe(0);
		const mutant = new W9World({ seed: 1, scenario: wallClockFenceScenario(), mutant: 'fence-wall-clock' }).run();
		expect(mutant.stats.strictOverlapMs).toBeGreaterThan(1000);
	});

	test('a legitimate control takeover by the same holder is not a monotonicity failure', () => {
		let sawSameHolderTakeover = false;
		for (let seed = 100; seed < 200 && !sawSameHolderTakeover; seed += 10) {
			const result = new W9World({ seed, scenario: scenarioFor(seed, 'control-outage') }).run();
			expect(result.violations.filter((v) => v.kind === 'lease-epoch-decreased')).toEqual([]);
			sawSameHolderTakeover = result.stats.controlTakeovers > 0;
		}
		expect(sawSameHolderTakeover).toBe(true);
	});

	test('a seed replays exactly', () => {
		const a = new W9World({ seed: 99, scenario: scenarioFor(99, 'mixed'), trace: true }).run();
		const b = new W9World({ seed: 99, scenario: scenarioFor(99, 'mixed'), trace: true }).run();
		expect(a.violations).toEqual(b.violations);
		expect(a.trace).toEqual(b.trace);
		expect(a.stats).toEqual(b.stats);
	});
});
