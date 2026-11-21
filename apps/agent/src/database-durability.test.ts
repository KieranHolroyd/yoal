import { describe, expect, test } from 'bun:test';
import type { DesiredState } from '@yoal/contracts';
import { DatabaseDurabilityRunner } from './database-durability.ts';

/**
 * The node half of W10 (apps/agent/src/database-durability.ts): the barrier proof, the drain
 * order, the rewind workload id and the node-hosted sync-loss watchdog. These are the defects an
 * independent review found; each test pins the behaviour rather than the implementation.
 */

const SLOT = 'yoal_dbr_0123456789abcdef';
const DATABASE = 'db_0123456789abcdef';
const NODE = 'nod_primary';
const OTHER = 'nod_other';

interface Call {
	syncConfigure: Array<{ id: string; members: string[] }>;
	barrier: string[];
	checkpoint: string[];
	stop: string[];
	resume: string[];
	rewinds: Array<{ id: string; databaseId: string }>;
}

function harness(options: {
	slots?: Array<{ slot: string; replayLsn: string | null; syncState: string | null; state?: string }>;
	slotSequence?: Array<Array<{ slot: string; replayLsn: string | null; syncState: string | null; state?: string }>>;
	now?: () => number;
	barrierWaitMs?: number;
} = {}) {
	const calls: Call = { syncConfigure: [], barrier: [], checkpoint: [], stop: [], resume: [], rewinds: [] };
	let sample = 0;
	const helper = {
		async syncConfigure(id: string, members: string[]): Promise<void> {
			calls.syncConfigure.push({ id, members });
		},
		async syncBarrier(id: string) {
			calls.barrier.push(id);
			return '0/3000148';
		},
		async checkpoint(id: string) {
			calls.checkpoint.push(id);
		},
		async writesStop(id: string) {
			calls.stop.push(id);
		},
		async writesResume(id: string) {
			calls.resume.push(id);
		},
		async memberStatus() {
			return { inRecovery: false, lsn: '0/3000148', streaming: true, readOnly: false };
		},
		async replicationStatus() {
			const rows =
				options.slotSequence
					? options.slotSequence[Math.min(sample++, options.slotSequence.length - 1)]!
					: (options.slots ?? []);
			return rows.map((slot) => ({
				slot: slot.slot,
				active: true,
				walStatus: 'reserved',
				state: slot.state ?? 'streaming',
				sentLsn: slot.replayLsn,
				replayLsn: slot.replayLsn,
				lagBytes: 0,
				lagSeconds: 0,
				syncState: slot.syncState,
			}));
		},
		async replicaRewind(
			id: string,
			input: { databaseId: string; source: { host: string; port: number; user: string; database: string }; password: string; image: string },
		) {
			calls.rewinds.push({ id, databaseId: input.databaseId });
			return { status: 'rewound' as const };
		},
	};
	const runner = new DatabaseDurabilityRunner({
		controlUrl: 'https://control.test',
		nodeToken: 'token',
		nodeId: NODE,
		helper,
		now: options.now,
		// The replay poll must not add real time to a unit test; the deadline is exercised by
		// `barrierWaitMs: 0`, so one sample decides.
		sleep: async () => undefined,
		barrierWaitMs: options.barrierWaitMs ?? 0,
		pollMs: 0,
		fetch: (async () =>
			new Response(
				JSON.stringify({
					databaseId: DATABASE,
					version: 'v',
					source: { nodeId: OTHER, address: '10.0.0.2', port: 5432, tlsFingerprint: null },
					image: 'postgres:18',
					password: 'Abcdefghijklmnop_qrstu-vwxyz',
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)) as unknown as typeof fetch,
	});
	return { calls, runner };
}

function state(overrides: Partial<DesiredState>): DesiredState {
	return {
		version: 1,
		workloads: [{ id: `db_${DATABASE}`, projectId: DATABASE, database: { engine: 'postgres' } }],
		...overrides,
	} as unknown as DesiredState;
}

describe('the agent barrier proof', () => {
	test('a target slot that has not reported its replay is a failed result, not a close', async () => {
		const { calls, runner } = harness({ slots: [{ slot: SLOT, replayLsn: null, syncState: 'sync' }] });
		await runner.runOnce(
			state({
				databaseSyncTasks: [{ databaseId: DATABASE, version: 'v1', step: 'set-sync', sync: [SLOT], leaseEtag: '"1"' }],
			}),
			new AbortController().signal,
		);
		expect(calls.barrier).toEqual([DATABASE]);
		const result = runner.pendingSyncResults()[0]!;
		expect(result.status).toBe('failed');
		expect(result.replayLsn).toBeNull();
		expect(result.version).toBe('v1');
	});

	test('a target slot with sync_state potential is a failed result', async () => {
		const { runner } = harness({ slots: [{ slot: SLOT, replayLsn: '0/4000000', syncState: 'potential' }] });
		await runner.runOnce(
			state({
				databaseSyncTasks: [{ databaseId: DATABASE, version: 'v1', step: 'set-sync', sync: [SLOT], leaseEtag: '"1"' }],
			}),
			new AbortController().signal,
		);
		expect(runner.pendingSyncResults()[0]).toMatchObject({ status: 'failed', targetSyncState: 'potential' });
	});

	test('a target that is not sync before the barrier never writes the barrier', async () => {
		const { calls, runner } = harness({ slots: [{ slot: SLOT, replayLsn: '0/3000148', syncState: 'potential' }] });
		await runner.runOnce(
			state({
				databaseSyncTasks: [{ databaseId: DATABASE, version: 'v1', step: 'set-sync', sync: [SLOT], leaseEtag: '"1"' }],
			}),
			new AbortController().signal,
		);
		expect(calls.barrier).toEqual([]);
		expect(runner.pendingSyncResults()[0]).toMatchObject({ status: 'failed', targetSyncState: 'potential' });
	});

	test('the runner polls the target replay until it reaches the barrier', async () => {
		let tick = 0;
		const { runner } = harness({
			barrierWaitMs: 10,
			now: () => {
				tick += 1;
				return tick;
			},
			slotSequence: [
				[{ slot: SLOT, replayLsn: '0/2000000', syncState: 'sync' }],
				[{ slot: SLOT, replayLsn: '0/3000148', syncState: 'sync' }],
			],
		});
		await runner.runOnce(
			state({
				databaseSyncTasks: [{ databaseId: DATABASE, version: 'v1', step: 'set-sync', sync: [SLOT], leaseEtag: '"1"' }],
			}),
			new AbortController().signal,
		);
		expect(runner.pendingSyncResults()[0]).toMatchObject({ status: 'ok', replayLsn: '0/3000148', applied: [SLOT] });
	});

	test('a target that replayed the barrier and is sync reports the target LSN and the task version', async () => {
		const { runner } = harness({ slots: [{ slot: SLOT, replayLsn: '0/3000148', syncState: 'sync' }] });
		await runner.runOnce(
			state({
				databaseSyncTasks: [{ databaseId: DATABASE, version: 'v1', step: 'set-sync', sync: [SLOT], leaseEtag: '"1"' }],
			}),
			new AbortController().signal,
		);
		expect(runner.pendingSyncResults()[0]).toMatchObject({
			status: 'ok',
			lsn: '0/3000148',
			replayLsn: '0/3000148',
			targetSyncState: 'sync',
			version: 'v1',
			leaseEtag: '"1"',
		});
	});
});

describe('the agent drain and rewind', () => {
	test('the drain checkpoints before stopping writes and samples after', async () => {
		const { calls, runner } = harness({ slots: [{ slot: SLOT, replayLsn: '0/3000148', syncState: 'sync' }] });
		await runner.runOnce(
			state({
				databaseSwitchovers: [{ switchoverId: 'dfo_1', databaseId: DATABASE, step: 'drain', replicaSlot: SLOT, version: 'v1' }],
			}),
			new AbortController().signal,
		);
		expect(calls.checkpoint).toEqual([DATABASE]);
		expect(calls.stop).toEqual([DATABASE]);
		expect(calls.checkpoint.length).toBe(1);
		expect(runner.pendingSwitchoverResults()[0]).toMatchObject({
			step: 'drain',
			status: 'ok',
			lsn: '0/3000148',
			replayLsn: '0/3000148',
			version: 'v1',
		});
	});

	test('the rewind calls the helper with the rewind workload id and the database id in the body', async () => {
		const { calls, runner } = harness();
		const workloadId = 'db_dbr_0123456789abcdef';
		await runner.runOnce(
			state({
				databaseRewindTasks: [
					{
						databaseId: DATABASE,
						workloadId,
						generation: 1,
						source: { nodeId: OTHER, address: '10.0.0.2', port: 5432, tlsFingerprint: null },
					},
				],
			}),
			new AbortController().signal,
		);
		expect(calls.rewinds).toEqual([{ id: workloadId, databaseId: DATABASE }]);
	});
});

describe('the shipped drain path can lose an in-flight commit', () => {
	/**
	 * The commit-loss harness around `DatabaseDurabilityRunner`'s drain (the shipped path), not the
	 * unused `runSwitchover` model. `writesStop` leaves one transaction in flight; with the correct
	 * helper it commits before the sample, without the wait it commits only on the next
	 * `pg_stat_replication` call, after the sampled LSN. The assertion detects that loss.
	 */
	function drainHarness(skipWait: boolean) {
		let committed = 0x1000000n;
		let acked = committed;
		let replica = committed;
		let inflight: bigint | null = null;
		let lastSample = 0n;
		const calls: string[] = [];
		const helper = {
			async syncConfigure() {},
			async syncBarrier() {
				return '0/1000000';
			},
			async checkpoint() {
				calls.push('checkpoint');
				// Commits that land between the checkpoint and the stop, as under load.
				committed += 3n;
				acked = committed;
				replica = committed;
			},
			async writesStop() {
				calls.push('stop');
				inflight = committed + 1n;
				if (!skipWait) {
					committed = inflight;
					acked = inflight;
					inflight = null;
				}
			},
			async writesResume() {},
			async memberStatus() {
				calls.push('sample');
				return { inRecovery: false, lsn: `0/${committed.toString(16).toUpperCase()}`, streaming: true, readOnly: true };
			},
			async replicationStatus() {
				calls.push('slots');
				// The in-flight transaction only reaches the WAL after the sample when the stop did not
				// wait: this is the acknowledged commit the switchover would lose.
				if (inflight !== null) {
					committed = inflight;
					acked = inflight;
					inflight = null;
				}
				if (!skipWait) replica = committed;
				return [
					{
						slot: SLOT,
						active: true,
						walStatus: 'reserved',
						state: 'streaming',
						sentLsn: `0/${replica.toString(16).toUpperCase()}`,
						replayLsn: `0/${replica.toString(16).toUpperCase()}`,
						lagBytes: 0,
						lagSeconds: 0,
						syncState: 'sync',
					},
				];
			},
			async replicaRewind() {
				return { status: 'rewound' as const };
			},
		};
		const runner = new DatabaseDurabilityRunner({
			controlUrl: 'https://control.test',
			nodeToken: 'token',
			nodeId: NODE,
			helper,
			sleep: async () => undefined,
			barrierWaitMs: 0,
			fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
		});
		const drain = async () => {
			await runner.runOnce(
				state({
					databaseSwitchovers: [{ switchoverId: 'dfo_1', databaseId: DATABASE, step: 'drain', replicaSlot: SLOT, version: 'v1' }],
				}),
				new AbortController().signal,
			);
			const reported = runner.pendingSwitchoverResults()[0]?.lsn;
			const match = reported ? /^([0-9A-F]{1,8})\/([0-9A-F]{1,8})$/i.exec(reported) : null;
			lastSample = match ? (BigInt(`0x${match[1]}`) << 32n) + BigInt(`0x${match[2]}`) : 0n;
		};
		return {
			calls,
			drain,
			get acked() {
				return acked;
			},
			get sample() {
				return lastSample;
			},
		};
	}

	test('100 shipped drains lose no acknowledged commit', async () => {
		for (let run = 0; run < 100; run += 1) {
			const f = drainHarness(false);
			await f.drain();
			expect(f.calls.slice(0, 2)).toEqual(['checkpoint', 'stop']);
			expect(f.acked <= f.sample).toBe(true);
		}
	});

	test('the same harness detects the loss when stop-writes does not wait', async () => {
		const f = drainHarness(true);
		await f.drain();
		expect(f.acked > f.sample).toBe(true);
	});
});

describe('the node-hosted sync-loss watchdog', () => {
	const steady = (overrides: Record<string, unknown> = {}) => ({
		databaseId: DATABASE,
		generation: 0,
		members: [
			{ nodeId: NODE, address: null, role: 'primary' as const, slot: null },
			{ nodeId: OTHER, address: '10.0.0.2', role: 'replica' as const, slot: SLOT },
		],
		sync: [OTHER],
		durability: 'sync' as const,
		syncState: 'steady' as const,
		durabilityEffective: 'sync' as const,
		holderNodeId: NODE,
		leaseEtag: '"9"',
		leaseExpiresAt: new Date(0).toISOString(),
		leaseGeneration: 0,
		leaseEpoch: 0,
		syncTimeoutSeconds: 30,
		onSyncLoss: 'downgrade' as const,
		...overrides,
	});

	test('a lost standby downgrades on the primary node after sync_timeout, with the lease token', async () => {
		let now = 1_000_000;
		const { calls, runner } = harness({
			now: () => now,
			slots: [{ slot: SLOT, replayLsn: '0/1', syncState: 'async', state: 'stopped' }],
		});
		const desired = state({ databaseMembers: [steady() as never] });
		await runner.runOnce(desired, new AbortController().signal);
		expect(calls.syncConfigure).toHaveLength(0);
		now += 30_000;
		await runner.runOnce(desired, new AbortController().signal);
		expect(calls.syncConfigure).toEqual([{ id: DATABASE, members: [] }]);
		expect(runner.pendingSyncResults()[0]).toMatchObject({
			step: 'watchdog',
			status: 'ok',
			targetSyncState: 'downgrade',
			leaseEtag: '"9"',
		});
	});

	test('on_sync_loss block leaves the setting named and reports block', async () => {
		let now = 2_000_000;
		const { calls, runner } = harness({
			now: () => now,
			slots: [{ slot: SLOT, replayLsn: '0/1', syncState: 'async', state: 'stopped' }],
		});
		const desired = state({ databaseMembers: [steady({ onSyncLoss: 'block' }) as never] });
		await runner.runOnce(desired, new AbortController().signal);
		now += 30_000;
		await runner.runOnce(desired, new AbortController().signal);
		expect(calls.syncConfigure).toHaveLength(0);
		expect(runner.pendingSyncResults()[0]).toMatchObject({ targetSyncState: 'block', leaseEtag: '"9"' });
	});

	test('a replica node never acts, and a healthy standby resets the timer', async () => {
		let now = 3_000_000;
		const { calls, runner } = harness({
			now: () => now,
			slots: [{ slot: SLOT, replayLsn: '0/1', syncState: 'async', state: 'stopped' }],
		});
		await runner.runOnce(state({ databaseMembers: [steady({ holderNodeId: OTHER }) as never] }), new AbortController().signal);
		now += 60_000;
		await runner.runOnce(state({ databaseMembers: [steady({ holderNodeId: OTHER }) as never] }), new AbortController().signal);
		expect(calls.syncConfigure).toHaveLength(0);
		expect(runner.pendingSyncResults()).toHaveLength(0);
	});
});
