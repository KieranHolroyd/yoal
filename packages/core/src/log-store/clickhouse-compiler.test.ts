import { describe, expect, test } from 'bun:test';
import type { LogPipeStage, LogQueryNode } from '@yoal/contracts';
import { ValidationError } from '../errors.ts';
import {
	SqlParams,
	boundarySql,
	compileBuiltinFacets,
	compileBuiltinSparklines,
	compileContext,
	compileCount,
	compileGet,
	compileHistogram,
	compileMapFacets,
	compileMapKeys,
	compileMapSparklines,
	compileSearch,
	compileTable,
	decodeSearchCursor,
	encodeSearchCursor,
	escapeParamString,
	filterSql,
	globToLike,
	innerTokens,
	parseFieldName,
	pickHistogramInterval,
	type ClickHouseCompileOptions,
	type CompiledLogQuery,
} from './clickhouse-compiler.ts';
import type { LogReadBoundary, LogStoreRead } from './types.ts';

const boundary: LogReadBoundary = { orgId: 'org_1', scopes: [{ kind: 'project', id: 'prj_1' }], crossOrg: false };
const TEXT: ClickHouseCompileOptions = { textIndex: 'text' };
const TOKENBF: ClickHouseCompileOptions = { textIndex: 'tokenbf' };
const NONE: ClickHouseCompileOptions = { textIndex: null };

function read(filter: LogQueryNode | null = null, pipes: LogPipeStage[] = [], scope = boundary): LogStoreRead {
	return { boundary: scope, ast: { filter, pipes }, from: 1_000, to: 2_000 };
}

function frag(node: LogQueryNode, options: ClickHouseCompileOptions = TEXT): { sql: string; params: Record<string, unknown> } {
	const params = new SqlParams();
	return { sql: filterSql(node, params, options), params: params.values };
}

const TENANCY = '(org_id = {p0:String} AND ((scope_kind = {p1:String} AND scope_id IN {p2:Array(String)})))';

const field = (name: string, op: 'eq' | 'wildcard' | 'regex' | 'gt' | 'gte' | 'lt' | 'lte', value: string | number): LogQueryNode => ({
	type: 'field',
	field: name.startsWith('@')
		? { kind: 'attribute', key: name.slice(1) }
		: name.startsWith('resource.')
			? { kind: 'resource', key: name.slice(9) }
			: { kind: 'builtin', name: name as never },
	op,
	value,
});

/** Every statement must carry the tenancy clause with this org and scope as parameters. */
function expectTenancy(compiled: CompiledLogQuery, org = 'org_1', scope = 'prj_1'): void {
	expect(compiled.sql).toMatch(/org_id = \{p\d+:String\}/);
	expect(compiled.sql).toMatch(/scope_id IN \{p\d+:Array\(String\)\}/);
	const values = Object.values(compiled.params);
	expect(values).toContain(org);
	expect(values).toContainEqual([scope]);
}

