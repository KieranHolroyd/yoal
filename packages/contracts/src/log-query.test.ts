import { describe, expect, test } from 'bun:test';
import { LOG_QUERY_LIMITS, type LogFieldOp, type LogFieldRef, type LogPipeStage, type LogQueryAst, type LogQueryNode } from './log-query-ast.ts';
import {
	checkLogRegex,
	compileLogPredicate,
	formatLogFilter,
	formatLogQuery,
	logFieldValues,
	logGlobToRegExp,
	logLevelBounds,
	logRegexSource,
	parseLogFieldName,
	parseLogNumber,
	parseLogQuery,
	requiredLogFeatures,
	splitLogGlob,
} from './log-query.ts';
import type { LogRecord } from './log-record.ts';

function ast(text: string): LogQueryAst {
	const result = parseLogQuery(text);
	if (!result.ok) throw new Error(`parse failed for ${JSON.stringify(text)}: ${JSON.stringify(result.error)}`);
	return result.ast;
}

function filter(text: string): LogQueryNode | null {
	return ast(text).filter;
}

function error(text: string) {
	const result = parseLogQuery(text);
	if (result.ok) throw new Error(`expected an error for ${JSON.stringify(text)}, got ${JSON.stringify(result.ast)}`);
	return result.error;
}

const builtin = (name: string) => ({ kind: 'builtin', name }) as LogFieldRef;
const attr = (key: string): LogFieldRef => ({ kind: 'attribute', key });
const text = (value: string, phrase = false): LogQueryNode => ({ type: 'text', value, phrase });

describe('parseLogQuery: terms', () => {
	test('empty and whitespace-only queries match everything', () => {
		expect(ast('')).toEqual({ filter: null, pipes: [] });
		expect(ast('   \n\t')).toEqual({ filter: null, pipes: [] });
	});

	test('bare words and phrases', () => {
		expect(filter('timeout')).toEqual(text('timeout'));
		expect(filter('"connection reset"')).toEqual(text('connection reset', true));
		expect(filter('"say \\"hi\\" \\\\ there"')).toEqual(text('say "hi" \\ there', true));
		expect(filter('"C:\\Users"')).toEqual(text('C:\\Users', true));
		expect(filter('12:30:00')).toEqual(text('12:30:00'));
		expect(filter('user@example.com')).toEqual(text('user@example.com'));
		expect(filter('foo*')).toEqual(text('foo*'));
	});

	test('backslash escapes in bare words', () => {
		expect(filter('foo\\ bar')).toEqual(text('foo bar'));
		expect(filter('http\\://x')).toEqual(text('http://x'));
		expect(filter('\\-v')).toEqual(text('-v'));
		// Letters are not escapable, so the backslash stays; quote a keyword to search for it.
		expect(filter('\\OR')).toEqual(text('\\OR'));
		expect(filter('"OR"')).toEqual(text('OR', true));
		expect(filter('\\@home')).toEqual(text('@home'));
		expect(filter('a\\(b\\)')).toEqual(text('a(b)'));
		expect(filter('C\\d')).toEqual(text('C\\d'));
	});

	test('built-in fields, case-insensitive names, message alias', () => {
		expect(filter('service:api')).toEqual({ type: 'field', field: builtin('service'), op: 'eq', value: 'api' });
		expect(filter('SERVICE:api')).toEqual({ type: 'field', field: builtin('service'), op: 'eq', value: 'api' });
		expect(filter('deployment:dep_1')).toEqual({ type: 'field', field: builtin('deployment'), op: 'eq', value: 'dep_1' });
		expect(filter('scope:project:prj_1')).toEqual({ type: 'field', field: builtin('scope'), op: 'eq', value: 'project:prj_1' });
		expect(filter('service:"my api"')).toEqual({ type: 'field', field: builtin('service'), op: 'eq', value: 'my api' });
		expect(filter('message:timeout')).toEqual(text('timeout'));
		expect(filter('body:"a b"')).toEqual(text('a b', true));
		expect(filter('Message:=exact line')).toEqual({
			type: 'and',
			children: [{ type: 'field', field: builtin('body'), op: 'eq', value: 'exact' }, text('line')],
		});
	});

	test('attributes and resource fields', () => {
		expect(filter('@http.status:500')).toEqual({ type: 'field', field: attr('http.status'), op: 'eq', value: '500' });
		expect(filter('@user-agent:curl')).toEqual({ type: 'field', field: attr('user-agent'), op: 'eq', value: 'curl' });
		expect(filter('@Http.Status:500')).toEqual({ type: 'field', field: attr('Http.Status'), op: 'eq', value: '500' });
		expect(filter('resource.host.name:edge-a')).toEqual({ type: 'field', field: { kind: 'resource', key: 'host.name' }, op: 'eq', value: 'edge-a' });
		expect(filter('@resource.host.name:edge-a')).toEqual({ type: 'field', field: { kind: 'resource', key: 'host.name' }, op: 'eq', value: 'edge-a' });
		expect(filter('Resource.k:v')).toEqual({ type: 'field', field: { kind: 'resource', key: 'k' }, op: 'eq', value: 'v' });
	});

	test('comparisons parse numbers', () => {
		expect(filter('@http.status:>=500')).toEqual({ type: 'field', field: attr('http.status'), op: 'gte', value: 500 });
		expect(filter('@d:>1.5')).toEqual({ type: 'field', field: attr('d'), op: 'gt', value: 1.5 });
		expect(filter('@d:<-3')).toEqual({ type: 'field', field: attr('d'), op: 'lt', value: -3 });
		expect(filter('@d:<=1e3')).toEqual({ type: 'field', field: attr('d'), op: 'lte', value: 1000 });
		expect(filter('@d:>"7"')).toEqual({ type: 'field', field: attr('d'), op: 'gt', value: 7 });
		expect(filter('replica:>0')).toEqual({ type: 'field', field: builtin('replica'), op: 'gt', value: 0 });
		expect(filter('replica:1')).toEqual({ type: 'field', field: builtin('replica'), op: 'eq', value: 1 });
		expect(filter('replica:=2')).toEqual({ type: 'field', field: builtin('replica'), op: 'eq', value: 2 });
	});

	test('level: bands, synonyms, numbers and operators', () => {
		const level = (op: LogFieldOp, value: string): LogQueryNode => ({ type: 'field', field: builtin('level'), op, value });
		expect(filter('level:error')).toEqual(level('gte', 'error'));
		expect(filter('level:warn')).toEqual(level('gte', 'warn'));
		expect(filter('level:WARNING')).toEqual(level('gte', 'warn'));
		expect(filter('level:err')).toEqual(level('gte', 'error'));
		expect(filter('level:17')).toEqual(level('gte', 'error'));
		expect(filter('level:=warn')).toEqual(level('eq', 'warn'));
		expect(filter('level:>info')).toEqual(level('gt', 'info'));
		expect(filter('level:>=info')).toEqual(level('gte', 'info'));
		expect(filter('level:<warn')).toEqual(level('lt', 'warn'));
		expect(filter('level:<=debug')).toEqual(level('lte', 'debug'));
		expect(filter('Level:"fatal"')).toEqual(level('gte', 'fatal'));
	});

	test('wildcards, exact match and exists', () => {
		expect(filter('@path:/api/*')).toEqual({ type: 'field', field: attr('path'), op: 'wildcard', value: '/api/*' });
		expect(filter('service:api-*')).toEqual({ type: 'field', field: builtin('service'), op: 'wildcard', value: 'api-*' });
		expect(filter('body:*timeout*')).toEqual({ type: 'field', field: builtin('body'), op: 'wildcard', value: '*timeout*' });
		expect(filter('@path:"/a*"')).toEqual({ type: 'field', field: attr('path'), op: 'eq', value: '/a*' });
		expect(filter('@path:=/a*')).toEqual({ type: 'field', field: attr('path'), op: 'eq', value: '/a*' });
		expect(filter('@path:/a\\*b')).toEqual({ type: 'field', field: attr('path'), op: 'eq', value: '/a*b' });
		expect(filter('@user.id:*')).toEqual({ type: 'exists', field: attr('user.id') });
		expect(filter('trace:*')).toEqual({ type: 'exists', field: builtin('trace') });
		expect(filter('replica:*')).toEqual({ type: 'exists', field: builtin('replica') });
		expect(filter('@k:"*"')).toEqual({ type: 'field', field: attr('k'), op: 'eq', value: '*' });
	});

	test('regex values', () => {
		expect(filter('@msg:/time(out|d out)/')).toEqual({ type: 'field', field: attr('msg'), op: 'regex', value: 'time(out|d out)' });
		expect(filter('body:/^GET \\/api/')).toEqual({ type: 'field', field: builtin('body'), op: 'regex', value: '^GET /api' });
		expect(filter('@m:/\\d+ms/')).toEqual({ type: 'field', field: attr('m'), op: 'regex', value: '\\d+ms' });
		expect(filter('(@m:/a|b/)')).toEqual({ type: 'field', field: attr('m'), op: 'regex', value: 'a|b' });
		// A slash that does not close at the end of the term is a path, not a regex.
		expect(filter('@path:/api/v1/users')).toEqual({ type: 'field', field: attr('path'), op: 'eq', value: '/api/v1/users' });
		expect(filter('@path:/health')).toEqual({ type: 'field', field: attr('path'), op: 'eq', value: '/health' });
		expect(filter('@path:"/health/"')).toEqual({ type: 'field', field: attr('path'), op: 'eq', value: '/health/' });
	});
});

