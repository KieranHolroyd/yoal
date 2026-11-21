import type { DatabaseDurability, DatabaseLease, DurabilitySettings, SyncLossPolicy } from '@yoal/contracts';
import type { ConditionalStore } from './object-store.ts';

/**
 * The H23 synchronous set (W9-SPEC Revision 1 §5.5, docs/HA-PLAN.md H23).
 *
 * The lease object is the authority. A change is always three steps and is never promotable while
 * it is open:
 *
 *  1. **open** — CAS the lease to `sync: []`, `syncState: 'changing'`, same generation. No member
 *     may acquire the lease automatically from here until step 3.
 *  2. **switch** — set `synchronous_standby_names` to the new member and write a barrier commit;
 *     the target must replay the barrier's LSN before the transition may close.
 *  3. **close** — CAS the lease to `sync: [new]`, `syncState: 'steady'`.
 *
 * If the barrier is not acknowledged within the timeout, step 3 falls back to the previous member
 * when it is healthy, else applies `on_sync_loss` (`downgrade` or `block`). A primary death while
 * `changing` leaves the lease changing: no automatic promotion happens and a person chooses
 * (W9-SPEC §5.5). Recording the new set before switching the Postgres setting is the Revision 0
 * defect: a promotion could lose an acknowledged commit.
 *
 * This module is deliberately free of SQLite and HTTP. The helper/agent supplies the two side
 * effects (`setSynchronousStandbyNames` and `writeBarrier`); the control plane and the node engine
 * share the same pure lease transitions.
 */

export const DB_LEASE_PREFIX = 'yoal/ha/db/';
/** W9-SPEC §3: `SYNC_CHANGE_TIMEOUT`. */
export const SYNC_CHANGE_TIMEOUT_MS = 30_000;
/** W9-SPEC §3: `SYNC_DOWNGRADE_AFTER`. */
export const SYNC_DOWNGRADE_AFTER_MS = 30_000;
/** W9-SPEC §3: `DB_TTL`; every CAS renews it. */
export const DB_LEASE_TTL_MS = 15_000;

/**
 * Renew a lease's expiry on every CAS: `max(now, previous) + DB_TTL`. A write that did not renew
 * would let a live holder's lease go permanently expired after one TTL (W10 review blocker 8).
 */
export function renewedLease(lease: DatabaseLease, now: number, ttlMs = DB_LEASE_TTL_MS): DatabaseLease {
	const previous = Date.parse(lease.expiresAt);
	const base = Number.isFinite(previous) ? Math.max(now, previous) : now;
	return { ...lease, expiresAt: new Date(base + ttlMs).toISOString() };
}

/** A lease that has expired by the arbiter's clock cannot be held (W9-SPEC §3, §5.2). */
export function leaseExpired(lease: DatabaseLease, now: number): boolean {
	const expiresAt = Date.parse(lease.expiresAt);
	return !Number.isFinite(expiresAt) || expiresAt <= now;
}

export function databaseLeaseKey(databaseId: string): string {
	if (!/^[a-z0-9_]{1,64}$/i.test(databaseId)) throw new Error('A database id has letters, digits and underscores only.');
	return `${DB_LEASE_PREFIX}${databaseId}.json`;
}

export interface DatabaseLeaseRecord {
	lease: DatabaseLease;
	etag: string;
}

/** Conditional access to one database's lease. The store, not this process, arbitrates. */
export interface DatabaseLeaseStore {
	read(databaseId: string): Promise<DatabaseLeaseRecord | null>;
	/** `expectedEtag` null means create; false means the store rejected the write (CAS lost). */
	compareAndSwap(databaseId: string, expectedEtag: string | null, lease: DatabaseLease): Promise<boolean>;
}

/** The object-store arbiter (`ConditionalStore`: S3/R2, Azure Blob, GCS). */
export class ObjectStoreDatabaseLeaseStore implements DatabaseLeaseStore {
	constructor(private readonly store: ConditionalStore) {}

