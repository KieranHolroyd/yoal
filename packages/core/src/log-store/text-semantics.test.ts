import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { compileLogPredicate, isLogTokenSearch, parseLogQuery, type LogQueryNode, type LogRecord } from '@yoal/contracts';
import { clickhouseRow } from '../log-indexer.ts';
import { disposeTelemetryStore, hasClickHouse, testTelemetryStore } from '../test-clickhouse.ts';
import type { TelemetryStore } from '../telemetry.ts';
import { SqlParams, filterSql, type ClickHouseCompileOptions } from './clickhouse-compiler.ts';
import { ClickHouseLogStore } from './clickhouse-store.ts';
import { compileSqliteFilter } from './sqlite-compiler.ts';
import type { LogReadBoundary } from './types.ts';

/**
 * One corpus, three engines (docs/LOGS.md §6.1, the "Leaves" rule in log-query.ts): a bare
 * letters/digits word is a whole-token match, anything else a case-insensitive substring. The JS
 * predicate is the reference; the SQLite compiler runs against an in-memory table; the ClickHouse
 * SQL is checked by inspection and, when a server answers, by running it.
 */
const CORPUS = [
	'GET /v1/orders upstream Timeout after 30000ms',
	'UpstreamTimeout is one token',
	'connection_timeout=5s',
	'timeouts happen',
	'TIMEOUT!',
	'a naïve timeout',
	'Échec du paiement',
	'échec',
	'user@example.com logged in',
	'progress 100%_done',
	'tab\tseparated\tvalue',
	'line1\nline2 error',
	'error42 code=42',
	'v1.2.3 released',
	'',
];

const QUERIES = [
	'timeout',
	'TIMEOUT',
	'time',
	'"time"',
	'"Timeout after"',
	'30000',
	'30000ms',
	'upstreamtimeout',
	'"upstreamtimeout"',
	'naïve',
	'na',
	'échec',
	'Échec',
	'user@example.com',
	'example',
	'100%_d',
	'done',
	'separated',
	'line2',
	'42',
	'error42',
	'"1.2"',
	'v1',
	'-timeout',
	'timeout OR échec',
	'message:timeout',
	'body:"timeout"',
	'(error OR value) -tab',
];

function filterOf(query: string): LogQueryNode | null {
	const parsed = parseLogQuery(query);
	if (!parsed.ok) throw new Error(`${query}: ${parsed.error.message}`);
	return parsed.ast.filter;
}

function record(index: number): LogRecord {
	return {
		id: `le:${index + 1}`,
		ts: 1_700_000_000_000 + index,
		observedTs: null,
		orgId: 'org_1',
		scope: { kind: 'project', id: 'prj_1' },
		scopeName: 'api',
		stream: null,
		source: 'runtime',
		channel: 'stdout',
		severityNumber: 9,
		severity: 'info',
		body: CORPUS[index]!,
		attributes: {},
		resource: {},
		traceId: null,
		spanId: null,
		requestId: null,
		patternId: null,
		projectId: 'prj_1',
		deploymentId: null,
		buildId: null,
		jobRunId: null,
		nodeId: null,
		replica: null,
	};
}

const RECORDS = CORPUS.map((_, index) => record(index));

function predicateHits(query: string): number[] {
	const predicate = compileLogPredicate(filterOf(query));
	return RECORDS.flatMap((rec, index) => (predicate(rec) ? [index] : []));
}

const sqlite = new Database(':memory:');
sqlite.run('CREATE TABLE t (n INTEGER, body TEXT)');
CORPUS.forEach((body, index) => sqlite.run('INSERT INTO t (n, body) VALUES (?, ?)', [index, body]));

function sqliteHits(query: string): number[] {
	const filter = compileSqliteFilter(filterOf(query));
	return sqlite
		.query<{ n: number }, SQLQueryBindings[]>(`SELECT n FROM t u WHERE ${filter.sql} ORDER BY n`)
		.all(...(filter.params as SQLQueryBindings[]))
		.map((row) => row.n);
}

/** Every text leaf in a filter. */
function textLeaves(node: LogQueryNode | null): Array<{ value: string; phrase: boolean }> {
	if (!node) return [];
	switch (node.type) {
		case 'text':
			return [node];
		case 'and':
		case 'or':
			return node.children.flatMap(textLeaves);
		case 'not':
			return textLeaves(node.child);
		default:
			return [];
	}
}

