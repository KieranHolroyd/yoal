import { createHash, createSign, randomUUID } from 'node:crypto';
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
import { bodyToReadableStream, strongEtag } from '../object-store.ts';
import { runConnectionProbe } from './probe.ts';
import { objectStoreTimeout, stallGuardedDownload, stallGuardedUpload, withDeadline } from './timeouts.ts';

/**
 * Google Cloud Storage (HA-PLAN W3, G17; Wave 0 S7; Wave 1 lane E). One bucket through the JSON
 * API v1, so the compare-and-swap token is the object **generation** — a decimal string that never
 * repeats, which makes it a sound arbiter (S7). `endpoint` points at fake-gcs-server in tests.
 *
 * - `{ ifMatch: g }` → `ifGenerationMatch=g`; `{ ifNoneMatch: '*' }` → `ifGenerationMatch=0`.
 * - S7 found 429 is GCS's main loser answer under contention (a throttle decides nothing, never a
 *   win). It is returned as a status so the caller retries; it is never mapped to success.
 * - Uploads and downloads stream. A service-account key file signs the OAuth token and presigned
 *   V4 URLs; an emulator can run anonymously (`anonymous`) or with a fixed token.
 */

const SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';
const JSON_API = '/storage/v1';
const UPLOAD_API = '/upload/storage/v1';

export interface GcsOptions {
	bucket: string;
	/** Defaults to `https://storage.googleapis.com`; set for fake-gcs-server. */
	endpoint?: string;
	prefix?: string;
	/** A service-account key file (JSON). Required for real GCS and for presigned URLs. */
	serviceAccountJson?: string;
	/** A pre-issued OAuth token (an emulator, or a short-lived credential from outside). */
	accessToken?: string;
	/** No Authorization header (fake-gcs-server); real GCS refuses anonymous writes. */
	anonymous?: boolean;
	timeoutMs?: number;
	fetch?: typeof fetch;
}

interface ServiceAccount {
	client_email: string;
	private_key: string;
	private_key_id?: string;
	token_uri?: string;
}

/** One token per key, shared by every store built from it (single flight). */
class ServiceAccountAuth {
	#token: { value: string; expiresAt: number } | null = null;
	#pending: Promise<string> | null = null;
	constructor(private readonly account: ServiceAccount) {}

	async header(): Promise<string> {
		if (this.#token && this.#token.expiresAt - Date.now() > 120_000) return `Bearer ${this.#token.value}`;
		this.#pending ??= this.#fetchToken().finally(() => (this.#pending = null));
		return `Bearer ${await this.#pending}`;
	}

	async #fetchToken(): Promise<string> {
		const tokenUri = this.account.token_uri ?? 'https://oauth2.googleapis.com/token';
		const now = Math.floor(Date.now() / 1000);
		const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
		const unsigned = `${b64({ alg: 'RS256', typ: 'JWT', kid: this.account.private_key_id })}.${b64({
			iss: this.account.client_email,
			scope: SCOPE,
			aud: tokenUri,
			iat: now,
			exp: now + 3600,
		})}`;
		const signature = createSign('RSA-SHA256').update(unsigned).sign(this.account.private_key).toString('base64url');
		const response = await fetch(tokenUri, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
				assertion: `${unsigned}.${signature}`,
			}),
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new Error(`GCS OAuth token exchange failed: HTTP ${response.status}`);
		}
		const json = (await response.json()) as { access_token: string; expires_in: number };
		this.#token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
		return json.access_token;
	}
}

export class GcsObjectStore implements ObjectStore, ConditionalStore {
	readonly kind = 'gcs' as const;
	private readonly base: string;
	private readonly bucket: string;
	private readonly prefix: string;
	private readonly account: ServiceAccount | null;
	private readonly fixedToken: string | null;
	private readonly anonymous: boolean;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private auth: ServiceAccountAuth | null = null;

	constructor(options: GcsOptions) {
		this.base = (options.endpoint ?? 'https://storage.googleapis.com').replace(/\/+$/, '');
		this.bucket = options.bucket;
		this.prefix = (options.prefix ?? '').replace(/^\/+|\/+$/g, '');
		this.account = options.serviceAccountJson ? (JSON.parse(options.serviceAccountJson) as ServiceAccount) : null;
		this.fixedToken = options.accessToken ?? null;
		this.anonymous = options.anonymous === true || (!this.account && !this.fixedToken);
		this.fetchImpl = options.fetch ?? fetch;
		this.timeoutMs = objectStoreTimeout(options.timeoutMs);
	}

