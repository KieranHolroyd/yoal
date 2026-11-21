import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT_CODES, decideVerdict, exitCodeFor, parseAccept, readCheckerReport, worst, writeScenarioReport, type ScenarioReport } from './report.ts';

describe('scenario verdicts', () => {
	test('the overall verdict is the worst check: error > fail > invalid > skip > pass', () => {
		expect(worst([])).toBe('pass');
		expect(worst(['pass', 'skip'])).toBe('skip');
		expect(worst(['skip', 'invalid', 'pass'])).toBe('invalid');
		expect(worst(['invalid', 'fail', 'skip'])).toBe('fail');
		expect(worst(['fail', 'error'])).toBe('error');
	});

	test('exit codes, and --accept maps only the named verdicts to 0', () => {
		expect(EXIT_CODES).toEqual({ pass: 0, fail: 1, invalid: 2, skip: 3, error: 4 });
		const accept = parseAccept('invalid, skip');
		expect(exitCodeFor('invalid', accept)).toBe(0);
		expect(exitCodeFor('skip', accept)).toBe(0);
		expect(exitCodeFor('fail', accept)).toBe(1);
		expect(exitCodeFor('error', accept)).toBe(4);
		expect(exitCodeFor('pass', parseAccept(undefined))).toBe(0);
		expect(() => parseAccept('passed')).toThrow(/unknown verdict/);
	});

	test('the checker summary lists failed invariants; a missing report is null', () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-scenario-'));
		expect(readCheckerReport(join(dir, 'report.json'))).toBeNull();
		writeFileSync(join(dir, 'report.json'), JSON.stringify({ requests: 10, failedRequests: 1, invariants: { I6: { status: 'pass' }, I15: { status: 'fail' }, I1: { status: 'not-observed' } } }));
		const summary = readCheckerReport(join(dir, 'report.json'))!;
		expect(summary.failedInvariants).toEqual(['I15']);
		expect(summary.requests).toBe(10);
	});

	test('writes scenario.json and a summary with the verdict and reason', () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-scenario-'));
		const report: ScenarioReport = {
			scenario: 'demo',
			verdict: 'skip',
			reason: 'RELEASE_PHASE is off',
			startedAt: '2026-11-20T00:00:00.000Z',
			endedAt: null,
			params: {},
			checks: [{ name: 'a|b', verdict: 'skip', reason: 'x|y', values: {} }],
			timings: { offline: 29_100, rejoined: null },
			measures: {},
			timeline: [],
			checker: null,
			notes: ['Edge bypassed'],
		};
		const text = writeScenarioReport(dir, report);
		expect(text).toContain('**Verdict: SKIP** — RELEASE_PHASE is off');
		expect(text).toContain('| offline | 29.1 s |');
		expect(text).toContain('| rejoined | not observed |');
		expect(text).toContain('x\\|y');
		expect(JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8')).verdict).toBe('skip');
	});

	test('Scenario.finish: an early stop, the worst check, or an error when nothing was judged', () => {
		const check = (name: string, verdict: Parameters<typeof worst>[0][number], reason: string | null = null) => ({ name, verdict, reason, values: {} });
		expect(decideVerdict([], null)).toEqual({ verdict: 'error', reason: 'the scenario judged nothing' });
		expect(decideVerdict([check('a', 'pass'), check('b', 'pass')], null)).toEqual({ verdict: 'pass', reason: null });
		expect(decideVerdict([check('a', 'pass'), check('b', 'skip', 'flag off'), check('c', 'invalid', 'no traffic')], null)).toEqual({ verdict: 'invalid', reason: 'c: no traffic' });
		expect(decideVerdict([check('a', 'fail', 'x'), check('b', 'fail', 'y')], null)).toEqual({ verdict: 'fail', reason: 'a: x; b: y' });
		// An early stop keeps its own verdict and reason...
		expect(decideVerdict([check('a', 'pass')], { verdict: 'skip', reason: 'RELEASE_PHASE is off' })).toEqual({ verdict: 'skip', reason: 'RELEASE_PHASE is off' });
		expect(decideVerdict([], { verdict: 'invalid', reason: 'two nodes' })).toEqual({ verdict: 'invalid', reason: 'two nodes' });
		// ...unless a check already failed: a later skip or invalid never hides a failure.
		expect(decideVerdict([check('spread', 'fail', 'refused')], { verdict: 'skip', reason: 'later' })).toEqual({ verdict: 'fail', reason: 'spread: refused (then: later)' });
		// A harness error stays an error: it says nothing about the platform.
		expect(decideVerdict([check('spread', 'fail', 'refused')], { verdict: 'error', reason: 'harness error: boom' })).toEqual({ verdict: 'error', reason: 'harness error: boom' });
	});
});
