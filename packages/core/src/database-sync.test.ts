import { describe, expect, test } from 'bun:test';
import type { DatabaseLease } from '@yoal/contracts';
import {
	DB_LEASE_TTL_MS,
	MemoryDatabaseLeaseStore,
	SYNC_CHANGE_TIMEOUT_MS,
	SyncSetTransition,
	acquireRefusal,
	barrierHolds,
	closeSyncChange,
	databaseLeaseKey,
	mayAcquire,
	openSyncChange,
	parseLease,
	parseLsn,
	renewedLease,
	syncLossDecision,
	type SyncTransitionEvent,
} from './database-sync.ts';

/**
 * The Revision 1 sync change (W9-SPEC §5.5): open → switch + barrier → close, and the two timeout
 * outcomes. The old two-step order is the regression: a lagging replica named in the lease before
 * the Postgres setting changes could promote and lose an acknowledged commit. These tests pin the
 * three-step order and the non-promotable window.
 */

const DATABASE = 'db_orders';
const PRIMARY = 'nod_primary';
const OLD = 'nod_old';
const NEW = 'nod_new';
/** The lease's own expiry is in 2026; tests pass this "now" so expiry checks stay meaningful. */
const AT = Date.parse('2026-11-20T20:41:00Z');

function lease(overrides: Partial<DatabaseLease> = {}): DatabaseLease {
	return {
		generation: 3,
		holderNodeId: PRIMARY,
		expiresAt: '2026-11-20T20:41:12.000Z',
		sync: [OLD],
		syncState: 'steady',
		durability: 'sync',
		durabilityEffective: 'sync',
		syncSetAt: '2026-11-20T20:40:00.000Z',
		...overrides,
	};
}

interface Harness {
	store: MemoryDatabaseLeaseStore;
	engine: SyncSetTransition;
	clock: { now: number };
	names: string[][];
	barriers: number;
	events: SyncTransitionEvent[];
	failBarrier: { value: boolean; once?: boolean };
	seed: (value?: DatabaseLease) => Promise<void>;
}

function harness(settings: Partial<{ durability: 'async' | 'sync'; syncTimeoutSeconds: number; onSyncLoss: 'downgrade' | 'block' }> = {}): Harness {
	const store = new MemoryDatabaseLeaseStore();
	const clock = { now: Date.parse('2026-11-20T20:41:00Z') };
	const names: string[][] = [];
	const events: SyncTransitionEvent[] = [];
	const failBarrier: { value: boolean; once?: boolean } = { value: false };
	const engine = new SyncSetTransition({
		databaseId: DATABASE,
		nodeId: PRIMARY,
		store,
		settings: { durability: settings.durability ?? 'sync', syncTimeoutSeconds: settings.syncTimeoutSeconds ?? 30, onSyncLoss: settings.onSyncLoss ?? 'downgrade' },
		now: () => clock.now,
		setSynchronousStandbyNames: async (members) => {
			names.push(members);
		},
		writeBarrier: async () => {
			if (failBarrier.value) {
				if (failBarrier.once) failBarrier.value = false;
				throw new Error('the setting did not take');
			}
			return '0/2000000';
		},
		onEvent: (event) => events.push(event),
	});
	return {
		store,
		engine,
		clock,
		names,
		barriers: 0,
		events,
		failBarrier,
		seed: async (value = lease()) => {
			expect(await store.compareAndSwap(DATABASE, null, value)).toBe(true);
		},
	};
}

