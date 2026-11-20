#!/usr/bin/env bun
/**
 * Deterministic model of W9-SPEC's control plane and database member machines.
 *
 *   bun tests/ha/sim/w9/run.ts --runs 5000                 # bounded CI run, all families
 *   bun tests/ha/sim/w9/run.ts --runs 500 --family sync-change
 *   bun tests/ha/sim/w9/run.ts --scenario sync-change-minimal --trace
 *   bun tests/ha/sim/w9/run.ts --mutant fence-wall-clock --scenario wall-clock-fence --trace
 *
 * Seeds run from --seed to --seed + --runs − 1; the family is seed % FAMILIES.length unless
 * --family is given, so the default run covers every schedule family evenly.
 *
 * A violation exits 1. Revision 1 (the three-step non-promotable sync change) must produce none.
 */
import { parseArgs } from 'node:util';
import { W9World } from './model.ts';
import { FIXED_SCENARIOS, generateScenario } from './schedules.ts';
import {
	FAMILIES,
	type Family,
	type Mutant,
	type RunResult,
} from './spec.ts';

const { values: flags } = parseArgs({
	options: {
		runs: { type: 'string', default: '5000' },
		seed: { type: 'string', default: '1' },
		family: { type: 'string' },
		mutant: { type: 'string', default: 'none' },
		scenario: { type: 'string' },
		trace: { type: 'boolean', default: false },
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
	process.exit(result.violations.length > 0 ? 1 : 0);
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
	opened: number;
	closed: number;
	fellBack: number;
	downgraded: number;
	killedChanging: number;
	violations: number;
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
		opened: 0,
		closed: 0,
		fellBack: 0,
		downgraded: 0,
		killedChanging: 0,
		violations: 0,
		seeds: [],
	};
	stats.runs++;
	stats.promotions += result.stats.promotions;
	stats.controlTakeovers += result.stats.controlTakeovers;
	stats.acks += result.stats.acks;
	stats.strictOverlapMs += result.stats.strictOverlapMs;
	stats.maxStrictOverlapMs = Math.max(stats.maxStrictOverlapMs, result.stats.strictOverlapMs);
	stats.opened += result.stats.syncChangesOpened;
	stats.closed += result.stats.syncChangesClosed;
	stats.fellBack += result.stats.syncChangesFellBack;
	stats.downgraded += result.stats.syncChangesDowngraded;
	stats.killedChanging += result.stats.primaryKilledChanging;
	stats.violations += result.violations.length;
	perFamily.set(family, stats);
	if (result.violations.length > 0) {
		failures.push(result);
		stats.seeds.push(seed);
	}
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
			stats.violations === 0 ? 'none' : `${stats.violations} violation(s)`
		}`,
	);
}

for (const family of FAMILIES) {
	const stats = perFamily.get(family);
	if (!stats || stats.opened === 0) continue;
	console.log(
		`sync changes in ${family}: opened ${stats.opened}, closed ${stats.closed}, fell back ${stats.fellBack}, downgraded ${stats.downgraded}, primary killed while changing ${stats.killedChanging}`,
	);
}
console.log(`\nviolating runs: ${failures.length}`);

if (failures.length > 0) {
	const byKind = new Map<string, { property: string; count: number; seeds: number[] }>();
	for (const result of failures) {
		for (const violation of result.violations) {
			const entry = byKind.get(violation.kind) ?? { property: violation.property, count: 0, seeds: [] };
			entry.count++;
			if (entry.seeds.length < 30) entry.seeds.push(result.seed);
			byKind.set(violation.kind, entry);
		}
	}
	for (const [kind, entry] of byKind)
		console.log(`  ${entry.property}/${kind}: ${entry.count} occurrence(s), seeds ${entry.seeds.join(' ')}`);
	for (const result of failures.slice(0, maxReport)) {
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

process.exit(failures.length > 0 ? 1 : 0);