describe('parseLogQuery: boolean structure', () => {
	test('implicit and explicit AND flatten', () => {
		expect(filter('a b c')).toEqual({ type: 'and', children: [text('a'), text('b'), text('c')] });
		expect(filter('a AND b AND c')).toEqual({ type: 'and', children: [text('a'), text('b'), text('c')] });
		expect(filter('(a b) c')).toEqual({ type: 'and', children: [text('a'), text('b'), text('c')] });
		expect(filter('((a))')).toEqual(text('a'));
	});

	test('AND binds tighter than OR', () => {
		expect(filter('a OR b c')).toEqual({ type: 'or', children: [text('a'), { type: 'and', children: [text('b'), text('c')] }] });
		expect(filter('a b OR c')).toEqual({ type: 'or', children: [{ type: 'and', children: [text('a'), text('b')] }, text('c')] });
		expect(filter('a OR b OR c')).toEqual({ type: 'or', children: [text('a'), text('b'), text('c')] });
		expect(filter('(a OR b) c')).toEqual({ type: 'and', children: [{ type: 'or', children: [text('a'), text('b')] }, text('c')] });
	});

	test('negation binds tightest', () => {
		expect(filter('-a b')).toEqual({ type: 'and', children: [{ type: 'not', child: text('a') }, text('b')] });
		expect(filter('NOT a OR b')).toEqual({ type: 'or', children: [{ type: 'not', child: text('a') }, text('b')] });
		expect(filter('-(a OR b)')).toEqual({ type: 'not', child: { type: 'or', children: [text('a'), text('b')] } });
		expect(filter('NOT(a)')).toEqual({ type: 'not', child: text('a') });
		expect(filter('--a')).toEqual({ type: 'not', child: { type: 'not', child: text('a') } });
		expect(filter('-@path:/health')).toEqual({ type: 'not', child: { type: 'field', field: attr('path'), op: 'eq', value: '/health' } });
		expect(filter('-"a b"')).toEqual({ type: 'not', child: text('a b', true) });
	});

	test('keywords are upper-case only', () => {
		expect(filter('a or b')).toEqual({ type: 'and', children: [text('a'), text('or'), text('b')] });
		expect(filter('ORACLE')).toEqual(text('ORACLE'));
		expect(filter('a OR-b')).toEqual({ type: 'and', children: [text('a'), text('OR-b')] });
	});

	test('the spec example', () => {
		const parsed = filter('level:error service:api -@path:/health "timeout"');
		expect(parsed).toEqual({
			type: 'and',
			children: [
				{ type: 'field', field: builtin('level'), op: 'gte', value: 'error' },
				{ type: 'field', field: builtin('service'), op: 'eq', value: 'api' },
				{ type: 'not', child: { type: 'field', field: attr('path'), op: 'eq', value: '/health' } },
				text('timeout', true),
			],
		});
	});
});

