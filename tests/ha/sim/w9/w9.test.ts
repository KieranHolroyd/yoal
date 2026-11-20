import { describe, expect, test } from 'bun:test';
import { W9World } from './model.ts';
import { generateScenario, minimalControlOutage, minimalSyncChange, wallClockFenceScenario } from './schedules.ts';
import { FAMILIES, type Family, isKnownCounterexample } from './spec.ts';

function scenarioFor(seed: number, family?: Family) {
	return generateScenario(seed, family ?? (FAMILIES[seed % FAMILIES.length] as Family));
}

describe('W9 model (W9-SPEC §7)', () => {
	test('the two-step sync-set ordering is a counterexample (I13)', () => {
		const result = new W9World({ seed: 1, scenario: minimalSyncChange() }).run();
		const missing = result.violations.filter((v) => v.kind === 'missing-ack-at-promotion');
		expect(missing.length).toBeGreaterThan(0);
		expect(result.violations.every(isKnownCounterexample)).toBe(true);
		expect(result.stats.promotions).toBe(1);
		// The lagging async replica promotes only because step 1 named it before step 2 changed
		// synchronous_standby_names.
		const trace = result.trace.map((e) => e.text).join('\n');
		expect(trace).toContain('step 1: lease records sync {a}; synchronous_standby_names still b');
		expect(trace).toContain('primary killed');
		expect(trace).toContain('PRIMARY at generation 2');
	});

	test('changing the setting before recording the set loses no acknowledged commit', () => {
		const result = new W9World({ seed: 1, scenario: minimalSyncChange(), mutant: 'sync-setting-first', trace: true }).run();
		expect(result.violations).toEqual([]);
		// The replica that actually held the acknowledged commits (b) promotes, not the lagging a.
		expect(result.trace.some((e) => e.actor === 'b' && e.text.includes('PRIMARY'))).toBe(true);
		expect(result.stats.promotions).toBe(1);
	});

	test('I11: a control-plane outage keeps traffic and completes the database failover', () => {
		const result = new W9World({ seed: 1, scenario: minimalControlOutage() }).run();
		expect(result.violations).toEqual([]);
		expect(result.stats.failoverLatencyMs).not.toBeNull();
		expect(result.stats.failoverLatencyMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(35_000);
		expect(result.stats.controlOutageAcks).toBeGreaterThan(0);
	});

	test('5,000-schedule default run has no violation other than the known counterexample', () => {
		// Bounded here so the unit suite stays quick; `bun tests/ha/sim/w9/run.ts --runs 5000` is
		// the CI command and covers the same code.
		for (let seed = 1; seed <= 300; seed++) {
			const result = new W9World({ seed, scenario: scenarioFor(seed) }).run();
			for (const violation of result.violations) expect(isKnownCounterexample(violation)).toBe(true);
		}
	});

	test('the counterexample is not hiding a same-generation split (I3)', () => {
		const result = new W9World({ seed: 1, scenario: minimalSyncChange() }).run();
		expect(result.violations.some((v) => v.property === 'I3')).toBe(false);
		expect(result.violations.some((v) => v.property === 'I12')).toBe(false);
	});

	test('checker: an ineligible promotion is caught as I12', () => {
		let caught = false;
		for (let seed = 1; seed <= 50 && !caught; seed++) {
			const result = new W9World({ seed, scenario: scenarioFor(seed, 'sync-change'), mutant: 'ignore-eligibility' }).run();
			caught = result.violations.some((v) => v.property === 'I12');
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
		for (let seed = 1; seed <= 60 && !caught; seed++) {
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
		// The control plane is away long enough that c0 fences and later takes over its own lease at
		// epoch+1. That is a takeover, not a renew, and must not trip the epoch check.
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
