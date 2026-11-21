import { describe, expect, test } from 'bun:test';
import type { DatabaseLease, DatabaseMembersDesired, DesiredState } from '@yoal/contracts';
import {
	DatabaseMemberRunner,
	memberOperations,
	type MemberEvent,
	type MemberLeaseArbiter,
	type MemberLeaseRecord,
	type MemberOperations,
	type MemberPeerTransport,
} from './database-member.ts';

/**
 * The W11 member machine (W11-SPEC §4–§5, Revision 4). The fake arbiter is the only clock; the
 * control plane is not reachable in any test, which is also the I11 control-plane-down case.
 */

const DB = 'db_main';
const P = 'nod_p';
const A = 'nod_a';
const B = 'nod_b';
const T0 = 1_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

function lease(overrides: Partial<DatabaseLease> = {}): DatabaseLease {
	return {
		generation: 1,
		holderNodeId: P,
		expiresAt: iso(T0 - 1),
		sync: [A],
		syncState: 'steady',
		durability: 'sync',
		durabilityEffective: 'sync',
		syncSetAt: iso(T0 - 60_000),
		...overrides,
	};
}

class FakeArbiter implements MemberLeaseArbiter {
	record: { lease: DatabaseLease; etag: string } | null;
	casWins = true;
	/** Simulate a lost CAS response: the write applied, but the caller saw a failure. */
	applyOnFalse = false;
	reads = 0;
	renewals = 0;
	constructor(initial: DatabaseLease | null = lease()) {
		this.record = initial ? { lease: initial, etag: 'etag-1' } : null;
	}
	async read(): Promise<MemberLeaseRecord | null> {
		this.reads += 1;
		return this.record ? { ...this.record, arbiterNow: T0 } : { lease: null as never, etag: '', arbiterNow: T0 } as never;
	}
	async compareAndSwap(_databaseId: string, expected: string | null, next: DatabaseLease): Promise<{ ok: boolean; arbiterNow: number }> {
		if (!this.casWins && !this.applyOnFalse) return { ok: false, arbiterNow: T0 };
		if ((this.record?.etag ?? null) !== expected) return { ok: false, arbiterNow: T0 };
		this.renewals += 1;
		this.record = { lease: next, etag: `etag-${this.renewals + 1}` };
		return { ok: this.casWins, arbiterNow: T0 };
	}
}

class FakePeers implements MemberPeerTransport {
	reachable: string[] = [A, B];
	sent: Array<{ peer: string; generation: number }> = [];
	lastAnswer: number | null = null;
	everyPeerAnswered = true;
	async peers(): Promise<Array<{ nodeId: string; reachable: boolean }>> {
		return [P, A, B].map((nodeId) => ({ nodeId, reachable: this.reachable.includes(nodeId) }));
	}
	async sendFenceNotice(_databaseId: string, peer: string, notice: { generation: number }): Promise<boolean> {
		if (!this.reachable.includes(peer)) return false;
		this.sent.push({ peer, generation: notice.generation });
		return true;
	}
	async keepAlive(): Promise<{ everyPeerAnswered: boolean }> {
		return { everyPeerAnswered: this.everyPeerAnswered };
	}
	lastAnsweredToPrimary(): number | null {
		return this.lastAnswer;
	}
}

interface Calls {
	promoted: number;
	fenced: Array<'stop' | 'readonly'>;
	cleared: number;
	clearSyncArgs?: string[];
	promoteArgs?: Array<[string, string]>;
	promoteFailures?: number;
	/** Default true; false simulates a helper that accepted the verb but did not take effect. */
	fenceConfirms?: boolean;
}

function ops(status: { inRecovery: boolean; streaming: boolean; readOnly: boolean; lsn?: string | null }, calls: Calls): MemberOperations {
	let fenced = false;
	return {
		async status() {
			return {
				inRecovery: status.inRecovery,
				streaming: status.streaming,
				readOnly: status.readOnly || fenced,
				lsn: status.lsn ?? '0/200',
			};
		},
		async fence(_id, mode) {
			calls.fenced.push(mode);
			if (calls.fenceConfirms !== false) fenced = true;
		},
		async promote(workloadId, databaseId) {
			calls.promoted += 1;
			(calls.promoteArgs ??= []).push([workloadId, databaseId]);
			if ((calls.promoteFailures ?? 0) > 0) {
				calls.promoteFailures = (calls.promoteFailures ?? 0) - 1;
				return { promoted: false, lsn: null, error: 'pg_ctl promote failed' };
			}
			return { promoted: true, lsn: '0/300' };
		},
		async clearSync(workloadId) {
			calls.cleared += 1;
			(calls.clearSyncArgs ??= []).push(workloadId);
		},
	};
}

