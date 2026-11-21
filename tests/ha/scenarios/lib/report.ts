/**
 * Scenario verdicts and the report every scenario writes next to the checker's `report.json`
 * (tests/ha/README.md, "Scenarios").
 *
 * A verdict is about the platform, never the harness:
 *
 * - `pass`: every bound and invariant the scenario judges held;
 * - `fail`: one did not (the reason names which, with the number);
 * - `invalid`: the run could not measure what it is for, because of a property of the platform as it
 *   is today (a remote copy that takes no edge traffic, say): any number it produced would mislead;
 * - `skip`: the scenario needs a feature another lane is still building; the reason names it and the
 *   refusal or missing field that proved it absent;
 * - `error`: the harness itself could not run (lab down, a timeout waiting for a deploy). Never a
 *   statement about the platform.
 *
 * Exit codes: pass 0, fail 1, invalid 2, skip 3, error 4. `--accept invalid,skip` maps listed
 * verdicts to 0 for CI steps that run a scenario known to be invalid or skipped on this tree.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const VERDICTS = ['pass', 'fail', 'invalid', 'skip', 'error'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const EXIT_CODES: Record<Verdict, number> = { pass: 0, fail: 1, invalid: 2, skip: 3, error: 4 };

/** One judged property: a sub-check of a scenario with its own verdict and numbers. */
export interface Check {
	name: string;
	verdict: Verdict;
	reason: string | null;
	/** Numbers the check was judged on, or measured for the record. */
	values: Record<string, unknown>;
}

/** Worst first: an overall verdict is the worst of its checks, `error` above everything. */
const SEVERITY: Record<Verdict, number> = { error: 4, fail: 3, invalid: 2, skip: 1, pass: 0 };

export function worst(verdicts: Verdict[]): Verdict {
	return verdicts.reduce<Verdict>((acc, verdict) => (SEVERITY[verdict] > SEVERITY[acc] ? verdict : acc), 'pass');
}

/**
 * A scenario's overall verdict (`Scenario.finish`): an early stop's verdict and reason, unless a
 * check already failed (a later skip or invalid never hides a failure; a harness error stays an
 * error); else the worst check's, with the reasons of every check at that verdict; no checks at
 * all is an error.
 */
export function decideVerdict(checks: Check[], stopped: { verdict: Verdict; reason: string } | null): { verdict: Verdict; reason: string | null } {
	if (stopped) {
		if (stopped.verdict !== 'error' && worst(checks.map((check) => check.verdict)) === 'fail')
			return { verdict: 'fail', reason: `${checks.filter((check) => check.verdict === 'fail').map((check) => `${check.name}: ${check.reason}`).join('; ')} (then: ${stopped.reason})` };
		return { verdict: stopped.verdict, reason: stopped.reason };
	}
	if (checks.length === 0) return { verdict: 'error', reason: 'the scenario judged nothing' };
	const verdict = worst(checks.map((check) => check.verdict));
	return {
		verdict,
		reason: verdict === 'pass' ? null : checks.filter((check) => check.verdict === verdict).map((check) => `${check.name}: ${check.reason}`).join('; '),
	};
}

