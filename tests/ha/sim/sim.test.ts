import { describe, expect, test } from 'bun:test';
import { MUTANTS, mutantSource } from './fixtures/mutants.ts';
import { loadModule, profileNamed, runBatch, shrink, traceFingerprint } from './harness.ts';
import { type Violation, i13BoundMs, runOnce } from './world.ts';

// A fixed seed range. run.ts defaults to 500 runs; ha-sim CI runs 2000. The planted bug is first
// caught at seed 8 and in 201 of seeds 1–2000, so 200 seeds is a safe in-test margin.
const SEEDS = { firstSeed: 1, runs: 200 };
const profile = profileNamed('default');

/**
 * Each mutant of ha-lease.ts (fixtures/mutants.ts), the first default-profile seed that catches it
 * and the property it breaks. `bun tests/ha/sim/run.ts --module mutant:<name> --runs 2000` gives the
 * full catch rate (README). Only the search up to the first catch runs here, to keep the suite fast.
 */
const CAUGHT: Record<string, { firstSeed: number; property: Violation['property'] }> = {
	'no-observe-wait': { firstSeed: 169, property: 'I1s' },
	'fence-29s': { firstSeed: 2, property: 'I13' },
	'holds-ignores-fence': { firstSeed: 40, property: 'I13' },
	'fence-wall-clock': { firstSeed: 27, property: 'I13' },
};

describe('lease simulator (HA-PLAN W1, CLUSTERING §19.1)', () => {
	test('the real ha-lease.ts holds I1, I2 and I13 on the default profile', async () => {
		const { module } = await loadModule('real');
		const batch = await runBatch({ module, profile, ...SEEDS });
		expect(batch.runs).toBe(SEEDS.runs);
		expect(batch.failures.map((f) => `${f.seed}: ${f.violation?.property} ${f.violation?.message}`)).toEqual([]);
		expect(batch.takeovers).toBeGreaterThan(50); // the schedules really move the lease around
	});

	test('the planted bug is found on the same seeds', async () => {
		const { module } = await loadModule('planted');
		const batch = await runBatch({ module, profile, ...SEEDS });
		expect(batch.failures.length).toBeGreaterThan(0);
		const first = batch.failures[0];
		expect(first?.seed).toBe(8);
		expect(first?.violation?.property).toBe('I13');
	});

	for (const [name, expected] of Object.entries(CAUGHT)) {
		test(`mutant ${name} (${MUTANTS[name]?.description}) is caught`, async () => {
			const { module } = await loadModule(`mutant:${name}`);
			const batch = await runBatch({ module, profile, firstSeed: 1, runs: expected.firstSeed, stopAfterFailures: 1 });
			expect(batch.failures.map((f) => `${f.seed} ${f.violation?.property}`)).toEqual([`${expected.firstSeed} ${expected.property}`]);
		});
	}

	test('mutant takeover-31s is not catchable on the default profile, by construction', async () => {
		// A standby starts its unchanged-ETag clock when it first reads a version, which is after the
		// store applied it; the old holder stops acting by apply + the I13 bound (fence 20 s plus at most
		// 9 s of response lag). Any takeover wait above that bound is safe in this world, so 31 s is.
		expect(i13BoundMs(profile)).toBeLessThan(31_000);
		const { module } = await loadModule('mutant:takeover-31s');
		const batch = await runBatch({ module, profile, firstSeed: 1, runs: 50 });
		expect(batch.failures).toEqual([]);
	});

	test('every mutant still applies to the current ha-lease.ts, and a stale one refuses to build', () => {
		for (const [name, mutant] of Object.entries(MUTANTS)) {
			const source = mutantSource(name);
			for (const [from, to] of mutant.replacements) {
				expect(source.includes(from)).toBe(false);
				expect(source.includes(to)).toBe(true);
			}
		}
		expect(() => mutantSource('fence-29s', 'export const nothing = 1;')).toThrow(/expected one match/);
	});

	test('the I13 bound comes from the documented policy and the profile, not the TTL', () => {
		expect(i13BoundMs(profile)).toBe(Math.ceil(20_000 / (1 - 100e-6)) + 4_000 + 5_000 + 1);
		expect(i13BoundMs(profileNamed('adversarial'))).toBe(30_000); // capped at the TTL
	});

	test('a seed replays to the identical trace', async () => {
		const { module } = await loadModule('planted');
		const a = await runOnce({ seed: 8, profile, module });
		const b = await runOnce({ seed: 8, profile, module });
		expect(a.violation).toEqual(b.violation);
		expect(traceFingerprint(a)).toBe(traceFingerprint(b));
		const real = (await loadModule('real')).module;
		const c = await runOnce({ seed: 7, profile, module: real });
		const d = await runOnce({ seed: 7, profile, module: real });
		expect(traceFingerprint(c)).toBe(traceFingerprint(d));
	});

	test('a failing seed shrinks to a minimal schedule that still fails on replay', async () => {
		const { module } = await loadModule('planted');
		const shrunk = await shrink({ seed: 8, module, profile });
		expect(shrunk.keep.length).toBeGreaterThan(0);
		expect(shrunk.keep.length).toBeLessThan(4);
		const replay = await runOnce({ seed: 8, profile, module, keep: new Set(shrunk.keep) });
		expect(replay.violation).toEqual(shrunk.result.violation);
		expect(traceFingerprint(replay)).toBe(traceFingerprint(shrunk.result));
	});
});