function desired(overrides: Partial<DatabaseMembersDesired> = {}): DatabaseMembersDesired {
	return {
		databaseId: DB,
		generation: 1,
		members: [
			{ nodeId: P, address: '10.0.0.1', role: 'primary', slot: null, workloadId: DB },
			{ nodeId: A, address: '10.0.0.2', role: 'replica', slot: 'slot_a', workloadId: 'db_dbr_a' },
		],
		sync: [A],
		durability: 'sync',
		syncState: 'steady',
		durabilityEffective: 'sync',
		holderNodeId: P,
		leaseEtag: 'etag-1',
		leaseExpiresAt: iso(T0 - 1),
		leaseGeneration: 1,
		leaseEpoch: 0,
		syncTimeoutSeconds: 30,
		onSyncLoss: 'downgrade',
		failover: { mode: 'auto', acceptDataLoss: false, autoArmedAt: iso(T0 - 60_000) },
		...overrides,
	};
}

function state(members: DatabaseMembersDesired[]): DesiredState {
	return { databaseMembers: members } as DesiredState;
}

function runner(options: {
	nodeId: string;
	arbiter: MemberLeaseArbiter | null;
	peers: FakePeers;
	ops: MemberOperations;
	events?: MemberEvent[];
	now?: () => number;
	streamDownMs?: number;
}): DatabaseMemberRunner {
	return new DatabaseMemberRunner({
		nodeId: options.nodeId,
		arbiter: options.arbiter,
		helper: options.ops,
		peer: options.peers,
		now: options.now ?? (() => T0),
		streamDownMs: options.streamDownMs ?? 5_000,
		onEvent: (event) => options.events?.push(event),
	});
}