describe('tenancy', () => {
	test('scopes are grouped by kind and ANDed with the org', () => {
		const params = new SqlParams();
		const sql = boundarySql(
			{
				orgId: 'org_1',
				scopes: [
					{ kind: 'project', id: 'a' },
					{ kind: 'database', id: 'd' },
					{ kind: 'project', id: 'b' },
				],
				crossOrg: false,
			},
			params,
		);
		expect(sql).toBe(
			'(org_id = {p0:String} AND ((scope_kind = {p1:String} AND scope_id IN {p2:Array(String)}) OR (scope_kind = {p3:String} AND scope_id IN {p4:Array(String)})))',
		);
		expect(params.values).toEqual({ p0: 'org_1', p1: 'project', p2: ['a', 'b'], p3: 'database', p4: ['d'] });
	});

	test('an empty boundary is nothing, never everything', () => {
		expect(boundarySql({ orgId: 'org_1', scopes: [], crossOrg: true }, new SqlParams())).toBe('0');
		expect(compileSearch(read(null, [], { orgId: 'org_1', scopes: [], crossOrg: false }), { limit: 10, order: 'desc' }, TEXT).sql).toContain('WHERE 0 AND');
	});

	test('cross-org reads drop the org only for platform and edge scopes', () => {
		const params = new SqlParams();
		const sql = boundarySql(
			{
				orgId: 'org_1',
				scopes: [
					{ kind: 'platform', id: 'node_1' },
					{ kind: 'project', id: 'p' },
					{ kind: 'edge', id: 'e' },
				],
				crossOrg: true,
			},
			params,
		);
		expect(sql).toBe(
			'((org_id = {p0:String} AND ((scope_kind = {p1:String} AND scope_id IN {p2:Array(String)}))) OR ((scope_kind = {p3:String} AND scope_id IN {p4:Array(String)}) OR (scope_kind = {p5:String} AND scope_id IN {p6:Array(String)})))',
		);
		expect(params.values.p1).toBe('project');
		expect(params.values.p3).toBe('platform');
		expect(params.values.p5).toBe('edge');
		// Without crossOrg, platform scopes stay inside the org.
		const scoped = new SqlParams();
		expect(boundarySql({ orgId: 'o', scopes: [{ kind: 'platform', id: 'n' }], crossOrg: false }, scoped)).toBe(
			'(org_id = {p0:String} AND ((scope_kind = {p1:String} AND scope_id IN {p2:Array(String)})))',
		);
	});

	test('every compiled statement carries the boundary', () => {
		const r = read({ type: 'text', value: 'x', phrase: false }, [{ type: 'patterns' }]);
		const anchor = { ts: 1_500, id: 'le:1', scopeKind: 'project', scopeId: 'prj_1', stream: 'deployment:d' };
		const statements: CompiledLogQuery[] = [
			compileSearch(r, { limit: 10, order: 'desc' }, TEXT),
			compileGet(boundary, 'le:1'),
			compileContext(boundary, anchor, 'before', 5),
			compileContext(boundary, anchor, 'after', 5),
			compileHistogram(r, 60_000, TEXT),
			compileCount(r, TEXT),
			compileBuiltinFacets(r, ['level', 'service'], 5, TEXT),
			compileBuiltinSparklines(r, ['level'], 60_000, TEXT),
			compileMapKeys(r, 'attributes', 30, TEXT),
			compileMapFacets(r, 'attributes', ['http.status'], 5, TEXT),
			compileMapSparklines(r, 'resource', ['host.name'], 60_000, TEXT),
			compileTable(r, TEXT),
			compileTable(read(null, [{ type: 'stats', aggregations: [{ fn: 'count', alias: 'count' }], by: [] }]), TEXT),
			compileTable(read(null, [{ type: 'dedup', field: { kind: 'builtin', name: 'body' } }]), TEXT),
		];
		for (const statement of statements) expectTenancy(statement);
		// The patterns join reads log_patterns under the same boundary.
		expect(compileTable(r, TEXT).sql.match(/org_id = /g)).toHaveLength(2);
	});

	test('user text never reaches the SQL', () => {
		const evil = "x' OR 1=1 --";
		const compiled = compileSearch(
			read({
				type: 'and',
				children: [
					{ type: 'text', value: evil, phrase: true },
					field('@' + evil, 'eq', evil),
					field('deployment', 'wildcard', evil),
					field('body', 'regex', evil),
				],
			}),
			{ limit: 10, order: 'desc' },
			TEXT,
		);
		expect(compiled.sql).not.toContain('OR 1=1');
		expect(compiled.sql).not.toContain("'x");
	});
});

