import type {
	ConditionalStore,
	ConditionalWrite,
	ObjectStore,
	VersionedRead,
	WriteCondition,
} from './object-store.ts';

/**
 * The W9 arbiter (docs/build-plan/W9-SPEC.md §2, CLUSTERING §6.3).
 *
 * The arbiter is the object store's conditional object API, never a separate service: S3/R2,
 * Azure Blob and GCS already implement `ConditionalStore` (`If-Match`, `If-None-Match: *`), and the
 * database lease later reuses the same object. This module is the one place that decides whether a
 * configured store can arbitrate at all. A store without an atomic conditional write makes HA
 * unavailable and the surfaces fail closed (W9-SPEC assumption 1) instead of pretending.
 *
 * Status mapping is deliberately the spec's:
 * - `200` won; the returned ETag is the next condition;
 * - `409` / `412` lost the compare-and-swap — re-read, never retry blind;
 * - `501`, or a `200` without a strong ETag, means the store cannot arbitrate.
 */
export class ArbiterUnavailableError extends Error {}

/** True when the store exposes both halves of the conditional API. */
export function isConditionalStore(store: ObjectStore): store is ObjectStore & ConditionalStore {
	const candidate = store as Partial<ConditionalStore>;
	return typeof candidate.readVersioned === 'function' && typeof candidate.writeConditional === 'function';
}

/**
 * The arbiter view of a platform object store. Throws `ArbiterUnavailableError` synchronously so a
 * caller can fail closed before a lease is ever read or written.
 */
export function arbiterStore(store: ObjectStore): ConditionalStore {
	if (!isConditionalStore(store))
		throw new ArbiterUnavailableError(
			`The ${store.kind} object store has no conditional write; control-plane HA cannot arbitrate and stays off.`,
		);
	return new FailClosedConditionalStore(store);
}

/** What a CAS result means to the lease machine. */
export type CasOutcome = 'won' | 'lost' | 'unavailable' | 'error';

export function casOutcome(status: number, hasEtag = true): CasOutcome {
	if (status === 200) return hasEtag ? 'won' : 'unavailable';
	if (status === 409 || status === 412) return 'lost';
	if (status === 501) return 'unavailable';
	return 'error';
}

/**
 * Normalises the few backend differences before the lease sees them:
 * - a success without a strong ETag is `501`: no future `If-Match` can ever match, so a silent
 *   success would turn one bad response into an undefined lease;
 * - a missing `Date` is preserved, and the lease (which owns the clock rule) fails closed.
 */
class FailClosedConditionalStore implements ConditionalStore {
	constructor(private readonly store: ObjectStore & ConditionalStore) {}

	async readVersioned(key: string): Promise<VersionedRead> {
		const read = await this.store.readVersioned(key);
		if (read.status === 200 && (read.body === null || !read.etag))
			return { ...read, status: 501 };
		return read;
	}

	async writeConditional(key: string, body: string, condition: WriteCondition): Promise<ConditionalWrite> {
		const write = await this.store.writeConditional(key, body, condition);
		if (write.status === 200 && !write.etag) return { ...write, status: 501 };
		// Azure answers 201 Created for a conditional create; the lease treats it as a win.
		if (write.status === 201) return { ...write, status: 200 };
		return write;
	}
}
