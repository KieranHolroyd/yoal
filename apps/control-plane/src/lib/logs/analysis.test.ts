import { describe, expect, test } from 'bun:test';
import type { LogCompareResult, LogHistogramMarker, LogTableResult } from '@yoal/contracts';
import {
	analyticsShape,
	baselineKey,
	baselineLabel,
	compareGroups,
	deployIdOf,
	patternRows,
	percent,
	ratioLabel,
	sparklinePoints,
	templateParts,
	toQueryResult,
	whySelection
} from './analysis';
import { decodeExplorerState, encodeExplorerState } from './url-state';

const table = (overrides: Partial<LogTableResult>): LogTableResult => ({
	columns: [],
	rows: [],
	engine: 'clickhouse',
	warnings: [],
	elapsedMs: 3,
	...overrides
});

describe('patterns tab', () => {
	const patterns = table({
		columns: [
			{ name: 'pattern', type: 'string' },
			{ name: 'template', type: 'string' },
			{ name: 'count', type: 'number' },
			{ name: 'first_seen', type: 'time' },
			{ name: 'last_seen', type: 'time' }
		],
		rows: [
			['aa', 'GET <PATH> <NUM>', 30, 500, 2_000],
			['bb', 'boom', 10, 1_500, 1_900]
		],
		sampleIds: ['le:1', null],
		sparklines: [
			[1, 2, 3],
			[0, 0, 10]
		]
	});

	test('rows carry share, first seen, new-in-window, sample and sparkline', () => {
		expect(patternRows(patterns, 1_000)).toEqual([
			{
				id: 'aa',
				template: 'GET <PATH> <NUM>',
				count: 30,
				share: 0.75,
				firstSeen: 500,
				lastSeen: 2_000,
				isNew: false,
				sampleId: 'le:1',
				sparkline: [1, 2, 3]
			},
			{
				id: 'bb',
				template: 'boom',
				count: 10,
				share: 0.25,
				firstSeen: 1_500,
				lastSeen: 1_900,
				isNew: true,
				sampleId: null,
				sparkline: [0, 0, 10]
			}
		]);
	});

	test('an older server without sparklines or first_seen still renders', () => {
		const bare = table({
			columns: [
				{ name: 'pattern', type: 'string' },
				{ name: 'count', type: 'number' }
			],
			rows: [['aa', 3]]
		});
		expect(patternRows(bare, 0)[0]).toMatchObject({
			id: 'aa',
			template: 'aa',
			count: 3,
			firstSeen: null,
			isNew: false,
			sparkline: []
		});
	});

	test('template placeholders are split out', () => {
		expect(templateParts('took <NUM>ms for <*>')).toEqual([
			{ text: 'took ', placeholder: false },
			{ text: '<NUM>', placeholder: true },
			{ text: 'ms for ', placeholder: false },
			{ text: '<*>', placeholder: true }
		]);
	});

	test('sparkline points span the box with the max at the top', () => {
		expect(sparklinePoints([0, 4, 2], 10, 9)).toBe('0.0,8.5 5.0,0.5 10.0,4.5');
		expect(sparklinePoints([], 10, 9)).toBe('');
	});
});

describe('analytics tab', () => {
	const stats = table({
		columns: [
			{ name: 'bin(1m)', type: 'time' },
			{ name: 'level', type: 'string' },
			{ name: 'count', type: 'number' }
		],
		rows: [
			[0, 'info', 5],
			[0, 'error', '1'],
			[120_000, 'info', 3]
		]
	});

	test('binned stats are a time series; small groups are bars; the rest a table', () => {
		expect(analyticsShape(stats)).toBe('time');
		expect(
			analyticsShape(
				table({
					columns: [
						{ name: 'route', type: 'string' },
						{ name: 'p95', type: 'number' }
					],
					rows: [['/a', 1]]
				})
			)
		).toBe('category');
		expect(
			analyticsShape(table({ columns: [{ name: 'body', type: 'string' }], rows: [['x']] }))
		).toBe('table');
		expect(analyticsShape({ ...stats, rows: [] })).toBe('table');
	});

	test('a table becomes a dashboards QueryResult with the bin interval', () => {
		const result = toQueryResult(stats);
		expect(result.columns.map((column) => column.kind)).toEqual(['time', 'string', 'number']);
		expect(result.intervalSeconds).toBe(120);
		expect(result.rows[1]).toEqual([0, 'error', 1]);
		expect(result.stats.elapsedMs).toBe(3);
	});
});