describe('filters', () => {
	test('a bare word is an index-backed, case-insensitive token match', () => {
		expect(frag({ type: 'text', value: 'Timeout', phrase: false })).toEqual({ sql: 'hasToken(body, {p0:String})', params: { p0: 'timeout' } });
		expect(frag({ type: 'text', value: 'Timeout', phrase: false }, TOKENBF)).toEqual({
			sql: 'hasTokenCaseInsensitive(body, {p0:String})',
			params: { p0: 'timeout' },
		});
		// Without an index (or when configured), it is a substring.
		expect(frag({ type: 'text', value: 'Timeout', phrase: false }, NONE)).toEqual({
			sql: 'positionCaseInsensitive(body, {p0:String}) > 0',
			params: { p0: 'Timeout' },
		});
		expect(frag({ type: 'text', value: 'timeout', phrase: false }, { textIndex: 'text', bareWordMatch: 'substring' })).toEqual({
			sql: 'body ILIKE {p0:String}',
			params: { p0: '%timeout%' },
		});
	});

	test('phrases and punctuated words are substrings; LIKE metacharacters are literal', () => {
		expect(frag({ type: 'text', value: 'connection reset', phrase: true })).toEqual({ sql: 'body ILIKE {p0:String}', params: { p0: '%connection reset%' } });
		expect(frag({ type: 'text', value: '100%_done*', phrase: false })).toEqual({ sql: 'body ILIKE {p0:String}', params: { p0: '%100\\\\%\\\\_done*%' } });
		expect(frag({ type: 'text', value: 'a.b', phrase: false }, NONE).sql).toBe('positionCaseInsensitive(body, {p0:String}) > 0');
	});

	test('with tokenbf, whole words inside a phrase pre-filter the substring', () => {
		expect(innerTokens('upstream connect error or reset')).toEqual(['connect', 'error', 'or']);
		expect(innerTokens('GET /api/v1 500')).toEqual(['api', 'v1']);
		expect(frag({ type: 'text', value: 'upstream connect error', phrase: true }, TOKENBF)).toEqual({
			sql: 'hasTokenCaseInsensitive(body, {p1:String}) AND positionCaseInsensitive(body, {p0:String}) > 0',
			params: { p0: 'upstream connect error', p1: 'connect' },
		});
		expect(frag({ type: 'text', value: 'two words', phrase: true }, TOKENBF).sql).toBe('positionCaseInsensitive(body, {p0:String}) > 0');
	});

	test('level compares by severity band', () => {
		expect(frag(field('level', 'gte', 'warn'))).toEqual({ sql: 'severity_number >= {p0:Int64}', params: { p0: 13 } });
		expect(frag(field('level', 'eq', 'warn'))).toEqual({
			sql: '(severity_number >= {p0:Int64} AND severity_number < {p1:Int64})',
			params: { p0: 13, p1: 17 },
		});
		expect(frag(field('level', 'gt', 'warning')).params).toEqual({ p0: 17 });
		expect(frag(field('level', 'lt', 'error')).sql).toBe('severity_number < {p0:Int64}');
		expect(frag(field('level', 'lte', 'info')).params).toEqual({ p0: 13 });
		expect(frag(field('level', 'eq', 'fatal')).params).toEqual({ p0: 21, p1: 25 });
		expect(frag(field('level', 'eq', 'trace')).params).toEqual({ p0: 1, p1: 5 });
		expect(frag(field('level', 'eq', 14)).params).toEqual({ p0: 13, p1: 17 });
		expect(frag(field('level', 'wildcard', 'err*'))).toEqual({ sql: '(1 AND severity_text ILIKE {p0:String})', params: { p0: 'err%' } });
		expect(() => frag(field('level', 'eq', 'loud'))).toThrow(ValidationError);
	});

	test('string fields: case-insensitive equality where values are free text, exact for ids', () => {
		expect(frag(field('@user.name', 'eq', 'Bob'))).toEqual({ sql: 'lower(attributes[{p0:String}]) = {p1:String}', params: { p0: 'user.name', p1: 'bob' } });
		expect(frag(field('resource.host.name', 'eq', 'Edge-B'))).toEqual({
			sql: 'lower(resource[{p0:String}]) = {p1:String}',
			params: { p0: 'host.name', p1: 'edge-b' },
		});
		expect(frag(field('service', 'eq', 'API')).sql).toBe("lower(resource['service.name']) = {p0:String}");
		expect(frag(field('deployment', 'eq', 'dep_X'))).toEqual({ sql: 'deployment_id = {p0:String}', params: { p0: 'dep_X' } });
		expect(frag(field('request', 'eq', 'Req-1')).sql).toBe('request_id = {p0:String}');
		expect(frag(field('trace', 'eq', 'ABC'))).toEqual({ sql: 'trace_id = {p0:String}', params: { p0: 'abc' } });
		expect(frag(field('source', 'eq', 'Runtime')).params).toEqual({ p0: 'runtime' });
		expect(frag(field('kind', 'eq', 'project')).sql).toBe('scope_kind = {p0:String}');
		expect(frag(field('pattern', 'eq', 'AB12')).sql).toBe('pattern_id = {p0:String}');
		expect(frag(field('stream', 'eq', 'pod:ns/p/c')).sql).toBe('stream = {p0:String}');
		expect(frag(field('channel', 'eq', 'stderr')).sql).toBe('channel = {p0:String}');
		expect(frag(field('build', 'eq', 'b')).sql).toBe('build_id = {p0:String}');
		expect(frag(field('job', 'eq', 'j')).sql).toBe('job_run_id = {p0:String}');
		expect(frag(field('span', 'eq', 'S')).sql).toBe('span_id = {p0:String}');
		expect(frag(field('body', 'eq', 'Exact')).sql).toBe('lower(body) = {p0:String}');
	});

	test('project, node and scope have their special forms', () => {
		expect(frag(field('project', 'eq', 'API'))).toEqual({
			sql: "(project_id = {p0:String} OR (scope_kind IN ('project', 'function') AND lower(resource['service.name']) = {p1:String}))",
			params: { p0: 'API', p1: 'api' },
		});
		expect(frag(field('node', 'eq', 'Edge-B'))).toEqual({
			sql: "(node_id = {p0:String} OR lower(resource['host.name']) = {p1:String})",
			params: { p0: 'Edge-B', p1: 'edge-b' },
		});
		expect(frag(field('scope', 'eq', 'Database:db_1'))).toEqual({
			sql: '(scope_kind = {p0:String} AND scope_id = {p1:String})',
			params: { p0: 'database', p1: 'db_1' },
		});
		expect(frag(field('scope', 'eq', 'db_1')).sql).toBe('scope_id = {p0:String}');
	});

	test('numeric compares are null-safe so a missing field matches under NOT', () => {
		expect(frag(field('@http.status', 'gte', 500))).toEqual({
			sql: 'ifNull(toFloat64OrNull(attributes[{p0:String}]) >= {p1:Float64}, 0)',
			params: { p0: 'http.status', p1: 500 },
		});
		expect(frag(field('@duration_ms', 'lt', '1.5e3')).params.p1).toBe(1500);
		expect(frag({ type: 'not', child: field('@http.status', 'gte', 500) }).sql).toBe(
			'NOT (ifNull(toFloat64OrNull(attributes[{p0:String}]) >= {p1:Float64}, 0))',
		);
		// A non-numeric bound compares as text, on rows that carry the field.
		expect(frag(field('@day', 'gt', '2026-01-01')).sql).toBe('(mapContains(attributes, {p0:String}) AND attributes[{p0:String}] > {p1:String})');
	});

	test('replica is a number and missing means -1', () => {
		expect(frag(field('replica', 'eq', 1))).toEqual({ sql: 'replica = {p0:Float64}', params: { p0: 1 } });
		expect(frag(field('replica', 'lt', 2)).sql).toBe('(replica >= 0 AND replica < {p0:Float64})');
		expect(frag(field('replica', 'eq', 'x')).sql).toBe('0');
		expect(frag({ type: 'exists', field: { kind: 'builtin', name: 'replica' } }).sql).toBe('replica >= 0');
	});

	test('wildcards are ILIKE behind a presence check; globs escape LIKE metacharacters', () => {
		expect(globToLike('/api/*_v?')).toBe('/api/%\\_v_');
		expect(frag(field('@path', 'wildcard', '/api/*'))).toEqual({
			sql: '(mapContains(attributes, {p0:String}) AND attributes[{p0:String}] ILIKE {p1:String})',
			params: { p0: 'path', p1: '/api/%' },
		});
		expect(frag(field('deployment', 'wildcard', 'dep_*')).sql).toBe("(deployment_id != '' AND deployment_id ILIKE {p0:String})");
	});

	test('regexes are parameters, guarded by presence; invalid ones never match; long ones are refused', () => {
		expect(frag(field('@msg', 'regex', 'time(out|d out)'))).toEqual({
			sql: '(mapContains(attributes, {p0:String}) AND match(attributes[{p0:String}], {p1:String}))',
			params: { p0: 'msg', p1: 'time(out|d out)' },
		});
		expect(frag(field('body', 'regex', '(')).sql).toBe('0');
		expect(() => frag(field('body', 'regex', 'a'.repeat(600)))).toThrow('limited to 512');
	});

	test('exists and boolean structure', () => {
		expect(frag({ type: 'exists', field: { kind: 'attribute', key: 'user.id' } })).toEqual({
			sql: 'mapContains(attributes, {p0:String})',
			params: { p0: 'user.id' },
		});
		expect(frag({ type: 'exists', field: { kind: 'builtin', name: 'trace' } }).sql).toBe("trace_id != ''");
		expect(frag({ type: 'exists', field: { kind: 'builtin', name: 'level' } }).sql).toBe('1');
		const tree = frag({
			type: 'or',
			children: [
				{ type: 'and', children: [{ type: 'text', value: 'a', phrase: false }, { type: 'not', child: { type: 'text', value: 'b', phrase: false } }] },
				field('level', 'gte', 'error'),
			],
		});
		expect(tree.sql).toBe('((hasToken(body, {p0:String})) AND (NOT (hasToken(body, {p1:String})))) OR (severity_number >= {p2:Int64})');
		expect(frag({ type: 'and', children: [] }).sql).toBe('1');
		expect(frag({ type: 'or', children: [] }).sql).toBe('0');
	});

	test('string parameters are escaped for the HTTP param format', () => {
		expect(escapeParamString('a\tb\\c\nd')).toBe('a\\tb\\\\c\\nd');
		expect(frag(field('@k', 'eq', 'tab\there')).params.p1).toBe('tab\\there');
	});
});