	async read(databaseId: string): Promise<DatabaseLeaseRecord | null> {
		const response = await this.store.readVersioned(databaseLeaseKey(databaseId));
		if (response.status === 404) return null;
		if (response.status !== 200 || !response.body || !response.etag)
			throw new Error(`The database lease store answered ${response.status}${response.etag === null ? ' without an ETag' : ''}.`);
		return { lease: parseLease(response.body), etag: response.etag };
	}

	async compareAndSwap(databaseId: string, expectedEtag: string | null, lease: DatabaseLease): Promise<boolean> {
		const write = await this.store.writeConditional(
			databaseLeaseKey(databaseId),
			JSON.stringify(lease),
			expectedEtag === null ? { ifNoneMatch: '*' } : { ifMatch: expectedEtag },
		);
		if (write.status === 200) return true;
		if (write.status === 409 || write.status === 412) return false;
		throw new Error(`The database lease store answered ${write.status}.`);
	}
}

/** In-memory CAS store for tests and single-process simulations. */
export class MemoryDatabaseLeaseStore implements DatabaseLeaseStore {
	private readonly objects = new Map<string, DatabaseLeaseRecord>();
	private counter = 0;

	async read(databaseId: string): Promise<DatabaseLeaseRecord | null> {
		const object = this.objects.get(databaseId);
		return object ? { lease: structuredClone(object.lease), etag: object.etag } : null;
	}

	async compareAndSwap(databaseId: string, expectedEtag: string | null, lease: DatabaseLease): Promise<boolean> {
		const current = this.objects.get(databaseId);
		if ((current?.etag ?? null) !== expectedEtag) return false;
		this.objects.set(databaseId, { lease: structuredClone(lease), etag: `"${++this.counter}"` });
		return true;
	}

	/** Test hook: what is stored now. */
	peek(databaseId: string): DatabaseLease | null {
		return this.objects.get(databaseId)?.lease ?? null;
	}
}

export function parseLease(body: string): DatabaseLease {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error('The stored database lease is not JSON.');
	}
	if (!parsed || typeof parsed !== 'object') throw new Error('The stored database lease is not an object.');
	const value = parsed as Record<string, unknown>;
	const isDurability = (item: unknown): item is 'async' | 'sync' => item === 'async' || item === 'sync';
	if (typeof value.generation !== 'number' || !Number.isInteger(value.generation) || value.generation < 0)
		throw new Error('The stored database lease has no valid generation.');
	if (typeof value.holderNodeId !== 'string' || value.holderNodeId.length < 1 || value.holderNodeId.length > 64)
		throw new Error('The stored database lease has no valid holder.');
	if (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)))
		throw new Error('The stored database lease has no valid expiry.');
	if (!Array.isArray(value.sync) || value.sync.length > 3)
		throw new Error('The stored database lease has an invalid sync set.');
	const sync: string[] = [];
	for (const entry of value.sync) {
		if (typeof entry !== 'string' || entry.length < 1 || entry.length > 64)
			throw new Error('The stored database lease has a malformed sync member.');
		if (sync.includes(entry)) throw new Error('The stored database lease repeats a sync member.');
		sync.push(entry);
	}
	if (value.syncState !== 'steady' && value.syncState !== 'changing')
		throw new Error('The stored database lease has an invalid sync state.');
	if (!isDurability(value.durability)) throw new Error('The stored database lease has an invalid durability.');
	// `durabilityEffective` is optional on leases written before W9 Revision 1; absent means the
	// requested durability is what is in force.
	const durabilityEffective = value.durabilityEffective === undefined ? value.durability : value.durabilityEffective;
	if (!isDurability(durabilityEffective))
		throw new Error('The stored database lease has an invalid effective durability.');
	if (value.syncSetAt !== undefined && value.syncSetAt !== null && typeof value.syncSetAt !== 'string')
		throw new Error('The stored database lease has an invalid syncSetAt.');
	return {
		generation: value.generation,
		holderNodeId: value.holderNodeId,
		expiresAt: value.expiresAt,
		sync,
		syncState: value.syncState,
		durability: value.durability,
		durabilityEffective,
		syncSetAt: typeof value.syncSetAt === 'string' ? value.syncSetAt : null,
	};
}

