import { describe, expect, test } from 'bun:test';
import { nodeDrillLimits } from '@yoal/contracts';
import { OfflineDrill } from './offline-drill.ts';

const T0 = 1_000_000;

describe('OfflineDrill', () => {
	test('is dark from arm until endsAt, then never re-arms the same id', () => {
		const drill = new OfflineDrill();
		expect(drill.active(T0)).toBe(false);
		expect(drill.arm({ id: 'drl_1', endsAt: T0 + 60_000 }, T0)).toBe(true);
		expect(drill.arm({ id: 'drl_1', endsAt: T0 + 60_000 }, T0 + 1)).toBe(false);
		expect(drill.active(T0 + 59_999)).toBe(true);
		expect(drill.remainingMs(T0 + 50_000)).toBe(10_000);
		expect(drill.active(T0 + 60_000)).toBe(false);
		// The control plane's clock may still list it for a moment.
		expect(drill.arm({ id: 'drl_1', endsAt: T0 + 61_000 }, T0 + 60_100)).toBe(false);
		expect(drill.active(T0 + 60_100)).toBe(false);
	});

	test('ignores nothing, an ended window, and caps a far-off end', () => {
		const drill = new OfflineDrill();
		expect(drill.arm(undefined, T0)).toBe(false);
		expect(drill.arm(null, T0)).toBe(false);
		expect(drill.arm({ id: 'drl_old', endsAt: T0 - 1 }, T0)).toBe(false);
		expect(drill.arm({ id: 'drl_far', endsAt: T0 + 24 * 3_600_000 }, T0)).toBe(true);
		expect(drill.remainingMs(T0)).toBe(nodeDrillLimits.maxSeconds * 1000);
	});

	test('a poll without the drill ends it; a poll with it only moves the end earlier', () => {
		const drill = new OfflineDrill();
		drill.arm({ id: 'drl_1', endsAt: T0 + 60_000 }, T0);
		expect(drill.poll({ id: 'drl_1', endsAt: T0 + 120_000 }, T0 + 5_000)).toBe(false);
		expect(drill.remainingMs(T0 + 5_000)).toBe(55_000);
		expect(drill.poll({ id: 'drl_1', endsAt: T0 + 30_000 }, T0 + 10_000)).toBe(false);
		expect(drill.remainingMs(T0 + 10_000)).toBe(20_000);
		expect(drill.poll(null, T0 + 15_000)).toBe(true);
		expect(drill.active(T0 + 15_000)).toBe(false);
		expect(drill.poll(null, T0 + 16_000)).toBe(false);
	});

	test('a different drill in the poll ends the current one', () => {
		const drill = new OfflineDrill();
		drill.arm({ id: 'drl_1', endsAt: T0 + 60_000 }, T0);
		expect(drill.poll({ id: 'drl_2', endsAt: T0 + 60_000 }, T0 + 5_000)).toBe(true);
		expect(drill.id).toBeNull();
	});
});