describe('candidate acquisition', () => {
	test('a settled replica CASes generation + 1, promotes and clears sync', async () => {
		const arbiter = new FakeArbiter();
		const peers = new FakePeers();
		peers.lastAnswer = T0 - 20_000;
		const calls: Calls = { promoted: 0, fenced: [], cleared: 0 };
		const events: MemberEvent[] = [];
		const machine = runner({
			nodeId: A,
			arbiter,
			peers,
			ops: ops({ inRecovery: true, streaming: false, readOnly: false }, calls),
			events,
			streamDownMs: 0,
		});
		await machine.runOnce(state([desired()]), AbortSignal.timeout(1_000));
		expect(calls.promoted).toBe(1);
		expect(calls.cleared).toBe(1);
		expect(calls.promoteArgs).toEqual([['db_dbr_a', DB]]);
		expect(calls.clearSyncArgs).toEqual(['db_dbr_a']);
		expect(arbiter.renewals).toBe(1);
		expect(arbiter.record?.lease).toMatchObject({ generation: 2, holderNodeId: A, sync: [], syncState: 'changing' });
		expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining(['candidate', 'promoted']));
		expect(machine.pendingPromotionReports()).toEqual([{ databaseId: DB, generation: 2, lsn: '0/300' }]);
	});

	test('does not promote while the member answered the keep-alive within one TTL', async () => {
		const arbiter = new FakeArbiter();
		const peers = new FakePeers();
		peers.lastAnswer = T0 - 1_000;
		const calls: Calls = { promoted: 0, fenced: [], cleared: 0 };
		const machine = runner({ nodeId: A, arbiter, peers, ops: ops({ inRecovery: true, streaming: false, readOnly: false }, calls), streamDownMs: 0 });
		await machine.runOnce(state([desired()]), AbortSignal.timeout(1_000));
		expect(calls.promoted).toBe(0);
		expect(arbiter.record?.lease.generation).toBe(1);
	});

	test('a valid revision-4 fence notice waives the TTL block and the debounce', async () => {
		const arbiter = new FakeArbiter();
		const peers = new FakePeers();
		peers.lastAnswer = T0 - 1_000;
		const calls: Calls = { promoted: 0, fenced: [], cleared: 0 };
		// Default timings: the stream is observed down in this very pass, so only the notice can
		// allow a promotion (review blocker 17: the waiver test must not disable the debounce).
		const machine = runner({ nodeId: A, arbiter, peers, ops: ops({ inRecovery: true, streaming: false, readOnly: false }, calls) });
		machine.receiveFenceNotice(DB, { generation: 1, epoch: 1, from: P, at: iso(T0 - 100) });
		await machine.runOnce(state([desired()]), AbortSignal.timeout(1_000));
		expect(calls.promoted).toBe(1);
	});

	test('a stale notice does not waive the debounce with default timings', async () => {
		const arbiter = new FakeArbiter();
		const peers = new FakePeers();
		peers.lastAnswer = T0 - 20_000;
		const calls: Calls = { promoted: 0, fenced: [], cleared: 0 };
		const machine = runner({ nodeId: A, arbiter, peers, ops: ops({ inRecovery: true, streaming: false, readOnly: false }, calls) });
		machine.receiveFenceNotice(DB, { generation: 0, epoch: 0, from: P, at: iso(T0 - 100) });
		await machine.runOnce(state([desired()]), AbortSignal.timeout(1_000));
		expect(calls.promoted).toBe(0);
		expect(arbiter.renewals).toBe(0);
	});

	test('a stale or bad-epoch notice waives nothing', async () => {
		for (const notice of [
			{ generation: 0, epoch: 0, from: P, at: iso(T0 - 100) },
			{ generation: 1, epoch: 0, from: P, at: iso(T0 - 100) },
			{ generation: 1, epoch: 1, from: B, at: iso(T0 - 100) },
		]) {
			const arbiter = new FakeArbiter();
			const peers = new FakePeers();
			peers.lastAnswer = T0 - 1_000;
			const calls: Calls = { promoted: 0, fenced: [], cleared: 0 };
			const machine = runner({ nodeId: A, arbiter, peers, ops: ops({ inRecovery: true, streaming: false, readOnly: false }, calls), streamDownMs: 0 });
			machine.receiveFenceNotice(DB, notice);
			await machine.runOnce(state([desired()]), AbortSignal.timeout(1_000));
			expect(calls.promoted).toBe(0);
		}
	});

	test('a lost CAS re-follows and never promotes', async () => {
		const arbiter = new FakeArbiter();
		arbiter.casWins = false;
		const peers = new FakePeers();
		peers.lastAnswer = T0 - 20_000;
		const calls: Calls = { promoted: 0, fenced: [], cleared: 0 };
		const events: MemberEvent[] = [];
		const machine = runner({ nodeId: A, arbiter, peers, ops: ops({ inRecovery: true, streaming: false, readOnly: false }, calls), events, streamDownMs: 0 });
		await machine.runOnce(state([desired()]), AbortSignal.timeout(1_000));
		expect(calls.promoted).toBe(0);
		expect(events.map((event) => event.kind)).toContain('cas-lost');
	});

	test('a lost CAS response re-reads and promotes when the re-read proves the win', async () => {
		const arbiter = new FakeArbiter();
		arbiter.casWins = false;
		arbiter.applyOnFalse = true;
		const peers = new FakePeers();
		peers.lastAnswer = T0 - 20_000;
		const calls: Calls = { promoted: 0, fenced: [], cleared: 0 };
		const machine = runner({ nodeId: A, arbiter, peers, ops: ops({ inRecovery: true, streaming: false, readOnly: false }, calls), streamDownMs: 0 });
		await machine.runOnce(state([desired()]), AbortSignal.timeout(1_000));
		expect(calls.promoted).toBe(1);
		expect(arbiter.record?.lease).toMatchObject({ generation: 2, holderNodeId: A });
	});

	test('a live stream is not a candidate even with a notice', async () => {
		const arbiter = new FakeArbiter();
		const peers = new FakePeers();
		const calls: Calls = { promoted: 0, fenced: [], cleared: 0 };
		const machine = runner({ nodeId: A, arbiter, peers, ops: ops({ inRecovery: true, streaming: true, readOnly: false }, calls) });
		machine.receiveFenceNotice(DB, { generation: 1, epoch: 1, from: P, at: iso(T0 - 100) });
		await machine.runOnce(state([desired()]), AbortSignal.timeout(1_000));
		expect(calls.promoted).toBe(0);
	});

	test('an unarmed policy never promotes, and a report-only machine (no arbiter) never promotes', async () => {
		const peers = new FakePeers();
		peers.lastAnswer = T0 - 20_000;
		const calls: Calls = { promoted: 0, fenced: [], cleared: 0 };
		const unarmed = runner({ nodeId: A, arbiter: new FakeArbiter(), peers, ops: ops({ inRecovery: true, streaming: false, readOnly: false }, calls) });
		await unarmed.runOnce(state([desired({ failover: { mode: 'manual', acceptDataLoss: false, autoArmedAt: null } })]), AbortSignal.timeout(1_000));
		expect(calls.promoted).toBe(0);
		const reportOnly = runner({ nodeId: A, arbiter: null, peers, ops: ops({ inRecovery: true, streaming: true, readOnly: false }, calls) });
		await reportOnly.runOnce(state([desired()]), AbortSignal.timeout(1_000));
		expect(calls.promoted).toBe(0);
		expect(reportOnly.reports()[0]).toMatchObject({ role: 'streaming', databaseId: DB });
	});
});


	test('a notice is keyed by generation, not by database', async () => {
		const arbiter = new FakeArbiter();
		const peers = new FakePeers();
		peers.lastAnswer = T0 - 1_000;
		const calls: Calls = { promoted: 0, fenced: [], cleared: 0 };
		const machine = runner({ nodeId: A, arbiter, peers, ops: ops({ inRecovery: true, streaming: false, readOnly: false }, calls) });
		// A generation-2 notice must not authorise an acquisition from the generation-1 lease.
		machine.receiveFenceNotice(DB, { generation: 2, epoch: 2, from: P, at: iso(T0 - 100) });
		await machine.runOnce(state([desired()]), AbortSignal.timeout(1_000));
		expect(calls.promoted).toBe(0);
		// The matching generation is the promise that authorises the waiver.
		machine.receiveFenceNotice(DB, { generation: 1, epoch: 1, from: P, at: iso(T0 - 100) });
		await machine.runOnce(state([desired()]), AbortSignal.timeout(1_000));
		expect(calls.promoted).toBe(1);
	});

	test('does not report primary when the lease moved during pg_ctl promote; it fences', async () => {
		const arbiter = new FakeArbiter();
		const peers = new FakePeers();
		peers.lastAnswer = T0 - 20_000;
		const calls: Calls = { promoted: 0, fenced: [], cleared: 0 };
		const events: MemberEvent[] = [];
		const machine = runner({
			nodeId: A,
			arbiter,
			peers,
			ops: {
				...ops({ inRecovery: true, streaming: false, readOnly: false }, calls),
				async promote(workloadId, databaseId) {
					calls.promoted += 1;
					(calls.promoteArgs ??= []).push([workloadId, databaseId]);
					// Another member takes the next generation between the CAS and pg_ctl promote.
					arbiter.record = { lease: lease({ generation: 3, holderNodeId: B }), etag: 'etag-x' };
					return { promoted: true, lsn: '0/300' };
				},
			},
			events,
			streamDownMs: 0,
		});
		await machine.runOnce(state([desired()]), AbortSignal.timeout(1_000));
		expect(events.map((event) => event.kind)).not.toContain('promoted');
		expect(calls.fenced).toEqual(['readonly']);
	});

	test('a failed pg_ctl promote retries as the changing-lease holder', async () => {
		const arbiter = new FakeArbiter();
		const peers = new FakePeers();
		peers.lastAnswer = T0 - 20_000;
		const calls: Calls = { promoted: 0, fenced: [], cleared: 0, promoteFailures: 1 };
		const events: MemberEvent[] = [];
		let clock = T0;
		const machine = runner({
			nodeId: A,
			arbiter,
			peers,
			ops: ops({ inRecovery: true, streaming: false, readOnly: false }, calls),
			events,
			now: () => clock,
			streamDownMs: 0,
		});
		await machine.runOnce(state([desired()]), AbortSignal.timeout(1_000));
		expect(calls.promoted).toBe(1);
		expect(calls.cleared).toBe(0);
		expect(arbiter.record?.lease).toMatchObject({ generation: 2, holderNodeId: A, syncState: 'changing' });
		expect(events.map((event) => event.kind)).toContain('promotion-retry');
		// The won changing lease is renewed while we wait, then the promotion is retried.
		clock += 2_100;
		await machine.runOnce(state([desired()]), AbortSignal.timeout(1_000));
		expect(calls.promoted).toBe(2);
		expect(calls.cleared).toBe(1);
		expect(machine.pendingPromotionReports()).toEqual([{ databaseId: DB, generation: 2, lsn: '0/300' }]);
	});