	private fullKey(key: string): string {
		return this.prefix ? `${this.prefix}/${key}` : key;
	}

	/** The object name is one path segment on the JSON API, so its slashes are encoded too. */
	private objectUrl(key: string, query: Record<string, string> = {}): URL {
		const url = new URL(`${this.base}${JSON_API}/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(this.fullKey(key))}`);
		for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
		return url;
	}

	private uploadUrl(name: string, query: Record<string, string>): URL {
		const url = new URL(`${this.base}${UPLOAD_API}/b/${encodeURIComponent(this.bucket)}/o`);
		url.searchParams.set('uploadType', 'media');
		url.searchParams.set('name', name);
		url.searchParams.set('fields', 'generation');
		for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
		return url;
	}

	private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
		const headers: Record<string, string> = { ...extra };
		if (this.anonymous) return headers;
		if (this.fixedToken) {
			headers.authorization = `Bearer ${this.fixedToken}`;
			return headers;
		}
		this.auth ??= new ServiceAccountAuth(this.account!);
		headers.authorization = await this.auth.header();
		return headers;
	}

	private async send(method: string, url: URL, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
		const headers = await this.headers((init.headers as Record<string, string> | undefined) ?? {});
		const request: RequestInit & { duplex?: 'half' } = { ...init, method, headers };
		if (init.body !== undefined) request.duplex = 'half';
		return signal ? this.fetchImpl(url, { ...request, signal }) : this.fetchImpl(url, request);
	}

	private request<T>(
		operation: string,
		method: string,
		url: URL,
		init: RequestInit,
		read: (response: Response) => Promise<T>,
	): Promise<T> {
		return withDeadline(`GCS ${operation}`, this.timeoutMs, async (signal) => read(await this.send(method, url, init, signal)));
	}

	async put(key: string, data: Uint8Array, contentType?: string): Promise<void> {
		await this.putStream(
			key,
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(data);
					controller.close();
				},
			}),
			contentType,
			data.byteLength,
		);
	}

	async putStream(key: string, body: ObjectStoreBody, contentType?: string, size?: number): Promise<void> {
		const headers: Record<string, string> = {};
		if (contentType) headers['content-type'] = contentType;
		if (size !== undefined) headers['content-length'] = String(size);
		const stream = bodyToReadableStream(body);
		const url = this.uploadUrl(this.fullKey(key), {});
		try {
			const response = await stallGuardedUpload(`GCS PUT ${key}`, this.timeoutMs, stream, (guarded, signal) =>
				this.send('POST', url, { body: guarded as unknown as RequestInit['body'], headers }, signal),
			);
			if (!response.ok)
				throw new Error(
					`GCS PUT ${key} failed: ${response.status} ${(await response.text().catch(() => '')).slice(0, 300)}`.trim(),
				);
			await response.body?.cancel().catch(() => undefined);
		} catch (error) {
			await stream.cancel(error).catch(() => undefined);
			throw error;
		}
	}

	async get(key: string): Promise<Uint8Array> {
		return this.request(`GET ${key}`, 'GET', this.objectUrl(key, { alt: 'media' }), {}, async (response) => {
			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);
				throw new Error(`GCS GET ${key} failed: ${response.status}`);
			}
			return new Uint8Array(await response.arrayBuffer());
		});
	}

	async getStream(key: string): Promise<ObjectStoreStream> {
		const response = await stallGuardedDownload(`GCS GET ${key}`, this.timeoutMs, (signal) =>
			this.send('GET', this.objectUrl(key, { alt: 'media' }), {}, signal),
		);
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new Error(`GCS GET ${key} failed: ${response.status}`);
		}
		const length = Number(response.headers.get('content-length'));
		return {
			body: response.body ?? emptyStream(),
			size: response.headers.get('content-length') !== null && Number.isFinite(length) ? length : null,
		};
	}

	async delete(key: string): Promise<void> {
		await this.request(`DELETE ${key}`, 'DELETE', this.objectUrl(key), {}, async (response) => {
			await response.body?.cancel().catch(() => undefined);
			if (!response.ok && response.status !== 404) throw new Error(`GCS DELETE ${key} failed: ${response.status}`);
		});
	}

	async exists(key: string): Promise<boolean> {
		return (await this.metadata(key)) !== null;
	}

	async size(key: string): Promise<number | null> {
		const meta = await this.metadata(key);
		return meta?.size ?? null;
	}

	private async metadata(key: string): Promise<{ size: number; generation: string | null } | null> {
		return this.request(`GET ${key} metadata`, 'GET', this.objectUrl(key, { fields: 'size,generation' }), {}, async (response) => {
			if (response.status === 404) {
				await response.body?.cancel().catch(() => undefined);
				return null;
			}
			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);
				throw new Error(`GCS metadata ${key} failed: ${response.status}`);
			}
			const json = (await response.json()) as { size?: string; generation?: string };
			return { size: Number(json.size ?? 0), generation: json.generation ?? null };
		});
	}

	async *list(prefix: string): AsyncIterable<StoredObject> {
		let pageToken: string | undefined;
		const searchPrefix = this.fullKey(prefix);
		do {
			const url = new URL(`${this.base}${JSON_API}/b/${encodeURIComponent(this.bucket)}/o`);
			url.searchParams.set('prefix', searchPrefix);
			// Real GCS caps a page at 1000 and returns a nextPageToken; fake-gcs-server returns the
			// whole (capped) result and no token, so a high cap keeps both honest.
			url.searchParams.set('maxResults', '5000');
			url.searchParams.set('fields', 'items(name,size,updated),nextPageToken');
			if (pageToken) url.searchParams.set('pageToken', pageToken);
			const page = await this.request(`LIST ${prefix}`, 'GET', url, {}, async (response) => {
				if (!response.ok) throw new Error(`GCS LIST ${prefix} failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
				return (await response.json()) as {
					items?: { name: string; size?: string; updated?: string }[];
					nextPageToken?: string;
				};
			});
			for (const item of page.items ?? []) {
				if (this.prefix && !item.name.startsWith(`${this.prefix}/`)) continue;
				const updated = item.updated ? Date.parse(item.updated) : NaN;
				yield {
					key: this.prefix ? item.name.slice(this.prefix.length + 1) : item.name,
					size: Number(item.size ?? 0),
					lastModified: Number.isFinite(updated) ? updated : 0,
				};
			}
			pageToken = page.nextPageToken;
		} while (pageToken);
	}

	/** The token is `x-goog-generation`; a generation never repeats (S7). */
	async readVersioned(key: string): Promise<VersionedRead> {
		return this.request(
			`GET ${key}`,
			'GET',
			this.objectUrl(key, { alt: 'media' }),
			{ headers: { 'cache-control': 'no-cache', 'accept-encoding': 'identity' } },
			async (response) => {
				const serverDate = parseHttpDate(response.headers.get('date'));
				if (!response.ok) {
					await response.body?.cancel().catch(() => undefined);
					return { status: response.status, body: null, etag: null, serverDate };
				}
				return { status: 200, body: await response.text(), etag: strongEtag(response.headers.get('x-goog-generation')), serverDate };
			},
		);
	}

	async writeConditional(key: string, body: string, condition: WriteCondition): Promise<ConditionalWrite> {
		// The generation is a decimal string, so a quoted ETag must lose its quotes.
		const query = 'ifMatch' in condition ? { ifGenerationMatch: unquote(condition.ifMatch) } : { ifGenerationMatch: '0' };
		// A multipart upload, not `uploadType=media`: GCS (and fake-gcs-server) applies
		// `ifGenerationMatch` to multipart/resumable uploads, and silently replaces with a media one.
		const boundary = `yoal-${randomUUID()}`;
		const metadata = JSON.stringify({ name: this.fullKey(key), contentType: 'application/json' });
		const payload = [
			`--${boundary}`,
			'Content-Type: application/json; charset=UTF-8',
			'',
			metadata,
			`--${boundary}`,
			'Content-Type: application/json',
			'',
			body,
			`--${boundary}--`,
			'',
		].join('\r\n');
		const data = new TextEncoder().encode(payload);
		const url = new URL(`${this.base}${UPLOAD_API}/b/${encodeURIComponent(this.bucket)}/o`);
		url.searchParams.set('uploadType', 'multipart');
		url.searchParams.set('fields', 'generation');
		for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
		return this.request(`PUT ${key}`, 'POST', url, {
			body: data as unknown as RequestInit['body'],
			headers: {
				'content-type': `multipart/related; boundary=${boundary}`,
				'content-length': String(data.byteLength),
			},
		}, async (response) => {
			const text = await response.text().catch(() => '');
			const generation = response.ok ? ((JSON.parse(text) as { generation?: string }).generation ?? null) : null;
			return {
				status: response.ok ? 200 : response.status,
				etag: generation ? strongEtag(generation) : null,
				serverDate: parseHttpDate(response.headers.get('date')),
			};
		});
	}

	/**
	 * V4 signed URLs on the XML API. Only a service-account key can sign them; an emulator that
	 * does not verify signatures sets `presign: false` in its conformance subject.
	 */
	private presign(method: 'GET' | 'PUT', key: string, ttlSeconds: number): string {
		if (!this.account)
			throw new Error('GCS presigned URLs need a service-account key; this store is anonymous or uses a fixed token');
		const host = new URL(this.base).host;
		const path = `/${encodeURIComponent(this.bucket)}/${rfc3986(this.fullKey(key))}`;
		const now = new Date();
		const timestamp = `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
		const date = timestamp.slice(0, 8);
		const scope = `${date}/auto/storage/goog4_request`;
		const query = new URLSearchParams({
			'X-Goog-Algorithm': 'GOOG4-RSA-SHA256',
			'X-Goog-Credential': `${this.account.client_email}/${scope}`,
			'X-Goog-Date': timestamp,
			'X-Goog-Expires': String(ttlSeconds),
			'X-Goog-SignedHeaders': 'host',
		});
		const canonicalQuery = [...query.entries()]
			.map(([name, value]) => `${rfc3986(name)}=${rfc3986(value)}`)
			.sort()
			.join('&');
		const canonicalRequest = [method, path, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
		const stringToSign = ['GOOG4-RSA-SHA256', timestamp, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
		const signature = createSign('RSA-SHA256').update(stringToSign).sign(this.account.private_key).toString('hex');
		return `${this.base}${path}?${canonicalQuery}&X-Goog-Signature=${signature}`;
	}

	presignPut(key: string, ttlSeconds: number): Promise<string> {
		return Promise.resolve(this.presign('PUT', key, ttlSeconds));
	}

	presignGet(key: string, ttlSeconds: number): Promise<string> {
		return Promise.resolve(this.presign('GET', key, ttlSeconds));
	}

	/**
	 * Create the bucket when it does not exist (fake-gcs-server; real buckets are provisioned
	 * outside Yoal). Not part of `ObjectStore`.
	 */
	async ensureBucket(): Promise<void> {
		const url = new URL(`${this.base}${JSON_API}/b`);
		url.searchParams.set('project', 'yoal-conformance');
		await this.request('POST bucket', 'POST', url, {
			body: JSON.stringify({ name: this.bucket }),
			headers: { 'content-type': 'application/json' },
		}, async (response) => {
			const text = response.ok ? '' : await response.text().catch(() => '');
			await response.body?.cancel().catch(() => undefined);
			if (!response.ok && response.status !== 409 && !/already exist/i.test(text))
				throw new Error(`GCS create bucket ${this.bucket} failed: ${response.status} ${text}`.trim());
		});
	}

	async testConnection(options: { skipConditional?: boolean } = {}): Promise<ObjectStoreTestResult> {
		return runConnectionProbe({
			kind: this.kind,
			store: this,
			skipConditional: options.skipConditional,
			head: async () => {
				const url = new URL(`${this.base}${JSON_API}/b/${encodeURIComponent(this.bucket)}`);
				url.searchParams.set('fields', 'versioning,retentionPolicy');
				return this.request('GET bucket', 'GET', url, {}, async (response) => {
					if (!response.ok) {
						await response.body?.cancel().catch(() => undefined);
						throw new Error(`GCS GET bucket failed: ${response.status}`);
					}
					const json = (await response.json()) as {
						versioning?: { enabled?: boolean };
						retentionPolicy?: { retentionPeriod?: string };
					};
					return {
						versioning: json.versioning?.enabled ?? null,
						// A readable bucket without a retention policy is measurably not immutable.
						objectLock: json.retentionPolicy ? true : false,
					};
				});
			},
		});
	}
}

function unquote(token: string): string {
	return token.replace(/^"|"$/g, '');
}

/** RFC 3986 percent-encoding for V4 canonical paths and queries (stricter than encodeURIComponent). */
function rfc3986(value: string): string {
	return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
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
