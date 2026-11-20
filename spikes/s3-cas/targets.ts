/**
 * What the rig talks to. A target is configuration only (endpoint, credentials, bucket); the
 * checks in spike.ts never branch on the store. Each protocol is one adapter:
 *
 * - `s3` (here): R2, AWS S3, MinIO, Garage, RustFS. The lease path (`readVersioned`,
 *   `writeConditional`) is the production `S3ObjectStore`, unchanged.
 * - `gcs` (gcs.ts, S7): the JSON API with generation preconditions (`ifGenerationMatch`,
 *   `ifGenerationMatch=0` for create). Its token is the generation number, carried in the
 *   `etag` fields of the lease interface; the S3-dialect conditions spike.ts sends are translated.
 * - `azure-blob` (not written; no credentials): ETag conditions on Put Blob.
 *
 * The token a CAS compares is the adapter's business: an ETag for S3 and Azure, the generation for GCS.
 */
import { AwsClient } from 'aws4fetch';
import { S3ObjectStore } from '../../packages/core/src/object-store.ts';
import type { ConditionalStore } from '../../packages/core/src/object-store.ts';
import { GcsCasTarget } from './gcs.ts';

interface BaseTargetConfig {
	/** Label in results, e.g. `minio`, `r2`. */
	name: string;
	endpoint: string;
	bucket: string;
	/** Image, version and digest, recorded in the result as given. */
	version?: string;
}
export interface S3TargetConfig extends BaseTargetConfig {
	protocol: 's3';
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	forcePathStyle?: boolean;
}
export interface GcsTargetConfig extends BaseTargetConfig {
	protocol: 'gcs';
	/** Path to a service-account JSON key; read at run time, never logged. */
	keyFile: string;
}
export type TargetConfig = S3TargetConfig | GcsTargetConfig;

export interface RawResult {
	status: number;
	etag: string | null;
	serverDate: number | null;
	/** S3 error code (or GCS error reason) from the body, when the store sent one. */
	code: string | null;
}

/** The lease's own interface plus the probes the checks need beyond it. */
export interface CasTarget extends ConditionalStore {
	readonly config: TargetConfig;
	head(key: string): Promise<RawResult>;
	/** Plain PUT with no condition: what a misbehaving client could do to a held lease. */
	putUnconditional(key: string, body: string): Promise<RawResult>;
	/**
	 * A condition the lease does not use and the protocol does not support on writes, sent with a
	 * token that matches the current object. A store must refuse it (501 or any non-2xx);
	 * 200 is silent success. For S3: `If-None-Match: "<etag>"` (only `*` is defined for PUT).
	 */
	putUnsupportedCondition(key: string, body: string, currentToken: string): Promise<RawResult>;
	/** The same unsupported condition with a token that does not match, for the record. */
	putUnsupportedConditionMismatch(key: string, body: string): Promise<RawResult>;
	/** Conditional PUT returning the raw code and error body, for the per-condition table. */
	putRaw(key: string, body: string, headers: Record<string, string>): Promise<RawResult>;
	delete(key: string): Promise<void>;
	/** Create the bucket if missing (local stores only). */
	ensureBucket(): Promise<void>;
	/** Every key under `prefix` (used only for the run's own prefix, to prove it empty). */
	list(prefix: string): Promise<string[]>;
	/** A well-formed token that matches no version of any object. */
	readonly unknownToken: string;
	/** Checks recorded but not gating for this protocol (its criteria differ; see README). */
	readonly ungated: readonly string[];
	/** How the S3-dialect conditions in spike.ts map onto this protocol, for the result. */
	readonly dialect: Record<string, string>;
	/** A second view of the same target with its own fetch (a proxy, a timeout). */
	withFetch(fetchImpl: typeof fetch, endpoint?: string): CasTarget;
}

export function targetFromEnv(env: Record<string, string | undefined> = process.env): TargetConfig {
	const need = (name: string): string => {
		const value = env[name];
		if (!value) throw new Error(`missing ${name}`);
		return value;
	};
	return {
		name: env.S3_NAME ?? new URL(need('S3_ENDPOINT')).host,
		protocol: 's3',
		endpoint: need('S3_ENDPOINT'),
		bucket: need('S3_BUCKET'),
		region: env.S3_REGION ?? 'auto',
		accessKeyId: need('S3_ACCESS_KEY_ID'),
		secretAccessKey: need('S3_SECRET_ACCESS_KEY'),
		forcePathStyle: env.S3_PATH_STYLE !== '0',
		version: env.S3_VERSION,
	};
}

