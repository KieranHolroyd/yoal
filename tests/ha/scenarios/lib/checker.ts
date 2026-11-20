/**
 * Run the checker (tests/ha/checker/cli.ts) through a target for a scenario: its report goes to the
 * scenario's `report.json`, its log to `checker.log`, and it reads the scenario's observations.
 */
import { existsSync } from 'node:fs';
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
