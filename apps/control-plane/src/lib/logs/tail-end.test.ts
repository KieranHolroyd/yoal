import { describe, expect, test } from 'bun:test';
import { tailEndIsRoutine } from './tail-end';

describe('tailEndIsRoutine', () => {
	test('only the lifetime close reconnects silently', () => {
		expect(tailEndIsRoutine({ reason: 'This live tail reached its time limit; reconnecting.', code: 'max_lifetime' })).toBe(true);
		expect(tailEndIsRoutine({ reason: 'The log stream failed.' })).toBe(false);
		expect(tailEndIsRoutine(null)).toBe(false);
	});
});
