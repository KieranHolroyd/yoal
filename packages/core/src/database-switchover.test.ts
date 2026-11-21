import { describe, expect, test } from 'bun:test';
import { SWITCHOVER_BUDGET_MS, runSwitchover, type SwitchoverTransport } from './database-switchover.ts';
import { parseLsn } from './database-sync.ts';

/**
 * Planned switchover (W10): checkpoint → stop writes → quiesce → wait for LSN equality → promote →
 * re-point. Writes are resumed on every refusal, and never after a promotion succeeded.
 *
 * The harness can now lose a commit: `stopWrites` leaves one transaction in flight, and it commits
 * only when the transport is quiesced. If the switchover samples the LSN before quiescing, the
 * sample is below an acknowledged commit and the promotion loses it. The 100-run test asserts the
 * opposite; the negative-control test below deliberately skips quiescence and proves the harness
 * detects the loss, so the assertion is not self-fulfilling.
 *
 * Durations here are from a simulated clock (`now` is the fake's counter), so the ≤ 5 s bound is
 * the plan's budget checked against the model, not wall time. The wall-time claim needs a live
 * fleet and is not made by this test.
 */

function lsn(value: bigint): string {
	return `0/${value.toString(16).toUpperCase()}`;
}

interface Fake extends SwitchoverTransport {
	writesStopped: boolean;
	resumed: number;
	promoted: boolean;
	promotedLsn: bigint | null;
	acked: bigint;
	committed: bigint;
	replica: bigint;
	clock: { now: number };
	repointed: string | null;
}

interface FakeOptions {
	start: bigint;
	/** Commits that land between the checkpoint and the stop, as under load. */
	writeRate?: number;
	/** The replica never catches up. */
	stall?: boolean;
	/** The promoted replica reports one byte behind the primary. */
	shortPromote?: boolean;
	/** Simulate a transport that returns from stop-writes without waiting (the defect). */
	skipQuiesce?: boolean;
}

function fake(options: FakeOptions): Fake {
	const clock = { now: 0 };
	let inflight: bigint | null = null;
	const state: Fake = {
		writesStopped: false,
		resumed: 0,
		promoted: false,
		promotedLsn: null,
		acked: options.start,
		committed: options.start,
		replica: options.start,
		clock,
		repointed: null,
		async checkpoint() {
			clock.now += 100;
			const extra = options.writeRate ?? 3;
			for (let index = 0; index < extra; index += 1) {
				state.committed += 1n;
				state.acked = state.committed;
			}
			if (!options.stall) state.replica = state.committed;
		},
		async stopWrites() {
			clock.now += 50;
			state.writesStopped = true;
			// A transaction that began before read-only was applied. It is acknowledged to its client
			// when it commits, which is exactly the window a pre-quiesce LSN sample misses.
			inflight = state.committed + 1n;
		},
		async quiesceWrites() {
			clock.now += 40;
			if (options.skipQuiesce) return;
			if (inflight !== null) {
				state.committed = inflight;
				state.acked = inflight;
				inflight = null;
			}
		},
		async resumeWrites() {
			clock.now += 20;
			state.resumed += 1;
			state.writesStopped = false;
		},
		async primaryLsn() {
			return lsn(state.committed);
		},
		async replicaReplayLsn() {
			clock.now += 10;
			if (options.stall) return lsn(state.replica);
			if (state.replica < state.committed) state.replica = state.committed;
			return lsn(state.replica);
		},
		async promote() {
			clock.now += 300;
			// Without quiescence, the in-flight transaction commits only now, after the sample: the
			// promotion is about to lose an acknowledged commit.
			if (inflight !== null) {
				state.committed = inflight;
				state.acked = inflight;
				inflight = null;
			}
			state.promoted = true;
			const promoted = options.shortPromote ? state.replica - 1n : state.replica;
			state.promotedLsn = promoted;
			return lsn(promoted);
		},
		async repoint(value) {
			clock.now += 150;
			state.repointed = value;
		},
	};
	return state;
}

/** Every acknowledged commit is at or below the promoted replica's position. */
function lostCommits(transport: Fake): bigint {
	const promoted = transport.promotedLsn ?? 0n;
	return transport.acked > promoted ? transport.acked - promoted : 0n;
}

const noSleep = async () => undefined;