describe('search, get and context', () => {
	test('search: tenancy, time, filter, keyset order and one extra row', () => {
		const compiled = compileSearch(read({ type: 'text', value: 'boom', phrase: false }), { limit: 50, order: 'desc' }, TEXT);
		expect(compiled.sql).toBe(
			[
				'SELECT id, toUnixTimestamp64Milli(ts) AS ts_ms, toUnixTimestamp64Milli(observed_ts) AS observed_ms, org_id, scope_kind, scope_id, stream, source, channel, severity_number, body, attributes, resource, trace_id, span_id, request_id, pattern_id, project_id, deployment_id, build_id, job_run_id, node_id, replica',
				'FROM logs',
				`WHERE ${TENANCY} AND ts >= fromUnixTimestamp64Milli({p3:Int64}, 'UTC') AND ts <= fromUnixTimestamp64Milli({p4:Int64}, 'UTC') AND (hasToken(body, {p5:String}))`,
				'ORDER BY ts DESC, id DESC',
				'LIMIT {p6:Int64}',
			].join('\n'),
		);
		expect(compiled.params).toEqual({ p0: 'org_1', p1: 'project', p2: ['prj_1'], p3: 1_000, p4: 2_000, p5: 'boom', p6: 51 });
		expect(compiled.limit).toBe(50);
	});

	test('cursors page older (desc) and newer (asc) by (ts, id)', () => {
		const cursor = encodeSearchCursor({ ts: 1_500, id: 'le:9' });
		expect(decodeSearchCursor(cursor)).toEqual({ ts: 1_500, id: 'le:9' });
		const older = compileSearch(read(), { limit: 10, cursor, order: 'desc' }, TEXT);
		expect(older.sql).toContain("(ts, id) < (fromUnixTimestamp64Milli({p5:Int64}, 'UTC'), {p6:String})");
		expect(older.params).toMatchObject({ p5: 1_500, p6: 'le:9' });
		const newer = compileSearch(read(), { limit: 10, cursor, order: 'asc' }, TEXT);
		expect(newer.sql).toContain('(ts, id) > (');
		expect(newer.sql).toContain('ORDER BY ts ASC, id ASC');
		expect(() => decodeSearchCursor('garbage')).toThrow(ValidationError);
		expect(() => decodeSearchCursor('ch1.' + Buffer.from('{"x":1}').toString('base64url'))).toThrow(ValidationError);
		// Limits are clamped.
		expect(compileSearch(read(), { limit: 100_000, order: 'desc' }, TEXT).limit).toBe(1_000);
	});

	test('get and context stay inside the boundary', () => {
		expect(compileGet(boundary, 'le:1').sql).toBe(
			`SELECT id, toUnixTimestamp64Milli(ts) AS ts_ms, toUnixTimestamp64Milli(observed_ts) AS observed_ms, org_id, scope_kind, scope_id, stream, source, channel, severity_number, body, attributes, resource, trace_id, span_id, request_id, pattern_id, project_id, deployment_id, build_id, job_run_id, node_id, replica\nFROM logs\nWHERE ${TENANCY} AND id = {p3:String}\nLIMIT 1`,
		);
		const before = compileContext(boundary, { ts: 5_000, id: 'le:5', scopeKind: 'project', scopeId: 'prj_1', stream: 'deployment:d' }, 'before', 3);
		expect(before.sql).toContain('stream = {p5:String}');
		expect(before.sql).toContain('(ts, id) < (');
		expect(before.sql).toContain('ORDER BY ts DESC, id DESC');
		const noStream = compileContext(boundary, { ts: 5_000, id: 'le:5', scopeKind: 'project', scopeId: 'prj_1', stream: null }, 'after', 3);
		expect(noStream.sql).not.toContain('stream =');
		expect(noStream.sql).toContain('ORDER BY ts ASC, id ASC');
	});
});

