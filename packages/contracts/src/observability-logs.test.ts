import { describe, expect, test } from 'bun:test';
import { logsBuilderFromQuery, logsBuilderQuery } from './observability-logs.ts';
import { builderSpecSchema } from './observability.ts';

/** "Add to dashboard" from the Explorer: an Analytics query ↔ a `logs` builder spec (docs/LOGS.md §8.4, §9.2). */

const scopes = [{ kind: 'project' as const, id: 'prj_1' }];

describe('logsBuilderFromQuery', () => {
	test('the Analytics default (count by bin and level) becomes a time series that compiles back to the same query', () => {
		const result = logsBuilderFromQuery('level:warn | stats count() by bin(5m), level', scopes);
		if (!result.ok) throw new Error(result.error);
		expect(result.viz).toBe('timeseries');
		expect(result.builder).toMatchObject({
			dataset: 'logs',
			metrics: [{ field: 'count', agg: 'count' }],
			groupBy: ['level'],
			timeSeries: true,
			interval: '5m',
			logs: { q: 'level:warn', scopes }
		});
		expect(builderSpecSchema.safeParse(result.builder).success).toBe(true);
		const back = logsBuilderQuery(result.builder, 300_000);
		expect(back.ok && back.q).toBe('level:warn | stats count() by bin(5m) as time, level');
	});

	test('distinct counts by an attribute become a bar chart; a lone count is a stat', () => {
		const bar = logsBuilderFromQuery('| stats count_distinct(@user.id) as users by @http.route | sort users desc | limit 10', []);
		expect(bar).toMatchObject({
			ok: true,
			viz: 'bar',
			builder: { metrics: [{ field: 'count_distinct', of: '@user.id', alias: 'users' }], groupBy: ['@http.route'], limit: 10, timeSeries: false }
		});
		expect(logsBuilderFromQuery('source:access | stats count()', [])).toMatchObject({ ok: true, viz: 'stat' });
	});

	test('what a builder cannot express is an error', () => {
		expect(logsBuilderFromQuery('level:error', [])).toMatchObject({ ok: false });
		expect(logsBuilderFromQuery('| patterns', [])).toMatchObject({ ok: false });
		expect(logsBuilderFromQuery('| stats p95(@duration_ms) by bin(1m)', [])).toMatchObject({ ok: false });
		expect(logsBuilderFromQuery('| stats count() | fields count', [])).toMatchObject({ ok: false });
	});
});
