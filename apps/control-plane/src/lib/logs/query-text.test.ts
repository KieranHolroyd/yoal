import { describe, expect, test } from 'bun:test';
import { suggestLogQuery } from '@yoal/contracts';
import {
	combineQuery,
	formatFilterClause,
	hasFilterClause,
	highlightMatches,
	lexLogQuery,
	searchTerms,
	splitPipes,
	toggleFilterClause,
	withPipes
} from './query-text';
import { binFor, logTimeLabel, resolveLogTime, shiftLogTime } from './time';

describe('lexer', () => {
	test('tokens cover the input exactly', () => {
		const text =
			'level:error -@path:/health "timeout ok" (a OR b) @msg:/time(out)/ | stats p95(@d) by bin(5m), level';
		expect(
			lexLogQuery(text)
				.map((token) => token.text)
				.join('')
		).toBe(text);
	});

	test('classifies fields, attributes, operators, strings and stages', () => {
		const kinds = lexLogQuery('level:>=warn -@http.status:500 "x" | stats count()')
			.filter((token) => token.kind !== 'ws')
			.map((token) => `${token.kind}:${token.text}`);
		expect(kinds).toEqual([
			'field:level:',
			'op:>=',
			'value:warn',
			'neg:-',
			'attr:@http.status:',
			'value:500',
			'string:"x"',
			'pipe:|',
			'stage:stats',
			'fn:count',
			'paren:(',
			'paren:)'
		]);
	});

	test('a pipe inside quotes or a regex is not a pipe', () => {
		expect(splitPipes('"a | b" @m:/x|y/ | limit 5')).toEqual({
			filter: '"a | b" @m:/x|y/',
			pipes: '| limit 5'
		});
	});

	test('values may contain colons', () => {
		const tokens = lexLogQuery('stream:pipeline-job:job_1').filter((token) => token.kind !== 'ws');
		expect(tokens.map((token) => token.kind)).toEqual(['field', 'value']);
		expect(tokens[1]!.text).toBe('pipeline-job:job_1');
	});
});

describe('combining a locked preset with the reader’s query', () => {
	test('ANDs both, keeping pipes at the end', () => {
		expect(combineQuery('deployment:dep_1', 'timeout | stats count()')).toBe(
			'deployment:dep_1 timeout | stats count()'
		);
	});

	test('parenthesises sides with OR', () => {
		expect(combineQuery('source:runtime OR source:system', 'a OR b')).toBe(
			'(source:runtime OR source:system) (a OR b)'
		);
	});

	test('either side may be empty', () => {
		expect(combineQuery('', 'a OR b')).toBe('a OR b');
		expect(combineQuery('source:build build:b1', '')).toBe('source:build build:b1');
		expect(combineQuery('', '')).toBe('');
	});

	test('withPipes swaps the stages', () => {
		expect(withPipes('level:error | stats count()', '| patterns')).toBe('level:error | patterns');
		expect(withPipes('', '| patterns')).toBe('| patterns');
	});
});

describe('facet clauses', () => {
	test('values are quoted when needed', () => {
		expect(formatFilterClause('service', 'api')).toBe('service:api');
		expect(formatFilterClause('stream', 'pod:ns/a/b')).toBe('stream:pod:ns/a/b');
		expect(formatFilterClause('@user.name', 'Ada Lovelace', true)).toBe(
			'-@user.name:"Ada Lovelace"'
		);
		expect(formatFilterClause('@q', 'say "x"')).toBe('@q:"say \\"x\\""');
		expect(formatFilterClause('@v', '>5')).toBe('@v:">5"');
		expect(formatFilterClause('@v', 'a*')).toBe('@v:"a*"');
	});

	test('click adds, click again removes, alt-click flips', () => {
		let q = 'timeout | limit 10';
		q = toggleFilterClause(q, 'level', 'error');
		expect(q).toBe('timeout level:error | limit 10');
		expect(hasFilterClause(q, 'level', 'error')).toBe(true);
		q = toggleFilterClause(q, 'level', 'error', true);
		expect(q).toBe('timeout -level:error | limit 10');
		q = toggleFilterClause(q, 'level', 'error', true);
		expect(q).toBe('timeout | limit 10');
	});

	test('clauses inside groups are left alone', () => {
		expect(toggleFilterClause('(level:error OR x)', 'level', 'error')).toBe(
			'(level:error OR x) level:error'
		);
	});
});

