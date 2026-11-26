import { formatLogScope, type LogRecord, type LogScopeKind } from '@yoal/contracts';
import type { LogReadBoundary } from './log-store/types.ts';
import { unifiedRowToLogRecord, type SqliteLogTag, type UnifiedLogRow } from './log-store/sqlite-sources.ts';
import type { LogSeqVector } from './log-store/sqlite-store.ts';

/**
 * Live tail (docs/LOGS.md §4.4, LP4). `LogService.append*` publishes the rows it inserts here;
 * each subscriber (SSE, CLI `-f`, MCP tail) registers its server-resolved boundary and a predicate
 * compiled once from its query, and receives only matching rows. Nothing polls the database.
 *
 * Each subscriber has a bounded queue. When it falls more than `capacity` lines behind, the oldest
 * queued lines are dropped and counted, so the client shows a "sampled" notice and stays live,
 * like CloudWatch Live Tail. The bus is per process, which is right with one active control plane.
 */

export const LOG_TAIL_QUEUE_CAPACITY = 2_000;

/** Platform-wide scope kinds a cross-org (platform admin) boundary reads without `org_id`. */
const CROSS_ORG_KINDS: ReadonlySet<LogScopeKind> = new Set<LogScopeKind>(['platform', 'edge']);

interface TailItem {
	tag: SqliteLogTag;
	seq: number;
	record: LogRecord;
}

export interface LogTailFilter {
	boundary: LogReadBoundary;
	/** From `compileLogPredicate`; a throwing predicate counts as "no match". */
	predicate: (record: LogRecord) => boolean;
	capacity?: number;
}

export class LogTailSubscription {
	readonly #bus: LogTailBus;
	readonly #orgId: string;
	readonly #crossOrg: boolean;
	readonly #scopes: ReadonlySet<string>;
	readonly #predicate: (record: LogRecord) => boolean;
	readonly #capacity: number;
	#queue: TailItem[] = [];
	#dropped = 0;
	#floor: LogSeqVector = {};
	#vector: LogSeqVector = {};
	#waiters: Array<() => void> = [];
	#closed = false;

	constructor(bus: LogTailBus, filter: LogTailFilter) {
		this.#bus = bus;
		this.#orgId = filter.boundary.orgId;
		this.#crossOrg = filter.boundary.crossOrg;
		this.#scopes = new Set(filter.boundary.scopes.map(formatLogScope));
		this.#predicate = filter.predicate;
		this.#capacity = Math.max(1, filter.capacity ?? LOG_TAIL_QUEUE_CAPACITY);
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** Highest seq seen per table, merged with the floor: the resume cursor for this subscriber. */
	get vector(): LogSeqVector {
		const merged: LogSeqVector = { ...this.#floor };
		for (const [tag, seq] of Object.entries(this.#vector) as Array<[SqliteLogTag, number]>)
			if (seq > (merged[tag] ?? 0)) merged[tag] = seq;
		return merged;
	}

	/**
	 * Rows at or below the floor were already sent by a catch-up read; skip them, including any
	 * that were queued while the catch-up ran.
	 */
	setFloor(floor: LogSeqVector): void {
		this.#floor = { ...floor };
		this.#queue = this.#queue.filter((item) => item.seq > (this.#floor[item.tag] ?? 0));
	}

	/** @internal Called by the bus for every published batch. */
	offer(items: readonly TailItem[]): void {
		if (this.#closed) return;
		let added = false;
		for (const item of items) {
			if (item.seq > (this.#vector[item.tag] ?? 0)) this.#vector[item.tag] = item.seq;
			if (item.seq <= (this.#floor[item.tag] ?? 0)) continue;
			if (!this.#inBoundary(item.record)) continue;
			let matches = false;
			try {
				matches = this.#predicate(item.record);
			} catch {
				matches = false;
			}
			if (!matches) continue;
			this.#queue.push(item);
			added = true;
		}
		if (this.#queue.length > this.#capacity) {
			const overflow = this.#queue.length - this.#capacity;
			this.#queue.splice(0, overflow);
			this.#dropped += overflow;
		}
		if (added) this.#wake();
	}

	/** Everything queued since the last call, plus how many lines were dropped to stay live. */
	take(): { records: LogRecord[]; dropped: number } {
		const records = this.#queue.map((item) => item.record);
		const dropped = this.#dropped;
		this.#queue = [];
		this.#dropped = 0;
		return { records, dropped };
	}

	get pending(): number {
		return this.#queue.length;
	}

	/** Resolves when lines are queued, after `timeoutMs`, on abort, or on close. */
	wait(timeoutMs: number, signal?: AbortSignal): Promise<void> {
		if (this.#closed || this.#queue.length > 0 || this.#dropped > 0 || signal?.aborted) return Promise.resolve();
		return new Promise((resolve) => {
			const finish = (): void => {
				clearTimeout(timer);
				signal?.removeEventListener('abort', finish);
				this.#waiters = this.#waiters.filter((waiter) => waiter !== finish);
				resolve();
			};
			const timer = setTimeout(finish, Math.max(0, timeoutMs));
			signal?.addEventListener('abort', finish, { once: true });
			this.#waiters.push(finish);
		});
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#queue = [];
		this.#bus.unsubscribe(this);
		this.#wake();
	}

	#inBoundary(record: LogRecord): boolean {
		if (!this.#scopes.has(formatLogScope(record.scope))) return false;
		if (record.orgId === this.#orgId) return true;
		return this.#crossOrg && CROSS_ORG_KINDS.has(record.scope.kind);
	}

	#wake(): void {
		const waiters = this.#waiters;
		this.#waiters = [];
		for (const waiter of waiters) waiter();
	}
}

export class LogTailBus {
	readonly #subscribers = new Set<LogTailSubscription>();

	get size(): number {
		return this.#subscribers.size;
	}

	subscribe(filter: LogTailFilter): LogTailSubscription {
		const subscription = new LogTailSubscription(this, filter);
		this.#subscribers.add(subscription);
		return subscription;
	}

	/** @internal */
	unsubscribe(subscription: LogTailSubscription): void {
		this.#subscribers.delete(subscription);
	}

	/** Fan inserted rows out to every subscriber. Rows are mapped once, only when someone listens. */
	publish(rows: readonly UnifiedLogRow[]): void {
		if (this.#subscribers.size === 0 || rows.length === 0) return;
		const items: TailItem[] = rows.map((row) => ({
			tag: row.tag,
			seq: Number(row.seq),
			record: unifiedRowToLogRecord(row),
		}));
		for (const subscriber of this.#subscribers) subscriber.offer(items);
	}

	/** Close every subscriber (shutdown, tests). */
	closeAll(): void {
		for (const subscriber of [...this.#subscribers]) subscriber.close();
	}
}