/** `--accept invalid,skip` → the verdicts that exit 0. */
export function parseAccept(value: string | undefined): Set<Verdict> {
	const out = new Set<Verdict>(['pass']);
	for (const item of (value ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
		if (!(VERDICTS as readonly string[]).includes(item)) throw new Error(`--accept: unknown verdict "${item}" (one of ${VERDICTS.join(', ')})`);
		out.add(item as Verdict);
	}
	return out;
}

export function exitCodeFor(verdict: Verdict, accept: Set<Verdict>): number {
	return accept.has(verdict) ? 0 : EXIT_CODES[verdict];
}

/** The fields of the checker's report a scenario summary repeats (tests/ha/checker/report.ts). */
export interface CheckerSummary {
	requests: number | null;
	failedRequests: number | null;
	failedByStatus: Record<string, number> | null;
	longestWriteGapMs: number | null;
	acknowledgedWrites: number | null;
	lostAcknowledgedWrites: number | null;
	duplicateSingletonRuns: number | null;
	invariants: Record<string, string> | null;
	failedInvariants: string[];
	/** Invariants the checker could not observe in this run: never a pass. */
	notObservedInvariants: string[];
}

export function readCheckerReport(path: string): CheckerSummary | null {
	if (!existsSync(path)) return null;
	const report = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
	const invariants = Object.fromEntries(Object.entries(report.invariants ?? {}).map(([key, value]: [string, any]) => [key, String(value?.status)]));
	return {
		requests: report.requests ?? null,
		failedRequests: report.failedRequests ?? null,
		failedByStatus: report.failedByStatus ?? null,
		longestWriteGapMs: report.longestWriteGapMs ?? null,
		acknowledgedWrites: report.acknowledgedWrites ?? null,
		lostAcknowledgedWrites: report.lostAcknowledgedWrites ?? null,
		duplicateSingletonRuns: report.duplicateSingletonRuns ?? null,
		invariants,
		failedInvariants: Object.entries(invariants)
			.filter(([, status]) => status === 'fail')
			.map(([key]) => key),
		notObservedInvariants: Object.entries(invariants)
			.filter(([, status]) => status !== 'pass' && status !== 'fail')
			.map(([key]) => key),
	};
}

export interface ScenarioReport {
	scenario: string;
	verdict: Verdict;
	reason: string | null;
	startedAt: string;
	endedAt: string | null;
	/** Command-line parameters, after defaults. */
	params: Record<string, unknown>;
	checks: Check[];
	/** Named moments, in ms after the scenario's zero (its fault, or its start). */
	timings: Record<string, number | null>;
	/** Everything else measured, for the record. */
	measures: Record<string, unknown>;
	/** Timeline of what the scenario did: faults applied and reverted, deploys, scale changes. */
	timeline: Array<{ t: number; at: string; event: string; [key: string]: unknown }>;
	checker: CheckerSummary | null;
	error?: string;
	/** Free-form notes a reader needs (edge bypassed, a known platform bug, …). */
	notes: string[];
}

/** Writes `scenario.json` and `summary.md` into `out`. */
export function writeScenarioReport(out: string, report: ScenarioReport): string {
	writeFileSync(join(out, 'scenario.json'), `${JSON.stringify(report, null, 2)}\n`);
	const secs = (ms: unknown) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)} s` : 'not observed');
	const value = (item: unknown) => (item === null || item === undefined ? '—' : typeof item === 'object' ? JSON.stringify(item) : String(item));
	const checker = report.checker;
	const lines = [
		`# ${report.scenario} — ${report.startedAt}`,
		'',
		`**Verdict: ${report.verdict.toUpperCase()}**${report.reason ? ` — ${report.reason}` : ''}`,
		'',
		...report.notes.flatMap((note) => [`> ${note}`, '']),
		'## Checks',
		'',
		'| Check | Verdict | Reason | Values |',
		'|---|---|---|---|',
		...report.checks.map((check) => `| ${check.name} | ${check.verdict} | ${(check.reason ?? '').replace(/\|/g, '\\|')} | ${value(check.values).replace(/\|/g, '\\|')} |`),
		'',
		'## Checker',
		'',
		checker
			? [
				'| Measure | Value |',
				'|---|---|',
				`| Requests / failed | ${value(checker.requests)} / ${value(checker.failedRequests)} |`,
				`| Failed by status | ${value(checker.failedByStatus)} |`,
				`| Longest write gap | ${secs(checker.longestWriteGapMs)} |`,
				`| Acknowledged / lost writes | ${value(checker.acknowledgedWrites)} / ${value(checker.lostAcknowledgedWrites)} |`,
				`| Duplicate singleton runs | ${value(checker.duplicateSingletonRuns)} |`,
				`| Invariants | ${Object.entries(checker.invariants ?? {}).map(([key, status]) => `${key} ${status}`).join(', ')} |`,
			].join('\n')
			: 'Not run.',
		'',
		'## Timings',
		'',
		...(Object.keys(report.timings).length ? ['| Moment | After zero |', '|---|---|', ...Object.entries(report.timings).map(([key, ms]) => `| ${key} | ${secs(ms)} |`)] : ['None recorded.']),
		'',
		'## Measures',
		'',
		...(Object.keys(report.measures).length ? ['| Measure | Value |', '|---|---|', ...Object.entries(report.measures).map(([key, item]) => `| ${key} | ${value(item).replace(/\|/g, '\\|')} |`)] : ['None.']),
		'',
		'## Timeline',
		'',
		...report.timeline.map((entry) => `- +${(entry.t / 1000).toFixed(1)} s ${entry.event}${Object.keys(entry).length > 3 ? ` ${JSON.stringify(Object.fromEntries(Object.entries(entry).filter(([key]) => !['t', 'at', 'event'].includes(key))))}` : ''}`),
		'',
		...(report.error ? ['## Error', '', '```', report.error, '```', ''] : []),
	];
	const text = lines.join('\n');
	writeFileSync(join(out, 'summary.md'), text);
	return text;
}
