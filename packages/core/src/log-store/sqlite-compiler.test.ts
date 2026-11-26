import { describe, expect, test } from 'bun:test';
import type { SQLQueryBindings } from 'bun:sqlite';
import type { LogFieldOp, LogFieldRef, LogQueryNode } from '@yoal/contracts';
import { compileBoundary, compileSourceWhere, compileSqliteFilter, globToLike } from './sqlite-compiler.ts';
import { seedLogFixtures } from './sqlite-fixtures.test-support.ts';
import { SQLITE_LOG_SOURCES } from './sqlite-sources.ts';
import { LogStoreUnsupported, type LogReadBoundary } from './types.ts';

/**
 * The placeholder parser only yields text nodes, so these tests build ASTs by hand and run the
 * compiled SQL against a seeded hot tail (sqlite-fixtures.test-support.ts).
 */
const sqlite = seedLogFixtures();
const union = SQLITE_LOG_SOURCES.map((source) => source.select).join('\nUNION ALL\n');

function ids(node: LogQueryNode | null): string[] {
	const filter = compileSqliteFilter(node);
	return sqlite
		.query<{ id: string }, SQLQueryBindings[]>(
			`SELECT u.tag || ':' || u.seq AS id FROM (${union}) u WHERE ${filter.sql} ORDER BY u.ts`,
		)
		.all(...(filter.params as SQLQueryBindings[]))
		.map((row) => row.id);
}

const builtin = (name: Extract<LogFieldRef, { kind: 'builtin' }>['name']): LogFieldRef => ({ kind: 'builtin', name });
const attr = (key: string): LogFieldRef => ({ kind: 'attribute', key });
const res = (key: string): LogFieldRef => ({ kind: 'resource', key });
const field = (ref: LogFieldRef, op: LogFieldOp, value: string | number): LogQueryNode => ({ type: 'field', field: ref, op, value });
const text = (value: string, phrase = false): LogQueryNode => ({ type: 'text', value, phrase });
const not = (child: LogQueryNode): LogQueryNode => ({ type: 'not', child });

const ALL = ['le:1', 'le:2', 'sle:1', 'le:3', 'pll:1', 'le:4', 'lr:1', 'lr:2', 'le:5', 'le:6'];

describe('sqlite compiler: text and logic', () => {
	test('no filter matches everything', () => {
		expect(ids(null)).toEqual(ALL);
	});

	test('a bare word is a whole-token match; phrases and punctuated words are substrings', () => {
		expect(ids(text('TIMEOUT'))).toEqual(['le:2', 'sle:1', 'le:6']);
		expect(ids(text('TIME'))).toEqual([]);
		expect(ids(text('TIME', true))).toEqual(['le:2', 'sle:1', 'le:6']);
		expect(ids(text('upstream timeout', true))).toEqual(['le:2']);
		expect(ids(text('done'))).toEqual(['le:4']);
		expect(ids(text('100%_d'))).toEqual(['le:4']);
		expect(ids(text('payment'))).toEqual(['le:3']);
	});

	test('and, or and not combine', () => {
		expect(ids({ type: 'and', children: [text('timeout'), field(builtin('level'), 'gte', 'error')] })).toEqual(['le:2', 'le:6']);
		expect(ids({ type: 'or', children: [text('crashed'), field(builtin('source'), 'eq', 'build')] })).toEqual(['le:4', 'lr:1']);
		expect(ids(not(text('timeout')))).toEqual(ALL.filter((id) => !['le:2', 'sle:1', 'le:6'].includes(id)));
		expect(ids({ type: 'and', children: [] })).toEqual(ALL);
		expect(ids({ type: 'or', children: [] })).toEqual([]);
	});
});

