/**
 * S7: Google Cloud Storage behind the rig's `CasTarget`, through the JSON API.
 *
 * - The CAS token is the object's **generation** (a decimal string). It travels in the `etag`
 *   fields of the lease interface, so `ControlLease` and spike.ts treat it as an opaque token.
 * - `{ ifMatch: g }` → `ifGenerationMatch=g`; `{ ifNoneMatch: '*' }` → `ifGenerationMatch=0`.
 * - Auth: a service-account JWT (RS256, `node:crypto`) exchanged for an OAuth access token.
 *   The key file is read from the path in the config; neither it nor the token is ever logged,
 *   and errors carry only status codes and GCS error reasons.
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ConditionalWrite, VersionedRead, WriteCondition } from '../../packages/core/src/object-store.ts';
import type { CasTarget, GcsTargetConfig, RawResult } from './targets.ts';

const SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';

/** One token source per key file, shared by every view of the target (single flight). */
class ServiceAccountAuth {
	#token: { value: string; expiresAt: number } | null = null;
	#pending: Promise<string> | null = null;
	constructor(readonly keyFile: string) {}

	async header(): Promise<string> {
		if (this.#token && this.#token.expiresAt - Date.now() > 120_000) return `Bearer ${this.#token.value}`;
		this.#pending ??= this.#fetchToken().finally(() => (this.#pending = null));
		return `Bearer ${await this.#pending}`;
	}

	async #fetchToken(): Promise<string> {
		const key = JSON.parse(readFileSync(this.keyFile, 'utf8')) as {
			client_email: string;
			private_key: string;
			private_key_id: string;
			token_uri?: string;
		};
		const tokenUri = key.token_uri ?? 'https://oauth2.googleapis.com/token';
		const now = Math.floor(Date.now() / 1000);
		const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
		const unsigned = `${b64({ alg: 'RS256', typ: 'JWT', kid: key.private_key_id })}.${b64({ iss: key.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 })}`;
		const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url');
		// The global fetch on purpose: a delaying fetch under test must not hold the token exchange.
		const response = await fetch(tokenUri, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new Error(`gcs oauth token exchange failed: HTTP ${response.status}`);
		}
		const json = (await response.json()) as { access_token: string; expires_in: number };
		this.#token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
		return json.access_token;
	}
}

const auths = new Map<string, ServiceAccountAuth>();
const parseDate = (value: string | null): number | null => {
	const parsed = value ? Date.parse(value) : NaN;
	return Number.isFinite(parsed) ? parsed : null;
};
const unquote = (token: string) => token.replace(/^"|"$/g, '');

export class GcsCasTarget implements CasTarget {
	/** Well-formed (int64) and far beyond any generation this run creates. */
	readonly unknownToken = '1000000000000001';
	readonly ungated = ['unsupported-condition-refused', 'put-p99-under-300ms', 'only-200-409-412', 'only-200-409-412-flood', 'etag-is-not-body-md5'] as const;
	readonly dialect = {
		'If-Match: <token>': 'ifGenerationMatch=<generation>',
		'If-None-Match: *': 'ifGenerationMatch=0',
		'If-Match: W/<token>': 'ifGenerationMatch=W/<generation> (malformed)',
		'If-Match: *': 'ifGenerationNotMatch=0 (object exists)',
		'If-Match: <token> + If-None-Match: *': 'ifGenerationMatch=<g>&ifGenerationNotMatch=<g> (contradictory)',
		'If-None-Match: <token>': 'sent as the HTTP header If-None-Match, which the JSON API does not define for uploads',
	};
	readonly #auth: ServiceAccountAuth;
	readonly #fetch: typeof fetch;
	readonly #base: string;

	constructor(
		readonly config: GcsTargetConfig,
		fetchImpl: typeof fetch,
	) {
		this.#fetch = fetchImpl;
		this.#base = config.endpoint.replace(/\/+$/, '');
		let auth = auths.get(config.keyFile);
		if (!auth) auths.set(config.keyFile, (auth = new ServiceAccountAuth(config.keyFile)));
		this.#auth = auth;
	}

	withFetch(fetchImpl: typeof fetch, endpoint?: string): CasTarget {
		return new GcsCasTarget({ ...this.config, endpoint: endpoint ?? this.config.endpoint }, fetchImpl);
	}