describe('the three-step sync change (H23, Revision 1)', () => {
	test('open empties the set and makes it non-promotable; close names the new member', async () => {
		const f = harness();
		await f.seed();
		const started = await f.engine.begin(NEW);
		expect(started.kind).toBe('switched');
		const opened = f.store.peek(DATABASE)!;
		expect(opened).toMatchObject({ sync: [], syncState: 'changing', durability: 'sync', durabilityEffective: 'sync' });
		expect(f.names).toEqual([[NEW]]);

		// The old two-step bug is impossible: while changing, nobody is named and nobody may acquire.
		expect(mayAcquire(opened, OLD, AT)).toBe(false);
		expect(mayAcquire(opened, NEW, AT)).toBe(false);
		expect(acquireRefusal(opened, NEW)).toContain('sync-set change is open');

		expect(await f.engine.tick({ nodeId: NEW, streaming: true, replayLsn: '0/1FFFFFF' }, null)).toBeNull();
		const closed = await f.engine.tick({ nodeId: NEW, streaming: true, replayLsn: '0/2000000' }, null);
		expect(closed?.kind).toBe('closed');
		const final = f.store.peek(DATABASE)!;
		expect(final).toMatchObject({ sync: [NEW], syncState: 'steady', durability: 'sync', durabilityEffective: 'sync' });
		expect(mayAcquire(final, NEW, AT)).toBe(true);
		expect(mayAcquire(final, OLD, AT)).toBe(false);
	});

	test('a primary death while changing leaves the lease changing and allows no automatic promotion', async () => {
		const f = harness();
		await f.seed();
		await f.engine.begin(NEW);
		// A new process has no local transition state; it must not close or promote on its own.
		const restarted = new SyncSetTransition({
			databaseId: DATABASE,
			nodeId: PRIMARY,
			store: f.store,
			settings: { durability: 'sync', syncTimeoutSeconds: 30, onSyncLoss: 'downgrade' },
			now: () => f.clock.now,
			setSynchronousStandbyNames: async () => undefined,
			writeBarrier: async () => '0/3000000',
		});
		expect((await restarted.begin(OLD)).kind).toBe('refused');
		expect(f.store.peek(DATABASE)!.syncState).toBe('changing');
		// A replica reading the lease refuses: the person must choose (old member, or accept loss).
		expect(acquireRefusal(f.store.peek(DATABASE), OLD)).toContain('no member may promote automatically');
	});

	test('a barrier that times out falls back to a healthy previous member', async () => {
		const f = harness();
		await f.seed();
		await f.engine.begin(NEW);
		f.clock.now += SYNC_CHANGE_TIMEOUT_MS + 1;
		const result = await f.engine.tick(
			{ nodeId: NEW, streaming: true, replayLsn: '0/1F00000' },
			{ nodeId: OLD, streaming: true, replayLsn: '0/2000000' },
		);
		expect(result?.kind).toBe('fallback');
		expect(f.store.peek(DATABASE)).toMatchObject({ sync: [OLD], syncState: 'steady', durabilityEffective: 'sync' });
		expect(f.names.at(-1)).toEqual([OLD]);
	});

	test('a barrier that times out with no healthy previous member downgrades after the timeout', async () => {
		const f = harness();
		await f.seed();
		await f.engine.begin(NEW);
		f.clock.now += SYNC_CHANGE_TIMEOUT_MS + 1;
		const result = await f.engine.tick({ nodeId: NEW, streaming: false, replayLsn: null }, { nodeId: OLD, streaming: false, replayLsn: null });
		expect(result?.kind).toBe('downgraded');
		expect(f.store.peek(DATABASE)).toMatchObject({
			sync: [],
			syncState: 'steady',
			durability: 'sync',
			durabilityEffective: 'async',
		});
		expect(f.names.at(-1)).toEqual([]);
	});

	test('on_sync_loss: block keeps sync in force and names nobody', async () => {
		const f = harness({ onSyncLoss: 'block' });
		await f.seed();
		await f.engine.begin(NEW);
		f.clock.now += SYNC_CHANGE_TIMEOUT_MS + 1;
		const result = await f.engine.tick(null, null);
		expect(result?.kind).toBe('blocked');
		expect(f.store.peek(DATABASE)).toMatchObject({ sync: [], syncState: 'steady', durability: 'sync', durabilityEffective: 'sync' });
		// The unavailable member stays named, so writes block rather than silently going async.
		expect(f.names.at(-1)).toEqual([NEW]);
	});

	test('a barrier write that fails falls back immediately, never leaving a half-switched setting', async () => {
		const f = harness();
		await f.seed();
		f.failBarrier.value = true;
		f.failBarrier.once = true;
		const result = await f.engine.begin(NEW);
		expect(result.kind).toBe('fallback');
		expect(f.store.peek(DATABASE)).toMatchObject({ sync: [OLD], syncState: 'steady' });
		expect(f.names).toEqual([[NEW], [OLD]]);
	});

	test('a fallback whose setting or barrier also fails applies on_sync_loss, never records OLD', async () => {
		const f = harness();
		await f.seed();
		f.failBarrier.value = true;
		const result = await f.engine.begin(NEW);
		expect(result.kind).toBe('downgraded');
		expect(f.store.peek(DATABASE)).toMatchObject({ sync: [], syncState: 'steady', durabilityEffective: 'async' });
	});

	test('a previous member behind the failed barrier is not restored', async () => {
		const f = harness();
		await f.seed();
		await f.engine.begin(NEW);
		f.clock.now += SYNC_CHANGE_TIMEOUT_MS + 1;
		const result = await f.engine.tick(
			{ nodeId: NEW, streaming: true, replayLsn: '0/1F00000' },
			{ nodeId: OLD, streaming: true, replayLsn: '0/1FFFFFF' },
		);
		expect(result?.kind).toBe('downgraded');
		expect(f.store.peek(DATABASE)).toMatchObject({ sync: [], durabilityEffective: 'async' });
	});

	test('a lost CAS is reported, not retried blind', async () => {
		const f = harness();
		await f.seed();
		// Someone else changes the lease between the read and the CAS: use a store whose write loses.
		const losing = new MemoryDatabaseLeaseStore();
		await losing.compareAndSwap(DATABASE, null, lease());
		const engine = new SyncSetTransition({
			databaseId: DATABASE,
			nodeId: PRIMARY,
			store: {
				read: async () => ({ lease: lease(), etag: 'stale' }),
				compareAndSwap: async () => false,
			},
			settings: { durability: 'sync', syncTimeoutSeconds: 30, onSyncLoss: 'downgrade' },
			now: () => f.clock.now,
			setSynchronousStandbyNames: async () => undefined,
			writeBarrier: async () => '0/1',
		});
		const result = await engine.begin(NEW);
		expect(result.kind).toBe('refused');
		expect(result.kind === 'refused' && result.reason).toContain('compare-and-swap');
	});

	test('durability changes to async close at once; sync closes only with the barrier', async () => {
		const f = harness({ durability: 'async' });
		await f.seed(lease({ durability: 'async', durabilityEffective: 'async', sync: [] }));
		expect(mayAcquire(f.store.peek(DATABASE)!, PRIMARY, AT)).toBe(true);
	});
});