export function openTarget(config: TargetConfig, fetchImpl: typeof fetch = fetch): CasTarget {
	if (config.protocol === 's3') return new S3CasTarget(config, fetchImpl);
	if (config.protocol === 'gcs') return new GcsCasTarget(config, fetchImpl);
	throw new Error(`no adapter for protocol ${(config as { protocol: string }).protocol}`);
}

const parseDate = (value: string | null): number | null => {
	const parsed = value ? Date.parse(value) : NaN;
	return Number.isFinite(parsed) ? parsed : null;
};

class S3CasTarget implements CasTarget {
	readonly unknownToken = '"00000000000000000000000000000000"';
	readonly ungated = ['malformed-condition-refused', 'etag-is-not-body-md5'] as const;
	readonly dialect = {};
	readonly #store: S3ObjectStore;
	readonly #client: AwsClient;
	readonly #fetch: typeof fetch;

	constructor(
		readonly config: S3TargetConfig,
		fetchImpl: typeof fetch,
	) {
		this.#fetch = fetchImpl;
		this.#store = new S3ObjectStore({
			endpoint: config.endpoint,
			bucket: config.bucket,
			region: config.region,
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
			forcePathStyle: config.forcePathStyle ?? true,
			fetch: fetchImpl,
		});
		this.#client = new AwsClient({
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
			service: 's3',
			region: config.region,
			retries: 0,
		});
	}

	readVersioned = (key: string) => this.#store.readVersioned(key);
	writeConditional: ConditionalStore['writeConditional'] = (key, body, condition) =>
		this.#store.writeConditional(key, body, condition);
	delete = (key: string) => this.#store.delete(key);

	withFetch(fetchImpl: typeof fetch, endpoint?: string): CasTarget {
		return new S3CasTarget({ ...this.config, endpoint: endpoint ?? this.config.endpoint }, fetchImpl);
	}

	#url(key = ''): string {
		const base = new URL(this.config.endpoint.replace(/\/+$/, ''));
		const path = key ? `/${key.split('/').map(encodeURIComponent).join('/')}` : '';
		if (this.config.forcePathStyle ?? true) {
			base.pathname = `${base.pathname.replace(/\/+$/, '')}/${encodeURIComponent(this.config.bucket)}${path}`;
		} else {
			base.host = `${this.config.bucket}.${base.host}`;
			base.pathname = path || '/';
		}
		return base.toString();
	}

	async #raw(method: string, url: string, body?: string, headers: Record<string, string> = {}): Promise<RawResult> {
		const request = await this.#client.sign(url, {
			method,
			...(body === undefined ? {} : { body }),
			headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
		});
		const response = await this.#fetch(request);
		const text = method === 'HEAD' ? '' : await response.text().catch(() => '');
		return {
			status: response.status,
			etag: response.headers.get('etag'),
			serverDate: parseDate(response.headers.get('date')),
			code: text.match(/<Code>([^<]*)<\/Code>/)?.[1] ?? null,
		};
	}

	head = (key: string) => this.#raw('HEAD', this.#url(key));
	putUnconditional = (key: string, body: string) => this.#raw('PUT', this.#url(key), body);
	putRaw = (key: string, body: string, headers: Record<string, string>) => this.#raw('PUT', this.#url(key), body, headers);
	putUnsupportedCondition = (key: string, body: string, etag: string) =>
		this.#raw('PUT', this.#url(key), body, { 'if-none-match': etag });
	putUnsupportedConditionMismatch = (key: string, body: string) =>
		this.#raw('PUT', this.#url(key), body, { 'if-none-match': '"00000000000000000000000000000000"' });

	async list(prefix: string): Promise<string[]> {
		const keys: string[] = [];
		for await (const object of this.#store.list(prefix)) keys.push(object.key);
		return keys;
	}

	async ensureBucket(): Promise<void> {
		const head = await this.#raw('HEAD', this.#url());
		if (head.status === 200) return;
		const created = await this.#raw('PUT', this.#url(), '');
		if (created.status !== 200 && created.code !== 'BucketAlreadyOwnedByYou')
			throw new Error(`create bucket ${this.config.bucket}: ${created.status} ${created.code}`);
	}
}