describe('parseLogQuery: pipes', () => {
	test('fields', () => {
		expect(ast('| fields ts, level, @http.status, body').pipes).toEqual([
			{ type: 'fields', fields: [builtin('level'), attr('http.status'), builtin('body')] },
		]);
		expect(ast('| FIELDS Message').pipes).toEqual([{ type: 'fields', fields: [builtin('body')] }]);
	});

	test('stats with every aggregation, aliases and groups', () => {
		const stats = ast(
			'| stats count(), count_distinct(service), sum(@b), avg(@d), min(replica), max(level), p50(@d) as med, p90(@d) by bin(5m), level',
		).pipes[0];
		expect(stats).toEqual({
			type: 'stats',
			aggregations: [
				{ fn: 'count', alias: 'count' },
				{ fn: 'count_distinct', field: builtin('service'), alias: 'count_distinct(service)' },
				{ fn: 'sum', field: attr('b'), alias: 'sum(@b)' },
				{ fn: 'avg', field: attr('d'), alias: 'avg(@d)' },
				{ fn: 'min', field: builtin('replica'), alias: 'min(replica)' },
				{ fn: 'max', field: builtin('level'), alias: 'max(level)' },
				{ fn: 'p50', field: attr('d'), alias: 'med' },
				{ fn: 'p90', field: attr('d'), alias: 'p90(@d)' },
			],
			by: [
				{ type: 'bin', intervalMs: 300_000, alias: 'bin(5m)' },
				{ type: 'field', field: builtin('level'), alias: 'level' },
			],
		});
		expect(ast('| stats p99(@d) as slow, count(*) as n by bin(1h) as hour, @http.route as route').pipes[0]).toEqual({
			type: 'stats',
			aggregations: [
				{ fn: 'p99', field: attr('d'), alias: 'slow' },
				{ fn: 'count', alias: 'n' },
			],
			by: [
				{ type: 'bin', intervalMs: 3_600_000, alias: 'hour' },
				{ type: 'field', field: attr('http.route'), alias: 'route' },
			],
		});
		expect(ast('| STATS COUNT() BY Level').pipes[0]).toEqual({
			type: 'stats',
			aggregations: [{ fn: 'count', alias: 'count' }],
			by: [{ type: 'field', field: builtin('level'), alias: 'level' }],
		});
	});

	test('bin intervals are clamped to [1s, 1d]', () => {
		const bin = (q: string) => (ast(q).pipes[0] as Extract<LogPipeStage, { type: 'stats' }>).by[0];
		expect(bin('| stats count() by bin(500ms)')).toEqual({ type: 'bin', intervalMs: 1_000, alias: 'bin(1s)' });
		expect(bin('| stats count() by bin(7d)')).toEqual({ type: 'bin', intervalMs: 86_400_000, alias: 'bin(1d)' });
		expect(bin('| stats count() by bin(90s)')).toEqual({ type: 'bin', intervalMs: 90_000, alias: 'bin(90s)' });
		expect(bin('| stats count() by bin(1500ms)')).toEqual({ type: 'bin', intervalMs: 1_500, alias: 'bin(1500ms)' });
	});

	test('patterns, dedup, sort and limit', () => {
		expect(ast('| patterns').pipes).toEqual([{ type: 'patterns' }]);
		expect(ast('| dedup body').pipes).toEqual([{ type: 'dedup', field: builtin('body') }]);
		expect(ast('| sort ts asc | limit 500').pipes).toEqual([
			{ type: 'sort', key: 'ts', direction: 'asc' },
			{ type: 'limit', count: 500 },
		]);
		expect(ast('| sort timestamp').pipes).toEqual([{ type: 'sort', key: 'ts', direction: 'asc' }]);
		expect(ast('| sort @http.status DESC').pipes).toEqual([{ type: 'sort', key: '@http.status', direction: 'desc' }]);
		expect(ast('| sort Level desc').pipes).toEqual([{ type: 'sort', key: 'level', direction: 'desc' }]);
		expect(ast('| dedup body | sort count desc').pipes[1]).toEqual({ type: 'sort', key: 'count', direction: 'desc' });
		expect(ast('| patterns | sort count desc').pipes[1]).toEqual({ type: 'sort', key: 'count', direction: 'desc' });
		expect(ast(`| limit ${LOG_QUERY_LIMITS.maxLimit}`).pipes).toEqual([{ type: 'limit', count: LOG_QUERY_LIMITS.maxLimit }]);
	});

	test('sort after stats resolves aliases and bare function names', () => {
		expect(ast('| stats p95(@duration_ms) by @http.route | sort p95 desc | limit 10').pipes.slice(1)).toEqual([
			{ type: 'sort', key: 'p95(@duration_ms)', direction: 'desc' },
			{ type: 'limit', count: 10 },
		]);
		expect(ast('| stats count() by level | sort count() desc').pipes[1]).toEqual({ type: 'sort', key: 'count', direction: 'desc' });
		expect(ast('| stats count() as n by level | sort N').pipes[1]).toEqual({ type: 'sort', key: 'n', direction: 'asc' });
		expect(ast('| stats count() by bin(5m) | sort bin(5m)').pipes[1]).toEqual({ type: 'sort', key: 'bin(5m)', direction: 'asc' });
		expect(ast('| stats count() by @http.route | sort @http.route').pipes[1]).toEqual({ type: 'sort', key: '@http.route', direction: 'asc' });
		expect(ast('| stats avg(@d) | sort avg(@d) desc').pipes[1]).toEqual({ type: 'sort', key: 'avg(@d)', direction: 'desc' });
	});

	test('filter plus pipes', () => {
		const parsed = ast('level:error -@path:/health "timeout" | stats count() by bin(1m)');
		expect(parsed.filter?.type).toBe('and');
		expect(parsed.pipes).toEqual([
			{ type: 'stats', aggregations: [{ fn: 'count', alias: 'count' }], by: [{ type: 'bin', intervalMs: 60_000, alias: 'bin(1m)' }] },
		]);
		// `|` inside a phrase or a regex is not a pipe.
		expect(ast('"a | b"').pipes).toEqual([]);
		expect(ast('@m:/a|b/ | limit 5').pipes).toEqual([{ type: 'limit', count: 5 }]);
	});
});