describe('pipe stages', () => {
	test('stats with bin(), a field group and every aggregation', () => {
		const http = { kind: 'attribute' as const, key: 'duration_ms' };
		const compiled = compileTable(
			read(field('level', 'gte', 'warn'), [
				{
					type: 'stats',
					aggregations: [
						{ fn: 'count', alias: 'count' },
						{ fn: 'count_distinct', field: { kind: 'builtin', name: 'deployment' }, alias: 'deploys' },
						{ fn: 'sum', field: http, alias: 'sum' },
						{ fn: 'avg', field: http, alias: 'avg' },
						{ fn: 'min', field: http, alias: 'min' },
						{ fn: 'max', field: http, alias: 'max' },
						{ fn: 'p50', field: http, alias: 'p50' },
						{ fn: 'p99', field: http, alias: 'p99' },
					],
					by: [
						{ type: 'bin', intervalMs: 300_000, alias: 'bin(5m)' },
						{ type: 'field', field: { kind: 'builtin', name: 'level' }, alias: 'level' },
					],
				},
			]),
			TEXT,
		);
		expect(compiled.sql).toBe(
			[
				'SELECT intDiv(toUnixTimestamp64Milli(ts), {p6:Int64}) * {p6:Int64} AS c0, severity_text AS c1, count() AS c2, uniqIf(deployment_id, deployment_id != \'\') AS c3, sum(toFloat64OrNull(attributes[{p7:String}])) AS c4, avg(toFloat64OrNull(attributes[{p8:String}])) AS c5, min(toFloat64OrNull(attributes[{p9:String}])) AS c6, max(toFloat64OrNull(attributes[{p10:String}])) AS c7, quantile(0.5)(toFloat64OrNull(attributes[{p11:String}])) AS c8, quantile(0.99)(toFloat64OrNull(attributes[{p12:String}])) AS c9',
				`FROM (SELECT * FROM logs WHERE ${TENANCY} AND ts >= fromUnixTimestamp64Milli({p3:Int64}, 'UTC') AND ts <= fromUnixTimestamp64Milli({p4:Int64}, 'UTC') AND (severity_number >= {p5:Int64}))`,
				'GROUP BY c0, c1',
				'ORDER BY c0 ASC',
				'LIMIT {p13:Int64}',
			].join('\n'),
		);
		expect(compiled.columns).toEqual([
			{ name: 'bin(5m)', type: 'time' },
			{ name: 'level', type: 'string' },
			...['count', 'deploys', 'sum', 'avg', 'min', 'max', 'p50', 'p99'].map((name) => ({ name, type: 'number' as const })),
		]);
		expect(compiled.params.p6).toBe(300_000);
		expect(compiled.params.p13).toBe(10_000);
		expect(compiled.sampleIdColumn).toBeNull();
	});

	test('stats then sort by an output column and limit; bins are clamped', () => {
		const compiled = compileTable(
			read(null, [
				{ type: 'stats', aggregations: [{ fn: 'p95', field: { kind: 'attribute', key: 'duration_ms' }, alias: 'p95' }], by: [{ type: 'field', field: { kind: 'attribute', key: 'http.route' }, alias: '@http.route' }] },
				{ type: 'sort', key: 'P95', direction: 'desc' },
				{ type: 'limit', count: 10 },
			]),
			TEXT,
		);
		expect(compiled.sql).toContain('GROUP BY c0\nORDER BY c1 DESC\nLIMIT {p');
		expect(Object.values(compiled.params)).toContain(10);
		const tiny = compileTable(read(null, [{ type: 'stats', aggregations: [{ fn: 'count', alias: 'n' }], by: [{ type: 'bin', intervalMs: 10, alias: 't' }] }]), TEXT);
		expect(Object.values(tiny.params)).toContain(1_000);
		const groupless = compileTable(read(null, [{ type: 'stats', aggregations: [{ fn: 'count', alias: 'n' }], by: [] }]), TEXT);
		expect(groupless.sql).toContain('GROUP BY tuple()\nORDER BY c0 DESC');
	});

	test('patterns group by template id joined to log_patterns, with a hidden sample id', () => {
		const compiled = compileTable(read(null, [{ type: 'patterns' }, { type: 'limit', count: 20 }]), TEXT);
		expect(compiled.sql).toBe(
			[
				"SELECT l.pattern_id AS c0, if(any(p.template) = '', any(l.body), any(p.template)) AS c1, count() AS c2, toUnixTimestamp64Milli(if(any(p.pattern_id) = '', min(l.ts), least(min(l.ts), any(p.first_seen)))) AS c3, toUnixTimestamp64Milli(max(l.ts)) AS c4, argMax(l.id, l.ts) AS c5, countResample(0, 24, 1)(intDiv(toUnixTimestamp64Milli(l.ts) - {p8:Int64}, {p9:Int64})) AS c6",
				`FROM (SELECT * FROM logs WHERE ${TENANCY} AND ts >= fromUnixTimestamp64Milli({p3:Int64}, 'UTC') AND ts <= fromUnixTimestamp64Milli({p4:Int64}, 'UTC')) AS l LEFT JOIN (SELECT pattern_id, any(template) AS template, min(first_seen) AS first_seen FROM log_patterns WHERE (org_id = {p5:String} AND ((scope_kind = {p6:String} AND scope_id IN {p7:Array(String)}))) GROUP BY pattern_id) AS p ON p.pattern_id = l.pattern_id`,
				'GROUP BY c0',
				'ORDER BY c2 DESC',
				'LIMIT {p10:Int64}',
			].join('\n'),
		);
		expect(compiled.columns.map((column) => column.name)).toEqual(['pattern', 'template', 'count', 'first_seen', 'last_seen']);
		expect(compiled.sampleIdColumn).toBe(5);
		expect(compiled.sparklineColumn).toBe(6);
		// Choosing columns after patterns keeps the sample id and sparkline last.
		const chosen = compileTable(read(null, [{ type: 'patterns' }, { type: 'fields', fields: [{ kind: 'builtin', name: 'pattern' }] }]), TEXT);
		expect(chosen.sql.startsWith('SELECT c0, c5, c6 FROM (SELECT')).toBe(true);
		expect(chosen.sampleIdColumn).toBe(1);
	});

	test('dedup collapses repeats newest first, with a count', () => {
		const compiled = compileTable(read(null, [{ type: 'dedup', field: { kind: 'builtin', name: 'body' } }]), TEXT);
		expect(compiled.sql).toBe(
			[
				"SELECT toUnixTimestamp64Milli(ts) AS c0, severity_text AS c1, resource['service.name'] AS c2, body AS c3, dedup_count AS c4",
				`FROM (SELECT *, count() OVER (PARTITION BY body) AS dedup_count FROM (SELECT * FROM logs WHERE ${TENANCY} AND ts >= fromUnixTimestamp64Milli({p3:Int64}, 'UTC') AND ts <= fromUnixTimestamp64Milli({p4:Int64}, 'UTC')) ORDER BY ts DESC, id DESC LIMIT 1 BY body)`,
				'ORDER BY ts DESC, id DESC',
				'LIMIT {p5:Int64}',
			].join('\n'),
		);
		expect(compiled.columns.at(-1)).toEqual({ name: 'count', type: 'number' });
	});

	test('fields, sort and limit on rows', () => {
		const compiled = compileTable(
			read(null, [
				{ type: 'sort', key: 'ts', direction: 'asc' },
				{ type: 'limit', count: 500 },
				{ type: 'fields', fields: [{ kind: 'builtin', name: 'level' }, { kind: 'attribute', key: 'http.status' }, { kind: 'builtin', name: 'replica' }] },
			]),
			TEXT,
		);
		expect(compiled.sql).toBe(
			[
				'SELECT severity_text AS c0, attributes[{p6:String}] AS c1, replica AS c2',
				`FROM (SELECT * FROM (SELECT * FROM logs WHERE ${TENANCY} AND ts >= fromUnixTimestamp64Milli({p3:Int64}, 'UTC') AND ts <= fromUnixTimestamp64Milli({p4:Int64}, 'UTC')) ORDER BY ts ASC, id ASC LIMIT {p5:Int64})`,
				'ORDER BY ts ASC, id ASC',
				'LIMIT {p7:Int64}',
			].join('\n'),
		);
		expect(compiled.columns).toEqual([
			{ name: 'level', type: 'string' },
			{ name: '@http.status', type: 'string' },
			{ name: 'replica', type: 'number' },
		]);
	});

	test('stages that cannot follow an aggregation, and unknown sort keys, are 422s', () => {
		const stats: LogPipeStage = { type: 'stats', aggregations: [{ fn: 'count', alias: 'count' }], by: [] };
		expect(() => compileTable(read(null, [stats, { type: 'patterns' }]), TEXT)).toThrow('one aggregation');
		expect(() => compileTable(read(null, [stats, { type: 'dedup', field: { kind: 'builtin', name: 'body' } }]), TEXT)).toThrow(ValidationError);
		expect(() => compileTable(read(null, [stats, { type: 'sort', key: 'nope', direction: 'asc' }]), TEXT)).toThrow('not a column');
		expect(() => compileTable(read(null, [{ type: 'sort', key: 'nonsense', direction: 'asc' }]), TEXT)).toThrow('Unknown field');
		expect(() => compileTable(read(null, [{ type: 'stats', aggregations: [{ fn: 'p95', alias: 'p' }], by: [] }]), TEXT)).toThrow('needs a field');
	});
});

