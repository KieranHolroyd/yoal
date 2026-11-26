import { describe, expect, test } from 'bun:test';
import { classifyLogCompare, formatLogCompareBaseline, parseLogCompareBaseline } from './log-analysis.ts';
import { logCompareInputSchema } from './log-record.ts';

const MIN = 60_000;

describe('compare classification (docs/LOGS.md §8.2)', () => {
	test('new, gone, rising, falling and steady by per-minute rate', () => {
		expect(classifyLogCompare(3, 0, 60 * MIN, 60 * MIN)).toEqual({ change: 'new', ratio: null });
		expect(classifyLogCompare(0, 4, 60 * MIN, 60 * MIN)).toEqual({ change: 'gone', ratio: 0 });
		expect(classifyLogCompare(10, 5, 60 * MIN, 60 * MIN)).toEqual({ change: 'rising', ratio: 2 });
		expect(classifyLogCompare(5, 10, 60 * MIN, 60 * MIN)).toEqual({ change: 'falling', ratio: 0.5 });
		expect(classifyLogCompare(15, 10, 60 * MIN, 60 * MIN)).toEqual({ change: 'steady', ratio: 1.5 });
	});

	test('rising needs at least 5 lines now', () => {
		expect(classifyLogCompare(4, 1, 60 * MIN, 60 * MIN).change).toBe('steady');
		expect(classifyLogCompare(5, 1, 60 * MIN, 60 * MIN).change).toBe('rising');
	});

	test('windows of different lengths compare by rate, not count', () => {
		// 60 lines in 1 h vs 60 lines in 24 h: 24× the rate.
		expect(classifyLogCompare(60, 60, 60 * MIN, 24 * 60 * MIN)).toEqual({ change: 'rising', ratio: 24 });
		// Same count over twice the time is half the rate.
		expect(classifyLogCompare(10, 10, 120 * MIN, 60 * MIN)).toEqual({ change: 'falling', ratio: 0.5 });
	});

	test('nothing in either window is steady', () => {
		expect(classifyLogCompare(0, 0, MIN, MIN)).toEqual({ change: 'steady', ratio: null });
	});
});

describe('baseline URL form (mode=compare&baseline=…)', () => {
	test('round-trips every kind and satisfies the input schema', () => {
		for (const text of ['previous', 'offset:86400000', 'deploy:dep_abc123', 'range:1000-2000']) {
			const baseline = parseLogCompareBaseline(text);
			expect(baseline).not.toBeNull();
			expect(formatLogCompareBaseline(baseline!)).toBe(text);
			expect(logCompareInputSchema.safeParse({ baseline }).success).toBe(true);
		}
	});

	test('offsets accept units; ranges are ordered', () => {
		expect(parseLogCompareBaseline('offset:1d')).toEqual({ kind: 'offset', offsetMs: 86_400_000 });
		expect(parseLogCompareBaseline('offset:7d')).toEqual({ kind: 'offset', offsetMs: 604_800_000 });
		expect(parseLogCompareBaseline('range:2000-1000')).toEqual({ kind: 'range', from: 1_000, to: 2_000 });
	});

	test('anything malformed is null', () => {
		for (const text of ['', 'yesterday', 'offset:', 'offset:0', 'offset:-5', 'deploy:', 'deploy:a b', 'range:5-5', 'range:x-y', 'nope:1'])
			expect(parseLogCompareBaseline(text)).toBeNull();
		expect(parseLogCompareBaseline(null)).toBeNull();
	});
});
