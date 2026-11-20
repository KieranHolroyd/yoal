import { createHmac } from 'node:crypto';
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
import { bodyToAsyncIterable, bodyToReadableStream, strongEtag } from '../object-store.ts';
import { runConnectionProbe } from './probe.ts';
import { objectStoreTimeout, stallGuardedDownload, stallGuardedUpload, withDeadline } from './timeouts.ts';

/**
 * Azure Blob Storage (HA-PLAN W3, G17; Wave 1 lane E). One container, the Blob service REST API,
 * Shared Key or a container-scoped SAS. Azurite is the same API through `endpoint`
 * (`http://127.0.0.1:10000/devstoreaccount1`).
 *
 * - `readVersioned` returns the blob's strong ETag; `writeConditional` maps `If-Match` and
 *   `If-None-Match: *` straight through, so the HA arbiter can use Blob as a store.
 * - Uploads keep streaming: a known size is one Put Blob; an unknown size is a block upload with
 *   at most one part in memory. Downloads are streamed.
 * - Every call has a deadline; a streamed body has a stall timeout (`object-store/timeouts.ts`).
 * - Immutability is reported from the container properties (`x-ms-has-immutability-policy`), not
 *   assumed from the target row.
 */

/** The Blob service version this backend signs with. Azurite accepts it with `--skipApiVersionCheck`. */
const API_VERSION = '2021-12-02';

/** Block size for an upload of unknown length; Azure allows at most 50,000 blocks. */
export const AZURE_BLOCK_BYTES = 8 * 1024 * 1024;

export interface AzureOptions {
	endpoint: string;
	account: string;
	container: string;
	/** Key prefix owned by this store (`yoal/backups`). Added on every call, stripped from lists. */
	prefix?: string;
	/** The storage account's shared key (base64). Exactly one of this and `sasToken`. */
	accountKey?: string;
	/** A container- or blob-scoped SAS query string (with or without the leading `?`). */
	sasToken?: string;
	/** Per-request timeout (ms). Default 15 s. */
	timeoutMs?: number;
	/** Test seam; production uses the global fetch. */
	fetch?: typeof fetch;
}

export class AzureObjectStore implements ObjectStore, ConditionalStore {
	readonly kind = 'azure' as const;
	private readonly endpoint: string;
	private readonly account: string;
	private readonly container: string;
	private readonly prefix: string;
	private readonly accountKey: string | undefined;
	private readonly sas: string;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;

	constructor(options: AzureOptions) {
		const sharedKey = (options.accountKey ?? '').length > 0;
		const sasToken = (options.sasToken ?? '').length > 0;
		if (sharedKey === sasToken) throw new Error('Azure Blob needs exactly one of an account key or a SAS token');
		this.endpoint = options.endpoint.replace(/\/+$/, '');
		this.account = options.account;
		this.container = options.container;
		this.prefix = (options.prefix ?? '').replace(/^\/+|\/+$/g, '');
		this.accountKey = options.accountKey;
		this.sas = (options.sasToken ?? '').replace(/^\?/, '');
		this.fetchImpl = options.fetch ?? fetch;
		this.timeoutMs = objectStoreTimeout(options.timeoutMs);
	}

	private containerUrl(): URL {
		return new URL(`${this.endpoint}/${encodeURIComponent(this.container)}`);
	}

	private fullKey(key: string): string {
		return this.prefix ? `${this.prefix}/${key}` : key;
	}

	private blobUrl(key: string): URL {
		const encoded = this.fullKey(key)
			.split('/')
			.map((part) => encodeURIComponent(part))
			.join('/');
		const url = this.containerUrl();
		url.pathname = `${url.pathname.replace(/\/+$/, '')}/${encoded}`;
		return url;
	}

	/** `x-ms-date` + Shared Key, or a SAS query. Returns the URL to fetch (with the SAS applied). */
	private authorize(method: string, url: URL, headers: Headers): URL {
		headers.set('x-ms-version', API_VERSION);
		if (this.accountKey) {
			headers.set('x-ms-date', new Date().toUTCString());
			headers.set('authorization', this.sign(method, url, headers));
			return url;
		}
		const signed = new URL(url);
		for (const [name, value] of new URLSearchParams(this.sas)) signed.searchParams.set(name, value);
		return signed;
	}

