import { randomUUID } from 'node:crypto';
import type {
	ConditionalStore,
	ObjectStore,
	ObjectStoreKind,
	ObjectStoreTestChecks,
	ObjectStoreTestResult,
} from '../object-store.ts';

/**
 * The connection check every remote backend runs (`testConnection`), and the active conformance
 * probe for conditional writes (HA-PLAN W3; Wave 0 S3/S7). A store that answers 501 is the easy
 * case; the probe also catches stores that accept `If-None-Match`/`If-Match` and ignore them, which
 * a 501 check never would.
 */

export type ConditionalWriteSupport = 'supported' | 'unsupported' | 'unknown';

export interface ConditionalProbeResult {
	support: ConditionalWriteSupport;
	/** What went wrong when the support is not `supported`. Never contains credentials. */
	detail: string | null;
}

const won = (status: number) => status === 200;
const lost = (status: number) => status === 409 || status === 412;

/**
 * Create → a conflicting create must lose (409/412) → replace with the right version must win →
 * the same stale version must now lose → a read returns the replacement and its version. The probe
 * object is deleted afterwards whatever happened.
 */
export async function probeConditionalWrites(
	store: ConditionalStore & Pick<ObjectStore, 'delete'>,
	key = `yoal/healthcheck/cas-${randomUUID()}.json`,
): Promise<ConditionalProbeResult> {
	const unsupported = (detail: string): ConditionalProbeResult => ({ support: 'unsupported', detail });
	try {
		const created = await store.writeConditional(key, '{"probe":1}', { ifNoneMatch: '*' });
		if (created.status === 501) return unsupported('the store has no conditional PUT (501)');
		if (!won(created.status)) return unsupported(`a create with If-None-Match: * answered ${created.status}`);
		if (!created.etag) return unsupported('a conditional create returned no strong version (ETag or generation)');
		const again = await store.writeConditional(key, '{"probe":2}', { ifNoneMatch: '*' });
		if (!lost(again.status))
			return unsupported(`a second create of the same object answered ${again.status}; it must lose with 412 or 409`);
		const replaced = await store.writeConditional(key, '{"probe":3}', { ifMatch: created.etag });
		if (!won(replaced.status) || !replaced.etag)
			return unsupported(`a replace with the current version answered ${replaced.status}`);
		if (replaced.etag === created.etag) return unsupported('a replace did not change the version');
		const stale = await store.writeConditional(key, '{"probe":4}', { ifMatch: created.etag });
		if (!lost(stale.status)) return unsupported(`a replace with a stale version answered ${stale.status}; it must lose with 412 or 409`);
		const read = await store.readVersioned(key);
		if (read.status !== 200 || read.body !== '{"probe":3}')
			return unsupported(`the object read back was not the winning write (status ${read.status})`);
		if (read.etag !== replaced.etag) return unsupported('a read returned a different version than the winning write (a weak or rewritten ETag)');
		return { support: 'supported', detail: null };
	} catch (error) {
		return { support: 'unknown', detail: errorMessage(error) };
	} finally {
		await store.delete(key).catch(() => undefined);
	}
}

export interface ConnectionProbeOptions {
	kind: ObjectStoreKind;
	store: ObjectStore & Required<Pick<ObjectStore, 'list'>> & Partial<ConditionalStore>;
	/** The bucket or container check; returns what the backend can report about immutability. */
	head(): Promise<{ versioning: boolean | null; objectLock: boolean | null }>;
	/** Skip the conditional-write probe (a write-only key cannot delete the probe object). */
	skipConditional?: boolean;
}

/** head → put → list → delete, then the conditional probe. `ok` does not depend on the probe. */
export async function runConnectionProbe(options: ConnectionProbeOptions): Promise<ObjectStoreTestResult> {
	const { kind, store } = options;
	const started = Date.now();
	const checks: ObjectStoreTestChecks = { head: false, put: false, list: false, delete: false };
	const key = `yoal/healthcheck/${randomUUID()}.txt`;
	let versioning: boolean | null = null;
	let objectLock: boolean | null = null;
	try {
		({ versioning, objectLock } = await options.head());
		checks.head = true;
		await store.put(key, new TextEncoder().encode(`yoal connection test ${new Date().toISOString()}\n`), 'text/plain');
		checks.put = true;
		for await (const object of store.list('yoal/healthcheck/')) {
			if (object.key === key) {
				checks.list = true;
				break;
			}
		}
		await store.delete(key);
		checks.delete = true;
	} catch (error) {
		await store.delete(key).catch(() => undefined);
		return { ok: false, kind, latencyMs: Date.now() - started, checks, error: errorMessage(error), versioning, objectLock };
	}
	const latencyMs = Date.now() - started;
	if (options.skipConditional || !store.readVersioned || !store.writeConditional)
		return { ok: true, kind, latencyMs, checks, versioning, objectLock, conditionalWrites: 'unknown' };
	const conditional = await probeConditionalWrites(store as ConditionalStore & ObjectStore);
	checks.conditional = conditional.support === 'supported';
	return {
		ok: true,
		kind,
		latencyMs,
		checks,
		versioning,
		objectLock,
		conditionalWrites: conditional.support,
		...(conditional.detail ? { conditionalDetail: conditional.detail } : {}),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
