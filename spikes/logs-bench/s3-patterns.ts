/**
 * Spike S3 (docs/LOGS.md §12): Drain miner cost per line in Bun, and memory.
 *
 *   bun spikes/logs-bench/s3-patterns.ts [lines=1000000] [scopes=100]
 *
 * Pass: < 20 µs per line p50; < 50 MB per 100 scopes.
 */
import { heapStats } from 'bun:jsc';
import { DrainMiner } from '../../packages/core/src/log-patterns.ts';
import { fmt, makeLineGenerator, percentile } from './corpus.ts';

const LINES = Number(process.argv[2] ?? 1_000_000);
const SCOPES = Number(process.argv[3] ?? 100);
const CHUNK = 10_000;

function heapMB(): number {
	Bun.gc(true);
	Bun.gc(true);
	return heapStats().heapSize / 1024 / 1024;
}

// Warm the JIT on a throwaway miner so the timed run measures steady state.
{
	const warm = new DrainMiner();
	const gen = makeLineGenerator(7);
	for (let i = 0; i < 50_000; i++) warm.patternFor(`warm:${i % 10}`, gen(i % 10));
}

const baseHeap = heapMB();
const miner = new DrainMiner();
const gen = makeLineGenerator(42);
const samples = new Float64Array(LINES);
let created = 0;
const started = Bun.nanoseconds();
for (let done = 0; done < LINES; done += CHUNK) {
	const n = Math.min(CHUNK, LINES - done);
	const scopes = new Array<string>(n);
	const lines = new Array<string>(n);
	for (let i = 0; i < n; i++) {
		const scope = (done + i) % SCOPES;
		scopes[i] = `org_1:project:prj_${scope}`;
		lines[i] = gen(scope);
	}
	for (let i = 0; i < n; i++) {
		const t0 = Bun.nanoseconds();
		const result = miner.patternFor(scopes[i]!, lines[i]!);
		samples[done + i] = (Bun.nanoseconds() - t0) / 1000;
		if (result.isNew) created++;
	}
}
const wallMs = (Bun.nanoseconds() - started) / 1e6;
const minedHeap = heapMB();
samples.sort();

const stats = miner.stats();
console.log(`S3 Drain miner — ${LINES.toLocaleString()} lines, ${SCOPES} scopes (Bun ${Bun.version})`);
console.log(`  per line   p50 ${fmt(percentile(samples, 50))}   p90 ${fmt(percentile(samples, 90))}   p99 ${fmt(percentile(samples, 99))}   p99.9 ${fmt(percentile(samples, 99.9))}`);
console.log(`  wall       ${wallMs.toFixed(0)} ms incl. corpus generation (${((LINES / wallMs) * 1000).toFixed(0)} lines/s)`);
console.log(`  templates  ${stats.templates.toLocaleString()} across ${stats.scopes} scopes (${(stats.templates / stats.scopes).toFixed(1)}/scope); ${created.toLocaleString()} new-id events`);
console.log(`  memory     ${(minedHeap - baseHeap).toFixed(1)} MB heap for ${stats.scopes} scopes`);

// Memory per 5,000 templates: one scope filled to the LRU cap with distinct templates.
{
	const before = heapMB();
	const full = new DrainMiner();
	// Random letter-only words from a large vocabulary: two lines share well under 40% of their
	// tokens, so every line is a template of its own.
	const r = Math.random;
	const word = () => {
		let s = '';
		for (let k = 0; k < 7; k++) s += String.fromCharCode(97 + Math.floor(r() * 26));
		return s;
	};
	let guard = 0;
	while (full.stats().templates < 5_000 && guard++ < 20_000) {
		const tokens: string[] = [];
		for (let k = 0; k < 8 + (guard % 6); k++) tokens.push(word());
		full.patternFor('scope', `${tokens.join(' ')} took ${guard}ms`);
	}
	const after = heapMB();
	console.log(`  5,000 templates in one scope: ${(after - before).toFixed(1)} MB heap (${(((after - before) * 1024 * 1024) / 5000).toFixed(0)} B/template)`);
	if (full.stats().templates < 0) console.log(full); // keep `full` alive until measured
}

const p50 = percentile(samples, 50);
console.log(`  verdict    p50 ${p50 < 20 ? 'PASS' : 'FAIL'} (< 20 µs)`);