	/** Shared Key signature over the logical resource (never the Azurite path-style URL). */
	private sign(method: string, url: URL, headers: Headers): string {
		const header = (name: string) => headers.get(name) ?? '';
		const contentLength = header('content-length');
		const canonicalHeaders = [...headers.entries()]
			.filter(([name]) => name.toLowerCase().startsWith('x-ms-'))
			.map(([name, value]) => [name.toLowerCase(), value.trim()] as const)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, value]) => `${name}:${value}\n`)
			.join('');
		const resource = this.canonicalResource(url);
		const stringToSign = [
			method,
			header('content-encoding'),
			header('content-language'),
			contentLength === '0' ? '' : contentLength,
			header('content-md5'),
			header('content-type'),
			'', // Date (x-ms-date is used)
			header('if-modified-since'),
			header('if-match'),
			header('if-none-match'),
			header('if-unmodified-since'),
			header('range'),
		].join('\n') + `\n${canonicalHeaders}${resource}`;
		return `SharedKey ${this.account}:${createHmac('sha256', Buffer.from(this.accountKey!, 'base64')).update(stringToSign).digest('base64')}`;
	}

	/** `/{account}/{container}/{blob}` plus the sorted query, as Shared Key defines it. */
	private canonicalResource(url: URL): string {
		// Always `/{account}` + the URL path. Azurite's path-style URL already carries the account,
		// so the account appears twice there; that is what the service and the SDKs sign.
		const resource = `/${this.account}${url.pathname}`;
		const query = [...url.searchParams.entries()]
			.sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))
			.map(([name, value]) => `\n${name.toLowerCase()}:${value}`)
			.join('');
		return `${resource}${query}`;
	}

	/** Sign and dispatch. Buffered callers wrap this in `withDeadline`; streamed bodies manage their own. */
	private async send(method: string, url: URL, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
		const headers = new Headers(init.headers);
		const target = this.authorize(method, url, headers);
		const request: RequestInit & { duplex?: 'half' } = { ...init, method, headers };
		if (init.body !== undefined) request.duplex = 'half';
		return signal ? this.fetchImpl(target, { ...request, signal }) : this.fetchImpl(target, request);
	}

	private request<T>(
		operation: string,
		method: string,
		url: URL,
		init: RequestInit,
		read: (response: Response) => Promise<T>,
	): Promise<T> {
		return withDeadline(`Azure ${operation}`, this.timeoutMs, async (signal) => read(await this.send(method, url, init, signal)));
	}

	async put(key: string, data: Uint8Array, contentType?: string): Promise<void> {
		await this.putBuffered(key, data, contentType);
	}

	async putStream(key: string, body: ObjectStoreBody, contentType?: string, size?: number): Promise<void> {
		if (size === undefined) return this.putUnknownSize(key, body, contentType);
		const headers = this.blobHeaders(size, contentType);
		const stream = bodyToReadableStream(body);
		try {
			const response = await stallGuardedUpload(`Azure PUT ${key}`, this.timeoutMs, stream, (guarded, signal) =>
				this.send('PUT', this.blobUrl(key), { body: guarded as unknown as RequestInit['body'], headers }, signal),
			);
			if (!response.ok)
				throw new Error(
					`Azure PUT ${key} failed: ${response.status} ${await response.text().catch(() => '')}`.trim(),
				);
		} catch (error) {
			await stream.cancel(error).catch(() => undefined);
			throw error;
		}
	}

	private blobHeaders(size: number, contentType?: string): Record<string, string> {
		const headers: Record<string, string> = { 'x-ms-blob-type': 'BlockBlob', 'content-length': String(size) };
		if (contentType) headers['x-ms-blob-content-type'] = contentType;
		return headers;
	}

	private async putBuffered(key: string, data: Uint8Array, contentType?: string): Promise<void> {
		await this.request(`PUT ${key}`, 'PUT', this.blobUrl(key), { body: data as unknown as RequestInit['body'], headers: this.blobHeaders(data.byteLength, contentType) }, async (response) => {
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				throw new Error(`Azure PUT ${key} failed: ${response.status} ${text}`.trim());
			}
			await response.body?.cancel().catch(() => undefined);
		});
	}

	/**
	 * An upload of unknown length: one Put Blob when it fits in a block, otherwise Put Block per
	 * part and a Put Block List. A failure leaves uncommitted blocks, which the service drops.
	 */
	private async putUnknownSize(key: string, body: ObjectStoreBody, contentType?: string): Promise<void> {
		const parts = chunkedParts(bodyToAsyncIterable(body), AZURE_BLOCK_BYTES);
		const first = await parts.next();
		const firstPart = first.done ? new Uint8Array(0) : first.value;
		const second = first.done ? first : await parts.next();
		if (second.done) {
			await this.putBuffered(key, firstPart, contentType);
			return;
		}
		const ids: string[] = [];
		const putBlock = async (data: Uint8Array) => {
			const id = Buffer.from(String(ids.length).padStart(6, '0')).toString('base64');
			ids.push(id);
			const url = this.blobUrl(key);
			url.searchParams.set('comp', 'block');
			url.searchParams.set('blockid', id);
			await this.request(`Put Block ${key} #${ids.length}`, 'PUT', url, {
				body: data as unknown as RequestInit['body'],
				headers: { 'content-length': String(data.byteLength) },
			}, async (response) => {
				if (!response.ok) {
					const text = await response.text().catch(() => '');
					throw new Error(`Azure PUT ${key} block ${ids.length} failed: ${response.status} ${text}`.trim());
				}
				await response.body?.cancel().catch(() => undefined);
			});
		};
		await putBlock(firstPart);
		await putBlock(second.value);
		for (let next = await parts.next(); !next.done; next = await parts.next()) await putBlock(next.value);
		const xml = `<?xml version="1.0" encoding="utf-8"?><BlockList>${ids.map((id) => `<Latest>${id}</Latest>`).join('')}</BlockList>`;
		const data = new TextEncoder().encode(xml);
		const url = this.blobUrl(key);
		url.searchParams.set('comp', 'blocklist');
		await this.request(`Put Block List ${key}`, 'PUT', url, {
			body: data,
			headers: {
				'content-type': 'application/xml',
				'content-length': String(data.byteLength),
				...(contentType ? { 'x-ms-blob-content-type': contentType } : {}),
			},
		}, async (response) => {
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				throw new Error(`Azure PUT ${key} block list failed: ${response.status} ${text}`.trim());
			}
			await response.body?.cancel().catch(() => undefined);
		});
	}

	async get(key: string): Promise<Uint8Array> {
		return this.request(`GET ${key}`, 'GET', this.blobUrl(key), {}, async (response) => {
			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);
				throw new Error(`Azure GET ${key} failed: ${response.status}`);
			}
			return new Uint8Array(await response.arrayBuffer());
		});
	}

	async getStream(key: string): Promise<ObjectStoreStream> {
		const response = await stallGuardedDownload(`Azure GET ${key}`, this.timeoutMs, (signal) =>
			this.send('GET', this.blobUrl(key), {}, signal),
		);
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new Error(`Azure GET ${key} failed: ${response.status}`);
		}
		const length = Number(response.headers.get('content-length'));
		return {
			body: response.body ?? emptyStream(),
			size: response.headers.get('content-length') !== null && Number.isFinite(length) ? length : null,
		};
	}

	async delete(key: string): Promise<void> {
		await this.request(`DELETE ${key}`, 'DELETE', this.blobUrl(key), {}, async (response) => {
			await response.body?.cancel().catch(() => undefined);
			if (!response.ok && response.status !== 404) throw new Error(`Azure DELETE ${key} failed: ${response.status}`);
		});
	}

	async exists(key: string): Promise<boolean> {
		return this.request(`HEAD ${key}`, 'HEAD', this.blobUrl(key), {}, async (response) => {
			await response.body?.cancel().catch(() => undefined);
			return response.ok;
		});
	}

	async size(key: string): Promise<number | null> {
		return this.request(`HEAD ${key}`, 'HEAD', this.blobUrl(key), {}, async (response) => {
			await response.body?.cancel().catch(() => undefined);
			if (!response.ok) return null;
			const length = Number(response.headers.get('content-length'));
			return Number.isFinite(length) ? length : null;
		});
	}

	async *list(prefix: string): AsyncIterable<StoredObject> {
		let marker = '';
		const searchPrefix = this.fullKey(prefix);
		do {
			const url = this.containerUrl();
			url.searchParams.set('restype', 'container');
			url.searchParams.set('comp', 'list');
			url.searchParams.set('prefix', searchPrefix);
			url.searchParams.set('maxresults', '1000');
			if (marker) url.searchParams.set('marker', marker);
			const page = await this.request(`LIST ${prefix}`, 'GET', url, {}, async (response) => {
				if (!response.ok) throw new Error(`Azure LIST ${prefix} failed: ${response.status} ${await response.text()}`);
				return parseBlobList(await response.text());
			});
			for (const object of page.objects) {
				if (this.prefix && !object.key.startsWith(`${this.prefix}/`)) continue;
				yield { ...object, key: this.prefix ? object.key.slice(this.prefix.length + 1) : object.key };
			}
			marker = page.nextMarker;
		} while (marker);
	}

	/** `Accept-Encoding: identity` keeps the ETag strong (a compressed response may carry `W/`). */
	async readVersioned(key: string): Promise<VersionedRead> {
		return this.request(
			`GET ${key}`,
			'GET',
			this.blobUrl(key),
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
		const headers = this.blobHeaders(data.byteLength, 'application/json');
		headers['ifMatch' in condition ? 'if-match' : 'if-none-match'] =
			'ifMatch' in condition ? condition.ifMatch : condition.ifNoneMatch;
		return this.request(`PUT ${key}`, 'PUT', this.blobUrl(key), { body: data, headers }, async (response) => {
			await response.body?.cancel().catch(() => undefined);
			return {
				// Put Blob answers 201; callers speak the 200 of every other backend.
				status: response.status === 201 ? 200 : response.status,
				etag: response.ok ? strongEtag(response.headers.get('etag')) : null,
				serverDate: parseHttpDate(response.headers.get('date')),
			};
		});
	}

	/** A service SAS over one blob when the target has an account key; a supplied SAS is used as-is. */
	private presign(method: 'GET' | 'PUT', key: string, ttlSeconds: number): string {
		const url = this.blobUrl(key);
		if (this.sas) {
			for (const [name, value] of new URLSearchParams(this.sas)) url.searchParams.set(name, value);
			return url.toString();
		}
		const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
		const permissions = method === 'GET' ? 'r' : 'w';
		// A service SAS over a blob signs `/blob/{account}/{container}/{blob}`.
		const resource = `/blob/${this.account}/${this.container}/${this.fullKey(key)}`;
		const stringToSign = [
			permissions,
			'',
			expires,
			resource,
			'', // signed identifier
			'', // signed IP
			'', // signed protocol
			API_VERSION,
			'b', // signed resource: blob
			'', // snapshot time
			'', // encryption scope
			'', // rscc
			'', // rscd
			'', // rsce
			'', // rscl
			'', // rsct
		].join('\n');
		const signature = createHmac('sha256', Buffer.from(this.accountKey!, 'base64')).update(stringToSign).digest('base64');
		url.searchParams.set('sv', API_VERSION);
		url.searchParams.set('sr', 'b');
		url.searchParams.set('sp', permissions);
		url.searchParams.set('se', expires);
		url.searchParams.set('sig', signature);
		return url.toString();
	}

	presignPut(key: string, ttlSeconds: number): Promise<string> {
		return Promise.resolve(this.presign('PUT', key, ttlSeconds));
	}

	presignGet(key: string, ttlSeconds: number): Promise<string> {
		return Promise.resolve(this.presign('GET', key, ttlSeconds));
	}

	/**
	 * Create the container when it does not exist. Not part of `ObjectStore`: production containers
	 * are provisioned outside Yoal. The conformance subject uses it to set up Azurite.
	 */
	async ensureContainer(): Promise<void> {
		const url = this.containerUrl();
		url.searchParams.set('restype', 'container');
		await this.request('PUT container', 'PUT', url, {}, async (response) => {
			const text = response.ok ? '' : await response.text().catch(() => '');
			await response.body?.cancel().catch(() => undefined);
			if (!response.ok && response.status !== 409 && !/ContainerAlreadyExists/i.test(text))
				throw new Error(`Azure create container ${this.container} failed: ${response.status} ${text}`.trim());
		});
	}

	async testConnection(options: { skipConditional?: boolean } = {}): Promise<ObjectStoreTestResult> {
		return runConnectionProbe({
			kind: this.kind,
			store: this,
			skipConditional: options.skipConditional,
			head: async () => {
				const url = this.containerUrl();
				url.searchParams.set('restype', 'container');
				const headers = await this.request('GET container properties', 'GET', url, {}, async (response) => {
					await response.body?.cancel().catch(() => undefined);
					if (!response.ok) throw new Error(`Azure GET container properties failed: ${response.status}`);
					return response.headers;
				});
				const versioning = headers.get('x-ms-versioning-enabled');
				const immutable = headers.get('x-ms-has-immutability-policy');
				return {
					versioning: versioning === null ? null : versioning === 'true',
					objectLock: immutable === null ? null : immutable === 'true',
				};
			},
		});
	}
}

/** Re-chunk a byte stream into parts of exactly `size` bytes (the last may be shorter). */
async function* chunkedParts(source: AsyncIterable<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
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

function emptyStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.close();
		},
	});
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

/** Parse one Azure `List Blobs` page. */
function parseBlobList(xml: string): { objects: StoredObject[]; nextMarker: string } {
	const objects: StoredObject[] = [];
	for (const match of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
		const body = match[1]!;
		const key = xmlTag(body, 'Name');
		if (key === undefined) continue;
		const modified = Date.parse(xmlTag(body, 'Last-Modified') ?? '');
		objects.push({
			key: unescapeXml(key),
			size: Number(xmlTag(body, 'Content-Length') ?? xmlTag(body, 'Size') ?? 0),
			lastModified: Number.isFinite(modified) ? modified : 0,
		});
	}
	return { objects, nextMarker: unescapeXml(xmlTag(xml, 'NextMarker') ?? '').trim() };
}