/** A member as the engine sees it: connected, and how far its replay has reached. */
export interface SyncMemberView {
	nodeId: string;
	streaming: boolean;
	replayLsn: string | null;
}

/** `X/Y` hexadecimal WAL positions compare as one big integer; null sorts below everything. */
export function parseLsn(value: string | null | undefined): bigint | null {
	if (typeof value !== 'string') return null;
	const match = /^([0-9A-F]{1,8})\/([0-9A-F]{1,8})$/i.exec(value);
	return match ? (BigInt(`0x${match[1]}`) << 32n) + BigInt(`0x${match[2]}`) : null;
}

/** True when `replay` has reached `barrier`; the barrier argument only holds in this direction. */
export function barrierHolds(replayLsn: string | null, barrierLsn: string | null): boolean {
	if (!barrierLsn) return false;
	if (barrierLsn === '0/0') return true;
	if (!replayLsn) return false;
	const replay = parseLsn(replayLsn);
	const barrier = parseLsn(barrierLsn);
	return replay !== null && barrier !== null && replay >= barrier;
}

/** I12 gate (W9-SPEC §5.1/§5.5): a member may acquire only from a steady, unexpired lease, and if in `sync` it must be named. */
export function mayAcquire(lease: DatabaseLease, nodeId: string, now = Date.now()): boolean {
	if (lease.syncState !== 'steady') return false;
	if (leaseExpired(lease, now)) return false;
	return lease.durability === 'async' || lease.sync.includes(nodeId);
}

/** Why a member may not acquire: `null` when it may. */
export function acquireRefusal(lease: DatabaseLease | null, nodeId: string, now = Date.now()): string | null {
	if (!lease) return 'there is no database lease';
	if (lease.syncState === 'changing')
		return 'a sync-set change is open; no member may promote automatically (W9-SPEC §5.5). Choose manually.';
	// An expired lease is un-held: whoever held it could not prove it to the arbiter, so a member
	// must not treat it as permission to promote (W9-SPEC §3).
	if (leaseExpired(lease, now)) return 'the database lease has expired, so no member can prove it is the holder.';
	if (lease.durability === 'sync' && !lease.sync.includes(nodeId))
		return 'this node is not in the lease’s synchronous set, so promoting it could lose an acknowledged commit.';
	return null;
}

/** Step 1: open a non-promotable transition to `target`. Same generation, `sync: []`. */
export function openSyncChange(lease: DatabaseLease): DatabaseLease {
	if (lease.syncState !== 'steady') throw new Error('A sync-set change is already open.');
	return { ...lease, sync: [], syncState: 'changing' };
}

/** Step 3 (success): the target acknowledged the barrier, so it is eligible now. */
export function closeSyncChange(
	lease: DatabaseLease,
	target: string,
	now: number,
	durability: DatabaseDurability = lease.durability,
): DatabaseLease {
	return {
		...lease,
		sync: [target],
		syncState: 'steady',
		durability,
		durabilityEffective: durability,
		syncSetAt: new Date(now).toISOString(),
	};
}

/** Step 3 (fallback): the previous member is healthy again; it stays the synchronous standby. */
export function fallbackSyncChange(
	lease: DatabaseLease,
	previous: string,
	now: number,
	durability: DatabaseDurability = lease.durability,
): DatabaseLease {
	return {
		...lease,
		sync: [previous],
		syncState: 'steady',
		durability,
		durabilityEffective: durability,
		syncSetAt: new Date(now).toISOString(),
	};
}

/**
 * The `on_sync_loss` outcome. The *requested* durability stays what the operator asked for; what is
 * in force (`durabilityEffective`) is async after a downgrade, or sync with no named member when
 * the policy is `block`. The distinction is the alert: a degraded `sync` database must stay visible.
 */
export function loseSyncSet(
	lease: DatabaseLease,
	policy: 'downgrade' | 'block',
	settings: Pick<DurabilitySettings, 'durability'>,
	now: number,
): DatabaseLease {
	return {
		...lease,
		sync: [],
		syncState: 'steady',
		durability: settings.durability,
		durabilityEffective: policy === 'downgrade' ? 'async' : 'sync',
		syncSetAt: new Date(now).toISOString(),
	};
}