describe('search terms to highlight', () => {
	test('bare words, phrases and body values; not negated or field values', () => {
		expect(
			searchTerms(
				'timeout "connection reset" -noise level:error body:upstream @path:/x NOT skip | stats count()'
			)
		).toEqual(['timeout', 'connection reset', 'upstream']);
	});

	test('keywords are not terms', () => {
		expect(searchTerms('a1 OR b2')).toEqual(['a1', 'b2']);
	});

	test('highlightMatches splits case-insensitively', () => {
		expect(highlightMatches('Upstream TIMEOUT after timeout', ['timeout'])).toEqual([
			{ text: 'Upstream ', match: false },
			{ text: 'TIMEOUT', match: true },
			{ text: ' after ', match: false },
			{ text: 'timeout', match: true }
		]);
		expect(highlightMatches('a.b', ['.'])).toEqual([
			{ text: 'a', match: false },
			{ text: '.', match: true },
			{ text: 'b', match: false }
		]);
		expect(highlightMatches('abc', [])).toEqual([{ text: 'abc', match: false }]);
	});
});

describe('suggestions (the shared contracts suggester the editor uses)', () => {
	test('field names at the start of a term', () => {
		const result = suggestLogQuery('lev', 3);
		expect(result.from).toBe(0);
		expect(result.to).toBe(3);
		expect(result.items[0]).toMatchObject({ label: 'level', insert: 'level:', kind: 'field' });
	});

	test('values for a field, from the catalog or built-ins', () => {
		const level = suggestLogQuery('level:er', 8);
		expect(level.items.map((item) => item.insert)).toContain('error');
		const catalog = { service: ['api', 'worker'] };
		const service = suggestLogQuery('x -service:w', 12, catalog);
		expect(service.items.map((item) => item.label)).toEqual(['worker']);
	});

	test('pipe stages and aggregations', () => {
		expect(suggestLogQuery('a | st', 6).items.map((item) => item.label)).toContain('stats');
		expect(
			suggestLogQuery('a | stats p9', 12)
				.items.map((item) => item.label)
				.filter((label) => label.startsWith('p9'))
		).toHaveLength(3);
	});
});

describe('time windows', () => {
	const now = Date.UTC(2026, 10, 25, 15, 0);

	test('relative windows resolve against now', () => {
		expect(resolveLogTime({ kind: 'relative', value: '15m' }, now)).toEqual({
			from: now - 900_000,
			to: now
		});
		expect(resolveLogTime({ kind: 'absolute', from: 5, to: null }, now)).toEqual({
			from: 5,
			to: now
		});
	});

	test('[ then ] returns to the relative window', () => {
		const back = shiftLogTime({ kind: 'relative', value: '1h' }, -1, now);
		expect(back).toEqual({ kind: 'absolute', from: now - 7_200_000, to: now - 3_600_000 });
		expect(shiftLogTime(back, 1, now)).toEqual({ kind: 'relative', value: '1h' });
	});

	test('labels and bins', () => {
		expect(logTimeLabel({ kind: 'relative', value: '24h' }, 'utc')).toBe('Last 24 hours');
		expect(logTimeLabel({ kind: 'absolute', from: now - 300_000, to: now }, 'utc')).toBe(
			'2026-11-25 14:55:00 → 15:00:00 (5m)'
		);
		expect(binFor(3_600_000)).toBe('1m');
		expect(binFor(86_400_000)).toBe('30m');
	});
});