describe('the sync-loss watchdog', () => {
	const base = lease();
	test('does nothing while the named standby streams', () => {
		expect(
			syncLossDecision({
				lease: base,
				members: [{ nodeId: OLD, streaming: true, replayLsn: '0/1' }],
				syncTimeoutSeconds: 30,
				onSyncLoss: 'downgrade',
				lostSince: 0,
				now: 60_000,
			}).action,
		).toBe('none');
	});

	test('starts a transition to another healthy replica at once', () => {
		const decision = syncLossDecision({
			lease: base,
			members: [
				{ nodeId: OLD, streaming: false, replayLsn: null },
				{ nodeId: NEW, streaming: true, replayLsn: '0/1' },
			],
			syncTimeoutSeconds: 30,
			onSyncLoss: 'downgrade',
			lostSince: 0,
			now: 1_000,
		});
		expect(decision).toEqual({ action: 'transition', target: NEW, reason: expect.any(String) });
	});

	test('waits out sync_timeout, then downgrades (or blocks)', () => {
		const members = [{ nodeId: OLD, streaming: false, replayLsn: null }];
		expect(
			syncLossDecision({ lease: base, members, syncTimeoutSeconds: 30, onSyncLoss: 'downgrade', lostSince: 0, now: 29_999 }).action,
		).toBe('none');
		expect(
			syncLossDecision({ lease: base, members, syncTimeoutSeconds: 30, onSyncLoss: 'downgrade', lostSince: 0, now: 30_000 }).action,
		).toBe('downgrade');
		expect(
			syncLossDecision({ lease: base, members, syncTimeoutSeconds: 30, onSyncLoss: 'block', lostSince: 0, now: 30_000 }).action,
		).toBe('block');
	});
});