describe('parseLogQuery: errors', () => {
	test('unknown fields suggest the closest name', () => {
		expect(error('servce:api')).toEqual({ message: 'Unknown field `servce`', start: 0, end: 6, hint: 'did you mean `service`?' });
		expect(error('a deploymnt:x')).toMatchObject({ start: 2, end: 11, hint: 'did you mean `deployment`?' });
		expect(error('http://example.com')).toMatchObject({ message: 'Unknown field `http`', start: 0, end: 4 });
		expect(error('http://example.com').hint).toContain('@http');
		expect(error('| fields levle').hint).toBe('did you mean `level`?');
	});

	test('structural errors carry offsets', () => {
		expect(error('(a b')).toMatchObject({ message: 'Missing `)`', start: 0, end: 1 });
		expect(error('a b)')).toMatchObject({ message: 'Unmatched `)`', start: 3, end: 4 });
		expect(error('()')).toMatchObject({ message: 'Empty group `()`' });
		expect(error('a OR')).toMatchObject({ message: 'Expected a term after `OR`', start: 2, end: 4 });
		expect(error('OR a')).toMatchObject({ message: 'Expected a term before `OR`', start: 0, end: 2 });
		expect(error('a AND OR b')).toMatchObject({ message: 'Expected a term after `AND`' });
		expect(error('NOT')).toMatchObject({ message: 'Expected a term after `NOT`', start: 0, end: 3 });
		expect(error('a -')).toMatchObject({ message: 'Nothing to negate after `-`', start: 2, end: 3 });
		expect(error('"abc')).toMatchObject({ message: 'Unterminated quote', start: 0, end: 4 });
		expect(error('""')).toMatchObject({ message: 'Empty phrase `""`' });
		expect(error('@foo')).toMatchObject({ message: 'An attribute needs a value', start: 0, end: 4 });
	});

	test('value errors', () => {
		expect(error('service:')).toMatchObject({ message: 'Missing value after `service:`', start: 0, end: 8 });
		expect(error('service: api')).toMatchObject({ message: 'Missing value after `service:`' });
		expect(error('@x:>')).toMatchObject({ message: 'Missing value after the operator' });
		expect(error('@x:""')).toMatchObject({ message: 'Empty value' });
		expect(error('@x://')).toMatchObject({ message: 'Empty regex `//`' });
		expect(error('@x:>abc')).toMatchObject({ message: '`abc` is not a number', start: 4, end: 7 });
		expect(error('service:>5').message).toContain('is not numeric');
		expect(error('level:loud')).toMatchObject({ message: 'Unknown level `loud`', start: 6, end: 10 });
		expect(error('level:*').message).toBe('`level` takes a severity');
		expect(error('level:/x/').message).toContain("can't be matched with a regex");
		expect(error('replica:one').message).toBe('`replica` is a number');
		expect(error('level:30').message).toBe('Unknown level `30`');
	});

	test('regex safety', () => {
		expect(error('@m:/(a+)+/').message).toBe('Nested repetition like (a+)+ is not allowed');
		expect(error('@m:/(a*){2,}/').message).toBe('Nested repetition like (a+)+ is not allowed');
		expect(error('@m:/a(?=b)/').message).toBe('Lookaround is not supported (RE2)');
		expect(error('@m:/(a)\\1/').message).toBe('Backreferences are not supported (RE2)');
		expect(error('@m:/a[/').message).toStartWith('Invalid regex');
		expect(checkLogRegex('x'.repeat(513))).toContain('longer than');
		expect(checkLogRegex('(ab)+c[+*]\\+')).toBeNull();
		expect(checkLogRegex('(?i)timeout')).toBeNull();
	});

	test('pipe errors', () => {
		expect(error('| statz count()')).toMatchObject({ message: 'Unknown stage `statz`', start: 2, end: 7, hint: 'did you mean `stats`?' });
		expect(error('a |')).toMatchObject({ message: 'Expected a pipe stage after `|`' });
		expect(error('| stats cout()').hint).toBe('did you mean `count()`?');
		expect(error('| stats count(@x)').message).toBe('`count()` takes no field');
		expect(error('| stats avg()').message).toBe('`avg` needs a field');
		expect(error('| stats avg(service)').message).toBe('`avg` needs a numeric field');
		expect(error('| stats count(), count()').message).toBe('Duplicate column `count`');
		expect(error('| stats count() as n, sum(@x) as N').message).toBe('Duplicate column `N`');
		expect(error('| stats count() by bin(1m), bin(5m)').message).toBe('Only one `bin()` per stats');
		expect(error('| stats count() by bin(5x)').message).toBe('`5x` is not an interval');
		expect(error('| stats count() as by').message).toBe('`by` is not a valid column name');
		expect(error('| limit 0').message).toBe(`\`limit\` must be between 1 and ${LOG_QUERY_LIMITS.maxLimit}`);
		expect(error(`| limit ${LOG_QUERY_LIMITS.maxLimit + 1}`).message).toContain('must be between');
		expect(error('| limit ten').message).toBe('`limit` takes a whole number');
		expect(error('| patterns extra').message).toBe('Unexpected `extra`');
		expect(error('| fields ts').message).toContain('`ts` is always shown');
		expect(error('| stats count() | sort p99').message).toBe('`p99` is not a column of the stats result');
		expect(error('| stats p95(@a), p95(@b) | sort p95').message).toBe('`p95` is ambiguous');
		expect(error('| patterns | sort body').message).toBe('`body` is not a column of patterns');
		expect(error('| sort count').message).toBe('Unknown field `count`');
		expect(error('| sort avg(@x)').message).toContain('only be sorted on after `stats`');
	});

	test('stage order and combinations', () => {
		expect(error('| limit 5 | sort ts').message).toBe('`sort` must come before `limit`');
		expect(error('| sort ts | fields level').message).toBe('`fields` must come before `sort`');
		expect(error('| limit 1 | limit 2').message).toBe('Only one `limit` stage is allowed');
		expect(error('| stats count() | patterns').message).toBe('Only one `stats` or `patterns` stage is allowed');
		expect(error('| fields level | stats count()').message).toBe("`stats` can't be combined with `fields`");
		expect(error('| dedup body | patterns').message).toBe("`patterns` can't be combined with `dedup`");
		expect(parseLogQuery('| fields level | dedup body | sort ts desc | limit 5').ok).toBe(true);
	});
});

