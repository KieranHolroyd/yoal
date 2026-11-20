import type {
	ConditionalStore,
	ConditionalWrite,
	ObjectStore,
	ObjectStoreBody,
	ObjectStoreStream,
	ObjectStoreTestResult,
	StoredObject,
	VersionedRead,
	WriteCondition,
} from '../object-store.ts';
import { bodyToAsyncIterable } from '../object-store.ts';
import { runConnectionProbe } from './probe.ts';

interface Entry {
	data: Uint8Array;
	version: number;
	contentType: string | undefined;
	lastModified: number;
}

/**
 * An in-memory store with the exact compare-and-swap semantics the conformance suite demands. A
 * test double for code that takes an `ObjectStore & ConditionalStore`, and the reference the suite
 * is checked against in `bun test`. Not for production: nothing persists.
 */
export class MemoryObjectStore implements ObjectStore, ConditionalStore {
	readonly kind = 's3' as const;
	readonly #shared: { objects: Map<string, Entry>; version: number };
	readonly #prefix: string;
	private readonly now: () => number;

	constructor(options: { now?: () => number; prefix?: string; shareWith?: MemoryObjectStore } = {}) {
		this.now = options.now ?? Date.now;
		this.#prefix = (options.prefix ?? '').replace(/^\/+|\/+$/g, '');
		this.#shared = options.shareWith ? options.shareWith.#shared : { objects: new Map(), version: 0 };
	}

	/** A view of the same objects under `prefix`, like a second target on the same bucket. */
	scoped(prefix: string): MemoryObjectStore {
		return new MemoryObjectStore({ now: this.now, prefix, shareWith: this });
	}

	get #objects(): Map<string, Entry> {
		return this.#shared.objects;
	}

	#full(key: string): string {
		return this.#prefix ? `${this.#prefix}/${key}` : key;
	}

	#write(key: string, data: Uint8Array, contentType?: string): Entry {
		const entry = { data, version: ++this.#shared.version, contentType, lastModified: this.now() };
		this.#objects.set(this.#full(key), entry);
		return entry;
	}

	async put(key: string, data: Uint8Array, contentType?: string): Promise<void> {
		this.#write(key, new Uint8Array(data), contentType);
	}

	async putStream(key: string, body: ObjectStoreBody, contentType?: string, size?: number): Promise<void> {
		const chunks: Uint8Array[] = [];
		let total = 0;
		for await (const chunk of bodyToAsyncIterable(body)) {
			chunks.push(chunk);
			total += chunk.byteLength;
		}
		if (size !== undefined && size !== total) throw new Error(`Object stream size mismatch for ${key}: expected ${size} bytes, got ${total}`);
		const data = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			data.set(chunk, offset);
			offset += chunk.byteLength;
		}
		this.#write(key, data, contentType);
	}

	async get(key: string): Promise<Uint8Array> {
		const entry = this.#objects.get(this.#full(key));
		if (!entry) throw new Error(`Object not found: ${key}`);
		return new Uint8Array(entry.data);
	}

	async getStream(key: string): Promise<ObjectStoreStream> {
		const data = await this.get(key);
		return { body: new Response(data).body!, size: data.byteLength };
	}

	async delete(key: string): Promise<void> {
		this.#objects.delete(this.#full(key));
	}

	async exists(key: string): Promise<boolean> {
		return this.#objects.has(this.#full(key));
	}

	async size(key: string): Promise<number | null> {
		return this.#objects.get(this.#full(key))?.data.byteLength ?? null;
	}

	async presignPut(key: string, ttlSeconds: number): Promise<string> {
		return `memory://${encodeURIComponent(key)}?method=PUT&ttl=${ttlSeconds}`;
	}

	async presignGet(key: string, ttlSeconds: number): Promise<string> {
		return `memory://${encodeURIComponent(key)}?method=GET&ttl=${ttlSeconds}`;
	}

	async *list(prefix: string): AsyncIterable<StoredObject> {
		const base = this.#prefix ? `${this.#prefix}/` : '';
		for (const full of [...this.#objects.keys()].sort()) {
			if (!full.startsWith(base + prefix)) continue;
			const entry = this.#objects.get(full);
			if (entry) yield { key: full.slice(base.length), size: entry.data.byteLength, lastModified: entry.lastModified };
		}
	}

	async readVersioned(key: string): Promise<VersionedRead> {
		const entry = this.#objects.get(this.#full(key));
		const serverDate = this.now();
		if (!entry) return { status: 404, body: null, etag: null, serverDate };
		return { status: 200, body: new TextDecoder().decode(entry.data), etag: `"${entry.version}"`, serverDate };
	}

	async writeConditional(key: string, body: string, condition: WriteCondition): Promise<ConditionalWrite> {
		const current = this.#objects.get(this.#full(key));
		const serverDate = this.now();
		const ok = 'ifMatch' in condition ? current !== undefined && `"${current.version}"` === condition.ifMatch : current === undefined;
		if (!ok) return { status: 412, etag: null, serverDate };
		const entry = this.#write(key, new TextEncoder().encode(body), 'application/json');
		return { status: 200, etag: `"${entry.version}"`, serverDate };
	}

	async testConnection(): Promise<ObjectStoreTestResult> {
		return runConnectionProbe({ kind: this.kind, store: this, head: async () => ({ versioning: null, objectLock: null }) });
	}
}
