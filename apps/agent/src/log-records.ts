import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NodeLogBatch, NodeLogRecord } from '@yoal/contracts';

/**
 * The node side of `POST /api/agent/log-records` (docs/LOGS.md §5, LP6/LP7): a bounded, per-target
 * buffer for the structured records the agent produces itself (edge access lines, OTLP logs) and the
 * POST that ships them. Tenancy is never in the payload for app scopes: the control plane resolves a
 * `site` host or a `workload` id to its project, and refuses a workload that is not on this node.
 *
 * Memory is bounded the same way the telemetry buffers are: past the cap the oldest records are
 * dropped and counted, and the count rides the next batch for that target as `dropped`.
 */

export type NodeLogTarget = NodeLogBatch['target'];

/** The contract's per-batch cap (`nodeLogBatchSchema.records.max`). */
export const LOG_RECORDS_PER_POST = 1_000;
/** Records held per target while the control plane is unreachable. */
const DEFAULT_MAX_PER_TARGET = 2_000;
/** Distinct targets held at once; a new target past this evicts the one idle longest. */
const DEFAULT_MAX_TARGETS = 500;
/** After a 404 (a control plane without the route) wait this long before trying again. */
const MISSING_ROUTE_BACKOFF_MS = 5 * 60_000;

export interface LogRecordsEndpoint {
	controlUrl: string;
	nodeToken: string;
}

/** A failed POST; `retry` says whether the same batch may succeed later. */
export class LogRecordsPostError extends Error {
	readonly status: number | null;
	readonly retry: boolean;
	/**
	 * A 404 that is not a JSON refusal: the control plane predates the route (its framework answers
	 * with a page, not an API error). A JSON 404 refuses only this batch (an unknown host or workload).
	 */
	readonly routeMissing: boolean;

	constructor(message: string, status: number | null, routeMissing = false) {
		super(message);
		this.name = 'LogRecordsPostError';
		this.status = status;
		this.routeMissing = routeMissing;
		// A network failure, an overloaded or restarting control plane: keep the batch. Anything
		// else (bad payload, a workload not on this node, no such route) will not change on retry.
		this.retry = status === null || status === 408 || status === 429 || status >= 500;
	}
}

