import { describe, expect, test } from 'bun:test';
import { SWITCHOVER_BUDGET_MS, runSwitchover, type SwitchoverTransport } from './database-switchover.ts';
import { parseLsn } from './database-sync.ts';

/**
 * Planned switchover (W10): checkpoint → stop writes → wait for LSN equality → promote → re-point.
 * Writes are resumed on every refusal. The load test models 100 switchovers with commits arriving
 * until writes stop; every acknowledged commit must be on the new primary and each run must stay
 * inside the 5 s budget.
 */

function lsn(value: bigint): string {
	return `0/${value.toString(16).toUpperCase()}`;
}

interface Fake extends SwitchoverTransport {
	writesStopped: boolean;
	resumed: number;
	promoted: boolean;
	commits: bigint[];
	replica: bigint;
	clock: { now: number };
	repointed: string | null;
}

function fake(options: { start: bigint; writeRate?: number; replayAfterPolls?: number; stall?: boolean; shortPromote?: boolean }): Fake {
	const clock = { now: 0 };
	const state: Fake = {
		writesStopped: false,
		resumed: 0,
		promoted: false,
		commits: [options.start],
		replica: options.start,
		clock,
		repointed: null,
		async checkpoint() {
			clock.now += 100;
			// A last batch of commits lands between the checkpoint and the stop, as under load.
			const extra = options.writeRate ?? 3;
			for (let index = 0; index < extra; index += 1) {
				options.start += 1n;
				state.commits.push(options.start);
			}
			if (!options.stall) state.replica = options.start;
		},
		async stopWrites() {
			clock.now += 50;
			state.writesStopped = true;
		},
		async resumeWrites() {
			clock.now += 20;
			state.resumed += 1;
			state.writesStopped = false;
		},
		async primaryLsn() {
			return lsn(options.start);
		},
		async replicaReplayLsn() {
			clock.now += 10;
			if (options.stall) return lsn(state.replica);
			if (state.replica < options.start) state.replica = options.start;
			return lsn(state.replica);
		},
		async promote() {
			clock.now += 300;
			state.promoted = true;
			return lsn(options.shortPromote ? state.replica - 1n : state.replica);
		},
		async repoint(value) {
			clock.now += 150;
			state.repointed = value;
		},
	};
	return state;
}

const noSleep = async () => undefined;

describe('planned switchover', () => {
	test('100 switchovers under load lose no acknowledged commit and stay within 5 s', async () => {
		let lsnValue = 0x1000000n;
		const durations: number[] = [];
		for (let run = 0; run < 100; run += 1) {
			const transport = fake({ start: lsnValue, writeRate: 1 + (run % 7) });
			const result = await runSwitchover({
				transport,
				now: () => transport.clock.now,
				sleep: noSleep,
			});
			expect(result.ok).toBe(true);
			expect(result.step).toBe('done');
			expect(transport.resumed).toBe(0);
			expect(transport.promoted).toBe(true);
			expect(transport.writesStopped).toBe(true);
			// The replica has the primary's last LSN, i.e. every acknowledged commit.
			expect(result.replayLsn).toBe(result.primaryLsn);
			expect(result.gapBytes).toBe(0);
			expect(result.durationMs).toBeLessThanOrEqual(SWITCHOVER_BUDGET_MS);
			expect(result.withinBudget).toBe(true);
			durations.push(result.durationMs!);
			lsnValue = parseLsn(result.primaryLsn!)! + 1n;
		}
		// A measured distribution is part of the exit evidence: no run exceeded the budget.
		expect(Math.max(...durations)).toBeLessThanOrEqual(SWITCHOVER_BUDGET_MS);
	});

	test('a replica that never catches up is refused, writes resume and nothing is promoted', async () => {
		const transport = fake({ start: 0x2000000n, stall: true });
		const result = await runSwitchover({ transport, now: () => transport.clock.now, sleep: noSleep, waitMs: 500 });
		expect(result.ok).toBe(false);
		expect(result.step).toBe('wait-lsn');
		expect(result.gapBytes).toBeGreaterThan(0);
		expect(transport.promoted).toBe(false);
		expect(transport.resumed).toBe(1);
		expect(transport.writesStopped).toBe(false);
		expect(result.withinBudget).toBe(false);
	});

	test('a promoted LSN behind the primary is a refusal, never a silent success', async () => {
		const transport = fake({ start: 0x3000000n, shortPromote: true });
		const result = await runSwitchover({ transport, now: () => transport.clock.now, sleep: noSleep });
		expect(result.ok).toBe(false);
		expect(result.step).toBe('promote');
		expect(result.gapBytes).toBe(1);
		expect(transport.resumed).toBe(1);
		expect(transport.repointed).toBeNull();
	});

	test('a transport failure after writes stop resumes them before returning', async () => {
		const transport = fake({ start: 0x4000000n });
		transport.primaryLsn = async () => {
			throw new Error('psql went away');
		};
		const result = await runSwitchover({ transport, now: () => transport.clock.now, sleep: noSleep });
		expect(result.ok).toBe(false);
		expect(result.message).toContain('psql went away');
		expect(transport.resumed).toBe(1);
		expect(transport.promoted).toBe(false);
	});

	test('a checkpoint failure happens before writes stop, so nothing needs resuming', async () => {
		const transport = fake({ start: 0x5000000n });
		transport.checkpoint = async () => {
			throw new Error('checkpoint refused');
		};
		const result = await runSwitchover({ transport, now: () => transport.clock.now, sleep: noSleep });
		expect(result.ok).toBe(false);
		expect(result.step).toBe('checkpoint');
		expect(transport.resumed).toBe(0);
		expect(transport.writesStopped).toBe(false);
	});
});