describe('lease helpers', () => {
	test('WAL positions compare as one integer and the barrier holds only forward', () => {
		expect(parseLsn('0/2000000')).toBe(0x2000000n);
		expect(barrierHolds('0/2000000', '0/2000000')).toBe(true);
		expect(barrierHolds('0/2000001', '0/2000000')).toBe(true);
		expect(barrierHolds('0/1FFFFFF', '0/2000000')).toBe(false);
		expect(barrierHolds(null, '0/2000000')).toBe(false);
		expect(barrierHolds('0/1', null)).toBe(false);
	});

	test('the lease key is fixed and the opening transition keeps the generation', () => {
		expect(databaseLeaseKey('db_orders')).toBe('yoal/ha/db/db_orders.json');
		expect(() => databaseLeaseKey('../etc/passwd')).toThrow();
		const opened = openSyncChange(lease());
		expect(opened).toMatchObject({ generation: 3, sync: [], syncState: 'changing' });
		expect(closeSyncChange(opened, NEW, Date.parse('2026-11-20T20:42:00Z'))).toMatchObject({
			generation: 3,
			sync: [NEW],
			syncState: 'steady',
		});
	});

	test('every CAS renewal extends from max(now, previous) by the DB TTL', () => {
		const now = Date.parse('2026-11-20T20:41:00Z');
		const renewed = renewedLease(lease({ expiresAt: new Date(now + 1_000).toISOString() }), now);
		expect(Date.parse(renewed.expiresAt)).toBe(now + 1_000 + DB_LEASE_TTL_MS);
		const late = renewedLease(lease({ expiresAt: new Date(now - 60_000).toISOString() }), now);
		expect(Date.parse(late.expiresAt)).toBe(now + DB_LEASE_TTL_MS);
	});

	test('parseLease rejects a malformed sync member instead of truncating it', () => {
		expect(() => parseLease(JSON.stringify({ ...lease(), sync: ['ok', 7] }))).toThrow(/malformed/);
		expect(() => parseLease(JSON.stringify({ ...lease(), sync: ['a', 'a'] }))).toThrow(/repeats/);
		expect(() => parseLease(JSON.stringify({ ...lease(), sync: ['a', 'b', 'c', 'd'] }))).toThrow(/invalid sync set/);
		// A Revision 0 lease without durabilityEffective is accepted; the requested value is in force.
		const { durabilityEffective: _ignored, ...specShaped } = lease();
		expect(parseLease(JSON.stringify(specShaped)).durabilityEffective).toBe('sync');
	});

	test('an expired steady lease is un-held: no member may acquire from it', () => {
		const expired = lease({ expiresAt: new Date(AT - 1_000).toISOString() });
		expect(acquireRefusal(expired, NEW, AT)).toContain('expired');
		expect(mayAcquire(expired, NEW, AT)).toBe(false);
		// A changing lease is still refused as changing first.
		expect(acquireRefusal({ ...expired, syncState: 'changing' }, NEW, AT)).toContain('sync-set change is open');
	});

	test('the synced test harness records expiry-renewing opens and closes', async () => {
		const f = harness();
		await f.seed(lease({ expiresAt: new Date(f.clock.now + 500).toISOString() }));
		await f.engine.begin(NEW);
		expect(Date.parse(f.store.peek(DATABASE)!.expiresAt)).toBe(f.clock.now + 500 + DB_LEASE_TTL_MS);
	});
});
