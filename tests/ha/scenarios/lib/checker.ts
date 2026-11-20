/**
 * Run the checker (tests/ha/checker/cli.ts) through a target for a scenario: its report goes to the
 * scenario's `report.json`, its log to `checker.log`, and it reads the scenario's observations.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { CheckerLog } from '../../checker/log.ts';
import { join, resolve } from 'node:path';
import { REPO, type Scenario } from './scenario.ts';
import type { Target } from './ingress.ts';

export interface CheckerRun {
	process: ReturnType<typeof Bun.spawn>;
	startedAt: number;
	/** Resolves with the checker's exit code (0 clean, 1 an invariant failed, 2 usage/I-O). */
	exited: Promise<number>;
	running(): boolean;
	stop(): void;
}

export interface CheckerOptions {
	durationS: number;
	rate: number;
	seed: number;
	cli?: string;
	timeoutMs?: number;
	extra?: string[];
}

export function startChecker(scenario: Scenario, target: Target, options: CheckerOptions): CheckerRun {
	const cli = resolve(REPO, options.cli ?? 'tests/ha/checker/cli.ts');
	if (!existsSync(cli)) throw new Error(`checker CLI ${cli} not found`);
	const argv = [
		'bun', cli,
		'--url', target.base,
		'--host', target.host,
		'--duration-s', String(options.durationS),
		'--rate', String(options.rate),
		'--seed', String(options.seed),
		'--observe', scenario.observations,
		'--out', scenario.checkerReportPath,
		'--log', join(scenario.out, 'requests.json'),
		...(options.timeoutMs ? ['--timeout-ms', String(options.timeoutMs)] : []),
		...(options.extra ?? []),
	];
	const process = Bun.spawn(argv, { cwd: REPO, stdout: Bun.file(join(scenario.out, 'checker.log')), stderr: Bun.file(join(scenario.out, 'checker.err.log')) });
	const startedAt = Date.now();
	scenario.event('checker start', { durationS: options.durationS, rate: options.rate, seed: options.seed, target: target.kind });
	const run: CheckerRun = {
		process,
		startedAt,
		exited: process.exited.then((code) => {
			scenario.event('checker end', { exit: code });
			return code;
		}),
		running: () => process.exitCode === null,
		stop: () => {
			if (process.exitCode === null) process.kill();
		},
	};
	scenario.onCleanup('stop checker', async () => {
		run.stop();
		await run.exited;
	});
	return run;
}

/** Sleep up to `ms`, returning early (false) if the checker exits first. */
export async function sleepWhileRunning(run: CheckerRun, ms: number): Promise<boolean> {
	await Promise.race([Bun.sleep(ms), run.exited]);
	return run.running();
}

/**
 * Failed run requests (not the final verification) inside each named window [from, to] (epoch ms,
 * by start time) and outside all of them, from the checker's request log (`requests.json`).
 */
export function failuresByWindow(scenario: Scenario, windows: Array<{ name: string; from: number; to: number }>): Record<string, { requests: number; failed: number; byStatus: Record<string, number> }> {
	const path = join(scenario.out, 'requests.json');
	const out: Record<string, { requests: number; failed: number; byStatus: Record<string, number> }> = {};
	for (const name of [...windows.map((window) => window.name), 'outside']) out[name] = { requests: 0, failed: 0, byStatus: {} };
	if (!existsSync(path)) return out;
	const log = JSON.parse(readFileSync(path, 'utf8')) as CheckerLog;
	for (const request of log.requests) {
		if (request.kind === 'verify') continue;
		const bucket = out[windows.find((window) => request.startedAt >= window.from && request.startedAt <= window.to)?.name ?? 'outside']!;
		bucket.requests++;
		if (request.status !== 200) {
			bucket.failed++;
			const key = request.status ? String(request.status) : (request.error ?? 'network');
			bucket.byStatus[key] = (bucket.byStatus[key] ?? 0) + 1;
		}
	}
	return out;
}