describe('planned switchover', () => {
	test('100 simulated switchovers under load lose no acknowledged commit (simulated clock)', async () => {
		let lsnValue = 0x1000000n;
		const durations: number[] = [];
		for (let run = 0; run < 100; run += 1) {
			const transport = fake({ start: lsnValue, writeRate: 1 + (run % 7) });
			const result = await runSwitchover({ transport, now: () => transport.clock.now, sleep: noSleep });
			expect(result.ok).toBe(true);
			expect(result.step).toBe('done');
			expect(result.promoted).toBe(true);
			expect(transport.resumed).toBe(0);
			expect(transport.writesStopped).toBe(true);
			// The replica reached the primary's final LSN, which includes the in-flight commit.
			expect(result.replayLsn).toBe(result.primaryLsn);
			expect(parseLsn(result.primaryLsn!)).toBe(transport.acked);
			expect(result.gapBytes).toBe(0);
			// The harness fails here if the implementation sampled before quiescence.
			expect(lostCommits(transport)).toBe(0n);
			expect(result.durationMs).toBeLessThanOrEqual(SWITCHOVER_BUDGET_MS);
			expect(result.withinBudget).toBe(true);
			durations.push(result.durationMs);
			lsnValue = parseLsn(result.primaryLsn!)! + 1n;
		}
		expect(Math.max(...durations)).toBeLessThanOrEqual(SWITCHOVER_BUDGET_MS);
	});

	test('the harness can lose an in-flight commit: skipping quiescence loses one', async () => {
		const transport = fake({ start: 0x1A00000n, skipQuiesce: true });
		const result = await runSwitchover({ transport, now: () => transport.clock.now, sleep: noSleep });
		// The pure function cannot see inside the transport, so it reports success from the stale
		// sample; the loss detector is what catches the defect, which is the point of the harness.
		expect(result.ok).toBe(true);
		expect(lostCommits(transport)).toBeGreaterThan(0n);
		expect(transport.acked).toBeGreaterThan(transport.promotedLsn!);
	});

	test('a replica that never catches up is refused, writes resume and nothing is promoted', async () => {
		const transport = fake({ start: 0x2000000n, stall: true });
		const result = await runSwitchover({ transport, now: () => transport.clock.now, sleep: noSleep, waitMs: 500 });
		expect(result.ok).toBe(false);
		expect(result.promoted).toBe(false);
		expect(result.step).toBe('wait-lsn');
		expect(result.gapBytes).toBeGreaterThan(0);
		expect(transport.promoted).toBe(false);
		expect(transport.resumed).toBe(1);
		expect(transport.writesStopped).toBe(false);
		expect(result.withinBudget).toBe(false);
	});

	test('a promoted LSN behind the primary is reported, and the old primary is not resumed', async () => {
		const transport = fake({ start: 0x3000000n, shortPromote: true });
		const result = await runSwitchover({ transport, now: () => transport.clock.now, sleep: noSleep });
		expect(result.ok).toBe(false);
		expect(result.promoted).toBe(true);
		expect(result.gapBytes).toBe(1);
		// Blocker 5: after a successful promote, resuming the old primary would create two primaries.
		expect(transport.resumed).toBe(0);
		expect(transport.repointed).toBeNull();
	});

	test('a quiesce failure refuses before promotion and resumes writes', async () => {
		const transport = fake({ start: 0x3500000n });
		transport.quiesceWrites = async () => {
			throw new Error('in-flight transactions did not finish');
		};
		const result = await runSwitchover({ transport, now: () => transport.clock.now, sleep: noSleep });
		expect(result.ok).toBe(false);
		expect(result.promoted).toBe(false);
		expect(result.step).toBe('quiesce');
		expect(transport.promoted).toBe(false);
		expect(transport.resumed).toBe(1);
	});

	test('a transport failure after writes stop resumes them before returning', async () => {
		const transport = fake({ start: 0x4000000n });
		transport.primaryLsn = async () => {
			throw new Error('psql went away');
		};
		const result = await runSwitchover({ transport, now: () => transport.clock.now, sleep: noSleep });
		expect(result.ok).toBe(false);
		expect(result.promoted).toBe(false);
		expect(result.message).toContain('psql went away');
		expect(transport.resumed).toBe(1);
		expect(transport.promoted).toBe(false);
	});

	test('a re-point failure after promotion is promoted-but-not-repointed and never resumes', async () => {
		const transport = fake({ start: 0x4500000n });
		transport.repoint = async () => {
			throw new Error('consumer re-point failed');
		};
		const result = await runSwitchover({ transport, now: () => transport.clock.now, sleep: noSleep });
		expect(result.ok).toBe(false);
		expect(result.promoted).toBe(true);
		expect(result.step).toBe('repoint');
		expect(result.message).toContain('re-point failed');
		expect(transport.resumed).toBe(0);
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