describe('text search: predicate and SQLite agree', () => {
	for (const query of QUERIES) {
		test(query, () => {
			expect(sqliteHits(query)).toEqual(predicateHits(query));
		});
	}

	test('the corpus pins the rule (a few spot checks against the reference)', () => {
		expect(predicateHits('timeout')).toEqual([0, 2, 4, 5]);
		expect(predicateHits('time')).toEqual([]);
		expect(predicateHits('"time"')).toEqual([0, 1, 2, 3, 4, 5]);
		expect(predicateHits('upstreamtimeout')).toEqual([1]);
		expect(predicateHits('naïve')).toEqual([5]);
		expect(predicateHits('na')).toEqual([]);
		expect(predicateHits('échec')).toEqual([7]);
		expect(predicateHits('Échec')).toEqual([6]);
		expect(predicateHits('example')).toEqual([8]);
		expect(predicateHits('42')).toEqual([12]);
		expect(predicateHits('v1')).toEqual([0, 13]);
		expect(predicateHits('separated')).toEqual([10]);
	});
});

describe('text search: the ClickHouse SQL by inspection', () => {
	const OPTIONS: Array<[string, ClickHouseCompileOptions]> = [
		['text', { textIndex: 'text' }],
		['tokenbf', { textIndex: 'tokenbf' }],
		['none', { textIndex: null }],
	];
	for (const [name, options] of OPTIONS) {
		test(`token words compile to hasToken, everything else to a substring (${name} index)`, () => {
			for (const query of QUERIES) {
				for (const leaf of textLeaves(filterOf(query))) {
					const params = new SqlParams();
					const sql = filterSql({ type: 'text', ...leaf }, params, options);
					const values = Object.values(params.values);
					if (isLogTokenSearch(leaf)) {
						expect(sql).toBe(options.textIndex === 'text' ? 'hasToken(body, {p0:String})' : 'hasTokenCaseInsensitive(body, {p0:String})');
						expect(values).toEqual([leaf.value.replace(/[A-Z]/g, (c) => c.toLowerCase())]);
					} else {
						expect(sql).not.toContain('hasToken(');
						expect(sql).toMatch(/ILIKE|positionCaseInsensitive/);
					}
				}
			}
		});
	}
});

describe.skipIf(!hasClickHouse)('text search: ClickHouse agrees when run', () => {
	let telemetry: TelemetryStore;
	const boundary: LogReadBoundary = { orgId: 'org_1', scopes: [{ kind: 'project', id: 'prj_1' }], crossOrg: false };

	beforeAll(async () => {
		telemetry = testTelemetryStore();
		expect(await telemetry.logsReady()).toBe(true);
		await telemetry.insertLogRows('logs', RECORDS.map(clickhouseRow));
	});

	afterAll(async () => {
		await disposeTelemetryStore(telemetry);
	});

	test('the store (with its real body index) returns the predicate hits', async () => {
		const store = new ClickHouseLogStore(telemetry);
		for (const query of QUERIES) {
			const result = await store.search(
				{ boundary, ast: { filter: filterOf(query), pipes: [] }, from: 1_699_999_999_000, to: 1_700_000_001_000 },
				{ limit: 100, order: 'asc' },
			);
			const hits = result.records.map((rec) => Number(rec.id.slice(3)) - 1);
			expect({ query, hits }).toEqual({ query, hits: predicateHits(query) });
		}
	});

	test('the index-free forms (tokenbf and none) evaluate the same over plain rows', async () => {
		for (const options of [{ textIndex: 'tokenbf' }, { textIndex: null }] satisfies ClickHouseCompileOptions[]) {
			for (const query of QUERIES) {
				const node = filterOf(query);
				const params = new SqlParams();
				const where = node ? filterSql(node, params, options) : '1';
				const corpus = params.strings(CORPUS);
				const result = await telemetry.runQuery(
					`SELECT n FROM (SELECT toUInt32(number) AS n, arrayElement(${corpus}, number + 1) AS body FROM numbers(${CORPUS.length})) WHERE ${where} ORDER BY n`,
					{ asReader: false, params: params.values },
				);
				expect({ query, hits: result.data.map((row) => Number(row[0])) }).toEqual({ query, hits: predicateHits(query) });
			}
		}
	});
});
