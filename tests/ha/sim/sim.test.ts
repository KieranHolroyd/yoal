import { describe, expect, test } from 'bun:test';
import { loadModule, profileNamed, runBatch, shrink, traceFingerprint } from './harness.ts';
import { runOnce } from './world.ts';

// A fixed seed range. run.ts defaults to 500 runs; ha-sim CI runs 2000. The planted bug is first
// caught at seed 25 and in 29 of the first 500 seeds, so 200 seeds is a safe in-test margin.
const SEEDS = { firstSeed: 1, runs: 200 };
const profile = profileNamed('default');

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
		expect(first?.seed).toBe(25);
		expect(first?.violation?.property).toBe('I13');
	});

	test('a seed replays to the identical trace', async () => {
		const { module } = await loadModule('planted');
		const a = await runOnce({ seed: 25, profile, module });
		const b = await runOnce({ seed: 25, profile, module });
		expect(a.violation).toEqual(b.violation);
		expect(traceFingerprint(a)).toBe(traceFingerprint(b));
		const real = (await loadModule('real')).module;
		const c = await runOnce({ seed: 7, profile, module: real });
		const d = await runOnce({ seed: 7, profile, module: real });
		expect(traceFingerprint(c)).toBe(traceFingerprint(d));
	});

	test('a failing seed shrinks to a minimal schedule that still fails on replay', async () => {
		const { module } = await loadModule('planted');
		const shrunk = await shrink({ seed: 25, module, profile });
		expect(shrunk.keep.length).toBeGreaterThan(0);
		expect(shrunk.keep.length).toBeLessThan(4);
		const replay = await runOnce({ seed: 25, profile, module, keep: new Set(shrunk.keep) });
		expect(replay.violation).toEqual(shrunk.result.violation);
		expect(traceFingerprint(replay)).toBe(traceFingerprint(shrunk.result));
	});
});
