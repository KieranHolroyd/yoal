import { describe, expect, test } from 'bun:test';
import { UsageError } from './errors.ts';
import {
	formatRecordLine,
	parseBaseline,
	parseDuration,
	parseScopeArg,
	parseTimeArg,
	renderCompare,
	renderLogTable,
	resolveScopeArgs,
	scopeLabel,
	type LogRecordView,
	type LogScopeEntryView,
} from './log-explorer.ts';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');

const available: LogScopeEntryView[] = [
	{ kind: 'project', id: 'prj_1', name: 'api' },
	{ kind: 'project', id: 'prj_2', name: 'patterns' },
	{ kind: 'function', id: 'prj_3', name: 'hooks' },
	{ kind: 'database', id: 'db_1', name: 'main' },
	{ kind: 'storage', id: 'st_1', name: 'media' },
	{ kind: 'broker', id: 'brk_1', name: 'events' },
	{ kind: 'k8s', id: 'k8s_1', name: 'prod' },
	{ kind: 'pipeline', id: 'repo_1', name: 'shop' },
	{ kind: 'platform', id: 'node_1', name: 'edge-a' },
];

function record(overrides: Partial<LogRecordView> = {}): LogRecordView {
	return {
		id: 'le:1',
		ts: Date.parse('2026-11-26T11:59:01.204Z'),
		scope: { kind: 'project', id: 'prj_1' },
		scopeName: 'api',
		stream: 'deployment:dep_1',
		source: 'runtime',
		severity: 'error',
		body: 'upstream timeout',
		...overrides,
	};
}

describe('scope shorthand', () => {
	test('a bare name is a project; prefixes map to kinds', () => {
		expect(parseScopeArg('api')).toMatchObject({ kind: 'project', ref: 'api' });
		expect(parseScopeArg('db:main')).toMatchObject({ kind: 'database', ref: 'main' });
		expect(parseScopeArg('database:main')).toMatchObject({ kind: 'database', ref: 'main' });
		expect(parseScopeArg('storage:media')).toMatchObject({ kind: 'storage', ref: 'media' });
		expect(parseScopeArg('broker:events')).toMatchObject({ kind: 'broker', ref: 'events' });
		expect(parseScopeArg('k8s:prod')).toMatchObject({ kind: 'k8s', ref: 'prod' });
		expect(parseScopeArg('kubernetes:prod')).toMatchObject({ kind: 'k8s', ref: 'prod' });
		expect(parseScopeArg('pipeline:acme/shop')).toMatchObject({ kind: 'pipeline', ref: 'acme/shop' });
		expect(parseScopeArg('platform:edge-a')).toMatchObject({ kind: 'platform', ref: 'edge-a' });
		expect(parseScopeArg('project:patterns')).toMatchObject({ kind: 'project', ref: 'patterns' });
	});

	test('an unknown prefix or an empty name is a usage error', () => {
		expect(() => parseScopeArg('galaxy:x')).toThrow(/Unknown scope kind "galaxy"/);
		expect(() => parseScopeArg('db:')).toThrow(UsageError);
		expect(() => parseScopeArg('  ')).toThrow(UsageError);
	});

	test('names and ids resolve against the readable scopes; duplicates collapse', () => {
		const typed = ['api', 'db:main', 'db:db_1', 'platform:edge-a', 'function:hooks', 'pipeline:shop'].map(parseScopeArg);
		expect(resolveScopeArgs(typed, available)).toEqual([
			{ kind: 'project', id: 'prj_1' },
			{ kind: 'database', id: 'db_1' },
			{ kind: 'platform', id: 'node_1' },
			{ kind: 'function', id: 'prj_3' },
			{ kind: 'pipeline', id: 'repo_1' },
		]);
		expect(resolveScopeArgs([parseScopeArg('API')], available)).toEqual([{ kind: 'project', id: 'prj_1' }]);
	});

	test('a scope the caller cannot read names what it can read instead', () => {
		expect(() => resolveScopeArgs([parseScopeArg('db:other')], available)).toThrow(
			'No database "other" that you can read logs in. Yours: db:main.',
		);
		expect(() => resolveScopeArgs([parseScopeArg('broker:x')], [])).toThrow('No broker "x" that you can read logs in.');
	});
});