describe('parseLogQuery: limits', () => {
	test('maxLength', () => {
		const long = 'a'.repeat(LOG_QUERY_LIMITS.maxLength + 1);
		expect(error(long)).toMatchObject({ start: LOG_QUERY_LIMITS.maxLength, end: long.length });
		expect(parseLogQuery('a'.repeat(LOG_QUERY_LIMITS.maxLength)).ok).toBe(true);
	});

	test('maxNodes', () => {
		const terms = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`).join(' ');
		// n terms under one AND = n + 1 nodes.
		expect(parseLogQuery(terms(LOG_QUERY_LIMITS.maxNodes - 1)).ok).toBe(true);
		expect(error(terms(LOG_QUERY_LIMITS.maxNodes)).message).toContain('too complex');
	});

	test('maxDepth (nesting and tree depth)', () => {
		const nested = (n: number) => `${'('.repeat(n)}a${')'.repeat(n)}`;
		expect(parseLogQuery(nested(LOG_QUERY_LIMITS.maxDepth)).ok).toBe(true);
		expect(error(nested(LOG_QUERY_LIMITS.maxDepth + 1)).message).toContain('levels deep');
		expect(error('-'.repeat(LOG_QUERY_LIMITS.maxDepth + 1) + 'a').message).toContain('levels deep');
		// Alternating AND/OR builds depth without many parens.
		let q = 'a';
		for (let i = 0; i < 9; i++) q = `(${q} OR b${i}) c${i}`;
		expect(error(q).message).toContain('levels deep');
		// A 4000-paren bomb fails cleanly rather than overflowing the stack.
		expect(parseLogQuery('('.repeat(3_999)).ok).toBe(false);
	});

	test('pipe-list limits', () => {
		const aggs = Array.from({ length: LOG_QUERY_LIMITS.maxAggregations + 1 }, (_, i) => `sum(@a${i})`).join(', ');
		expect(error(`| stats ${aggs}`).message).toContain(`At most ${LOG_QUERY_LIMITS.maxAggregations} aggregations`);
		const groups = Array.from({ length: LOG_QUERY_LIMITS.maxGroupBy + 1 }, (_, i) => `@g${i}`).join(', ');
		expect(error(`| stats count() by ${groups}`).message).toContain(`At most ${LOG_QUERY_LIMITS.maxGroupBy} group-by keys`);
	});
});

// ─── Predicate ─────────────────────────────────────────────────────────────────────────────────────

function record(overrides: Partial<LogRecord> = {}): LogRecord {
	return {
		id: 'le:1',
		ts: 1_000,
		observedTs: null,
		orgId: 'org_1',
		scope: { kind: 'project', id: 'prj_1' },
		scopeName: 'api',
		stream: 'deployment:dep_1',
		source: 'runtime',
		channel: 'stdout',
		severityNumber: 9,
		severity: 'info',
		body: 'GET /v1/orders upstream Timeout after 30000ms',
		attributes: { 'http.status': '502', 'http.route': '/v1/orders', duration_ms: '30000.5', user: 'Alice', empty: '' },
		resource: { 'host.name': 'edge-a' },
		traceId: 'abc123',
		spanId: null,
		requestId: 'req_9',
		patternId: 'ff00',
		projectId: 'prj_1',
		deploymentId: 'dep_1',
		buildId: null,
		jobRunId: null,
		nodeId: 'node_1',
		replica: 1,
		...overrides,
	};
}

function matches(query: string, rec: LogRecord = record()): boolean {
	return compileLogPredicate(filter(query))(rec);
}

describe('compileLogPredicate', () => {
	test('null filter matches everything', () => {
		expect(compileLogPredicate(null)(record())).toBe(true);
	});

	test('a bare word is a whole-token match; phrases and punctuated words are substrings', () => {
		expect(matches('timeout')).toBe(true);
		expect(matches('TIMEOUT')).toBe(true);
		expect(matches('TIME')).toBe(false);
		expect(matches('"TIME"')).toBe(true);
		expect(matches('v1')).toBe(true);
		expect(matches('orders')).toBe(true);
		expect(matches('/v1/ord')).toBe(true);
		expect(matches('30000')).toBe(false);
		expect(matches('30000ms')).toBe(true);
		expect(matches('"upstream timeout"')).toBe(true);
		expect(matches('"timeout upstream"')).toBe(false);
		expect(matches('nothing')).toBe(false);
		expect(matches('message:orders')).toBe(true);
	});

	test('level bands', () => {
		const at = (n: number) => record({ severityNumber: n });
		expect(matches('level:warn', at(13))).toBe(true);
		expect(matches('level:warn', at(17))).toBe(true);
		expect(matches('level:warn', at(12))).toBe(false);
		expect(matches('level:=warn', at(16))).toBe(true);
		expect(matches('level:=warn', at(17))).toBe(false);
		expect(matches('level:>warn', at(16))).toBe(false);
		expect(matches('level:>warn', at(17))).toBe(true);
		expect(matches('level:<warn', at(12))).toBe(true);
		expect(matches('level:<warn', at(13))).toBe(false);
		expect(matches('level:<=warn', at(16))).toBe(true);
		expect(matches('level:<=warn', at(17))).toBe(false);
		expect(matches('level:=fatal', at(24))).toBe(true);
		// Unspecified (0) reads as info.
		expect(matches('level:=info', at(0))).toBe(true);
		expect(matches('level:warn', at(0))).toBe(false);
	});

	test('built-in field mapping', () => {
		expect(matches('service:API')).toBe(true);
		expect(matches('scope:project:prj_1')).toBe(true);
		expect(matches('kind:project')).toBe(true);
		expect(matches('project:prj_1')).toBe(true);
		expect(matches('project:api')).toBe(true);
		expect(matches('project:api', record({ scope: { kind: 'database', id: 'db_1' }, projectId: 'prj_1' }))).toBe(false);
		expect(matches('deployment:dep_1')).toBe(true);
		expect(matches('node:node_1')).toBe(true);
		expect(matches('replica:1')).toBe(true);
		expect(matches('replica:0')).toBe(false);
		expect(matches('replica:>0')).toBe(true);
		expect(matches('source:runtime channel:stdout stream:deployment\\:dep_1')).toBe(true);
		expect(matches('stream:"deployment:dep_1"')).toBe(true);
		expect(matches('pattern:FF00 trace:abc123 request:req_9')).toBe(true);
		expect(matches('span:*')).toBe(false);
		expect(matches('build:*')).toBe(false);
	});

	test('attributes and resource', () => {
		expect(matches('@http.status:502')).toBe(true);
		expect(matches('@user:alice')).toBe(true);
		expect(matches('@http.status:>=500')).toBe(true);
		expect(matches('@http.status:<500')).toBe(false);
		expect(matches('@duration_ms:>30000')).toBe(true);
		expect(matches('@duration_ms:<=30000')).toBe(false);
		expect(matches('@user:>1')).toBe(false); // non-numeric → false
		expect(matches('resource.host.name:edge-a')).toBe(true);
		expect(matches('@resource.host.name:EDGE-*')).toBe(true);
		expect(matches('@HTTP.status:502')).toBe(false); // keys are case-sensitive
	});

	test('missing and empty fields are false, true under NOT', () => {
		expect(matches('@missing:x')).toBe(false);
		expect(matches('-@missing:x')).toBe(true);
		expect(matches('@missing:>1')).toBe(false);
		expect(matches('-@missing:>1')).toBe(true);
		expect(matches('@missing:*')).toBe(false);
		expect(matches('-@missing:*')).toBe(true);
		expect(matches('@empty:*')).toBe(false);
		expect(matches('@user:*')).toBe(true);
	});

	test('wildcards are anchored, case-insensitive globs', () => {
		expect(matches('@http.route:/v1/*')).toBe(true);
		expect(matches('@http.route:/V1/*')).toBe(true);
		expect(matches('@http.route:*orders')).toBe(true);
		expect(matches('@http.route:orders*')).toBe(false);
		expect(matches('@http.route:/v1*ord*s')).toBe(true);
		expect(matches('service:a.*')).toBe(false); // `.` is literal
		expect(matches('body:*TIMEOUT*')).toBe(true);
		expect(matches('body:timeout*')).toBe(false);
	});

	test('regex is unanchored and case-sensitive unless (?i)', () => {
		expect(matches('@http.route:/ord(er|ers)/')).toBe(true);
		expect(matches('body:/Timeout after \\d+ms/')).toBe(true);
		expect(matches('body:/timeout/')).toBe(false);
		expect(matches('body:/(?i)timeout/')).toBe(true);
		expect(matches('body:/^GET \\/v1/')).toBe(true);
	});

	test('an invalid regex in a hand-built AST never matches', () => {
		const bad: LogQueryNode = { type: 'field', field: attr('user'), op: 'regex', value: '(' };
		expect(compileLogPredicate(bad)(record())).toBe(false);
		expect(compileLogPredicate({ type: 'not', child: bad })(record())).toBe(true);
		const redos: LogQueryNode = { type: 'field', field: builtin('body'), op: 'regex', value: '(a+)+$' };
		expect(compileLogPredicate(redos)(record({ body: `${'a'.repeat(40)}!` }))).toBe(false);
	});

	test('exact equality is whole-value and case-insensitive', () => {
		expect(matches('service:ap')).toBe(false);
		expect(matches('@user:=ALICE')).toBe(true);
		expect(matches('body:="get /v1/orders upstream timeout after 30000ms"')).toBe(true);
		expect(matches('body:=timeout')).toBe(false);
	});

	test('boolean logic', () => {
		expect(matches('timeout service:api')).toBe(true);
		expect(matches('timeout service:db')).toBe(false);
		expect(matches('nothing OR service:api')).toBe(true);
		expect(matches('-(nothing OR service:db)')).toBe(true);
		expect(matches('NOT timeout')).toBe(false);
		expect(compileLogPredicate({ type: 'and', children: [] })(record())).toBe(true);
		expect(compileLogPredicate({ type: 'or', children: [] })(record())).toBe(false);
	});
});

describe('helpers', () => {
	test('parseLogNumber is strict', () => {
		expect(parseLogNumber('42')).toBe(42);
		expect(parseLogNumber(' -1.5e2 ')).toBe(-150);
		expect(parseLogNumber('.5')).toBe(0.5);
		for (const bad of ['', ' ', '0x10', '1e', 'abc', '1,000', 'Infinity', 'NaN']) expect(parseLogNumber(bad)).toBeNull();
	});

	test('logLevelBounds', () => {
		expect(logLevelBounds('gte', 'warn')).toEqual({ gte: 13 });
		expect(logLevelBounds('eq', 'warn')).toEqual({ gte: 13, lt: 17 });
		expect(logLevelBounds('gt', 'warn')).toEqual({ gte: 17 });
		expect(logLevelBounds('lt', 'warn')).toEqual({ lt: 13 });
		expect(logLevelBounds('lte', 'warn')).toEqual({ lt: 17 });
		expect(logLevelBounds('eq', 'fatal')).toEqual({ gte: 21, lt: 25 });
		expect(logLevelBounds('eq', 'trace')).toEqual({ gte: 1, lt: 5 });
		expect(logLevelBounds('eq', 'nope')).toBeNull();
		expect(logLevelBounds('wildcard', 'warn')).toBeNull();
	});

	test('globs and regex flags', () => {
		expect(splitLogGlob('/api/*/x*')).toEqual(['/api/', '/x', '']);
		expect(logGlobToRegExp('a.b*').test('A.Bcd')).toBe(true);
		expect(logGlobToRegExp('a.b*').test('axb')).toBe(false);
		expect(logGlobToRegExp('a*').test('a\nb')).toBe(true);
		expect(logRegexSource('(?i)x')).toEqual({ source: 'x', flags: 'i' });
		expect(logRegexSource('(?is)x')).toEqual({ source: 'x', flags: 'is' });
		expect(logRegexSource('x(?i)')).toEqual({ source: 'x(?i)', flags: '' });
	});

	test('field names and values', () => {
		expect(parseLogFieldName('Message')).toEqual(builtin('body'));
		expect(parseLogFieldName('@resource.a')).toEqual({ kind: 'resource', key: 'a' });
		expect(parseLogFieldName('nope')).toBeNull();
		expect(parseLogFieldName('@')).toBeNull();
		expect(logFieldValues(record(), builtin('level'))).toEqual([9]);
		expect(logFieldValues(record(), builtin('project'))).toEqual(['prj_1', 'api']);
		expect(logFieldValues(record(), attr('empty'))).toEqual([]);
	});
});

describe('requiredLogFeatures', () => {
	const features = (q: string) => requiredLogFeatures(ast(q));
	test('lite-safe queries need nothing', () => {
		expect(features('')).toEqual([]);
		expect(features('level:error service:api -timeout deployment:x* replica:>0')).toEqual([]);
		expect(features('| sort ts desc | limit 10')).toEqual([]);
	});
	test('each feature', () => {
		expect(features('@x:1')).toEqual(['attributes']);
		expect(features('-resource.host.name:*')).toEqual(['attributes']);
		expect(features('body:/x/')).toEqual(['regex']);
		expect(features('| stats count() by bin(5m)')).toEqual(['stats']);
		expect(features('| dedup body')).toEqual(['stats']);
		expect(features('| fields level')).toEqual(['stats']);
		expect(features('| patterns')).toEqual(['patterns']);
		expect(features('pattern:abc')).toEqual(['patterns']);
		expect(features('| sort @x')).toEqual(['attributes']);
		expect(features('| stats count() by @http.route')).toEqual(['attributes', 'stats']);
		expect(features('@m:/x/ | stats count() by pattern')).toEqual(['attributes', 'regex', 'stats', 'patterns']);
		// A stats alias that looks like an attribute does not count twice; the group already did.
		expect(features('| stats count() by level | sort count desc')).toEqual(['stats']);
	});
});

// ─── Round trips ───────────────────────────────────────────────────────────────────────────────────

function roundTrip(query: string): void {
	const first = ast(query);
	const formatted = formatLogQuery(first);
	const second = parseLogQuery(formatted);
	if (!second.ok) throw new Error(`canonical ${JSON.stringify(formatted)} of ${JSON.stringify(query)} failed: ${second.error.message}`);
	expect(second.ast).toEqual(first);
	expect(formatLogQuery(second.ast)).toBe(formatted);
}

describe('formatLogQuery', () => {
	test('canonical forms', () => {
		const canon = (q: string) => formatLogQuery(ast(q));
		expect(canon('NOT  a   AND b')).toBe('-a b');
		expect(canon('Level:WARNING')).toBe('level:warn');
		expect(canon('level:=17')).toBe('level:=error');
		expect(canon('@x:>=5.0')).toBe('@x:>=5');
		expect(canon('(a OR b) c')).toBe('(a OR b) c');
		expect(canon('a OR (b c)')).toBe('a OR b c');
		expect(canon('-(a b)')).toBe('-(a b)');
		expect(canon('@p:"/a/"')).toBe('@p:"/a/"');
		expect(canon('@p:"a b"')).toBe('@p:"a b"');
		expect(canon('@p:=x*')).toBe('@p:"x*"');
		expect(canon('@p:"=x"')).toBe('@p:"=x"');
		expect(canon('message:x')).toBe('x');
		expect(canon('@resource.a:b')).toBe('resource.a:b');
		expect(canon('| stats COUNT(*) by BIN(60s)')).toBe('| stats count() by bin(1m)');
		expect(canon('| stats p95(@d) as p by level as lv | sort p')).toBe('| stats p95(@d) as p by level as lv | sort p asc');
		expect(canon('x | limit 5')).toBe('x | limit 5');
	});

	test('hand-built ASTs format to equivalent queries', () => {
		const tricky: LogQueryNode[] = [
			text('OR'),
			text('-v'),
			text('@home'),
			text('a b(c)|"d"'),
			text('http://x'),
			text('back\\slash'),
			{ type: 'field', field: attr('k'), op: 'wildcard', value: '>a* b' },
			{ type: 'field', field: attr('k'), op: 'wildcard', value: '/a/*/' },
			{ type: 'field', field: attr('k'), op: 'wildcard', value: '/x/' + '*' },
			{ type: 'field', field: attr('k'), op: 'regex', value: 'a/b\\/c' },
			{ type: 'field', field: attr('k'), op: 'eq', value: 'quote " and \\' },
			{ type: 'and', children: [text('a'), { type: 'and', children: [text('b'), text('c')] }] },
			{ type: 'or', children: [text('a'), { type: 'or', children: [text('b'), text('c')] }] },
		];
		const rec = record({ body: 'OR -v @home a b(c)|"d" http://x back\\slash', attributes: { k: '>a1 b' } });
		for (const node of tricky) {
			const formatted = formatLogFilter(node);
			const reparsed = parseLogQuery(formatted);
			if (!reparsed.ok) throw new Error(`${JSON.stringify(node)} → ${formatted}: ${reparsed.error.message}`);
			expect(compileLogPredicate(reparsed.ast.filter)(rec)).toBe(compileLogPredicate(node)(rec));
		}
		expect(formatLogFilter(text('OR'))).toBe('"OR"');
		expect(formatLogFilter(text('http://x'))).toBe('http\\://x');
		expect(filter(formatLogFilter({ type: 'field', field: attr('k'), op: 'wildcard', value: '/x/*' }))).toEqual({
			type: 'field',
			field: attr('k'),
			op: 'wildcard',
			value: '/x/*',
		});
	});

	test('a corpus round-trips exactly', () => {
		const corpus = [
			'timeout',
			'"connection reset"',
			'level:error service:api -@path:/health "timeout"',
			'level:=warn level:>info level:<debug level:<=fatal',
			'@http.status:>=500 @d:<1.5 replica:>0 replica:2',
			'@user.id:123 @path:/api/*',
			'@msg:/time(out|d out)/ body:/^GET \\/api/',
			'-@path:/health NOT a',
			'a OR b c',
			'(a OR b) (c OR -d)',
			'-(a OR b)',
			'--x',
			'foo\\ bar http\\://x \\-v "OR" \\OR \\@me',
			'"say \\"hi\\""',
			'resource.host.name:edge-a @resource.k:v',
			'body:=x body:*x* body:* trace:*',
			'scope:project:prj_1',
			'@p:"/health/" @p:"a*" @q:"<5"',
			'| fields ts, level, @http.status, body',
			'| stats count() by bin(5m), level',
			'| stats p95(@duration_ms) by @http.route | sort p95 desc | limit 10',
			'| stats count() as n, avg(@d) as mean by bin(90s) as t, source as s | sort t asc',
			'| patterns | sort count desc | limit 20',
			'| dedup body | sort count desc',
			'| sort ts asc | limit 500',
			'x | fields level | dedup body | sort @x desc | limit 3',
		];
		for (const q of corpus) roundTrip(q);
	});
});

// Seeded PRNG so failures reproduce.
function rng(seed: number) {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
	return {
		next,
		int: (n: number) => Math.floor(next() * n),
		pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
	};
}

const CHARS = ['a', 'b', 'Z', '1', ' ', '"', '\\', '*', '(', ')', '|', ':', '/', '-', '@', '>', '<', '=', '.', '\t', 'é'];

describe('property: generated ASTs round-trip', () => {
	const r = rng(20261125);
	const str = (min = 1, max = 8) => {
		let s = '';
		const n = min + r.int(max - min + 1);
		for (let i = 0; i < n; i++) s += r.pick(CHARS);
		return s;
	};
	const stringFields = ['service', 'scope', 'kind', 'project', 'deployment', 'build', 'job', 'node', 'source', 'stream', 'channel', 'pattern', 'trace', 'span', 'request'];
	const anyRef = (): LogFieldRef => {
		const roll = r.int(3);
		if (roll === 0) return builtin(r.pick(stringFields));
		if (roll === 1) return attr(r.pick(['http.status', 'k', 'user-agent', 'a_b.c']));
		return { kind: 'resource', key: r.pick(['host.name', 'k8s.pod']) };
	};
	const glob = () => {
		const s = str(0, 5).replace(/\*/g, '');
		const at = r.int(s.length + 1);
		const g = `${s.slice(0, at)}*${s.slice(at)}`;
		return g === '*' ? '*x' : g;
	};
	const leaf = (): LogQueryNode => {
		switch (r.int(9)) {
			case 0:
				return text(str(), true);
			case 1:
				return text(str(), false);
			case 2:
				return { type: 'field', field: builtin('level'), op: r.pick(['eq', 'gte', 'gt', 'lt', 'lte'] as const), value: r.pick(['trace', 'debug', 'info', 'warn', 'error', 'fatal']) };
			case 3:
				return { type: 'field', field: anyRef(), op: 'eq', value: str() };
			case 4:
				return { type: 'field', field: r.next() < 0.2 ? builtin('body') : anyRef(), op: 'wildcard', value: glob() };
			case 5:
				return { type: 'field', field: r.next() < 0.3 ? builtin('body') : anyRef(), op: 'regex', value: r.pick(['a/b', 'time(out|d out)', '(?i)err', '^GET /api', '\\d+ms', 'x\\\\']) };
			case 6: {
				const ref = r.next() < 0.3 ? builtin('replica') : attr('n');
				return { type: 'field', field: ref, op: r.pick(['gt', 'gte', 'lt', 'lte'] as const), value: r.pick([0, 1, -2, 3.5, 1e21]) };
			}
			case 7:
				return { type: 'exists', field: r.next() < 0.2 ? builtin('replica') : anyRef() };
			default:
				return r.next() < 0.5
					? { type: 'field', field: builtin('replica'), op: 'eq', value: 3 }
					: { type: 'field', field: builtin('body'), op: 'eq', value: str() };
		}
	};
	const node = (depth: number): LogQueryNode => {
		if (depth <= 0 || r.next() < 0.35) return leaf();
		const roll = r.int(3);
		if (roll === 0) return { type: 'not', child: node(depth - 1) };
		const type = roll === 1 ? 'and' : 'or';
		const children: LogQueryNode[] = [];
		const n = 2 + r.int(3);
		for (let i = 0; i < n; i++) {
			let child = node(depth - 1);
			while (child.type === type) child = node(depth - 1);
			children.push(child);
		}
		return { type, children };
	};
	const pipes = (): LogPipeStage[] => {
		const out: LogPipeStage[] = [];
		const shape = r.int(4);
		if (shape === 0) out.push({ type: 'fields', fields: [anyRef(), builtin('level')] });
		if (shape === 0 && r.next() < 0.5) out.push({ type: 'dedup', field: anyRef() });
		if (shape === 1) out.push({ type: 'patterns' });
		if (shape === 2) {
			out.push({
				type: 'stats',
				aggregations: [
					{ fn: 'count', alias: r.next() < 0.5 ? 'count' : 'n' },
					{ fn: 'p95', field: attr('d'), alias: 'p95(@d)' },
					{ fn: 'count_distinct', field: anyRef(), alias: 'uniq' },
				],
				by: [{ type: 'bin', intervalMs: r.pick([1_000, 90_000, 300_000, 86_400_000, 1_500]), alias: r.next() < 0.5 ? 't' : 'BIN' }],
			});
			out.push({ type: 'sort', key: r.pick(['p95(@d)', 'uniq', 't', 'BIN']), direction: r.pick(['asc', 'desc'] as const) });
			const statsStage = out[0] as Extract<LogPipeStage, { type: 'stats' }>;
			const sort = out[1] as Extract<LogPipeStage, { type: 'sort' }>;
			const aliases = [...statsStage.by.map((g) => g.alias), ...statsStage.aggregations.map((a) => a.alias)];
			if (!aliases.includes(sort.key)) out.pop();
		}
		if (shape === 1 && r.next() < 0.5) out.push({ type: 'sort', key: r.pick(['count', 'template', 'pattern']), direction: 'desc' });
		if (shape === 3 && r.next() < 0.5) out.push({ type: 'sort', key: r.pick(['ts', 'level', '@k', 'resource.host.name']), direction: 'asc' });
		if (r.next() < 0.5) out.push({ type: 'limit', count: 1 + r.int(LOG_QUERY_LIMITS.maxLimit) });
		return out;
	};

	test('2,000 random ASTs: parse(format(ast)) === ast', () => {
		for (let i = 0; i < 2_000; i++) {
			const generated: LogQueryAst = { filter: r.next() < 0.1 ? null : node(4), pipes: pipes() };
			// Normalise the generator's shapes the parser canonicalises: `body:x` eq from bare text is a
			// text node; that is fine because the generator only emits body eq for `:=`.
			const formatted = formatLogQuery(generated);
			const parsed = parseLogQuery(formatted);
			if (!parsed.ok) throw new Error(`#${i} ${JSON.stringify(formatted)}: ${JSON.stringify(parsed.error)}\n${JSON.stringify(generated)}`);
			expect(parsed.ast).toEqual(generated);
		}
	});
});