describe('histogram and facets', () => {
	test('picks a round interval and groups by bucket and band', () => {
		expect(pickHistogramInterval(0, 3_600_000, 60)).toBe(60_000);
		expect(pickHistogramInterval(0, 86_400_000, 60)).toBe(1_800_000);
		expect(pickHistogramInterval(0, 10_000, 60)).toBe(1_000);
		const compiled = compileHistogram(read(field('level', 'gte', 'error'), [{ type: 'patterns' }]), 60_000, TEXT);
		expect(compiled.sql).toBe(
			`SELECT intDiv(toUnixTimestamp64Milli(ts), {p6:Int64}) * {p6:Int64} AS c0, severity_text AS c1, count() AS c2\nFROM logs\nWHERE ${TENANCY} AND ts >= fromUnixTimestamp64Milli({p3:Int64}, 'UTC') AND ts <= fromUnixTimestamp64Milli({p4:Int64}, 'UTC') AND (severity_number >= {p5:Int64})\nGROUP BY c0, c1\nORDER BY c0`,
		);
	});

	test('built-in facets explode into (field, value) pairs in one scan', () => {
		const compiled = compileBuiltinFacets(read(), ['level', 'deployment'], 5, TEXT);
		expect(compiled.sql).toContain("ARRAY JOIN arrayFilter(x -> x.2 != '', [({p5:String}, substring(severity_text, 1, 200)), ({p6:String}, substring(deployment_id, 1, 200))]) AS kv");
		expect(compiled.sql).toContain('LIMIT {p7:Int64} BY c0');
		expect(compiled.params).toMatchObject({ p5: 'level', p6: 'deployment', p7: 5 });
	});

	test('attribute keys are discovered with mapKeys and summarised by key', () => {
		expect(compileMapKeys(read(), 'attributes', 30, TEXT).sql).toContain('ARRAY JOIN mapKeys(attributes) AS k');
		const facets = compileMapFacets(read(), 'attributes', ['http.status', 'user'], 10, TEXT);
		expect(facets.sql).toContain('AND k IN {p5:Array(String)}');
		expect(facets.params.p5).toEqual(['http.status', 'user']);
	});
});

describe('field names', () => {
	test('built-ins, attributes, resources, ts and id', () => {
		expect(parseFieldName('Level')).toEqual({ kind: 'ref', ref: { kind: 'builtin', name: 'level' } });
		expect(parseFieldName('message')).toEqual({ kind: 'ref', ref: { kind: 'builtin', name: 'body' } });
		expect(parseFieldName('@http.status')).toEqual({ kind: 'ref', ref: { kind: 'attribute', key: 'http.status' } });
		expect(parseFieldName('resource.host.name')).toEqual({ kind: 'ref', ref: { kind: 'resource', key: 'host.name' } });
		expect(parseFieldName('@resource.k8s.pod.name')).toEqual({ kind: 'ref', ref: { kind: 'resource', key: 'k8s.pod.name' } });
		expect(parseFieldName('timestamp')).toEqual({ kind: 'ts' });
		expect(parseFieldName('id')).toEqual({ kind: 'id' });
		expect(parseFieldName('bogus')).toBeNull();
		expect(parseFieldName('@')).toBeNull();
	});
});
