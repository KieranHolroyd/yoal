import { describe, expect, test } from 'bun:test';
import { LameDuck } from './lame-duck.ts';

function harness(drainSeconds = 20) {
	const events: string[] = [];
	let clock = 1_000;
	const duck = new LameDuck({
		drainSeconds: () => drainSeconds,
		now: () => clock,
		wait: async (ms) => {
			events.push(`wait:${ms}`);
			clock += ms;
		},
		onChange: (draining) => {
			events.push(draining ? '503-while-serving' : 'serving');
		},
	});
	return { duck, events, advance: (ms: number) => (clock += ms) };
}

describe('ingress lame duck (HA-PLAN H19)', () => {
	test('answers 503 for drainSeconds while still serving, then the caller stops', async () => {
		const { duck, events } = harness(20);
		const run = duck.begin('shutdown').then(() => events.push('stop-caddy'));
		expect(duck.draining).toBe(true);
		// The 503 is visible before the drain completes, and nothing stops until it resolves.
		await Promise.resolve();
		expect(events[0]).toBe('503-while-serving');
		expect(events).not.toContain('stop-caddy');
		await run;
		expect(events).toEqual(['503-while-serving', 'wait:20000', 'stop-caddy']);
	});

	test('zero seconds still flips the state before stopping', async () => {
		const { duck, events } = harness(0);
		await duck.begin('update');
		events.push('stop-caddy');
		expect(events).toEqual(['503-while-serving', 'stop-caddy']);
	});

	test('is idempotent: a signal racing a role removal shares one drain', async () => {
		const { duck } = harness(20);
		const first = duck.begin('role-removal');
		const second = duck.begin('shutdown');
		expect(second).toBe(first);
		await Promise.all([first, second]);
	});

	test('reset leaves the lame duck when the stop did not happen', async () => {
		const { duck, events } = harness(5);
		await duck.begin('update');
		await duck.reset();
		expect(duck.draining).toBe(false);
		expect(events).toEqual(['503-while-serving', 'wait:5000', 'serving']);
	});
});
