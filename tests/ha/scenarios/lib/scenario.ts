/**
 * The frame every scenario runs in: its output directory, the observation log the checker reads,
 * the timeline, the checks it judges, cleanup that runs on success, failure and Ctrl-C, and the
 * report written at the end whatever happened (lib/report.ts).
 *
 *   const scenario = new Scenario('kill-node', params, flags);
 *   await scenario.run(async (s) => {
 *     s.check('replaced within bound', ms <= bound ? 'pass' : 'fail', `…`, { ms, bound });
 *   });
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Observer } from '../../../lab/lib/api.ts';
import { exitCodeFor, parseAccept, readCheckerReport, worst, writeScenarioReport, type Check, type ScenarioReport, type Verdict } from './report.ts';

export const REPO = resolve(import.meta.dir, '../../../..');

/** parseArgs options every scenario takes. */
export const COMMON_OPTIONS = {
	out: { type: 'string' },
	accept: { type: 'string' },
	seed: { type: 'string', default: '1' },
	project: { type: 'string' },
	checker: { type: 'string', default: 'tests/ha/checker/cli.ts' },
} as const;

/** Thrown to stop a scenario early with a verdict other than error (invalid, skip, fail). */
export class ScenarioStop extends Error {
	constructor(
		readonly verdict: Verdict,
		readonly reason: string,
	) {
		super(reason);
		this.name = 'ScenarioStop';
	}
}

export function positiveInt(name: string, raw: string | undefined): number {
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) throw new ScenarioStop('error', `${name} must be a positive integer (got ${raw})`);
	return value;
}

