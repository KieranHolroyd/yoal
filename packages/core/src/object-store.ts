import { AwsClient } from 'aws4fetch';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { hmac, randomToken, safeEqual } from './util.ts';
import { runConnectionProbe, type ConditionalWriteSupport } from './object-store/probe.ts';
import {
	objectStoreTimeout,
	stallGuardedDownload,
	stallGuardedUpload,
	withDeadline,
} from './object-store/timeouts.ts';

/**
 * Artifact storage (DESIGN §10, D25). S3-compatible endpoints (R2, MinIO, RustFS, Garage) are
 * canonical in v1; a local filesystem store exists for development and single-node installs.
 * Presigned URLs let large uploads go direct to the bucket and let agents download releases
 * without an extra hop through the control plane.
 */
/**
 * `azure` and `gcs` are HA-PLAN W3 backends (`object-store-factory.ts`, Wave 1 lane E), each
 * behind its `OBJECT_STORE_*` flag; nothing constructs them while the flags are off.
 */
export type ObjectStoreKind = 'local' | 's3' | 'azure' | 'gcs';

/** A stream we can upload: a web `ReadableStream` or any async iterable of byte chunks. */
export type ObjectStoreBody = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export interface ObjectStoreStream {
	body: ReadableStream<Uint8Array>;
	/** Bytes declared by the backend, or null when it does not send a Content-Length. */
	size: number | null;
}

export interface ObjectStoreTestChecks {
	head: boolean;
	put: boolean;
	list: boolean;
	delete: boolean;
	/** The active conditional-write probe passed (absent when it was not run). */
	conditional?: boolean;
}

export interface ObjectStoreTestResult {
	ok: boolean;
	kind: ObjectStoreKind;
	latencyMs: number;
	checks: ObjectStoreTestChecks;
	error?: string;
	/** Bucket versioning, when the backend can report it. Null means unknown/unsupported. */
	versioning?: boolean | null;
	/** Bucket object-lock, when the backend can report it. Null means unknown/unsupported. */
	objectLock?: boolean | null;
	/**
	 * The active conditional-write probe (`probeConditionalWrites`): what the HA arbiter needs.
	 * Absent for stores that cannot be probed (local). It never decides `ok`: a backup target does
	 * not need compare-and-swap.
	 */
	conditionalWrites?: ConditionalWriteSupport;
	/** Why the probe did not report `supported`. */
	conditionalDetail?: string;
}

export interface ObjectStore {
	readonly kind: ObjectStoreKind;
	put(key: string, data: Uint8Array, contentType?: string): Promise<void>;
	/**
	 * Stream an object to storage without holding it in memory. `size` is optional, but supplying
	 * it lets the backend send a Content-Length (S3 prefers it) and lets the local store detect a
	 * truncated stream.
	 */
	putStream(key: string, body: ObjectStoreBody, contentType?: string, size?: number): Promise<void>;
	get(key: string): Promise<Uint8Array>;
	/** Stream an object back without buffering the whole body. */
	getStream(key: string): Promise<ObjectStoreStream>;
	delete(key: string): Promise<void>;
	exists(key: string): Promise<boolean>;
	/** Stored size in bytes, or null when the object is missing. Lets finalize reject oversize uploads before downloading them. */
	size?(key: string): Promise<number | null>;
	/** Browser/CLI PUT URL. */
	presignPut(key: string, ttlSeconds: number, contentType?: string): Promise<string>;
	/** Agent GET URL. */
	presignGet(key: string, ttlSeconds: number): Promise<string>;
	/**
	 * Every object under `prefix` (e.g. `releases/`), in pages. Prune uses it to find objects with
	 * no row (docs/OPERATIONS.md L6).
	 */
	list?(prefix: string): AsyncIterable<StoredObject>;
	/** Probe the target with head/put/list/delete. Used by backup target setup, never by reads. */
	testConnection?(): Promise<ObjectStoreTestResult>;
}

