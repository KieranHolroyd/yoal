import { describe, expect, test } from 'bun:test';
import { logCompareInputSchema, logWhyInputSchema } from '@yoal/contracts';
import { analysisInput, analysisInputFromQuery } from './analysis';

const NOW = 1_800_000_000_000;

describe('compare / why request decoding', () => {
	test('GET compare: the URL baseline forms, defaulting to previous', () => {
		const decoded = analysisInputFromQuery(
			new URLSearchParams(
				'q=level:error&scope=project:prj_1&range=1h&baseline=deploy:dep_1&limit=20'
			),
			'compare',
			NOW
		);
		expect(decoded).toEqual({
			q: 'level:error',
			scopes: [{ kind: 'project', id: 'prj_1' }],
			from: NOW - 3_600_000,
			to: NOW,
			limit: 20,
			baseline: { kind: 'deploy', deploymentId: 'dep_1' }
		});
		expect(logCompareInputSchema.safeParse(decoded).success).toBe(true);
		expect(analysisInputFromQuery(new URLSearchParams(''), 'compare', NOW).baseline).toEqual({
			kind: 'previous'
		});
		expect(
			analysisInputFromQuery(new URLSearchParams('baseline=offset:1d'), 'compare', NOW).baseline
		).toEqual({
			kind: 'offset',
			offsetMs: 86_400_000
		});
		expect(
			analysisInputFromQuery(new URLSearchParams('baseline=range:1-2'), 'compare', NOW).baseline
		).toEqual({
			kind: 'range',
			from: 1,
			to: 2
		});
	});

	test('GET why: selection and repeated fields', () => {
		const decoded = analysisInputFromQuery(
			new URLSearchParams('from=1000&to=9000&selection=2000-3000&field=node&field=@http.route'),
			'why',
			NOW
		);
		expect(decoded).toEqual({
			q: '',
			scopes: [],
			from: 1_000,
			to: 9_000,
			selection: { from: 2_000, to: 3_000 },
			fields: ['node', '@http.route']
		});
		expect(logWhyInputSchema.safeParse(decoded).success).toBe(true);
	});

	test('malformed baselines, selections and limits are 422s, never silent defaults', () => {
		expect(() =>
			analysisInputFromQuery(new URLSearchParams('baseline=yesterday'), 'compare', NOW)
		).toThrow(/Invalid baseline/);
		expect(() => analysisInputFromQuery(new URLSearchParams(''), 'why', NOW)).toThrow(
			/Invalid selection/
		);
		expect(() => analysisInputFromQuery(new URLSearchParams('selection=a-b'), 'why', NOW)).toThrow(
			/Invalid selection/
		);
		const lots = analysisInputFromQuery(new URLSearchParams('limit=lots'), 'compare', NOW);
		expect(lots.limit).toBe('lots');
		expect(logCompareInputSchema.safeParse(lots).success).toBe(false);
	});

	test('POST: the contract body, with the baseline also accepted as its URL string', async () => {
		const url = new URL('https://control.test/api/v1/logs/compare');
		const post = (body: unknown) =>
			new Request(url, { method: 'POST', body: JSON.stringify(body) });
		expect(
			await analysisInput(
				post({ baseline: { kind: 'offset', offsetMs: 5 }, range: '15m' }),
				url,
				'compare',
				NOW
			)
		).toEqual({
			baseline: { kind: 'offset', offsetMs: 5 },
			from: NOW - 900_000,
			to: NOW
		});
		expect(
			(await analysisInput(post({ baseline: 'previous' }), url, 'compare', NOW)).baseline
		).toEqual({ kind: 'previous' });
		await expect(
			analysisInput(post({ baseline: 'soon' }), url, 'compare', NOW)
		).rejects.toMatchObject({ status: 422 });
		const why = await analysisInput(
			post({ selection: { from: 1, to: 2 }, scopes: ['project:prj_1'] }),
			url,
			'why',
			NOW
		);
		expect(why).toEqual({
			selection: { from: 1, to: 2 },
			scopes: [{ kind: 'project', id: 'prj_1' }]
		});
	});
});