/** Observed state of a transition, for status pages and tests. */
export interface SyncTransitionState {
	phase: 'idle' | 'opening' | 'switching' | 'waiting-barrier';
	target: string | null;
	previous: string[];
	openedAt: number | null;
	deadline: number | null;
	barrierLsn: string | null;
}

export type SyncTransitionEvent =
	| { kind: 'opened'; lease: DatabaseLease }
	| { kind: 'switched'; barrierLsn: string }
	| { kind: 'closed'; lease: DatabaseLease }
	| { kind: 'fallback'; lease: DatabaseLease }
	| { kind: 'downgraded'; lease: DatabaseLease }
	| { kind: 'blocked'; lease: DatabaseLease }
	| { kind: 'refused'; reason: string };

export interface SyncEngineOptions {
	databaseId: string;
	nodeId: string;
	/** The arbiter. Writes are conditional; a lost CAS is final for this attempt. */
	store: DatabaseLeaseStore;
	settings: DurabilitySettings;
	now: () => number;
	/** Set `synchronous_standby_names` (an empty list clears it); must be idempotent. */
	setSynchronousStandbyNames: (members: string[]) => Promise<void>;
	/** Append a barrier commit and return the primary's WAL position after it commits. */
	writeBarrier: () => Promise<string>;
	/** `on_sync_loss: block` keeps sync; `downgrade` switches to async after the timeout. */
	onEvent?: (event: SyncTransitionEvent) => void;
	changeTimeoutMs?: number;
}

/**
 * The primary's progress through one sync-set change. `begin` performs steps 1 and 2; `tick`
 * performs step 3 once the target has replayed the barrier, or the fallback/downgrade on timeout.
 * A fresh process adopts a `changing` lease without a target and refuses to close it (the safe
 * outcome after a mid-change death).
 */
export class SyncSetTransition {
	readonly databaseId: string;
	readonly nodeId: string;
	private readonly store: DatabaseLeaseStore;
	private readonly settings: DurabilitySettings;
	private readonly now: () => number;
	private readonly setNames: (members: string[]) => Promise<void>;
	private readonly writeBarrier: () => Promise<string>;
	private readonly onEvent: (event: SyncTransitionEvent) => void;
	readonly changeTimeoutMs: number;
	private state: SyncTransitionState = { phase: 'idle', target: null, previous: [], openedAt: null, deadline: null, barrierLsn: null };

	constructor(options: SyncEngineOptions) {
		this.databaseId = options.databaseId;
		this.nodeId = options.nodeId;
		this.store = options.store;
		this.settings = options.settings;
		this.now = options.now;
		this.setNames = options.setSynchronousStandbyNames;
		this.writeBarrier = options.writeBarrier;
		this.onEvent = options.onEvent ?? (() => undefined);
		this.changeTimeoutMs = options.changeTimeoutMs ?? SYNC_CHANGE_TIMEOUT_MS;
	}

	status(): SyncTransitionState {
		return { ...this.state, previous: [...this.state.previous] };
	}

	/**
	 * Steps 1 and 2. Refuses when the lease is not steady (a change is already open) or when this
	 * node does not hold it. The lease alone is written by CAS; the Postgres setting follows.
	 */
	async begin(target: string): Promise<SyncTransitionEvent> {
		const current = await this.store.read(this.databaseId);
		if (!current) return this.refuse('there is no database lease');
		if (current.lease.holderNodeId !== this.nodeId) return this.refuse('this node is not the lease holder');
		if (current.lease.syncState !== 'steady') return this.refuse('a sync-set change is already open');
		const opened = renewedLease(openSyncChange(current.lease), this.now());
		if (!(await this.store.compareAndSwap(this.databaseId, current.etag, opened)))
			return this.refuse('the open lost the compare-and-swap');
		this.state = {
			phase: 'opening',
			target,
			previous: [...current.lease.sync],
			openedAt: this.now(),
			deadline: this.now() + this.changeTimeoutMs,
			barrierLsn: null,
		};
		this.onEvent({ kind: 'opened', lease: opened });
		// Step 2: the setting first, then a commit that only returns once the new member has it.
		try {
			await this.setNames([target]);
			const barrierLsn = await this.writeBarrier();
			this.state = { ...this.state, phase: 'waiting-barrier', barrierLsn };
			this.onEvent({ kind: 'switched', barrierLsn });
			return { kind: 'switched', barrierLsn };
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return this.finishWithoutBarrier(`the barrier could not be written: ${reason}`);
		}
	}