/**
 * A read that carries what a compare-and-swap needs: the object's version and the store's own
 * clock (the `Date` header), which the HA lease trusts instead of the local wall clock
 * (CLUSTERING §6.3).
 *
 * `etag` is an opaque version token: the strong ETag for `s3` and `azure`, the object generation
 * for `gcs`. A backend returns null rather than a token it cannot compare exactly (a weak `W/`
 * ETag), so a caller fails closed instead of looping on a `If-Match` that never matches.
 */
export interface VersionedRead {
	status: number;
	/** Present on 200. */
	body: string | null;
	etag: string | null;
	/** Epoch ms from the response `Date` header, or null when the store sent none. */
	serverDate: number | null;
}

/** `ifNoneMatch: '*'` creates only; `ifMatch` replaces only the version read. */
export type WriteCondition = { ifMatch: string } | { ifNoneMatch: '*' };

export interface ConditionalWrite {
	/**
	 * 200 won (every backend maps its own success code, such as Azure's 201, to 200); 409/412 lost
	 * the race; 501 means the store has no conditional PUT.
	 */
	status: number;
	etag: string | null;
	serverDate: number | null;
}

/** Conditional object access: the only arbiter of one control-plane primary (§6.3). */
export interface ConditionalStore {
	readVersioned(key: string): Promise<VersionedRead>;
	writeConditional(key: string, body: string, condition: WriteCondition): Promise<ConditionalWrite>;
}

export interface StoredObject {
	key: string;
	size: number;
	/** Epoch milliseconds. */
	lastModified: number;
}

/**
 * The `storage` column predates the R2 → S3 generalization and still constrains values to
 * `local`/`r2` (packages/db/src/migrations.ts 0001). Map the new kind back so old rows and CHECK
 * constraints keep working until the schema migration ships.
 */
export function storageKindForDb(kind: ObjectStoreKind): 'local' | 'r2' {
	// Every remote store is `r2` ("remote") in that column; one platform has one store, whose kind
	// is configuration, so the column never needs widening.
	return kind === 'local' ? 'local' : 'r2';
}

function isReadableStream(body: ObjectStoreBody): body is ReadableStream<Uint8Array> {
	return typeof (body as ReadableStream<Uint8Array> | undefined)?.getReader === 'function';
}

/** Adapt either stream shape to the async iterable the local writer and fetch fake consume. */
export function bodyToAsyncIterable(body: ObjectStoreBody): AsyncIterable<Uint8Array> {
	if (!isReadableStream(body)) return body;
	return {
		async *[Symbol.asyncIterator]() {
			const reader = body.getReader();
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) return;
					if (value && value.byteLength > 0) yield value;
				}
			} finally {
				reader.releaseLock();
			}
		},
	};
}

/** Adapt either stream shape to the web stream `fetch` accepts as a body. */
export function bodyToReadableStream(body: ObjectStoreBody): ReadableStream<Uint8Array> {
	if (isReadableStream(body)) return body;
	const iterator = body[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await iterator.next();
				if (done) controller.close();
				else controller.enqueue(value);
			} catch (error) {
				controller.error(error);
			}
		},
		async cancel(reason) {
			await iterator.return?.(reason);
		},
	});
}

function emptyStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.close();
		},
	});
}

