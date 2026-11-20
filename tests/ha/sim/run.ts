#!/usr/bin/env bun
/**
 * Deterministic simulation of the control-plane lease (packages/core/src/ha-lease.ts).
 *
 *   bun tests/ha/sim/run.ts --runs 2000                     # CI (ha-sim): real lease, default profile
 *   bun tests/ha/sim/run.ts --seed 42 --trace               # replay one seed and print its trace
 *   bun tests/ha/sim/run.ts --runs 1 --seed 42 --verbose    # the same, every request shown
 *   bun tests/ha/sim/run.ts --seed 42 --runs 1 --keep 3,7   # replay a shrunk schedule exactly
 *   bun tests/ha/sim/run.ts --module planted --runs 500 --expect-violation
 *   bun tests/ha/sim/run.ts --module mutant:fence-29s --runs 2000   # fixtures/mutants.ts
 *   bun tests/ha/sim/run.ts --profile adversarial --runs 500   # outside the lease's assumptions
 *
 * Seeds run from --seed (default 1) to --seed + --runs − 1. Each failing seed is shrunk to a minimal
 * fault schedule and printed with its replay command and trace. Exit 1 on any violation (or, with
 * --expect-violation, on none).
 */
import { parseArgs } from 'node:util';
import { describeFault, formatTrace, loadModule, profileNamed, runBatch, shrink } from './harness.ts';
import { contenderCount, generateFaults, i13BoundMs, runOnce } from './world.ts';

const { values: flags } = parseArgs({
	options: {
		runs: { type: 'string', default: '500' },
		seed: { type: 'string', default: '1' },
		module: { type: 'string', default: 'real' },
		profile: { type: 'string', default: 'default' },
		contenders: { type: 'string' },
		keep: { type: 'string' },
		verbose: { type: 'boolean', default: false },
		trace: { type: 'boolean', default: false },
		'expect-violation': { type: 'boolean', default: false },
		'no-shrink': { type: 'boolean', default: false },
		'max-report': { type: 'string', default: '3' },
		'max-lines': { type: 'string', default: '400' },
		'show-stalls': { type: 'string', default: '3' },
	},
	strict: true,
});

const runs = Number(flags.runs);
const firstSeed = Number(flags.seed);
const profile = profileNamed(flags.profile);
const { path, module } = await loadModule(flags.module);
const contenders = flags.contenders ? Number(flags.contenders) : undefined;
const maxLines = Number(flags['max-lines']);
const replayBase = `bun tests/ha/sim/run.ts --module ${flags.module} --profile ${profile.name}${contenders ? ` --contenders ${contenders}` : ''}`;

console.log(`ha-sim: ${path}`);
console.log(`profile ${profile.name} (I13 bound ${i13BoundMs(profile) / 1000} s), seeds ${firstSeed}..${firstSeed + runs - 1}`);

if (flags.keep !== undefined || flags.trace || (runs === 1 && flags.verbose)) {
	// Exact replay of one seed (optionally with a shrunk fault set).
	const keep = flags.keep !== undefined ? new Set(flags.keep.split(',').filter(Boolean).map(Number)) : undefined;
	const result = await runOnce({ seed: firstSeed, profile, module, contenders, keep, verbose: flags.verbose });
	console.log(`contenders ${result.contenders}, faults:`);
	for (const f of result.faults) console.log(`  ${describeFault(f)}`);
	for (const line of formatTrace(result.trace, { verbose: flags.verbose, maxLines })) console.log(line);
	console.log(result.violation ? `VIOLATION ${result.violation.property} at ${(result.violation.t / 1000).toFixed(3)}s: ${result.violation.message}` : 'no violation');
	console.log(`liveness: ${result.liveness.primary ? `${result.liveness.primary} is primary at the end` : 'NO PRIMARY at the end'}`);
	for (const r of result.liveness.roles) console.log(`  ${r}`);
	process.exit(flags['expect-violation'] ? (result.violation ? 0 : 1) : result.violation ? 1 : 0);
}

const batch = await runBatch({ module, profile, firstSeed, runs, contenders });
const perRun = batch.elapsedMs / batch.runs;
console.log(
	`runs ${batch.runs} · violations ${batch.failures.length} · liveness stalls ${batch.stalls.length} · takeovers ${batch.takeovers} · events ${batch.events} · ${(batch.elapsedMs / 1000).toFixed(2)} s total · ${perRun.toFixed(2)} ms/run`,
);

if (batch.failures.length > 0) {
	const byProperty = new Map<string, number[]>();
	for (const f of batch.failures) {
		const key = f.violation?.property ?? '?';
		byProperty.set(key, [...(byProperty.get(key) ?? []), f.seed]);
	}
	for (const [property, seeds] of byProperty)
		console.log(`  ${property}: ${seeds.length} seeds: ${seeds.slice(0, 40).join(' ')}${seeds.length > 40 ? ' …' : ''}`);
	for (const failure of batch.failures.slice(0, Number(flags['max-report']))) {
		console.log('');
		console.log(`── seed ${failure.seed}: ${failure.violation?.property} — ${failure.violation?.message}`);
		if (flags['no-shrink']) {
			console.log(`   replay: ${replayBase} --runs 1 --seed ${failure.seed} --verbose`);
			for (const line of formatTrace(failure.trace, { maxLines })) console.log(line);
			continue;
		}
		const shrunk = await shrink({ seed: failure.seed, module, profile, contenders });
		const total = generateFaults(failure.seed, profile, contenders ?? contenderCount(failure.seed, profile)).length;
		console.log(`   minimal schedule: ${shrunk.keep.length} of ${total} faults, ${shrunk.result.contenders} contenders`);
		for (const f of shrunk.result.faults) console.log(`     ${describeFault(f)}`);
		console.log(`   violation: ${shrunk.result.violation?.property} at ${((shrunk.result.violation?.t ?? 0) / 1000).toFixed(3)}s — ${shrunk.result.violation?.message}`);
		console.log(`   replay: ${replayBase} --runs 1 --seed ${failure.seed} --keep ${shrunk.keep.join(',') || "''"}`);
		console.log('   trace:');
		for (const line of formatTrace(shrunk.result.trace, { maxLines })) console.log(line);
	}
}

const showStalls = Number(flags['show-stalls']);
if (batch.stalls.length > 0 && showStalls > 0) {
	console.log('');
	console.log(`liveness stalls (no primary after heal; reported, not failed): seeds ${batch.stalls.map((s) => s.seed).slice(0, 40).join(' ')}`);
	for (const stall of batch.stalls.slice(0, showStalls)) {
		console.log(`  seed ${stall.seed}:`);
		for (const r of stall.liveness.roles) console.log(`    ${r}`);
	}
}

const failed = batch.failures.length > 0;
process.exit(flags['expect-violation'] ? (failed ? 0 : 1) : failed ? 1 : 0);