describe('sqlite compiler: level bands', () => {
	test('level:warn is warn or worse, level:=warn exactly warn', () => {
		expect(ids(field(builtin('level'), 'gte', 'warn'))).toEqual(['le:2', 'sle:1', 'le:3', 'pll:1', 'lr:1', 'lr:2', 'le:6']);
		expect(ids(field(builtin('level'), 'eq', 'WARNING'))).toEqual(['sle:1', 'le:3', 'pll:1']);
	});

	test('ordered comparisons work by band, and numbers read as severity numbers', () => {
		expect(ids(field(builtin('level'), 'gt', 'warn'))).toEqual(['le:2', 'lr:1', 'lr:2', 'le:6']);
		expect(ids(field(builtin('level'), 'lte', 'info'))).toEqual(['le:1', 'le:4', 'le:5']);
		expect(ids(field(builtin('level'), 'lt', 'info'))).toEqual([]);
		expect(ids(field(builtin('level'), 'gte', 17))).toEqual(['le:2', 'lr:1', 'lr:2', 'le:6']);
	});

	test('an unknown level never matches; a wildcard matches the band name', () => {
		expect(ids(field(builtin('level'), 'eq', 'bogus'))).toEqual([]);
		expect(ids(field(builtin('level'), 'wildcard', 'err*'))).toEqual(['le:2', 'lr:1', 'lr:2', 'le:6']);
	});
});

describe('sqlite compiler: built-in fields', () => {
	test('eq is case-insensitive equality', () => {
		expect(ids(field(builtin('source'), 'eq', 'BUILD'))).toEqual(['le:4']);
		expect(ids(field(builtin('kind'), 'eq', 'pipeline'))).toEqual(['pll:1']);
		expect(ids(field(builtin('scope'), 'eq', 'database:db_1'))).toEqual(['sle:1']);
		expect(ids(field(builtin('stream'), 'eq', 'deployment:dep_1'))).toEqual(['le:1', 'le:2', 'le:3']);
		expect(ids(field(builtin('build'), 'eq', 'b_1'))).toEqual(['le:4']);
		expect(ids(field(builtin('request'), 'eq', 'req-1'))).toEqual(['lr:2']);
		expect(ids(field(builtin('channel'), 'eq', 'stderr'))).toEqual(['le:2', 'pll:1', 'le:6']);
	});

	test('wildcards are globs with LIKE metacharacters escaped', () => {
		expect(ids(field(builtin('body'), 'wildcard', 'GET /*'))).toEqual(['le:1', 'lr:2']);
		expect(ids(field(builtin('body'), 'wildcard', '*100%_*'))).toEqual(['le:4']);
		expect(ids(field(builtin('body'), 'wildcard', '*100_*'))).toEqual([]);
		expect(globToLike('a%b_c\\d*e?')).toBe('a\\%b\\_c\\\\d%e_');
	});

	test('service matches the scope display name; project and node match id or name', () => {
		expect(ids(field(builtin('service'), 'eq', 'main-db'))).toEqual(['sle:1']);
		expect(ids(field(builtin('service'), 'wildcard', 'api*'))).toEqual(['le:1', 'le:2', 'le:3', 'le:4', 'lr:2', 'le:6']);
		expect(ids(field(builtin('project'), 'eq', 'web'))).toEqual(['le:5']);
		expect(ids(field(builtin('project'), 'eq', 'prj_b'))).toEqual(['le:5']);
		expect(ids(field(builtin('node'), 'eq', 'edge-b'))).toEqual(['le:5', 'le:6']);
		expect(ids(field(builtin('node'), 'eq', 'node_2'))).toEqual(['le:5', 'le:6']);
	});

	test('replica compares numerically from the [rN] prefix or resource.replica', () => {
		expect(ids(field(builtin('replica'), 'gte', 1))).toEqual(['le:2', 'lr:2']);
		expect(ids(field(builtin('replica'), 'eq', 0))).toEqual(['le:1', 'le:3', 'le:5', 'le:6']);
		expect(ids(field(builtin('replica'), 'gt', 'abc'))).toEqual([]);
	});

	test('exists is true when the field is present and non-empty', () => {
		expect(ids({ type: 'exists', field: builtin('build') })).toEqual(['le:4']);
		expect(ids({ type: 'exists', field: builtin('level') })).toEqual(ALL);
	});
});

