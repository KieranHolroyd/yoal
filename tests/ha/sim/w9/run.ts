#!/usr/bin/env bun
/**
 * Deterministic model of W9-SPEC's control plane and database member machines.
 *
 *   bun tests/ha/sim/w9/run.ts --runs 5000                 # bounded CI run, all families
 *   bun tests/ha/sim/w9/run.ts --runs 500 --family sync-change
 *   bun tests/ha/sim/w9/run.ts --scenario sync-change-minimal --trace
 *   bun tests/ha/sim/w9/run.ts --mutant fence-wall-clock --scenario wall-clock-fence --trace
 *   bun tests/ha/sim/w9/run.ts --runs 200 --allow-known    # exit 0 while the known defect stands
 *
 * Seeds run from --seed to --seed + --runs − 1; the family is seed % FAMILIES.length unless
 * --family is given, so the default run covers every schedule family evenly.
 *
 * A violation exits 1. `--allow-known` exits 0 only when every violation is the counterexample
 * this model was written to find (the two-step sync-set ordering, W9-SPEC §5.1/§5.5). Fixing the
 * spec should make `--allow-known` unnecessary, not make it keep passing.
 */
import { parseArgs } from 'node:util';
import { W9World } from './model.ts';
import { FIXED_SCENARIOS, generateScenario } from './schedules.ts';
import {
	FAMILIES,
	type Family,
	type Mutant,
	type RunResult,
	isKnownCounterexample,
} from './spec.ts';

const { values: flags } = parseArgs({
	options: {
		runs: { type: 'string', default: '5000' },
		seed: { type: 'string', default: '1' },
		family: { type: 'string' },
		mutant: { type: 'string', default: 'none' },
		scenario: { type: 'string' },
		trace: { type: 'boolean', default: false },
		'allow-known': { type: 'boolean', default: false },
		'max-report': { type: 'string', default: '3' },
		'max-lines': { type: 'string', default: '260' },
	},
	strict: true,
});

const mutant = flags.mutant as Mutant;
const maxReport = Number(flags['max-report']);
const maxLines = Number(flags['max-lines']);

function printTrace(result: RunResult): void {
	const lines = result.trace;
	for (const line of lines.slice(Math.max(0, lines.length - maxLines)))
		console.log(`  ${(line.t / 1000).toFixed(3).padStart(9)}s ${line.actor.padEnd(9)} ${line.text}`);
}

function printViolations(result: RunResult): void {
	for (const violation of result.violations.slice(0, 20))
		console.log(
			`  VIOLATION ${violation.property}/${violation.kind} at ${(violation.t / 1000).toFixed(3)}s: ${violation.message}`,
		);
	if (result.violations.length > 20) console.log(`  … ${result.violations.length - 20} more`);
}

if (flags.scenario) {
	const factory = FIXED_SCENARIOS[flags.scenario];
	if (!factory) {
		console.error(`unknown scenario ${flags.scenario}; known: ${Object.keys(FIXED_SCENARIOS).join(', ')}`);
		process.exit(2);
	}
	const scenario = factory();
	const result = new W9World({ seed: Number(flags.seed), scenario, mutant, trace: true, verbose: true }).run();
	console.log(`scenario ${scenario.name} (${scenario.family}), seed ${result.seed}, mutant ${mutant}`);
	console.log('faults:');
	for (const f of scenario.faults)
		console.log(
			`  #${f.id} @${(f.at / 1000).toFixed(3)}s ${f.kind}${
				f.from ? ` ${f.from}→${f.to}${f.symmetric ? ' (both)' : ''}` : ''
			}${f.node ? ` ${f.node}` : ''}${f.target ? ` ${f.target}` : ''}${
				f.durationMs ? ` for ${(f.durationMs / 1000).toFixed(1)}s` : ''
			}${f.value ? ` value ${f.value}` : ''}`,
		);
	console.log(
		`events ${result.events}; ${result.stats.promotions} promotion(s); ${result.stats.acks} ack(s); strict overlap ${Math.round(result.stats.strictOverlapMs)} ms`,
	);
	if (flags.trace) {
		console.log('trace:');
		printTrace(result);
	}
	if (result.violations.length === 0) console.log('no violation');
	else printViolations(result);
	const failed = result.violations.length > 0 && !(flags['allow-known'] && result.knownOnly);
	process.exit(failed ? 1 : 0);
}

const runs = Number(flags.runs);
const firstSeed = Number(flags.seed);
const fixedFamily = flags.family as Family | undefined;
if (fixedFamily && !FAMILIES.includes(fixedFamily)) {
	console.error(`unknown family ${fixedFamily}; known: ${FAMILIES.join(', ')}`);
	process.exit(2);
}

