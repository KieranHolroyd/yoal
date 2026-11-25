/**
 * Spike S5 (docs/LOGS.md §12): known-secret redaction without decrypting on the hot path.
 *
 *   bun spikes/logs-bench/s5-redaction.ts [lines=200000]
 *
 * Runs the redactor over realistic lines with 0, 50 and 500 secret values (about 1% of lines
 * carry one, raw or base64), both with every built-in detector on (the real ingest cost) and with
 * the built-ins off (the known-secret matcher alone).
 *
 * Pass: < 5 µs p50 per line with 50 secrets.
 */
import { randomBytes } from 'node:crypto';
import { BUILTIN_REDACTION_KINDS, createRedactor, createSecretFingerprints, type Redactor } from '../../packages/core/src/log-redaction.ts';
import { fmt, makeLineGenerator, percentile, rng } from './corpus.ts';

const LINES = Number(process.argv[2] ?? 200_000);
const ALL_BUILTINS = BUILTIN_REDACTION_KINDS.filter((k) => k !== 'known_secret');

let injected = 0;
function corpus(secrets: string[]): string[] {
	const gen = makeLineGenerator(99);
	const r = rng(5);
	const lines: string[] = [];
	injected = 0;
	for (let i = 0; i < LINES; i++) {
		let line = gen(i % 50);
		if (secrets.length && r() < 0.01) {
			const s = secrets[Math.floor(r() * secrets.length)]!;
			line += r() < 0.5 ? ` env=${s}` : ` blob ${Buffer.from(s).toString('base64')}`;
			injected++;
		}
		lines.push(line);
	}
	return lines;
}

function measure(redactor: Redactor, lines: string[]): { p50: number; p90: number; p99: number; hits: number } {
	// warm up
	for (let i = 0; i < Math.min(20_000, lines.length); i++) redactor.redact(lines[i]!);
	const samples = new Float64Array(lines.length);
	let hits = 0;
	for (let i = 0; i < lines.length; i++) {
		const t0 = Bun.nanoseconds();
		const result = redactor.redact(lines[i]!);
		samples[i] = (Bun.nanoseconds() - t0) / 1000;
		if (result.hits.length) hits++;
	}
	samples.sort();
	return { p50: percentile(samples, 50), p90: percentile(samples, 90), p99: percentile(samples, 99), hits };
}

const avgLen = (lines: string[]) => lines.reduce((n, l) => n + l.length, 0) / lines.length;

console.log(`S5 redaction — ${LINES.toLocaleString()} lines per run (Bun ${Bun.version})`);
let pass = false;
const baseline: Record<string, number> = {};
for (const count of [0, 50, 500]) {
	const secrets = Array.from({ length: count }, () => randomBytes(24).toString('base64url'));
	const lines = corpus(secrets);
	// Fingerprints made once, as the control plane would when the secrets are written.
	const key = randomBytes(32);
	const fingerprints = createSecretFingerprints(secrets, key);
	const full = createRedactor({ fingerprints, fingerprintKey: key });
	const secretsOnly = createRedactor({ fingerprints, fingerprintKey: key, disable: ALL_BUILTINS });
	const a = measure(full, lines);
	const b = measure(secretsOnly, lines);
	if (count === 0) {
		baseline.full = a.p50;
		baseline.only = b.p50;
	}
	console.log(
		`  ${String(count).padStart(3)} secrets (${full.secretCount} fingerprints, avg line ${avgLen(lines).toFixed(0)} chars, ${injected.toLocaleString()} lines carry one)\n` +
			`      full redactor   p50 ${fmt(a.p50)}  p90 ${fmt(a.p90)}  p99 ${fmt(a.p99)}  lines with hits ${a.hits.toLocaleString()}\n` +
			`      secrets only    p50 ${fmt(b.p50)}  p90 ${fmt(b.p90)}  p99 ${fmt(b.p99)}  lines with hits ${b.hits.toLocaleString()}` +
			(count ? `\n      overhead vs 0   full +${fmt(a.p50 - baseline.full!)}  secrets-only +${fmt(b.p50 - baseline.only!)}` : ''),
	);
	if (count === 50) pass = a.p50 < 5;
}
console.log(`  verdict    p50 with 50 secrets (full redactor) ${pass ? 'PASS' : 'FAIL'} (< 5 µs)`);