describe('compare tab', () => {
	const result: LogCompareResult = {
		current: { from: 0, to: 1, total: 10 },
		baseline: { from: -1, to: 0, total: 10 },
		engine: 'clickhouse',
		warnings: [],
		rows: [
			{
				patternId: 's',
				template: 's',
				current: 5,
				baseline: 5,
				change: 'steady',
				ratio: 1,
				sampleId: null
			},
			{
				patternId: 'g',
				template: 'g',
				current: 0,
				baseline: 4,
				change: 'gone',
				ratio: 0,
				sampleId: null
			},
			{
				patternId: 'n',
				template: 'n',
				current: 3,
				baseline: 0,
				change: 'new',
				ratio: null,
				sampleId: 'le:1'
			},
			{
				patternId: 'r',
				template: 'r',
				current: 42,
				baseline: 10,
				change: 'rising',
				ratio: 4.2,
				sampleId: null
			}
		]
	};

	test('groups in the order new, rising, falling, gone, steady (empty groups left out)', () => {
		expect(
			compareGroups(result).map((group) => [group.label, group.rows.map((row) => row.patternId)])
		).toEqual([
			['New', ['n']],
			['Rising', ['r']],
			['Gone', ['g']],
			['Steady', ['s']]
		]);
	});

	test('ratio labels', () => {
		expect(result.rows.map(ratioLabel)).toEqual(['×1.0', 'gone', 'new', '×4.2']);
		expect(ratioLabel({ ...result.rows[0]!, ratio: 0.25 })).toBe('×0.25');
		expect(ratioLabel({ ...result.rows[0]!, ratio: 31.4 })).toBe('×31');
	});

	test('baseline keys and labels', () => {
		const marker: LogHistogramMarker = {
			ts: 5,
			kind: 'deploy',
			label: 'Deploy d7 · shop',
			href: '/projects/shop/deployments/dep_7',
			scope: null
		};
		expect(deployIdOf(marker)).toBe('dep_7');
		expect(deployIdOf({ ...marker, kind: 'alert' })).toBeNull();
		expect(baselineKey({ kind: 'offset', offsetMs: 86_400_000 })).toBe('yesterday');
		expect(baselineKey({ kind: 'offset', offsetMs: 3_600_000 })).toBe('offset');
		expect(baselineLabel({ kind: 'previous' }, 'utc')).toBe('Previous window');
		expect(baselineLabel({ kind: 'offset', offsetMs: 7 * 86_400_000 }, 'utc')).toBe(
			'Same time last week'
		);
		expect(baselineLabel({ kind: 'offset', offsetMs: 2 * 86_400_000 }, 'utc')).toBe(
			'2 days earlier'
		);
		expect(baselineLabel({ kind: 'deploy', deploymentId: 'dep_7' }, 'utc', [marker])).toBe(
			'Before Deploy d7 · shop'
		);
		expect(baselineLabel({ kind: 'range', from: 0, to: 60_000 }, 'utc')).toBe(
			'1970-01-01 00:00:00 → 1970-01-01 00:01:00'
		);
	});

	test('the URL carries mode=compare&baseline=… and leaves the default out', () => {
		const decoded = decodeExplorerState(new URLSearchParams('mode=compare&baseline=deploy:dep_7'));
		expect(decoded.mode).toBe('compare');
		expect(decoded.baseline).toEqual({ kind: 'deploy', deploymentId: 'dep_7' });
		expect(encodeExplorerState(decoded).toString()).toBe('mode=compare&baseline=deploy%3Adep_7');
		expect(encodeExplorerState({ ...decoded, baseline: { kind: 'previous' } }).toString()).toBe(
			'mode=compare'
		);
		expect(decodeExplorerState(new URLSearchParams('baseline=soon')).baseline).toBeUndefined();
		const prefixed = encodeExplorerState(
			{ ...decoded, baseline: { kind: 'offset', offsetMs: 86_400_000 } },
			{ prefix: 'log_' }
		);
		expect(prefixed.get('log_baseline')).toBe('offset:86400000');
	});
});

describe('why panel', () => {
	test('percentages and selections', () => {
		expect(percent(0.92)).toBe('92%');
		expect(percent(0.004)).toBe('0.4%');
		expect(percent(0)).toBe('0%');
		expect(whySelection(5_400.7, 1_200.2)).toEqual({ from: 1_200, to: 5_401 });
		expect(whySelection(1_000, 1_100)).toEqual({ from: 1_000, to: 2_000 });
	});
});
