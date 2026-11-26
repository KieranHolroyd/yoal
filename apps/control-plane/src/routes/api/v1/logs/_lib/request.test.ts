import { describe, expect, test } from 'bun:test';
import { logInput, logInputFromBody, logInputFromQuery } from './request';

const NOW = 1_800_000_000_000;

describe('logs API request decoding', () => {
	test('GET: repeated scope=kind:id, numbers, ISO times and paging fields', () => {
		const params = new URLSearchParams(
			'q=level:error&scope=project:prj_1&scope=database:db_1&from=2026-11-25T10:00:00Z&to=1800000000000&limit=50&cursor=p.abc&order=asc',
		);
		expect(logInputFromQuery(params, 'search', NOW)).toEqual({
			q: 'level:error',
			scopes: [
				{ kind: 'project', id: 'prj_1' },
				{ kind: 'database', id: 'db_1' },
			],
			from: Date.parse('2026-11-25T10:00:00Z'),
			to: 1_800_000_000_000,
			limit: 50,
			cursor: 'p.abc',
			order: 'asc',
		});
	});

	test('range resolves to bounds unless from/to are given', () => {
		expect(logInputFromQuery(new URLSearchParams('range=15m'), 'read', NOW)).toMatchObject({ from: NOW - 900_000, to: NOW });
		expect(logInputFromQuery(new URLSearchParams('range=15m&from=5'), 'read', NOW)).toMatchObject({ from: 5 });
		expect(() => logInputFromQuery(new URLSearchParams('range=forever'), 'read', NOW)).toThrow(/Invalid range/);
	});

	test('a malformed scope or number is a validation failure, never a silent default', () => {
		expect(() => logInputFromQuery(new URLSearchParams('scope=nope'), 'read', NOW)).toThrow(/Invalid scope/);
		expect(() => logInputFromQuery(new URLSearchParams('scope=galaxy:x'), 'read', NOW)).toThrow(/Invalid scope/);
		expect(logInputFromQuery(new URLSearchParams('limit=lots'), 'search', NOW).limit).toBe('lots');
	});

	test('per-endpoint fields: histogram buckets, fields + topValues, context id', () => {
		expect(logInputFromQuery(new URLSearchParams('buckets=30&limit=5'), 'histogram', NOW)).toEqual({ q: '', scopes: [], buckets: 30 });
		expect(logInputFromQuery(new URLSearchParams('field=level&field=service&topValues=5'), 'fields', NOW)).toMatchObject({
			fields: ['level', 'service'],
			topValues: 5,
		});
		expect(logInputFromQuery(new URLSearchParams('id=le:4&before=10'), 'context', NOW)).toEqual({ id: 'le:4', before: 10 });
	});

	test('POST: body as-is, with kind:id scope strings and range accepted', () => {
		expect(logInputFromBody({ q: 'x', scopes: ['project:prj_1', { kind: 'broker', id: 'brk_1' }], range: { relative: '1h' } }, 'search', NOW)).toEqual({
			q: 'x',
			scopes: [
				{ kind: 'project', id: 'prj_1' },
				{ kind: 'broker', id: 'brk_1' },
			],
			from: NOW - 3_600_000,
			to: NOW,
		});
		expect(() => logInputFromBody([1], 'search', NOW)).toThrow(/JSON object/);
	});

	test('logInput picks the query string for GET and the body for POST', async () => {
		const url = new URL('https://control.test/api/v1/logs/search?q=from-query');
		expect((await logInput(new Request(url), url, 'search', NOW)).q).toBe('from-query');
		const post = new Request(url, { method: 'POST', body: JSON.stringify({ q: 'from-body' }) });
		expect((await logInput(post, url, 'search', NOW)).q).toBe('from-body');
		const broken = new Request(url, { method: 'POST', body: '{nope' });
		await expect(logInput(broken, url, 'search', NOW)).rejects.toMatchObject({ code: 'invalid_json', status: 400 });
	});
});