/** One-chunk stream for the buffered `put` path; callers already hold those bytes. */
function bytesAsStream(data: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(data);
			controller.close();
		},
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class LocalObjectStore implements ObjectStore {
	readonly kind = 'local' as const;
	constructor(
		private readonly root: string,
		private readonly publicUrl: string,
		private readonly signingSecret: string,
		/** Path the signed URL is served from; backup targets mount their own object route. */
		private readonly urlBase = '/api/objects/',
	) {}

	private path(key: string): string {
		const full = resolve(join(this.root, normalize(key)));
		if (!full.startsWith(resolve(this.root) + '/')) throw new Error('Invalid object key');
		return full;
	}

	async put(key: string, data: Uint8Array, _contentType?: string): Promise<void> {
		const path = this.path(key);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, data);
	}

	async putStream(key: string, body: ObjectStoreBody, _contentType?: string, size?: number): Promise<void> {
		const path = this.path(key);
		await mkdir(dirname(path), { recursive: true });
		// Write beside the destination then rename, so a failed/aborted stream never replaces a
		// previously complete object.
		const temporary = `${path}.tmp-${randomUUID()}`;
		let written = 0;
		async function* counted() {
			for await (const chunk of bodyToAsyncIterable(body)) {
				written += chunk.byteLength;
				yield chunk;
			}
		}
		try {
			await pipeline(Readable.from(counted()), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
			if (size !== undefined && written !== size)
				throw new Error(`Object stream size mismatch for ${key}: expected ${size} bytes, wrote ${written}`);
			await rename(temporary, path);
		} catch (error) {
			await rm(temporary, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	async get(key: string): Promise<Uint8Array> {
		return new Uint8Array(await readFile(this.path(key)));
	}

	async getStream(key: string): Promise<ObjectStoreStream> {
		const path = this.path(key);
		const info = await stat(path);
		if (!info.isFile()) throw new Error(`Object not found: ${key}`);
		return {
			body: Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>,
			size: info.size,
		};
	}

	async delete(key: string): Promise<void> {
		await rm(this.path(key), { force: true });
	}

	async exists(key: string): Promise<boolean> {
		try {
			return (await stat(this.path(key))).isFile();
		} catch {
			return false;
		}
	}

	async size(key: string): Promise<number | null> {
		try {
			const info = await stat(this.path(key));
			return info.isFile() ? info.size : null;
		} catch {
			return null;
		}
	}

	async *list(prefix: string): AsyncIterable<StoredObject> {
		const base = resolve(this.root);
		const start = resolve(join(base, normalize(prefix)));
		if (start !== base && !start.startsWith(base + '/')) throw new Error('Invalid object prefix');
		let entries: string[];
		try {
			entries = (await readdir(start, { recursive: true })) as string[];
		} catch {
			return;
		}
		for (const entry of entries.sort()) {
			const full = join(start, entry);
			const info = await stat(full).catch(() => null);
			if (!info?.isFile()) continue;
			yield { key: full.slice(base.length + 1), size: info.size, lastModified: info.mtimeMs };
		}
	}

	async presignPut(key: string, ttlSeconds: number): Promise<string> {
		return this.sign('PUT', key, ttlSeconds);
	}

	async presignGet(key: string, ttlSeconds: number): Promise<string> {
		return this.sign('GET', key, ttlSeconds);
	}

	private sign(method: 'GET' | 'PUT', key: string, ttlSeconds: number): string {
		const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
		const signature = hmac(this.signingSecret, `${method}\n${key}\n${exp}`);
		return `${this.publicUrl}${this.urlBase}${key}?exp=${exp}&sig=${signature}`;
	}

	/** Verify a presigned URL produced by `presignPut` / `presignGet`. */
	verify(method: 'GET' | 'PUT', key: string, exp: number, signature: string): boolean {
		if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
		return safeEqual(hmac(this.signingSecret, `${method}\n${key}\n${exp}`), signature);
	}

	async testConnection(): Promise<ObjectStoreTestResult> {
		const started = Date.now();
		const checks: ObjectStoreTestChecks = { head: false, put: false, list: false, delete: false };
		const key = `yoal/healthcheck/${randomUUID()}.txt`;
		try {
			await mkdir(this.root, { recursive: true });
			checks.head = (await stat(this.root)).isDirectory();
			const data = new TextEncoder().encode(`yoal connection test ${new Date().toISOString()}\n`);
			await this.putStream(key, bytesAsStream(data), 'text/plain', data.byteLength);
			checks.put = true;
			for await (const object of this.list('yoal/healthcheck/')) {
				if (object.key === key) {
					checks.list = true;
					break;
				}
			}
			await this.delete(key);
			checks.delete = true;
			return { ok: true, kind: this.kind, latencyMs: Date.now() - started, checks, versioning: null, objectLock: false };
		} catch (error) {
			await this.delete(key).catch(() => undefined);
			return {
				ok: false,
				kind: this.kind,
				latencyMs: Date.now() - started,
				checks,
				error: errorMessage(error),
				versioning: null,
				objectLock: false,
			};
		}
	}
}

export interface S3Options {
	/** Base endpoint, e.g. `https://minio.internal:9000`. No bucket name in the path. */
	endpoint: string;
	bucket: string;
	/** SigV4 region. R2 uses `auto`; most S3-compatible servers accept `us-east-1`. */
	region?: string;
	/** Path-style (`endpoint/bucket/key`) or virtual-hosted (`bucket.endpoint/key`). Defaults true. */
	forcePathStyle?: boolean;
	/**
	 * Key prefix owned by this store (`yoal/backups`). Callers keep using relative keys; the store
	 * adds the prefix to every operation and strips it from listed keys.
	 */
	prefix?: string;
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	/**
	 * Per-request timeout (ms). A buffered call must finish inside it; a streamed body is aborted
	 * when the store makes no progress for this long (`object-store/timeouts.ts`). Default 15 s.
	 */
	timeoutMs?: number;
	/** Test seam; production uses the global fetch. */
	fetch?: typeof fetch;
}

export interface R2Options {
	accountId: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	/** Optional custom endpoint (MinIO, Garage); defaults to R2. */
	endpoint?: string;
	region?: string;
	forcePathStyle?: boolean;
	timeoutMs?: number;
	fetch?: typeof fetch;
}

type StreamingRequestInit = RequestInit & { duplex?: 'half' };

/**
 * A strong validator, or null. A weak ETag (`W/"…"`) is never usable with `If-Match`: R2 answers a
 * gzip-encoded GET with one, and an `If-Match` on it never matches (Wave 0 S3), so a caller holding
 * it would lose every compare-and-swap forever. Returning null makes the caller fail closed.
 */
export function strongEtag(value: string | null): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	return trimmed && !/^w\//i.test(trimmed) ? trimmed : null;
}

/**
 * S3-compatible object store. Speaks the same ListObjectsV2 and presign dialects as R2, MinIO,
 * RustFS and Garage. Upload/download bodies stay streams; no arrayBuffer on the streaming paths.
 * Every request has a timeout (`timeoutMs`).
 */
export class S3ObjectStore implements ObjectStore, ConditionalStore {
	readonly kind = 's3' as const;
	private readonly client: AwsClient;
	private readonly endpoint: string;
	private readonly bucket: string;
	private readonly forcePathStyle: boolean;
	private readonly fetchImpl: typeof fetch;
	private readonly prefix: string;
	private readonly timeoutMs: number;

	constructor(options: S3Options) {
		this.endpoint = options.endpoint.replace(/\/+$/, '');
		this.bucket = options.bucket;
		this.forcePathStyle = options.forcePathStyle ?? true;
		this.prefix = (options.prefix ?? '').replace(/^\/+|\/+$/g, '');
		this.fetchImpl = options.fetch ?? fetch;
		this.timeoutMs = objectStoreTimeout(options.timeoutMs);
		this.client = new AwsClient({
			accessKeyId: options.accessKeyId,
			secretAccessKey: options.secretAccessKey,
			sessionToken: options.sessionToken,
			service: 's3',
			region: options.region ?? 'us-east-1',
			retries: 0,
		});
	}

	private baseUrl(): URL {
		return new URL(this.endpoint);
	}

	private bucketUrl(): URL {
		const url = this.baseUrl();
		if (this.forcePathStyle) {
			url.pathname = `${url.pathname.replace(/\/+$/, '')}/${encodeURIComponent(this.bucket)}`;
		} else {
			url.host = `${this.bucket}.${url.host}`;
			url.pathname = url.pathname.replace(/\/+$/, '');
		}
		return url;
	}

	private fullKey(key: string): string {
		return this.prefix ? `${this.prefix}/${key}` : key;
	}

	private url(key: string): URL {
		const encoded = this.fullKey(key)
			.split('/')
			.map((part) => encodeURIComponent(part))
			.join('/');
		const url = this.bucketUrl();
		url.pathname = `${url.pathname.replace(/\/+$/, '')}/${encoded}`;
		return url;
	}

	/** Sign and dispatch. `sign` is used instead of `AwsClient.fetch` so requests are not retried after a body stream was consumed. */
	private async send(url: URL, init: StreamingRequestInit = {}, signal?: AbortSignal): Promise<Response> {
		const request = await this.client.sign(url.toString(), init);
		return signal ? this.fetchImpl(request, { signal }) : this.fetchImpl(request);
	}

	/** A buffered request: `read` consumes the response inside the same deadline. */
	private request<T>(
		operation: string,
		url: URL,
		init: StreamingRequestInit,
		read: (response: Response) => Promise<T>,
	): Promise<T> {
		return withDeadline(`S3 ${operation}`, this.timeoutMs, async (signal) => read(await this.send(url, init, signal)));
	}

	async put(key: string, data: Uint8Array, contentType?: string): Promise<void> {
		await this.putStream(key, bytesAsStream(data), contentType, data.byteLength);
	}

	async putStream(key: string, body: ObjectStoreBody, contentType?: string, size?: number): Promise<void> {
		// S3 refuses a PUT without Content-Length (411 on MinIO and AWS), so an upload of unknown
		// size goes through multipart, unless it turns out to fit in one part.
		if (size === undefined) return this.putUnknownSize(key, body, contentType);
		const headers: Record<string, string> = {};
		if (contentType) headers['content-type'] = contentType;
		headers['content-length'] = String(size);
		const stream = bodyToReadableStream(body);
		try {
			const response = await stallGuardedUpload(`S3 PUT ${key}`, this.timeoutMs, stream, (guarded, signal) =>
				this.send(
					this.url(key),
					{ method: 'PUT', body: guarded as unknown as RequestInit['body'], headers, duplex: 'half' },
					signal,
				),
			);
			if (!response.ok)
				throw new Error(`S3 PUT ${key} failed: ${response.status} ${await response.text().catch(() => '')}`.trim());
		} catch (error) {
			// If signing or the request failed before the body was fully consumed, release it so the
			// producer stops reading from its source.
			await stream.cancel(error).catch(() => undefined);
			throw error;
		}
	}

	/**
	 * A stream of unknown length: one buffered PUT when it fits in a part, otherwise a multipart
	 * upload of `S3_MULTIPART_PART_BYTES` parts (at most one part in memory). Each part is a
	 * buffered request with the normal deadline; a failure aborts the upload so no parts linger.
	 */
	private async putUnknownSize(key: string, body: ObjectStoreBody, contentType?: string): Promise<void> {
		const parts = chunkedParts(bodyToAsyncIterable(body), S3_MULTIPART_PART_BYTES);
		const first = await parts.next();
		const firstPart = first.done ? new Uint8Array(0) : first.value;
		const second = first.done ? first : await parts.next();
		if (second.done) {
			await this.putBuffered(key, firstPart, contentType);
			return;
		}
		const url = this.url(key);
		url.searchParams.set('uploads', '');
		const uploadId = await this.request(`CreateMultipartUpload ${key}`, url, {
			method: 'POST',
			headers: contentType ? { 'content-type': contentType } : {},
		}, async (response) => {
			const text = await response.text();
			if (!response.ok) throw new Error(`S3 PUT ${key} failed: ${response.status} ${text}`.trim());
			const id = xmlTag(text, 'UploadId');
			if (!id) throw new Error(`S3 PUT ${key} failed: no UploadId in CreateMultipartUpload`);
			return unescapeXml(id);
		});
		const etags: string[] = [];
		try {
			const upload = async (data: Uint8Array) => {
				const number = etags.length + 1;
				const partUrl = this.url(key);
				partUrl.searchParams.set('partNumber', String(number));
				partUrl.searchParams.set('uploadId', uploadId);
				etags.push(
					await this.request(`UploadPart ${key} #${number}`, partUrl, {
						method: 'PUT',
						body: data as unknown as RequestInit['body'],
						headers: { 'content-length': String(data.byteLength) },
					}, async (response) => {
						const text = await response.text().catch(() => '');
						const etag = response.headers.get('etag');
						if (!response.ok || !etag) throw new Error(`S3 PUT ${key} part ${number} failed: ${response.status} ${text}`.trim());
						return etag;
					}),
				);
			};
			await upload(firstPart);
			await upload(second.value);
			for (let next = await parts.next(); !next.done; next = await parts.next()) await upload(next.value);
			const completeUrl = this.url(key);
			completeUrl.searchParams.set('uploadId', uploadId);
			const xml = `<CompleteMultipartUpload>${etags
				.map((etag, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`)
				.join('')}</CompleteMultipartUpload>`;
			const data = new TextEncoder().encode(xml);
			await this.request(`CompleteMultipartUpload ${key}`, completeUrl, {
				method: 'POST',
				body: data,
				headers: { 'content-type': 'application/xml', 'content-length': String(data.byteLength) },
			}, async (response) => {
				const text = await response.text();
				// S3 can answer 200 and put the error in the body.
				if (!response.ok || /<Error>/.test(text)) throw new Error(`S3 PUT ${key} failed to complete: ${response.status} ${text}`.trim());
			});
		} catch (error) {
			const abortUrl = this.url(key);
			abortUrl.searchParams.set('uploadId', uploadId);
			await this.request(`AbortMultipartUpload ${key}`, abortUrl, { method: 'DELETE' }, async (response) => {
				await response.body?.cancel().catch(() => undefined);
			}).catch(() => undefined);
			await parts.return?.(undefined);
			throw error;
		}
	}

	private async putBuffered(key: string, data: Uint8Array, contentType?: string): Promise<void> {
		const headers: Record<string, string> = { 'content-length': String(data.byteLength) };
		if (contentType) headers['content-type'] = contentType;
		await this.request(`PUT ${key}`, this.url(key), { method: 'PUT', body: data as unknown as RequestInit['body'], headers }, async (response) => {
			if (!response.ok)
				throw new Error(`S3 PUT ${key} failed: ${response.status} ${await response.text().catch(() => '')}`.trim());
			await response.body?.cancel().catch(() => undefined);
		});
	}

	async get(key: string): Promise<Uint8Array> {
		return this.request(`GET ${key}`, this.url(key), {}, async (response) => {
			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);
				throw new Error(`S3 GET ${key} failed: ${response.status}`);
			}
			return new Uint8Array(await response.arrayBuffer());
		});
	}

	async getStream(key: string): Promise<ObjectStoreStream> {
		const response = await stallGuardedDownload(`S3 GET ${key}`, this.timeoutMs, (signal) => this.send(this.url(key), {}, signal));
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new Error(`S3 GET ${key} failed: ${response.status}`);
		}
		const length = Number(response.headers.get('content-length'));
		return {
			body: response.body ?? emptyStream(),
			size: response.body && response.headers.get('content-length') !== null && Number.isFinite(length) ? length : null,
		};
	}

	async delete(key: string): Promise<void> {
		await this.request(`DELETE ${key}`, this.url(key), { method: 'DELETE' }, async (response) => {
			await response.body?.cancel().catch(() => undefined);
			if (!response.ok && response.status !== 404) throw new Error(`S3 DELETE ${key} failed: ${response.status}`);
		});
	}

	async exists(key: string): Promise<boolean> {
		return this.request(`HEAD ${key}`, this.url(key), { method: 'HEAD' }, async (response) => response.ok);
	}

	async size(key: string): Promise<number | null> {
		return this.request(`HEAD ${key}`, this.url(key), { method: 'HEAD' }, async (response) => {
			if (!response.ok) return null;
			const length = Number(response.headers.get('content-length'));
			return Number.isFinite(length) ? length : null;
		});
	}

	async *list(prefix: string): AsyncIterable<StoredObject> {
		let token: string | undefined;
		const searchPrefix = this.fullKey(prefix);
		do {
			const url = this.bucketUrl();
			url.searchParams.set('list-type', '2');
			url.searchParams.set('prefix', searchPrefix);
			url.searchParams.set('max-keys', '1000');
			if (token) url.searchParams.set('continuation-token', token);
			const page = await this.request(`LIST ${prefix}`, url, {}, async (response) => {
				if (!response.ok) throw new Error(`S3 LIST ${prefix} failed: ${response.status} ${await response.text()}`);
				return parseListObjects(await response.text());
			});
			if (this.prefix) {
				for (const object of page.objects)
					yield {
						...object,
						key: object.key.startsWith(`${this.prefix}/`) ? object.key.slice(this.prefix.length + 1) : object.key,
					};
			} else {
				yield* page.objects;
			}
			token = page.nextToken;
		} while (token);
	}

	/**
	 * `Accept-Encoding: identity` so the store never compresses the body: a compressed response
	 * carries a weak ETag (R2), which no `If-Match` will ever match (Wave 0 S3). A weak ETag that
	 * arrives anyway is returned as null.
	 */
	async readVersioned(key: string): Promise<VersionedRead> {
		return this.request(
			`GET ${key}`,
			this.url(key),
			{ headers: { 'cache-control': 'no-cache', 'accept-encoding': 'identity' } },
			async (response) => {
				const serverDate = parseHttpDate(response.headers.get('date'));
				if (!response.ok) {
					await response.body?.cancel().catch(() => undefined);
					return { status: response.status, body: null, etag: null, serverDate };
				}
				return { status: 200, body: await response.text(), etag: strongEtag(response.headers.get('etag')), serverDate };
			},
		);
	}

	async writeConditional(key: string, body: string, condition: WriteCondition): Promise<ConditionalWrite> {
		const data = new TextEncoder().encode(body);
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			'content-length': String(data.byteLength),
			...('ifMatch' in condition ? { 'if-match': condition.ifMatch } : { 'if-none-match': condition.ifNoneMatch }),
		};
		return this.request(`PUT ${key}`, this.url(key), { method: 'PUT', body: data, headers }, async (response) => {
			await response.body?.cancel().catch(() => undefined);
			return {
				status: response.status,
				etag: response.ok ? strongEtag(response.headers.get('etag')) : null,
				serverDate: parseHttpDate(response.headers.get('date')),
			};
		});
	}

	private async presign(method: 'GET' | 'PUT', key: string, ttlSeconds: number): Promise<string> {
		const url = this.url(key);
		url.searchParams.set('X-Amz-Expires', String(ttlSeconds));
		const signed = await this.client.sign(new Request(url.toString(), { method }), {
			aws: { signQuery: true },
		});
		return signed.url;
	}

	presignPut(key: string, ttlSeconds: number): Promise<string> {
		return this.presign('PUT', key, ttlSeconds);
	}

	presignGet(key: string, ttlSeconds: number): Promise<string> {
		return this.presign('GET', key, ttlSeconds);
	}

	/**
	 * Bucket HEAD (with object lock and versioning when the store reports them), put, list and
	 * delete, then the active conditional-write probe (`probeConditionalWrites`).
	 */
	async testConnection(options: { skipConditional?: boolean } = {}): Promise<ObjectStoreTestResult> {
		return runConnectionProbe({
			kind: this.kind,
			store: this,
			skipConditional: options.skipConditional,
			head: async () => {
				const head = await this.request(`HEAD bucket ${this.bucket}`, this.bucketUrl(), { method: 'HEAD' }, async (response) => response);
				if (!head.ok) throw new Error(`S3 HEAD bucket ${this.bucket} failed: ${head.status}`);
				const lock = head.headers.get('x-amz-bucket-object-lock-enabled');
				let objectLock: boolean | null = lock === null ? null : lock === 'true';
				let versioning: boolean | null = null;
				try {
					const url = this.bucketUrl();
					url.searchParams.set('versioning', '');
					versioning = await this.request('GET bucket versioning', url, {}, async (response) =>
						response.ok ? /<Status>\s*Enabled\s*<\/Status>/i.test(await response.text()) : null,
					);
				} catch {
					// Versioning is a nice-to-have; a key without GetBucketVersioning still backs up.
				}
				if (objectLock === null) {
					try {
						const url = this.bucketUrl();
						url.searchParams.set('object-lock', '');
						objectLock = await this.request('GET bucket object-lock', url, {}, async (response) => {
							if (response.ok) return /<ObjectLockEnabled>\s*Enabled\s*<\/ObjectLockEnabled>/i.test(await response.text());
							const text = await response.text().catch(() => '');
							// AWS and MinIO answer 404 ObjectLockConfigurationNotFoundError on a bucket without it.
							return response.status === 404 && /ObjectLockConfigurationNotFound/i.test(text) ? false : null;
						});
					} catch {
						// Same: object lock is reported when the key may read it.
					}
				}
				return { versioning, objectLock };
			},
		});
	}
}

/** R2 is an S3 endpoint. Kept as an alias/config path so existing `YOAL_OBJECT_STORE=r2` installs work. */
export class R2ObjectStore extends S3ObjectStore {
	constructor(options: R2Options) {
		const { accountId, endpoint, ...rest } = options;
		super({
			...rest,
			endpoint: endpoint?.replace(/\/+$/, '') ?? `https://${accountId}.r2.cloudflarestorage.com`,
			region: options.region ?? 'auto',
			forcePathStyle: options.forcePathStyle ?? true,
		});
	}
}

