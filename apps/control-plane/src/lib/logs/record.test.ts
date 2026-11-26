import { describe, expect, test } from 'bun:test';
import type { LogRecord, LogTableResult } from '@yoal/contracts';
import { logShortcutFor } from './keyboard';
import { jsonBody, primaryField, recordFields, recordPivots } from './record';
import { comparePatterns, tableToSeries, templateParts } from './table';

const base: LogRecord = {
	id: 'le:7',
	ts: 1_000,
	observedTs: null,
	orgId: 'org_1',
	scope: { kind: 'project', id: 'prj_1' },
	scopeName: 'api',
	stream: 'deployment:dep_1',
	source: 'runtime',
	channel: 'stderr',
	severityNumber: 17,
	severity: 'error',
	body: 'boom',
	attributes: { 'http.status': '502' },
	resource: { 'host.id': 'node_1' },
	traceId: null,
	spanId: null,
	requestId: 'req_9',
	patternId: null,
	projectId: 'prj_1',
	deploymentId: 'dep_1',
	buildId: null,
	jobRunId: null,
	nodeId: 'node_1',
	replica: 1
};

describe('record fields and pivots', () => {
	test('fields use query names, built-ins first', () => {
		const fields = recordFields(base).map((field) => `${field.field}=${field.value}`);
		expect(fields.slice(0, 4)).toEqual([
			'level=error',
			'scope=project:prj_1',
			'service=api',
			'kind=project'
		]);
		expect(fields).toContain('@http.status=502');
		expect(fields).toContain('resource.host.id=node_1');
		expect(fields).toContain('request=req_9');
		expect(fields.some((field) => field.startsWith('trace='))).toBe(false);
	});

	test('pivots filter by request, deployment, node and stream, and link to the deployment', () => {
		const pivots = recordPivots(base);
		expect(pivots.filter((pivot) => pivot.query).map((pivot) => pivot.query)).toEqual([
			'request:req_9',
			'deployment:dep_1',
			'node:node_1',
			'stream:deployment:dep_1'
		]);
		expect(pivots.find((pivot) => pivot.href?.includes('/deployments/'))?.href).toBe(
			'/projects/api/deployments/dep_1'
		);
	});

	test('the focused value defaults to the stream', () => {
		expect(primaryField(base)).toEqual({ field: 'stream', value: 'deployment:dep_1' });
		expect(primaryField({ ...base, stream: null, deploymentId: null })).toEqual({
			field: 'scope',
			value: 'project:prj_1'
		});
	});

	test('JSON bodies are detected', () => {
		expect(jsonBody('{"a":1}')).toEqual({ a: 1 });
		expect(jsonBody('{not json}')).toBeNull();
		expect(jsonBody('plain')).toBeNull();
	});
});

describe('keyboard map', () => {
	const key = (k: string, extra: Partial<KeyboardEvent> = {}) => ({
		key: k,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		...extra
	});

	test('single keys act only when not typing', () => {
		expect(logShortcutFor(key('j'), false)).toBe('next');
		expect(logShortcutFor(key('j'), true)).toBeNull();
		expect(logShortcutFor(key(' '), false)).toBe('toggleLive');
		expect(logShortcutFor(key('['), false)).toBe('shiftBack');
	});

	test('⌘↵, ⌘K and Escape work while typing', () => {
		expect(logShortcutFor(key('Enter', { metaKey: true }), true)).toBe('run');
		expect(logShortcutFor(key('k', { ctrlKey: true }), true)).toBe('palette');
		expect(logShortcutFor(key('Escape'), true)).toBe('close');
	});
});

describe('tables for the analysis tabs', () => {
	const stats: LogTableResult = {
		columns: [
			{ name: 't', type: 'time' },
			{ name: 'level', type: 'string' },
			{ name: 'count', type: 'number' }
		],
		rows: [
			[0, 'info', 5],
			[0, 'error', 1],
			[60_000, 'info', 3]
		],
		engine: 'clickhouse',
		warnings: [],
		elapsedMs: 1
	};

	test('a binned stats table becomes stacked series', () => {
		const chart = tableToSeries(stats)!;
		expect(chart.intervalMs).toBe(60_000);
		expect(chart.series.map((item) => item.key)).toEqual(['info', 'error']);
		expect(chart.buckets[0]).toEqual({ ts: 0, values: { info: 5, error: 1 }, total: 6 });
		expect(chart.to).toBe(120_000);
	});

	test('a table without time has no chart', () => {
		expect(
			tableToSeries({ ...stats, columns: [{ name: 'x', type: 'string' }], rows: [['a']] })
		).toBeNull();
	});

	test('compare classifies new, gone, rising and falling', () => {
		const table = (rows: Array<[string, number]>): LogTableResult => ({
			columns: [
				{ name: 'template', type: 'string' },
				{ name: 'count', type: 'number' }
			],
			rows,
			engine: 'clickhouse',
			warnings: [],
			elapsedMs: 1
		});
		const rows = comparePatterns(
			table([
				['a', 10],
				['b', 100],
				['c', 10]
			]),
			table([
				['b', 10],
				['c', 100],
				['d', 5]
			])
		);
		expect(rows.map((row) => `${row.key}:${row.change}`)).toEqual([
			'a:new',
			'b:rising',
			'd:gone',
			'c:falling'
		]);
	});

	test('template placeholders are split out', () => {
		expect(templateParts('took <NUM>ms for <*>')).toEqual([
			{ text: 'took ', placeholder: false },
			{ text: '<NUM>', placeholder: true },
			{ text: 'ms for ', placeholder: false },
			{ text: '<*>', placeholder: true }
		]);
	});
});
