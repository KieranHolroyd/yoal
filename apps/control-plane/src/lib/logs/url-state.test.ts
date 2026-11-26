import { describe, expect, test } from 'bun:test';
import { decodeExplorerState, encodeExplorerState, type ExplorerUrlState } from './url-state';

const state = (overrides: Partial<ExplorerUrlState> = {}): ExplorerUrlState => ({
	q: '',
	scopes: [],
	time: { kind: 'relative', value: '1h' },
	mode: 'stream',
	row: null,
	tz: 'utc',
	live: false,
	...overrides
});

describe('explorer URL state', () => {
	test('an empty URL decodes to the defaults', () => {
		expect(decodeExplorerState(new URLSearchParams())).toEqual(state());
	});

	test('defaults are left out of the URL', () => {
		expect(encodeExplorerState(state()).toString()).toBe('');
	});

	test('a full investigation round-trips', () => {
		const full = state({
			q: 'level:error -@path:/health "timeout" | stats count() by bin(1m)',
			scopes: [
				{ kind: 'project', id: 'prj_1' },
				{ kind: 'database', id: 'db_2' }
			],
			time: {
				kind: 'absolute',
				from: Date.UTC(2026, 10, 25, 14, 0),
				to: Date.UTC(2026, 10, 25, 14, 5)
			},
			mode: 'analytics',
			row: 'le:42',
			tz: 'local',
			live: true
		});
		const params = encodeExplorerState(full);
		expect(params.getAll('scope')).toEqual(['project:prj_1', 'database:db_2']);
		expect(params.get('from')).toBe('2026-11-25T14:00:00.000Z');
		expect(decodeExplorerState(new URLSearchParams(params.toString()))).toEqual(full);
	});

	test('relative ranges use `range`', () => {
		const params = encodeExplorerState(state({ time: { kind: 'relative', value: '24h' } }));
		expect(params.toString()).toBe('range=24h');
		expect(decodeExplorerState(params).time).toEqual({ kind: 'relative', value: '24h' });
	});

	test('an open-ended window encodes `to=now`', () => {
		const time = { kind: 'absolute' as const, from: 1_700_000_000_000, to: null };
		const params = encodeExplorerState(state({ time }));
		expect(params.get('to')).toBe('now');
		expect(decodeExplorerState(params).time).toEqual(time);
		// A missing `to` also means "until now".
		expect(decodeExplorerState(new URLSearchParams('from=1700000000000')).time).toEqual(time);
	});

	test('epoch milliseconds are accepted as well as ISO times', () => {
		const decoded = decodeExplorerState(new URLSearchParams('from=1000&to=2000'));
		expect(decoded.time).toEqual({ kind: 'absolute', from: 1000, to: 2000 });
	});

	test('reversed bounds are put in order', () => {
		const decoded = decodeExplorerState(new URLSearchParams('from=2000&to=1000'));
		expect(decoded.time).toEqual({ kind: 'absolute', from: 1000, to: 2000 });
	});

	test('junk values fall back to the defaults', () => {
		const decoded = decodeExplorerState(
			new URLSearchParams('range=forever&mode=dance&tz=mars&scope=nope&scope=galaxy:1&live=maybe')
		);
		expect(decoded).toEqual(state());
	});

	test('duplicate scopes collapse', () => {
		const decoded = decodeExplorerState(
			new URLSearchParams('scope=project:a&scope=project:a&scope=broker:b')
		);
		expect(decoded.scopes).toEqual([
			{ kind: 'project', id: 'a' },
			{ kind: 'broker', id: 'b' }
		]);
	});

	test('a prefix keeps the page’s own parameters intact', () => {
		const base = new URLSearchParams('tab=logs&range=7d&log_q=old');
		const params = encodeExplorerState(
			state({ q: 'timeout', time: { kind: 'relative', value: '15m' } }),
			{
				prefix: 'log_',
				base
			}
		);
		expect(params.get('tab')).toBe('logs');
		expect(params.get('range')).toBe('7d');
		expect(params.get('log_q')).toBe('timeout');
		expect(params.get('log_range')).toBe('15m');
		const decoded = decodeExplorerState(params, { prefix: 'log_' });
		expect(decoded.q).toBe('timeout');
		expect(decoded.time).toEqual({ kind: 'relative', value: '15m' });
	});

	test('custom defaults are omitted and restored', () => {
		const defaults = { time: { kind: 'relative' as const, value: '7d' }, live: true };
		const params = encodeExplorerState(state(defaults), { defaults });
		expect(params.toString()).toBe('');
		expect(decodeExplorerState(params, { defaults })).toEqual(state(defaults));
		// Turning live off against a live default is written explicitly.
		expect(encodeExplorerState(state({ ...defaults, live: false }), { defaults }).get('live')).toBe(
			'0'
		);
	});

	test('stale keys are removed on encode', () => {
		const base = new URLSearchParams('from=1&to=2&row=le:1&other=x');
		const params = encodeExplorerState(state(), { base });
		expect(params.toString()).toBe('other=x');
	});

	test('an empty row clears the selection', () => {
		expect(decodeExplorerState(new URLSearchParams('row=')).row).toBeNull();
	});
});