	/**
	 * Step 3. `target` is the new member's current state. Closes when it replays the barrier;
	 * before the deadline a missing acknowledgement just waits. At the deadline it falls back to a
	 * healthy previous member, else applies `on_sync_loss`.
	 */
	async tick(target: SyncMemberView | null, previous: SyncMemberView | null): Promise<SyncTransitionEvent | null> {
		if (this.state.phase !== 'waiting-barrier') return null;
		const current = await this.store.read(this.databaseId);
		if (!current || current.lease.syncState !== 'changing' || current.lease.holderNodeId !== this.nodeId)
			return this.refuse('the lease changed while the transition was open');
		const targetName = this.state.target;
		if (!targetName) return this.refuse('the transition has no target');
		if (target?.nodeId === targetName && target.streaming && barrierHolds(target.replayLsn, this.state.barrierLsn)) {
			const closed = renewedLease(closeSyncChange(current.lease, targetName, this.now(), this.settings.durability), this.now());
			if (!(await this.store.compareAndSwap(this.databaseId, current.etag, closed)))
				return this.refuse('the close lost the compare-and-swap');
			this.reset();
			this.onEvent({ kind: 'closed', lease: closed });
			return { kind: 'closed', lease: closed };
		}
		if (this.state.deadline !== null && this.now() < this.state.deadline) return null;
		// The target did not acknowledge the barrier in time.
		const old = this.state.previous[0] ?? null;
		if (old && previous?.nodeId === old && previous.streaming) {
			// The previous member must already hold the failed barrier's position before it may be
			// recorded again; otherwise naming it would allow writes it cannot protect.
			if (!barrierHolds(previous.replayLsn, this.state.barrierLsn))
				return this.lose(current, 'the previous member is behind the failed barrier');
			try {
				// Prove the reverted setting is in force with a fresh barrier before the CAS. A
				// failed set or barrier is `on_sync_loss`, never a silently recorded member.
				await this.setNames([old]);
				await this.writeBarrier();
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				return this.lose(current, `the fallback setting could not be applied: ${reason}`);
			}
			const fallback = renewedLease(fallbackSyncChange(current.lease, old, this.now(), this.settings.durability), this.now());
			if (await this.store.compareAndSwap(this.databaseId, current.etag, fallback)) {
				this.reset();
				this.onEvent({ kind: 'fallback', lease: fallback });
				return { kind: 'fallback', lease: fallback };
			}
			return this.refuse('the fallback lost the compare-and-swap');
		}
		return this.lose(current, 'the target did not acknowledge the barrier and the previous member is not healthy');
	}

	/** The primary died or the operator abandoned the change: leave the lease `changing`. */
	abandon(reason: string): SyncTransitionEvent {
		this.reset();
		return this.refuse(reason);
	}

	/** `on_sync_loss` by hand (an operator or the steady-state watchdog). */
	async applySyncLoss(reason: string): Promise<SyncTransitionEvent> {
		const current = await this.store.read(this.databaseId);
		if (!current) return this.refuse('there is no database lease');
		if (current.lease.holderNodeId !== this.nodeId) return this.refuse('this node is not the lease holder');
		return this.lose(current, reason);
	}