/** One `POST /api/agent/log-records`. Throws `LogRecordsPostError` on any non-2xx. */
export async function postNodeLogBatch(
	endpoint: LogRecordsEndpoint,
	batch: NodeLogBatch,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	let response: Response;
	try {
		response = await fetchImpl(`${endpoint.controlUrl}/api/agent/log-records`, {
			method: 'POST',
			signal: AbortSignal.timeout(10_000),
			headers: {
				authorization: `Bearer ${endpoint.nodeToken}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify(batch),
		});
	} catch (error) {
		throw new LogRecordsPostError(`log-records POST failed: ${error instanceof Error ? error.message : String(error)}`, null);
	}
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		const json = (response.headers.get('content-type') ?? '').includes('json');
		throw new LogRecordsPostError(
			`log-records POST -> ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
			response.status,
			response.status === 404 && !json,
		);
	}
	// Drain the body so the connection can be reused.
	await response.arrayBuffer().catch(() => undefined);
}

interface TargetBuffer {
	target: NodeLogTarget;
	records: NodeLogRecord[];
	dropped: number;
}

export interface NodeLogBatcherOptions {
	post: (batch: NodeLogBatch) => Promise<void>;
	maxPerTarget?: number;
	maxTargets?: number;
	now?: () => number;
}

export interface NodeLogBatcherStats {
	/** Records the control plane acknowledged. */
	sent: number;
	/** Records dropped on this node: buffer overflow, eviction or a refused batch. */
	dropped: number;
	/** Batches the control plane refused for good (4xx other than 408/429). */
	rejectedBatches: number;
	failures: number;
	pending: number;
}

export function nodeLogTargetKey(target: NodeLogTarget): string {
	switch (target.kind) {
		case 'site':
			return `site:${target.host}`;
		case 'workload':
			return `workload:${target.workloadId}`;
		case 'platform':
			return `platform:${target.unit}`;
	}
}

/**
 * Per-target buffer + flush. `add` and `noteDropped` are synchronous and never throw: they run on
 * the access-log tail and inside the OTLP HTTP handler.
 */
export class NodeLogBatcher {
	private readonly post: (batch: NodeLogBatch) => Promise<void>;
	private readonly maxPerTarget: number;
	private readonly maxTargets: number;
	private readonly now: () => number;
	/** Map order is insertion order; a target is re-inserted when it gets records, so the first key is the idlest. */
	private readonly buffers = new Map<string, TargetBuffer>();
	private backoffUntil = 0;
	private flushing: Promise<void> | null = null;
	private counters = { sent: 0, dropped: 0, rejectedBatches: 0, failures: 0 };

	constructor(options: NodeLogBatcherOptions) {
		this.post = options.post;
		this.maxPerTarget = Math.max(1, options.maxPerTarget ?? DEFAULT_MAX_PER_TARGET);
		this.maxTargets = Math.max(1, options.maxTargets ?? DEFAULT_MAX_TARGETS);
		this.now = options.now ?? Date.now;
	}

	get stats(): NodeLogBatcherStats {
		let pending = 0;
		for (const buffer of this.buffers.values()) pending += buffer.records.length;
		return { ...this.counters, pending };
	}

	/** Free room left for `target` before the oldest records start being dropped. */
	room(target: NodeLogTarget): number {
		const buffer = this.buffers.get(nodeLogTargetKey(target));
		return this.maxPerTarget - (buffer?.records.length ?? 0);
	}

	add(target: NodeLogTarget, records: NodeLogRecord | NodeLogRecord[]): void {
		const list = Array.isArray(records) ? records : [records];
		if (list.length === 0) return;
		const buffer = this.buffer(target);
		buffer.records.push(...list);
		const overflow = buffer.records.length - this.maxPerTarget;
		if (overflow > 0) {
			buffer.records.splice(0, overflow);
			buffer.dropped += overflow;
			this.counters.dropped += overflow;
		}
	}

	/** Lines the producer chose not to ship (sampling); reported to the control plane, not counted locally. */
	noteDropped(target: NodeLogTarget, count: number): void {
		if (!Number.isFinite(count) || count <= 0) return;
		this.buffer(target).dropped += Math.trunc(count);
	}

	/**
	 * Ship everything buffered, oldest target first, at most 1,000 records per POST. A retryable
	 * failure puts the batch back and stops this pass (the control plane is down; the next pass
	 * retries). A permanent refusal drops that batch and moves on. Concurrent calls share one pass.
	 */
	flush(): Promise<void> {
		if (this.flushing) return this.flushing;
		this.flushing = this.flushOnce().finally(() => {
			this.flushing = null;
		});
		return this.flushing;
	}

	private async flushOnce(): Promise<void> {
		if (this.now() < this.backoffUntil) return;
		for (const key of [...this.buffers.keys()]) {
			const buffer = this.buffers.get(key);
			if (!buffer) continue;
			while (buffer.records.length > 0 || buffer.dropped > 0) {
				const records = buffer.records.splice(0, LOG_RECORDS_PER_POST);
				const dropped = buffer.dropped;
				buffer.dropped = 0;
				try {
					await this.post({ target: buffer.target, records, dropped });
					this.counters.sent += records.length;
				} catch (error) {
					this.counters.failures += 1;
					const retry = error instanceof LogRecordsPostError ? error.retry : true;
					if (retry) {
						// Put it back in front; `add` may have appended meanwhile, so re-apply the cap.
						buffer.records.unshift(...records);
						buffer.dropped += dropped;
						const overflow = buffer.records.length - this.maxPerTarget;
						if (overflow > 0) {
							buffer.records.splice(0, overflow);
							buffer.dropped += overflow;
							this.counters.dropped += overflow;
						}
						return;
					}
					this.counters.rejectedBatches += 1;
					this.counters.dropped += records.length;
					if (error instanceof LogRecordsPostError && error.routeMissing) {
						// An older control plane without the route: stop asking for a while.
						this.backoffUntil = this.now() + MISSING_ROUTE_BACKOFF_MS;
						this.counters.dropped += this.clear();
						return;
					}
				}
			}
			if (buffer.records.length === 0 && buffer.dropped === 0) this.buffers.delete(key);
		}
	}

	/** Drop every buffered record; returns how many there were. */
	private clear(): number {
		let count = 0;
		for (const buffer of this.buffers.values()) count += buffer.records.length;
		this.buffers.clear();
		return count;
	}

	private buffer(target: NodeLogTarget): TargetBuffer {
		const key = nodeLogTargetKey(target);
		let buffer = this.buffers.get(key);
		if (buffer) return buffer;
		if (this.buffers.size >= this.maxTargets) {
			const oldest = this.buffers.keys().next();
			if (!oldest.done) {
				const evicted = this.buffers.get(oldest.value);
				this.buffers.delete(oldest.value);
				this.counters.dropped += evicted?.records.length ?? 0;
			}
		}
		buffer = { target, records: [], dropped: 0 };
		this.buffers.set(key, buffer);
		return buffer;
	}
}

/**
 * A node-local secret for the log sources (32 random bytes, 0600, in the agent's data dir). It keys
 * the client-IP hash on access records and the per-workload OTLP ingest keys. It is generated once
 * and never leaves the node, so a node token rotation does not invalidate the keys workloads hold.
 */
export function loadLogsSecret(dataDir: string): Buffer {
	const path = join(dataDir, 'logs.key');
	try {
		const existing = readFileSync(path);
		if (existing.length >= 32) return existing.subarray(0, 32);
	} catch {
		// Missing or unreadable: write a new one below.
	}
	const secret = randomBytes(32);
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, secret, { mode: 0o600 });
	renameSync(temporary, path);
	return secret;
}

/** HMAC-SHA256 with domain separation, as lowercase hex. */
export function logsHmac(secret: Buffer, domain: string, value: string): string {
	return createHmac('sha256', secret).update(`${domain}\0${value}`).digest('hex');
}
