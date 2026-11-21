#!/usr/bin/env bun
/**
 * Deterministic model of W11-SPEC: automatic database promotion and the per-database policy.
 *
 *   bun tests/ha/sim/w11/run.ts --runs 5000                 # bounded CI run, all families
 *   bun tests/ha/sim/w11/run.ts --runs 500 --family power-off
 *   bun tests/ha/sim/w11/run.ts --scenario w11-failsafe-mixed-bound --trace
 *   bun tests/ha/sim/w11/run.ts --mutant arm-anyway --scenario w11-two-data-nodes --trace
 *
 * Seeds run from --seed to --seed + --runs − 1; the family is seed % FAMILIES.length unless
 * --family is given, so the default run covers every schedule family evenly.
 *
 * A violation exits 1. The worst-case time-to-writable bound (30 s) is checked per promotion; the
 * median bound (25 s) is checked over the whole run and printed.
 */
import { parseArgs } from 'node:util';
import { W11World } from './model.ts';
import { FIXED_SCENARIOS, generateScenario } from './schedules.ts';
import { FAMILIES, type Family, type Mutant, type RunResult } from './spec.ts';

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

function printLatencies(latencies: number[]): void {
	if (latencies.length === 0) {
		console.log('time to writable: no failover sample');
		return;
	}
	const sorted = [...latencies].sort((a, b) => a - b);
	const median = sorted[Math.floor((sorted.length - 1) / 2)] as number;
	console.log(
		`time to writable: ${latencies.length} sample(s), median ${(median / 1000).toFixed(2)} s, worst ${(
			(sorted[sorted.length - 1] as number) / 1000
		).toFixed(2)} s`,
	);
}

function printStats(result: RunResult): void {
	const s = result.stats;
	console.log(
		`events ${result.events}; ${s.promotions} promotion(s); ${s.acks} ack(s); strict overlap ${Math.round(s.strictOverlapMs)} ms; primary losses ${s.primaryLosses}; fences ${s.fences}`,
	);
	console.log(
		`candidates ${s.candidateAttempts}; lost CAS ${s.candidateLostCas}; sync changes opened ${s.syncChangesOpened}, closed ${s.syncChangesClosed}, fell back ${s.syncChangesFellBack}, downgraded ${s.syncChangesDowngraded}`,
	);
	console.log(
		`control down: ${s.controlDownPromotions} promotion(s), ${s.controlDownAcks} ack(s); row generation ${s.controlRowGeneration}; async acks missing at the end ${s.asyncLostAcks}`,
	);
}

if (flags.scenario) {
	const factory = FIXED_SCENARIOS[flags.scenario];
	if (!factory) {
		console.error(`unknown scenario ${flags.scenario}; known: ${Object.keys(FIXED_SCENARIOS).join(', ')}`);
		process.exit(2);
	}
	const scenario = factory();
	const world = new W11World({ seed: Number(flags.seed), scenario, mutant, trace: true, verbose: true });
	const result = world.run();
	console.log(`scenario ${scenario.name} (${scenario.family}), seed ${result.seed}, mutant ${mutant}`);
	console.log(
		`auto: ${world.armDecision.mode}${world.armDecision.refusals.length > 0 ? ` (refused: ${world.armDecision.refusals.join(', ')})` : ''}`,
	);
	console.log('faults:');
	for (const f of scenario.faults)
		console.log(
			`  #${f.id} @${(f.at / 1000).toFixed(3)}s ${f.kind}${
				f.from ? ` ${f.from}→${f.to}${f.symmetric ? ' (both)' : ''}` : ''
			}${f.node ? ` ${f.node}` : ''}${f.target ? ` ${f.target}` : ''}${
				f.durationMs ? ` for ${(f.durationMs / 1000).toFixed(1)}s` : ''
			}${f.value ? ` value ${f.value}` : ''}`,
		);
	printStats(result);
	printLatencies(result.failoverLatenciesMs);
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
	acks: number;
	strictOverlapMs: number;
	maxStrictOverlapMs: number;
	primaryLosses: number;
	fences: number;
	candidates: number;
	lostCas: number;
	controlPromotions: number;
	syncOpened: number;
	syncClosed: number;
	syncFellBack: number;
	syncDowngraded: number;
	latencies: number[];
	violations: number;
}

const perFamily = new Map<string, FamilyStats>();
const failures: RunResult[] = [];
const allLatencies: number[] = [];
const started = performance.now();