describe('property: fuzzed text never throws and canonicalises', () => {
	const TOKENS = [
		'a', 'b', 'OR', 'AND', 'NOT', '-', '(', ')', '"x y"', '"', '\\', '|', ' ', ' ', ' ', 'level:', 'warn', '@k:', 'service:',
		'*', '>=', '5', '/', 're/', ':', 'stats', 'count()', 'by', 'bin(5m)', 'sort', 'limit', '10', ',', 'fields', 'patterns', 'dedup',
		'body', 'replica:', '=', 'resource.x:', 'p95(@d)', 'as', 'n', 'desc',
	];
	test('5,000 random inputs', () => {
		const r = rng(42);
		let ok = 0;
		for (let i = 0; i < 5_000; i++) {
			let q = '';
			const n = 1 + r.int(14);
			for (let j = 0; j < n; j++) q += r.pick(TOKENS);
			let result: ReturnType<typeof parseLogQuery>;
			try {
				result = parseLogQuery(q);
			} catch (thrown) {
				throw new Error(`parseLogQuery threw on ${JSON.stringify(q)}: ${thrown}`);
			}
			if (!result.ok) {
				expect(result.error.start).toBeGreaterThanOrEqual(0);
				expect(result.error.end).toBeGreaterThanOrEqual(result.error.start);
				expect(result.error.end).toBeLessThanOrEqual(q.length);
				continue;
			}
			ok++;
			const formatted = formatLogQuery(result.ast);
			const again = parseLogQuery(formatted);
			if (!again.ok) throw new Error(`canonical ${JSON.stringify(formatted)} of ${JSON.stringify(q)} failed: ${again.error.message}`);
			expect(again.ast).toEqual(result.ast);
			expect(formatLogQuery(again.ast)).toBe(formatted);
		}
		expect(ok).toBeGreaterThan(500);
	});
});