	private async lose(current: DatabaseLeaseRecord, reason: string): Promise<SyncTransitionEvent> {
		const policy = this.settings.onSyncLoss;
		const lease = renewedLease(loseSyncSet(current.lease, policy, this.settings, this.now()), this.now());
		if (!(await this.store.compareAndSwap(this.databaseId, current.etag, lease))) return this.refuse('the downgrade lost the compare-and-swap');
		// `downgrade` makes writes async, so the setting goes away. `block` deliberately keeps the
		// unavailable member named: `synchronous_commit = on` then makes every write wait, which is
		// the point of choosing block over an invisible RPO change. A failed clear is reported, not
		// swallowed: the lease would otherwise say async while writes still block.
		if (policy === 'downgrade') await this.setNames([]);
		this.reset();
		const event: SyncTransitionEvent = { kind: policy === 'downgrade' ? 'downgraded' : 'blocked', lease };
		this.onEvent(event);
		this.onEvent({ kind: 'refused', reason });
		return event;
	}

	/** A barrier that could not be written is a failed switch: fall back or apply the policy now. */
	private async finishWithoutBarrier(reason: string): Promise<SyncTransitionEvent> {
		const current = await this.store.read(this.databaseId);
		if (!current) return this.refuse(reason);
		const old = this.state.previous[0] ?? null;
		if (old) {
			try {
				// The setting must be back in force, proven by a barrier, before the lease names it.
				await this.setNames([old]);
				await this.writeBarrier();
			} catch (error) {
				const failure = error instanceof Error ? error.message : String(error);
				return this.lose(current, `${reason}; the fallback setting could not be applied: ${failure}`);
			}
			const fallback = renewedLease(fallbackSyncChange(current.lease, old, this.now(), this.settings.durability), this.now());
			if (await this.store.compareAndSwap(this.databaseId, current.etag, fallback)) {
				this.reset();
				this.onEvent({ kind: 'fallback', lease: fallback });
				return { kind: 'fallback', lease: fallback };
			}
		}
		return this.lose(current, reason);
	}

	private refuse(reason: string): SyncTransitionEvent {
		const event: SyncTransitionEvent = { kind: 'refused', reason };
		this.onEvent(event);
		return event;
	}

	private reset(): void {
		this.state = { phase: 'idle', target: null, previous: [], openedAt: null, deadline: null, barrierLsn: null };
	}
}

/**
 * The steady-state watchdog (W9-SPEC §5.5): with `sync` in force and its member not streaming,
 * start a transition to another replica, or after `sync_timeout` apply `on_sync_loss`.
 * Returns the transition the caller should start, when one is due.
 */
export interface SyncLossDecision {
	action: 'none' | 'transition' | 'downgrade' | 'block';
	target: string | null;
	reason: string;
}

export function syncLossDecision(options: {
	lease: DatabaseLease;
	members: readonly SyncMemberView[];
	syncTimeoutSeconds: number;
	onSyncLoss: SyncLossPolicy;
	lostSince: number | null;
	now: number;
}): SyncLossDecision {
	const { lease, members, now } = options;
	if (lease.syncState !== 'steady' || lease.durability === 'async' || lease.durabilityEffective === 'async')
		return { action: 'none', target: null, reason: '' };
	const held = lease.sync.map((nodeId) => members.find((member) => member.nodeId === nodeId)).filter((member) => member?.streaming);
	if (lease.sync.length > 0 && held.length > 0) return { action: 'none', target: null, reason: '' };
	const candidate = members.find(
		(member) => member.streaming && !lease.sync.includes(member.nodeId) && member.replayLsn !== null,
	);
	if (candidate) return { action: 'transition', target: candidate.nodeId, reason: 'the synchronous standby is not streaming' };
	if (options.lostSince === null) return { action: 'none', target: null, reason: 'waiting for the sync loss timeout' };
	if (now - options.lostSince < options.syncTimeoutSeconds * 1000)
		return { action: 'none', target: null, reason: 'waiting for the sync loss timeout' };
	return options.onSyncLoss === 'block'
		? { action: 'block', target: null, reason: `no synchronous standby for ${options.syncTimeoutSeconds} s` }
		: { action: 'downgrade', target: null, reason: `no synchronous standby for ${options.syncTimeoutSeconds} s` };
}