for (let seed = firstSeed; seed < firstSeed + runs; seed++) {
	const family = fixedFamily ?? (FAMILIES[seed % FAMILIES.length] as Family);
	const scenario = generateScenario(seed, family);
	const result = new W11World({ seed, scenario, mutant, trace: flags.trace, verbose: flags.trace }).run();
	const stats = perFamily.get(family) ?? {
		runs: 0,
		promotions: 0,
		acks: 0,
		strictOverlapMs: 0,
		maxStrictOverlapMs: 0,
		primaryLosses: 0,
		fences: 0,
		candidates: 0,
		lostCas: 0,
		controlPromotions: 0,
		syncOpened: 0,
		syncClosed: 0,
		syncFellBack: 0,
		syncDowngraded: 0,
		latencies: [],
		violations: 0,
	};
	stats.runs++;
	stats.promotions += result.stats.promotions;
	stats.acks += result.stats.acks;
	stats.strictOverlapMs += result.stats.strictOverlapMs;
	stats.maxStrictOverlapMs = Math.max(stats.maxStrictOverlapMs, result.stats.strictOverlapMs);
	stats.primaryLosses += result.stats.primaryLosses;
	stats.fences += result.stats.fences;
	stats.candidates += result.stats.candidateAttempts;
	stats.lostCas += result.stats.candidateLostCas;
	stats.controlPromotions += result.stats.controlDownPromotions;
	stats.syncOpened += result.stats.syncChangesOpened;
	stats.syncClosed += result.stats.syncChangesClosed;
	stats.syncFellBack += result.stats.syncChangesFellBack;
	stats.syncDowngraded += result.stats.syncChangesDowngraded;
	stats.latencies.push(...result.failoverLatenciesMs);
	allLatencies.push(...result.failoverLatenciesMs);
	stats.violations += result.violations.length;
	perFamily.set(family, stats);
	if (result.violations.length > 0) failures.push(result);
}

const elapsed = performance.now() - started;
console.log(`w11 model: ${runs} schedules, ${(elapsed / 1000).toFixed(2)} s, ${(elapsed / runs).toFixed(2)} ms/run, mutant ${mutant}`);
console.log(
	'family                 runs  promos  acks  losses  fences  candidates  lost-cas  ctl-promos  strict-ms  max-strict  median-s  worst-s  violations',
);
for (const family of FAMILIES) {
	const stats = perFamily.get(family);
	if (!stats) continue;
	const sorted = [...stats.latencies].sort((a, b) => a - b);
	const median = sorted.length > 0 ? (sorted[Math.floor((sorted.length - 1) / 2)] as number) : null;
	const worst = sorted.length > 0 ? (sorted[sorted.length - 1] as number) : null;
	console.log(
		`${family.padEnd(22)} ${String(stats.runs).padStart(5)} ${String(stats.promotions).padStart(6)} ${String(stats.acks).padStart(6)} ${String(stats.primaryLosses).padStart(7)} ${String(stats.fences).padStart(7)} ${String(stats.candidates).padStart(11)} ${String(stats.lostCas).padStart(9)} ${String(stats.controlPromotions).padStart(11)} ${String(Math.round(stats.strictOverlapMs)).padStart(10)} ${String(Math.round(stats.maxStrictOverlapMs)).padStart(11)} ${(median === null ? '—' : (median / 1000).toFixed(2)).padStart(8)} ${(worst === null ? '—' : (worst / 1000).toFixed(2)).padStart(7)}  ${stats.violations === 0 ? 'none' : `${stats.violations} violation(s)`}`,
	);
}

const sortedAll = [...allLatencies].sort((a, b) => a - b);
if (sortedAll.length > 0) {
	const median = sortedAll[Math.floor((sortedAll.length - 1) / 2)] as number;
	const worst = sortedAll[sortedAll.length - 1] as number;
	console.log(
		`time to writable over ${sortedAll.length} failover sample(s): median ${(median / 1000).toFixed(2)} s, worst ${(worst / 1000).toFixed(2)} s (bounds 25.00 / 30.00)`,
	);
	if (median > 25_000) {
		console.log(`  VIOLATION bound/time-to-writable-median: median ${(median / 1000).toFixed(2)} s exceeds 25 s`);
		failures.push({
			seed: -1,
			family: 'power-off',
			scenario: 'median',
			violations: [
				{
					property: 'bound',
					kind: 'time-to-writable-exceeded',
					t: 0,
					message: `median time to writable ${(median / 1000).toFixed(2)} s exceeds 25 s`,
				},
			],
			stats: {} as never,
			failoverLatenciesMs: sortedAll,
			trace: [],
			events: 0,
			durationMs: 0,
		});
	}
} else {
	console.log('time to writable: no failover samples');
}

console.log(`\nviolating runs: ${failures.filter((f) => f.seed >= 0).length}`);

if (failures.length > 0) {
	const byKind = new Map<string, { property: string; count: number; seeds: number[] }>();
	for (const result of failures) {
		for (const violation of result.violations) {
			const entry = byKind.get(violation.kind) ?? { property: violation.property, count: 0, seeds: [] };
			entry.count++;
			if (result.seed >= 0 && entry.seeds.length < 30) entry.seeds.push(result.seed);
			byKind.set(violation.kind, entry);
		}
	}
	for (const [kind, entry] of byKind)
		console.log(`  ${entry.property}/${kind}: ${entry.count} occurrence(s), seeds ${entry.seeds.join(' ') || '—'}`);
	for (const result of failures.filter((f) => f.seed >= 0).slice(0, maxReport)) {
		console.log('');
		console.log(`── seed ${result.seed} ${result.family}: ${result.violations[0]?.property}/${result.violations[0]?.kind}`);
		printViolations(result);
		printTrace(result);
		console.log(
			`   replay: bun tests/ha/sim/w11/run.ts --runs 1 --seed ${result.seed}${
				fixedFamily ? ` --family ${fixedFamily}` : ''
			}${mutant !== 'none' ? ` --mutant ${mutant}` : ''} --trace`,
		);
	}
}

process.exit(failures.length > 0 ? 1 : 0);