describe('the fencing primary', () => {
	test('sends the notice to every reachable member, then fences Postgres', async () => {
		const arbiter = new FakeArbiter(lease({ generation: 2, holderNodeId: A }));
		const peers = new FakePeers();
		const calls: Calls = { promoted: 0, fenced: [], cleared: 0 };
		const events: MemberEvent[] = [];
		const machine = runner({ nodeId: P, arbiter, peers, ops: ops({ inRecovery: false, streaming: true, readOnly: false }, calls), events });
		await machine.runOnce(state([desired({ holderNodeId: A, leaseGeneration: 2 })]), AbortSignal.timeout(1_000));
		expect(calls.fenced).toEqual(['readonly']);
		expect(peers.sent.map((entry) => entry.peer)).toEqual(expect.arrayContaining([A, B]));
		expect(peers.sent.every((entry) => entry.generation === 1)).toBe(true);
		expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining(['fence-notice-sent', 'fenced']));
	});

	test('the notice is best effort: no reachable peer still fences and reports the miss', async () => {
		const arbiter = new FakeArbiter(lease({ generation: 2, holderNodeId: A }));
		const peers = new FakePeers();
		peers.reachable = [];
		const calls: Calls = { promoted: 0, fenced: [], cleared: 0 };
		const events: MemberEvent[] = [];
		const machine = runner({ nodeId: P, arbiter, peers, ops: ops({ inRecovery: false, streaming: true, readOnly: false }, calls), events });
		await machine.runOnce(state([desired({ holderNodeId: A, leaseGeneration: 2 })]), AbortSignal.timeout(1_000));
		expect(calls.fenced).toEqual(['readonly']);
		expect(events.map((event) => event.kind)).toContain('fence-notice-missed');
	});

	test('does not send a notice or report fenced until the helper confirms read-only', async () => {
		const arbiter = new FakeArbiter(lease({ generation: 2, holderNodeId: A }));
		const peers = new FakePeers();
		const calls: Calls = { promoted: 0, fenced: [], cleared: 0, fenceConfirms: false };
		const events: MemberEvent[] = [];
		const machine = runner({ nodeId: P, arbiter, peers, ops: ops({ inRecovery: false, streaming: true, readOnly: false }, calls), events });
		await machine.runOnce(state([desired({ holderNodeId: A, leaseGeneration: 2 })]), AbortSignal.timeout(1_000));
		expect(calls.fenced).toEqual(['readonly']);
		expect(peers.sent).toEqual([]);
		expect(events.map((event) => event.kind)).toContain('fence-failed');
		expect(events.map((event) => event.kind)).not.toContain('fenced');
		expect(machine.reports()[0]).toMatchObject({ role: 'fencing' });
		// The next pass retries; once the fence is confirmed the notice goes out and fenced is reported.
		calls.fenceConfirms = true;
		await machine.runOnce(state([desired({ holderNodeId: A, leaseGeneration: 2 })]), AbortSignal.timeout(1_000));
		expect(peers.sent.length).toBeGreaterThan(0);
		expect(events.map((event) => event.kind)).toContain('fenced');
	});

	test('a slow fence does not consume the 2 s notice window', async () => {
		const arbiter = new FakeArbiter(lease({ generation: 2, holderNodeId: A }));
		const peers = new FakePeers();
		const calls: Calls = { promoted: 0, fenced: [], cleared: 0 };
		const events: MemberEvent[] = [];
		let clock = T0;
		let fenced = false;
		const base = ops({ inRecovery: false, streaming: true, readOnly: false }, calls);
		const machine = runner({
			nodeId: P,
			arbiter,
			peers,
			events,
			now: () => clock,
			ops: {
				...base,
				async fence(id, mode) {
					calls.fenced.push(mode);
					fenced = true;
					clock += 3_000; // the helper's drain can take up to 20 s
				},
				async status() {
					return { inRecovery: false, streaming: true, readOnly: fenced, lsn: null };
				},
			},
		});
		await machine.runOnce(state([desired({ holderNodeId: A, leaseGeneration: 2 })]), AbortSignal.timeout(1_000));
		expect(peers.sent.length).toBeGreaterThan(0);
		const sent = events.find((event) => event.kind === 'fence-notice-sent');
		expect(sent?.detail).toContain('fence 3000 ms');
		expect(sent?.detail).toContain('fan-out');
		expect(sent?.detail).not.toContain('fan-out over the 2 s budget');
	});

	test('does not fence a healthy primary that can still prove the lease', async () => {
		const arbiter = new FakeArbiter(lease({ holderNodeId: P, expiresAt: iso(T0 + 10_000) }));
		const peers = new FakePeers();
		const calls: Calls = { promoted: 0, fenced: [], cleared: 0 };
		const machine = runner({ nodeId: P, arbiter, peers, ops: ops({ inRecovery: false, streaming: true, readOnly: false }, calls) });
		await machine.runOnce(state([desired({ holderNodeId: P })]), AbortSignal.timeout(1_000));
		expect(calls.fenced).toEqual([]);
		expect(arbiter.renewals).toBeGreaterThanOrEqual(1);
	});

	test('an arbiter outage alone neither fences nor stops a primary when every member answers', async () => {
		const peers = new FakePeers();
		peers.everyPeerAnswered = true;
		const calls: Calls = { promoted: 0, fenced: [], cleared: 0 };
		let down = false;
		let reads = 0;
		const live = new FakeArbiter(lease({ holderNodeId: P, expiresAt: iso(T0 + 60_000) }));
		const machine = runner({
			nodeId: P,
			arbiter: {
				read: async () => {
					reads += 1;
					if (down) throw new Error('down');
					return live.read();
				},
				compareAndSwap: async (id, etag, next) => {
					if (down) throw new Error('down');
					return live.compareAndSwap(id, etag, next);
				},
			},
			peers,
			ops: ops({ inRecovery: false, streaming: true, readOnly: false }, calls),
		});
		// A successful read establishes the proof window *before* the outage (review blocker 17).
		await machine.runOnce(state([desired({ holderNodeId: P })]), AbortSignal.timeout(1_000));
		expect(reads).toBeGreaterThan(0);
		down = true;
		await machine.runOnce(state([desired({ holderNodeId: P })]), AbortSignal.timeout(1_000));
		expect(calls.fenced).toEqual([]);
	});

	test('arbiter outage plus a silent member fences after one TTL', async () => {
		const peers = new FakePeers();
		peers.everyPeerAnswered = false;
		const calls: Calls = { promoted: 0, fenced: [], cleared: 0 };
		let clock = T0;
		let down = false;
		const live = new FakeArbiter(lease({ holderNodeId: P, expiresAt: iso(T0 + 60_000) }));
		const machine = runner({
			nodeId: P,
			arbiter: {
				read: async () => {
					if (down) throw new Error('down');
					return live.read();
				},
				compareAndSwap: async (id, etag, next) => {
					if (down) throw new Error('down');
					return live.compareAndSwap(id, etag, next);
				},
			},
			peers,
			ops: ops({ inRecovery: false, streaming: true, readOnly: false }, calls),
			now: () => clock,
		});
		const world = state([desired({ holderNodeId: P })]);
		// Establish the proof window while the arbiter is reachable.
		await machine.runOnce(world, AbortSignal.timeout(1_000));
		expect(calls.fenced).toEqual([]);
		down = true;
		clock = T0 + 16_000;
		await machine.runOnce(world, AbortSignal.timeout(1_000));
		expect(calls.fenced).toEqual(['readonly']);
	});
});

describe('helper wiring', () => {
	test('memberOperations maps only the fixed verbs', async () => {
		const seen: string[] = [];
		const helper = {
			memberStatus: async () => {
				seen.push('status');
				return { inRecovery: true, streaming: false, lsn: null, readOnly: false };
			},
			fenceWorkload: async () => {
				seen.push('fence');
			},
			replicaPromote: async () => {
				seen.push('promote');
				return { promoted: true, lsn: null };
			},
			syncConfigure: async () => {
				seen.push('sync');
			},
		};
		const operations = memberOperations(helper);
		await operations.status('db_dbr_a');
		await operations.fence('db_main', 'readonly');
		await operations.promote('db_dbr_a', 'db_main');
		await operations.clearSync('db_main');
		expect(seen).toEqual(['status', 'fence', 'promote', 'sync']);
	});
});
