#!/usr/bin/env bun
/**
 * The HA checker (HA-PLAN §4 W1): numbered writes and read-backs through the public route for the
 * whole run, then invariants I1–I7 and I11–I16 over its own request log plus the lab's observations.
 *
 *   bun tests/ha/checker/cli.ts --url http://203.0.113.10 --host checker.lab.test \
 *     --duration-s 300 --rate 20 --seed 7 --observe /tmp/obs.jsonl --out report.json
 *
 * Exit 0 when no invariant fails, 1 when one does, 2 on a usage or I/O error.
 * Extra flags: --timeout-ms (per request, 5000), --rpo-ms (I6, 0), --db-lease-ttl-ms (I13, 30000),
 * --log <file> (write the raw request log as JSON).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runChecker } from './client.ts';
import { parseObservations } from './observations.ts';
import { failedInvariants } from './report.ts';
import { summarize } from './summarize.ts';

function usage(message: string): never {
	console.error(`checker: ${message}`);
	console.error(
		'usage: bun tests/ha/checker/cli.ts --url <base URL> [--host <Host>] --duration-s <n> --rate <req/s> --seed <n> [--observe <file.jsonl>] --out <report.json>',
	);
	process.exit(2);
}

let flags: Record<string, string | undefined>;
try {
	flags = parseArgs({
		options: {
			url: { type: 'string' },
			host: { type: 'string' },
			'duration-s': { type: 'string' },
			rate: { type: 'string' },
			seed: { type: 'string' },
			observe: { type: 'string' },
			out: { type: 'string' },
			log: { type: 'string' },
			'timeout-ms': { type: 'string' },
			'rpo-ms': { type: 'string' },
			'db-lease-ttl-ms': { type: 'string' },
		},
		strict: true,
	}).values;
} catch (error) {
	usage(error instanceof Error ? error.message : String(error));
}

const number = (name: string, fallback?: number): number => {
	const raw = flags[name];
	if (raw === undefined) {
		if (fallback === undefined) usage(`--${name} is required`);
		return fallback;
	}
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) usage(`--${name} must be a non-negative number`);
	return value;
};

const url = flags.url ?? usage('--url is required');
const out = flags.out ?? usage('--out is required');
const durationS = number('duration-s');
const rate = number('rate');
const seed = Math.trunc(number('seed'));
if (rate <= 0) usage('--rate must be positive');

console.error(`checker: ${url}${flags.host ? ` (Host: ${flags.host})` : ''}, ${durationS} s at ${rate} req/s, seed ${seed}`);
const log = await runChecker({
	url,
	host: flags.host,
	durationS,
	rate,
	seed,
	timeoutMs: number('timeout-ms', 5_000),
	onProgress: (line) => console.error(`checker: ${line}`),
});

let observations: ReturnType<typeof parseObservations> = { observations: [], errors: [] };
if (flags.observe) {
	if (existsSync(flags.observe)) observations = parseObservations(readFileSync(flags.observe, 'utf8'));
	else console.error(`checker: ${flags.observe} does not exist; every observation-based invariant is not-observed`);
	for (const error of observations.errors.slice(0, 20)) console.error(`checker: observation ${error}`);
}

const report = summarize(log, observations.observations, {
	rpoMs: number('rpo-ms', 0),
	dbLeaseTtlMs: number('db-lease-ttl-ms', 30_000),
});
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
if (flags.log) writeFileSync(flags.log, `${JSON.stringify(log)}\n`);

const failed = failedInvariants(report);
console.error(
	`checker: ${report.requests} requests, ${report.failedRequests} failed ${JSON.stringify(report.failedByStatus)}, ` +
		`${report.acknowledgedWrites} writes acknowledged, ${report.lostAcknowledgedWrites} lost, longest write gap ${report.longestWriteGapMs} ms, ` +
		`${report.duplicateSingletonRuns} duplicate singleton runs, ${observations.observations.length} observations`,
);
for (const [id, result] of Object.entries(report.invariants)) console.error(`checker: ${id.padEnd(4)} ${result.status}${result.evidence[0] ? ` — ${result.evidence[0]}` : ''}`);
console.error(`checker: report written to ${out}${failed.length ? `; FAILED: ${failed.join(', ')}` : ''}`);
process.exit(failed.length > 0 ? 1 : 0);