/** Part size for S3 multipart uploads of unknown length (S3 needs at least 5 MiB but the last). */
export const S3_MULTIPART_PART_BYTES = 8 * 1024 * 1024;

/** Re-chunk a byte stream into parts of exactly `size` bytes (the last may be shorter). */
export async function* chunkedParts(source: AsyncIterable<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
	let buffer = new Uint8Array(size);
	let filled = 0;
	for await (const chunk of source) {
		let offset = 0;
		while (offset < chunk.byteLength) {
			const take = Math.min(size - filled, chunk.byteLength - offset);
			buffer.set(chunk.subarray(offset, offset + take), filled);
			filled += take;
			offset += take;
			if (filled === size) {
				yield buffer;
				buffer = new Uint8Array(size);
				filled = 0;
			}
		}
	}
	if (filled > 0) yield buffer.subarray(0, filled);
}

function escapeXml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function parseHttpDate(value: string | null): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

const xmlEntities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (value: string): string =>
	value.replace(/&(amp|lt|gt|quot|apos);/g, (_match, name: string) => xmlEntities[name]!);
const xmlTag = (xml: string, tag: string): string | undefined =>
	xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];

/** Parse one S3 ListObjectsV2 response page (R2, MinIO and Garage all speak it). */
export function parseListObjects(xml: string): { objects: StoredObject[]; nextToken?: string } {
	const objects: StoredObject[] = [];
	for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
		const body = match[1]!;
		const key = xmlTag(body, 'Key');
		if (key === undefined) continue;
		const modified = Date.parse(xmlTag(body, 'LastModified') ?? '');
		objects.push({
			key: unescapeXml(key),
			size: Number(xmlTag(body, 'Size') ?? 0),
			lastModified: Number.isFinite(modified) ? modified : 0,
		});
	}
	const truncated = xmlTag(xml, 'IsTruncated') === 'true';
	const next = xmlTag(xml, 'NextContinuationToken');
	return { objects, ...(truncated && next ? { nextToken: unescapeXml(next) } : {}) };
}

export function objectKeyForUpload(id: string): string {
	return `uploads/${id}.zip`;
}

export function objectKeyForRelease(sha256: string): string {
	return `releases/${sha256}.zip`;
}

export { randomToken };
