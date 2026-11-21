import { describe, expect, test } from 'bun:test';
import { requireIfMatch } from './if-match.ts';

describe('requireIfMatch', () => {
	test('requires the header and refuses a missing generation', () => {
		expect(requireIfMatch(null)).toMatchObject({ ok: false, status: 428 });
		expect(requireIfMatch('  ')).toMatchObject({ ok: false, status: 428 });
		expect(requireIfMatch('not-a-number')).toMatchObject({ ok: false, status: 400 });
		expect(requireIfMatch('-1')).toMatchObject({ ok: false, status: 400 });
	});

	test('accepts a plain or quoted generation, including a weak validator', () => {
		expect(requireIfMatch('3')).toEqual({ ok: true, generation: 3 });
		expect(requireIfMatch('"3"')).toEqual({ ok: true, generation: 3 });
		expect(requireIfMatch('W/"3"')).toEqual({ ok: true, generation: 3 });
		expect(requireIfMatch('0')).toEqual({ ok: true, generation: 0 });
	});
});