	#objectUrl(key: string, query: Record<string, string> = {}): string {
		const url = new URL(`${this.#base}/storage/v1/b/${encodeURIComponent(this.config.bucket)}/o/${encodeURIComponent(key)}`);
		for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
		return url.toString();
	}

	#uploadUrl(key: string, query: Record<string, string>): string {
		const url = new URL(`${this.#base}/upload/storage/v1/b/${encodeURIComponent(this.config.bucket)}/o`);
		url.searchParams.set('uploadType', 'media');
		url.searchParams.set('name', key);
		url.searchParams.set('fields', 'generation');
		for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
		return url.toString();
	}

	async #send(method: string, url: string, init: { body?: string; headers?: Record<string, string> } = {}) {
		return this.#fetch(url, {
			method,
			headers: { authorization: await this.#auth.header(), ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
			...(init.body === undefined ? {} : { body: init.body }),
		});
	}

	/** Status, generation and Date of an upload; the error reason, never the message. */
	async #upload(key: string, body: string, query: Record<string, string>, headers: Record<string, string> = {}): Promise<RawResult> {
		const response = await this.#send('POST', this.#uploadUrl(key, query), { body, headers });
		const text = await response.text().catch(() => '');
		let generation: string | null = null;
		let code: string | null = null;
		try {
			const json = JSON.parse(text) as { generation?: string; error?: { errors?: { reason?: string }[]; status?: string } };
			generation = json.generation ?? null;
			code = json.error?.errors?.[0]?.reason ?? json.error?.status ?? null;
		} catch {}
		return { status: response.status, etag: response.ok ? generation : null, serverDate: parseDate(response.headers.get('date')), code };
	}

	async readVersioned(key: string): Promise<VersionedRead> {
		const response = await this.#send('GET', this.#objectUrl(key, { alt: 'media' }), { headers: { 'cache-control': 'no-cache' } });
		const serverDate = parseDate(response.headers.get('date'));
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			return { status: response.status, body: null, etag: null, serverDate };
		}
		return { status: 200, body: await response.text(), etag: response.headers.get('x-goog-generation'), serverDate };
	}

	async writeConditional(key: string, body: string, condition: WriteCondition): Promise<ConditionalWrite> {
		const query = 'ifMatch' in condition ? { ifGenerationMatch: unquote(condition.ifMatch) } : { ifGenerationMatch: '0' };
		const result = await this.#upload(key, body, query);
		return { status: result.status, etag: result.etag, serverDate: result.serverDate };
	}

	async head(key: string): Promise<RawResult> {
		const response = await this.#send('GET', this.#objectUrl(key, { fields: 'generation' }));
		const json = (await response.json().catch(() => ({}))) as { generation?: string };
		return { status: response.status, etag: response.ok ? (json.generation ?? null) : null, serverDate: parseDate(response.headers.get('date')), code: null };
	}

	putUnconditional = (key: string, body: string) => this.#upload(key, body, {});

	/** Translate the S3-dialect headers spike.ts sends (see `dialect`). */
	putRaw(key: string, body: string, headers: Record<string, string>): Promise<RawResult> {
		const ifMatch = headers['if-match'];
		const ifNoneMatch = headers['if-none-match'];
		const query: Record<string, string> = {};
		const passHeaders: Record<string, string> = {};
		if (ifMatch === '*') query.ifGenerationNotMatch = '0';
		else if (ifMatch !== undefined) query.ifGenerationMatch = unquote(ifMatch);
		if (ifNoneMatch === '*') {
			if (ifMatch !== undefined && ifMatch !== '*') query.ifGenerationNotMatch = unquote(ifMatch);
			else query.ifGenerationMatch = '0';
		} else if (ifNoneMatch !== undefined) passHeaders['if-none-match'] = ifNoneMatch;
		return this.#upload(key, body, query, passHeaders);
	}

	putUnsupportedCondition = (key: string, body: string, current: string) =>
		this.#upload(key, body, {}, { 'if-none-match': `"${unquote(current)}"` });
	putUnsupportedConditionMismatch = (key: string, body: string) => this.#upload(key, body, {}, { 'if-none-match': '"0"' });

	async delete(key: string): Promise<void> {
		const response = await this.#send('DELETE', this.#objectUrl(key));
		await response.body?.cancel().catch(() => undefined);
		if (!response.ok && response.status !== 404) throw new Error(`gcs delete: HTTP ${response.status}`);
	}

	async list(prefix: string): Promise<string[]> {
		const keys: string[] = [];
		let pageToken: string | undefined;
		do {
			const url = new URL(`${this.#base}/storage/v1/b/${encodeURIComponent(this.config.bucket)}/o`);
			url.searchParams.set('prefix', prefix);
			url.searchParams.set('fields', 'items(name),nextPageToken');
			if (pageToken) url.searchParams.set('pageToken', pageToken);
			const response = await this.#send('GET', url.toString());
			if (!response.ok) throw new Error(`gcs list: HTTP ${response.status}`);
			const json = (await response.json()) as { items?: { name: string }[]; nextPageToken?: string };
			for (const item of json.items ?? []) keys.push(item.name);
			pageToken = json.nextPageToken;
		} while (pageToken);
		return keys;
	}

	async ensureBucket(): Promise<void> {}
}
