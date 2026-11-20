import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT_CODES, exitCodeFor, parseAccept, readCheckerReport, worst, writeScenarioReport, type ScenarioReport } from './report.ts';

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
			reason: 'RELEASE_PHASE is not built',
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
		expect(text).toContain('**Verdict: SKIP** — RELEASE_PHASE is not built');
		expect(text).toContain('| offline | 29.1 s |');
		expect(text).toContain('| rejoined | not observed |');
		expect(text).toContain('x\\|y');
		expect(JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8')).verdict).toBe('skip');
	});
});