export async function waitFor<T>(label: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, intervalMs = 2000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown = null;
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (value) return value;
		} catch (error) {
			last = error;
		}
		await Bun.sleep(intervalMs);
	}
	throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${label}${last ? `: ${(last as Error).message}` : ''}`);
}

export class Scenario {
	readonly out: string;
	readonly observations: string;
	readonly observer: Observer;
	readonly checkerReportPath: string;
	readonly report: ScenarioReport;
	private zeroAt: number;
	private readonly cleanups: Array<{ label: string; fn: () => unknown }> = [];
	private readonly accept: Set<Verdict>;

	constructor(
		readonly name: string,
		params: Record<string, unknown>,
		flags: { out?: string; accept?: string },
	) {
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		this.out = resolve(flags.out ?? join(REPO, 'tests/lab/.out', `${name}-${stamp}`));
		mkdirSync(this.out, { recursive: true });
		this.observations = join(this.out, 'observations.jsonl');
		writeFileSync(this.observations, '');
		this.observer = new Observer(this.observations);
		this.checkerReportPath = join(this.out, 'report.json');
		this.accept = parseAccept(flags.accept);
		this.zeroAt = Date.now();
		this.report = {
			scenario: name,
			verdict: 'error',
			reason: null,
			startedAt: new Date().toISOString(),
			endedAt: null,
			params,
			checks: [],
			timings: {},
			measures: {},
			timeline: [],
			checker: null,
			notes: [],
		};
	}

	say(message: string): void {
		console.log(`\x1b[1m==> ${message}\x1b[0m`);
	}

	note(message: string): void {
		console.log(`    ${message}`);
	}

	/** Timings are relative to this moment (the fault, usually). Defaults to the scenario's start. */
	setZero(at = Date.now()): void {
		this.zeroAt = at;
		this.event('zero');
	}

	get zero(): number {
		return this.zeroAt;
	}

	rel(at = Date.now()): number {
		return Math.round(at - this.zeroAt);
	}

	/** Record a moment once (the first call wins); returns ms after zero. */
	timing(name: string, at = Date.now()): number {
		if (this.report.timings[name] === undefined || this.report.timings[name] === null) this.report.timings[name] = this.rel(at);
		return this.report.timings[name]!;
	}

	unobserved(name: string): void {
		if (this.report.timings[name] === undefined) this.report.timings[name] = null;
	}

	measure(name: string, value: unknown): void {
		this.report.measures[name] = value;
	}

	notice(text: string): void {
		if (!this.report.notes.includes(text)) this.report.notes.push(text);
	}

	event(event: string, fields: Record<string, unknown> = {}): void {
		this.report.timeline.push({ t: this.rel(), at: new Date().toISOString(), event, ...fields });
	}

	check(name: string, verdict: Verdict, reason: string | null, values: Record<string, unknown> = {}): Check {
		const check: Check = { name, verdict, reason, values };
		this.report.checks.push(check);
		const colour = verdict === 'pass' ? 32 : verdict === 'fail' || verdict === 'error' ? 31 : 33;
		this.note(`\x1b[${colour}m${verdict.toUpperCase()}\x1b[0m ${name}${reason ? `: ${reason}` : ''}`);
		return check;
	}

	/** Stop now with this verdict (the cleanups still run and the report is still written). */
	stop(verdict: Exclude<Verdict, 'pass'>, reason: string): never {
		throw new ScenarioStop(verdict, reason);
	}

	/** Registered cleanups run last-first, once, on any exit. */
	onCleanup(label: string, fn: () => unknown): void {
		this.cleanups.push({ label, fn });
	}

	private async cleanup(): Promise<void> {
		while (this.cleanups.length) {
			const { label, fn } = this.cleanups.pop()!;
			try {
				await fn();
			} catch (error) {
				console.error(`cleanup "${label}" failed: ${(error as Error).message}`);
				this.report.notes.push(`Cleanup "${label}" failed: ${(error as Error).message.split('\n')[0]}`);
			}
		}
	}

	async run(body: (scenario: this) => Promise<void>): Promise<never> {
		let interrupted = false;
		const signals = process as unknown as { once(event: 'SIGINT' | 'SIGTERM', listener: () => void): void };
		for (const signal of ['SIGINT', 'SIGTERM'] as const)
			signals.once(signal, () => {
				interrupted = true;
				void this.cleanup().finally(() => {
					this.finish('error', `interrupted (${signal})`);
					process.exit(130);
				});
			});
		let stopped: { verdict: Verdict; reason: string } | null = null;
		try {
			await body(this);
		} catch (error) {
			if (error instanceof ScenarioStop) stopped = { verdict: error.verdict, reason: error.reason };
			else {
				stopped = { verdict: 'error', reason: `harness error: ${(error as Error).message.split('\n')[0]}` };
				this.report.error = (error as Error).stack ?? String(error);
				console.error(`\x1b[31m${this.name}: ${(error as Error).message}\x1b[0m`);
			}
		}
		await this.cleanup();
		// An interrupt finishes the report itself (above); never write it twice.
		if (interrupted) await new Promise(() => {});
		const code = this.finish(stopped?.verdict ?? null, stopped?.reason ?? null);
		process.exit(code);
	}

	/** Overall verdict: an early stop's, else the worst check's (no checks at all is an error). */
	private finish(stoppedVerdict: Verdict | null, stoppedReason: string | null): number {
		this.report.checker = readCheckerReport(this.checkerReportPath);
		let verdict: Verdict;
		let reason: string | null;
		if (stoppedVerdict) {
			verdict = stoppedVerdict;
			reason = stoppedReason;
			// A sub-check that already failed outranks a later invalid or skip.
			const judged = worst(this.report.checks.map((check) => check.verdict));
			if (verdict !== 'error' && judged === 'fail') {
				verdict = 'fail';
				reason = `${this.report.checks.filter((check) => check.verdict === 'fail').map((check) => `${check.name}: ${check.reason}`).join('; ')} (then: ${stoppedReason})`;
			}
		} else if (this.report.checks.length === 0) {
			verdict = 'error';
			reason = 'the scenario judged nothing';
		} else {
			verdict = worst(this.report.checks.map((check) => check.verdict));
			reason =
				verdict === 'pass'
					? null
					: this.report.checks
							.filter((check) => check.verdict === verdict)
							.map((check) => `${check.name}: ${check.reason}`)
							.join('; ');
		}
		this.report.verdict = verdict;
		this.report.reason = reason;
		this.report.endedAt = new Date().toISOString();
		const text = writeScenarioReport(this.out, this.report);
		this.say(`results in ${this.out}`);
		console.log(text);
		return exitCodeFor(verdict, this.accept);
	}
}