describe('times and baselines', () => {
	test('durations, now, epoch ms and ISO times', () => {
		expect(parseDuration('15m')).toBe(900_000);
		expect(parseDuration('7d')).toBe(604_800_000);
		expect(parseDuration('0m')).toBeNull();
		expect(parseDuration('1y')).toBeNull();
		expect(parseTimeArg('1h', NOW, '--since')).toBe(NOW - 3_600_000);
		expect(parseTimeArg('now', NOW, '--until')).toBe(NOW);
		expect(parseTimeArg('1764158400000', NOW, '--since')).toBe(1_764_158_400_000);
		expect(parseTimeArg('2026-11-26T10:00:00Z', NOW, '--since')).toBe(Date.parse('2026-11-26T10:00:00Z'));
		expect(() => parseTimeArg('yesterday', NOW, '--since')).toThrow(/--since takes a duration/);
	});

	test('baselines follow the compare contract', () => {
		expect(parseBaseline('previous', NOW)).toEqual({ kind: 'previous' });
		expect(parseBaseline('1d', NOW)).toEqual({ kind: 'offset', offsetMs: 86_400_000 });
		expect(parseBaseline('7d', NOW)).toEqual({ kind: 'offset', offsetMs: 604_800_000 });
		expect(parseBaseline('deploy:dep_9', NOW)).toEqual({ kind: 'deploy', deploymentId: 'dep_9' });
		expect(parseBaseline('2026-11-26T09:00:00Z..2026-11-26T08:00:00Z', NOW)).toEqual({
			kind: 'range',
			from: Date.parse('2026-11-26T08:00:00Z'),
			to: Date.parse('2026-11-26T09:00:00Z'),
		});
		expect(() => parseBaseline('deploy:', NOW)).toThrow(UsageError);
		expect(() => parseBaseline('last tuesday', NOW)).toThrow(/--baseline takes previous/);
	});
});

describe('rendering', () => {
	test('a line: UTC time, severity, optional scope, body; continuation lines indented', () => {
		expect(formatRecordLine(record(), { color: false, scope: true })).toBe('2026-11-26 11:59:01.204 ERR api  upstream timeout');
		expect(formatRecordLine(record({ scope: { kind: 'database', id: 'db_1' }, scopeName: 'main' }), { color: false, scope: true })).toContain(
			' ERR db:main  ',
		);
		const multi = formatRecordLine(record({ body: 'TypeError: x\n    at f (a.js:1)' }), { color: false, scope: false });
		expect(multi.split('\n')).toHaveLength(2);
		expect(multi.split('\n')[1]).toMatch(/^\s+ {4}at f/);
	});

	test('colour only when asked; ANSI in a body is kept only with colour', () => {
		const coloured = formatRecordLine(record({ body: '\x1b[32mok\x1b[0m', ansi: true }), { color: true, scope: false });
		expect(coloured).toContain('\x1b[31mERR\x1b[0m');
		expect(coloured).toContain('\x1b[32mok');
		expect(formatRecordLine(record({ body: '\x1b[32mok\x1b[0m', ansi: true }), { color: false, scope: false })).toEndWith('  ok');
	});

	test('scope labels use the shorthand', () => {
		expect(scopeLabel(record())).toBe('api');
		expect(scopeLabel(record({ scope: { kind: 'platform', id: 'node_1' }, scopeName: null }))).toBe('platform:node_1');
	});

	test('tables format time columns and nulls', () => {
		const text = renderLogTable({
			columns: [
				{ name: 'bin(5m)', type: 'time' },
				{ name: 'count', type: 'number' },
				{ name: 'level', type: 'string' },
			],
			rows: [[Date.parse('2026-11-26T11:55:00Z'), 12, null]],
			engine: 'clickhouse',
			warnings: [],
		});
		expect(text.split('\n')[2]).toBe('2026-11-26 11:55:00.000  12     -');
		expect(renderLogTable({ columns: [], rows: [], engine: 'sqlite', warnings: [] })).toBe('No rows.');
	});

	test('compare groups new, rising, falling and gone; steady only with --all', () => {
		const result = {
			current: { from: NOW - 3_600_000, to: NOW, total: 40 },
			baseline: { from: NOW - 7_200_000, to: NOW - 3_600_000, total: 20 },
			rows: [
				{ patternId: 'p1', template: 'steady <*>', current: 5, baseline: 5, change: 'steady' as const, ratio: 1, sampleId: null },
				{ patternId: 'p2', template: 'boom <*>', current: 9, baseline: 0, change: 'new' as const, ratio: null, sampleId: 'le:1' },
				{ patternId: 'p3', template: 'retry <*>', current: 20, baseline: 4, change: 'rising' as const, ratio: 5, sampleId: null },
			],
			engine: 'clickhouse',
			warnings: [],
		};
		const text = renderCompare(result, { color: false, all: false });
		expect(text).toContain('NEW (1)');
		expect(text).toContain('RISING (1)');
		expect(text.indexOf('NEW (1)')).toBeLessThan(text.indexOf('RISING (1)'));
		expect(text).not.toContain('STEADY');
		expect(text).toContain('5.0x');
		expect(renderCompare(result, { color: false, all: true })).toContain('STEADY (1)');
		expect(renderCompare({ ...result, rows: [result.rows[0]!] }, { color: false, all: false })).toContain('Nothing changed');
	});
});
