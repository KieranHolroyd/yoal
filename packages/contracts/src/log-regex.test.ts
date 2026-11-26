import { describe, expect, test } from 'bun:test';
import { checkLogRegex, compileLogPredicate, logRegexSource, parseLogQuery } from './log-query.ts';
import { checkRegexSafety, LOG_REGEX_JS_SUBJECT_MAX, logRegexSubject } from './log-regex.ts';
import type { LogRecord } from './log-record.ts';

const ATTACKS = [
	'(a|a)*$',
	'(a|aa)*c',
	'(a|b)+$',
	'(ab|a)*?c',
	'(a|b){2,}',
	'(a+)+',
	'(a*)*$',
	'(.*)*x',
	'(a+)?b',
	'(\\w+\\s?)*$',
	'a*a*a*a*a*a*c',
	'a*a*a*c',
	'.*.*x',
	'.*x.*y',
	'a.*a.*c',
	'\\w+\\w+c',
	'\\d+\\d*x',
	'x.*y.*z',
	`${'a?'.repeat(24)}${'a'.repeat(24)}`,
	'a(?=b)',
	'(?<!x)a',
	'(a)\\1',
];

const COMMON = [
	'time(out|d out)',
	'\\d{3}ms',
	'user=\\w+',
	'^GET .* 500$',
	'[a-f0-9]{8}',
	'(?i)timeout',
	'error.*timeout',
	'\\d+ms.*slow',
	'user=\\w+ .*err',
	'(GET|POST|PUT|PATCH|DELETE) .* 5\\d\\d',
	'(\\d{1,3}\\.){3}\\d{1,3}',
	'\\w+@\\w+\\.com',
	'"status":5\\d\\d',
	'(ab)+c[+*]\\+',
	'^\\[[A-Z]+\\]',
	'[^"]*"',
];

// Lines built to make backtracking engines work hardest on each shape.
const ADVERSARIAL = ['a', 'x', 'ab', 'xy', '1', ' a', 'a=', 'a1', 'aa1.', 'GET ', 'a\t'].map((unit) => unit.repeat(Math.ceil(16_384 / unit.length)));

describe('safe regex subset', () => {
	test('rejects catastrophic and polynomial shapes', () => {
		for (const pattern of ATTACKS) expect([pattern, checkLogRegex(pattern)]).not.toEqual([pattern, null]);
		expect(checkLogRegex('(a|a)*$')).toContain('may not contain `|`');
		expect(checkLogRegex('(a+)?b')).toStartWith('Nested repetition');
		expect(checkLogRegex('a*a*a*c')).toContain('At most 2 unbounded');
		expect(checkLogRegex('.*x.*y')).toContain('backtrack');
		expect(checkLogRegex('a(?=b)')).toBe('Lookaround is not supported (RE2)');
		expect(checkLogRegex('(a)\\1')).toBe('Backreferences are not supported (RE2)');
	});

	test('the parser refuses them with a positioned error', () => {
		const parsed = parseLogQuery('@msg:/(a|aa)*c/');
		expect(parsed.ok).toBe(false);
	});

	test('keeps common log regexes', () => {
		for (const pattern of COMMON) expect([pattern, checkLogRegex(pattern)]).toEqual([pattern, null]);
		expect(parseLogQuery('@msg:/time(out|d out)/ body:/\\d{3}ms/').ok).toBe(true);
	});

	test('a required neighbour the repeat cannot match decides where it ends', () => {
		expect(checkRegexSafety('\\w+=\\w+=x')).toBeNull();
		expect(checkRegexSafety('\\w+\\w+=x')).not.toBeNull();
		expect(checkRegexSafety('[a-z]+[0-9]+x')).toBeNull();
		expect(checkRegexSafety('[a-z]+[A-Z0-9]+x')).toBeNull();
		// Case folding makes `[a-z]` and `[A-Z]` overlap.
		expect(checkRegexSafety('[a-z]+[A-Z]+[a-z]x')).toBeNull();
		expect(checkRegexSafety('[a-z]+[A-Z]+x', 'i')).not.toBeNull();
		// Anchored at the start, only one start position is tried.
		expect(checkRegexSafety('^.*x.*y')).toBeNull();
		expect(checkRegexSafety('^.*x.*y', 'm')).not.toBeNull();
	});

	test('JS only tests the first 2 KiB of a value', () => {
		expect(LOG_REGEX_JS_SUBJECT_MAX).toBe(2048);
		expect(logRegexSubject('x'.repeat(5000)).length).toBe(2048);
		const predicate = compileLogPredicate({ type: 'field', field: { kind: 'builtin', name: 'body' }, op: 'regex', value: 'NEEDLE' });
		const record = (body: string) => ({ body }) as LogRecord;
		expect(predicate(record(`NEEDLE ${'x'.repeat(4096)}`))).toBe(true);
		expect(predicate(record(`${'x'.repeat(4096)} NEEDLE`))).toBe(false);
	});

	test('timing guard: every accepted pattern stays fast on adversarial 16 KiB lines', () => {
		let worst = 0;
		let worstPattern = '';
		for (const pattern of [...COMMON, '\\d{1,3}.*x', '.*c', '\\w+c', 'a+b+c', 'a{1,100}a{1,100}c']) {
			expect(checkLogRegex(pattern)).toBeNull();
			const { source, flags } = logRegexSource(pattern);
			const re = new RegExp(source, flags);
			for (const line of ADVERSARIAL) {
				const started = performance.now();
				re.test(logRegexSubject(line));
				const took = performance.now() - started;
				if (took > worst) {
					worst = took;
					worstPattern = pattern;
				}
			}
		}
		// The budget allows roughly 8 × 2048² steps (about 10 ms here); leave room for slow CI machines.
		expect({ worstPattern, slow: worst > 50 }).toEqual({ worstPattern, slow: false });
	});
});