interface FamilyStats {
	runs: number;
	promotions: number;
	controlTakeovers: number;
	acks: number;
	strictOverlapMs: number;
	maxStrictOverlapMs: number;
	violations: number;
	known: number;
	seeds: number[];
}

const perFamily = new Map<string, FamilyStats>();
const failures: RunResult[] = [];
const started = performance.now();

for (let seed = firstSeed; seed < firstSeed + runs; seed++) {
	const family = fixedFamily ?? (FAMILIES[seed % FAMILIES.length] as Family);
	const scenario = generateScenario(seed, family);
	const result = new W9World({ seed, scenario, mutant, trace: flags.trace, verbose: flags.trace }).run();
	const stats = perFamily.get(family) ?? {
		runs: 0,
		promotions: 0,
		controlTakeovers: 0,
		acks: 0,
		strictOverlapMs: 0,
		maxStrictOverlapMs: 0,
		violations: 0,
		known: 0,
		seeds: [],
	};
	stats.runs++;
	stats.promotions += result.stats.promotions;
	stats.controlTakeovers += result.stats.controlTakeovers;
	stats.acks += result.stats.acks;
	stats.strictOverlapMs += result.stats.strictOverlapMs;
	stats.maxStrictOverlapMs = Math.max(stats.maxStrictOverlapMs, result.stats.strictOverlapMs);
	stats.violations += result.violations.length;
	stats.known += result.knownOnly ? 1 : 0;
	perFamily.set(family, stats);
	if (result.violations.length > 0 && !result.knownOnly) {
		failures.push(result);
		stats.seeds.push(seed);
	}
	if (result.knownOnly && flags['allow-known'] === false) failures.push(result);
}

const elapsed = performance.now() - started;
console.log(
	`w9 model: ${runs} schedules, ${(elapsed / 1000).toFixed(2)} s, ${(elapsed / runs).toFixed(2)} ms/run, mutant ${mutant}`,
);
console.log('family                 runs  promotions  control  acks   strict-ms  max-strict  violation-seeds');
for (const family of FAMILIES) {
	const stats = perFamily.get(family);
	if (!stats) continue;
	console.log(
		`${family.padEnd(22)} ${String(stats.runs).padStart(5)} ${String(stats.promotions).padStart(11)} ${String(
			stats.controlTakeovers,
		).padStart(8)} ${String(stats.acks).padStart(6)} ${String(Math.round(stats.strictOverlapMs)).padStart(10)} ${String(Math.round(stats.maxStrictOverlapMs)).padStart(11)}  ${
			stats.violations === 0 ? 'none' : `${stats.violations} violation(s)${stats.known ? `, ${stats.known} known-counterexample run(s)` : ''}`
		}`,
	);
}

const knownRuns = [...perFamily.values()].reduce((sum, s) => sum + s.known, 0);
const otherFailures = failures.filter((f) => !f.knownOnly);
console.log(`\nknown counterexample (sync-set ordering, I13): ${knownRuns} run(s)`);
console.log(`other violations: ${otherFailures.length} run(s)`);

if (otherFailures.length > 0) {
	const byKind = new Map<string, { property: string; count: number; seeds: number[] }>();
	for (const result of otherFailures) {
		for (const violation of result.violations) {
			if (isKnownCounterexample(violation)) continue;
			const entry = byKind.get(violation.kind) ?? { property: violation.property, count: 0, seeds: [] };
			entry.count++;
			if (entry.seeds.length < 30) entry.seeds.push(result.seed);
			byKind.set(violation.kind, entry);
		}
	}
	for (const [kind, entry] of byKind)
		console.log(`  ${entry.property}/${kind}: ${entry.count} occurrence(s), seeds ${entry.seeds.join(' ')}`);
	for (const result of otherFailures.slice(0, maxReport)) {
		console.log('');
		console.log(`── seed ${result.seed} ${result.family}: ${result.violations[0]?.property}/${result.violations[0]?.kind}`);
		printViolations(result);
		printTrace(result);
		console.log(
			`   replay: bun tests/ha/sim/w9/run.ts --runs 1 --seed ${result.seed}${
				fixedFamily ? ` --family ${fixedFamily}` : ''
			}${mutant !== 'none' ? ` --mutant ${mutant}` : ''} --trace`,
		);
	}
}

if (knownRuns > 0 && otherFailures.length === 0) {
	console.log('');
	console.log('The only violations are the counterexample documented in docs/build-plan/W9-MODEL.md:');
	console.log('  W9-SPEC §5.1/§5.5 record the new sync set in the lease BEFORE changing');
	console.log('  synchronous_standby_names, so the recorded set names a replica that is not yet caught up.');
	console.log('  A crash between the two steps lets it promote and lose an acknowledged commit (I13).');
}

const failed = otherFailures.length > 0 || (knownRuns > 0 && !flags['allow-known']);
process.exit(failed ? 1 : 0);