describe('sqlite compiler: attributes and resource', () => {
	test('attributes read through json_extract where a source stores them', () => {
		expect(ids(field(attr('http.status'), 'gte', 500))).toEqual(['lr:2']);
		expect(ids(field(attr('http.status'), 'eq', '502'))).toEqual(['lr:2']);
		expect(ids(field(attr('http.route'), 'wildcard', '/v1/*'))).toEqual(['lr:2']);
		expect(ids(field(attr('pipeline.step'), 'eq', 2))).toEqual(['pll:1']);
		expect(ids({ type: 'exists', field: attr('unit') })).toEqual(['lr:1']);
	});

	test('a missing field is false, and true under NOT', () => {
		expect(ids(not(field(attr('http.status'), 'gte', 500)))).toEqual(ALL.filter((id) => id !== 'lr:2'));
		expect(ids(not({ type: 'exists', field: attr('http.status') }))).toEqual(ALL.filter((id) => id !== 'lr:2'));
	});

	test('resource keys the hot tail keeps as columns map to them', () => {
		expect(ids(field(res('deployment.id'), 'eq', 'dep_1'))).toEqual(['le:1', 'le:2', 'le:3']);
		expect(ids(field(res('host.id'), 'eq', 'node_2'))).toEqual(['le:5', 'le:6']);
		expect(ids(field(res('replica'), 'eq', 2))).toEqual(['lr:2']);
	});

	test('keys outside the safe character set never match instead of reaching SQL', () => {
		expect(ids(field(attr(`x') OR 1=1 --`), 'eq', '1'))).toEqual([]);
		expect(ids(not(field(attr('a"b'), 'eq', '1')))).toEqual(ALL);
	});
});

describe('sqlite compiler: unsupported in lite mode', () => {
	test('regex and pattern throw LogStoreUnsupported with the feature', () => {
		expect(() => compileSqliteFilter(field(builtin('body'), 'regex', 'time(out)'))).toThrow(LogStoreUnsupported);
		try {
			compileSqliteFilter(field(attr('msg'), 'regex', 'x'));
		} catch (error) {
			expect((error as LogStoreUnsupported).feature).toBe('regex');
		}
		try {
			compileSqliteFilter(field(builtin('pattern'), 'eq', 'abc'));
		} catch (error) {
			expect((error as LogStoreUnsupported).feature).toBe('patterns');
		}
	});
});

describe('sqlite compiler: boundary', () => {
	function bounded(boundary: LogReadBoundary): string[] {
		const out: string[] = [];
		for (const source of SQLITE_LOG_SOURCES) {
			const where = compileSourceWhere(source, boundary, { sql: '1', params: [] }, null);
			if (!where) continue;
			out.push(
				...sqlite
					.query<{ id: string }, SQLQueryBindings[]>(`SELECT u.tag || ':' || u.seq AS id FROM (${where.sql}) u`)
					.all(...(where.params as SQLQueryBindings[]))
					.map((row) => row.id),
			);
		}
		return out.sort();
	}

	test('org_id is always ANDed in, even for a scope id that belongs to another org', () => {
		expect(
			bounded({
				orgId: 'org_1',
				scopes: [
					{ kind: 'project', id: 'prj_a' },
					{ kind: 'project', id: 'prj_x' },
				],
				crossOrg: false,
			}),
		).toEqual(['le:1', 'le:2', 'le:3', 'le:4', 'lr:2']);
	});

	test('tables that cannot hold a boundary scope are skipped', () => {
		const boundary: LogReadBoundary = { orgId: 'org_1', scopes: [{ kind: 'database', id: 'db_1' }], crossOrg: false };
		expect(compileBoundary(boundary, SQLITE_LOG_SOURCES.find((source) => source.tag === 'le')!)).toBeNull();
		expect(bounded(boundary)).toEqual(['sle:1']);
	});

	test('platform scopes need a cross-org boundary; it never relaxes tenant scopes', () => {
		const scopes = [
			{ kind: 'platform' as const, id: 'node_1' },
			{ kind: 'project' as const, id: 'prj_x' },
		];
		expect(bounded({ orgId: 'org_1', scopes, crossOrg: false })).toEqual([]);
		expect(bounded({ orgId: 'org_1', scopes, crossOrg: true })).toEqual(['lr:1']);
	});

	test('an empty boundary reads nothing', () => {
		expect(bounded({ orgId: 'org_1', scopes: [], crossOrg: true })).toEqual([]);
	});
});
