import {
	DnsProviderError,
	normalizeDnsName,
	type DnsProvider,
	type DnsRecord,
	type DnsRecordInput,
	type DnsRecordType,
} from '../provider.ts';

/**
 * Cloudflare DNS, the first `dns-failover` provider (HA-PLAN H18, CLUSTERING §7.2).
 *
 * The token needs `Zone:DNS:Edit` (and `Zone:Zone:Read` when the zone is named rather than its id
 * is configured). It is only ever placed in the `Authorization` header: it is not logged, not
 * returned by `observe()` and not written to an event. `fetch` and the timeout are injectable so
 * the tests run against a local fake API.
 *
 * Proxied records use TTL 1 ("automatic") because Cloudflare rejects any other TTL on an
 * orange-cloud record. The driver compares against that effective TTL, so a 60 s target is not
 * reported as permanent drift.
 */

const API = 'https://api.cloudflare.com/client/v4';
const COMMENT = 'Managed by Yoal dns-failover';

export interface CloudflareDnsConfig {
	apiToken: string;
	zoneId?: string;
	zoneName?: string;
}

/** Read the same install-time variables the domain automation uses; disabled unless complete. */
export function cloudflareDnsConfigFromEnv(env: Record<string, string | undefined> = process.env): CloudflareDnsConfig | null {
	const apiToken = env.YOAL_CLOUDFLARE_API_TOKEN?.trim();
	const zoneId = env.YOAL_CLOUDFLARE_ZONE_ID?.trim() || undefined;
	const zoneName = env.YOAL_CLOUDFLARE_ZONE_NAME?.trim().toLowerCase() || undefined;
	if (!apiToken || (!zoneId && !zoneName)) return null;
	return { apiToken, zoneId, zoneName };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface CloudflareEnvelope<T> {
	success?: boolean;
	result?: T;
	errors?: Array<{ code?: number; message?: string }>;
}

interface CloudflareZone {
	id: string;
	name: string;
}

interface CloudflareRecord {
	id: string;
	name: string;
	type: string;
	content: string;
	ttl?: number;
	proxied?: boolean;
}

export class CloudflareDnsProvider implements DnsProvider {
	readonly kind = 'cloudflare';
	#zoneId: string | null;

	constructor(
		private readonly config: CloudflareDnsConfig,
		private readonly fetchImpl: FetchLike = fetch,
		private readonly timeoutMs = 5_000,
	) {
		this.#zoneId = config.zoneId ?? null;
	}

	async listRecords(name: string): Promise<DnsRecord[]> {
		const zoneId = await this.#zone();
		const query = `name=${encodeURIComponent(normalizeDnsName(name))}&per_page=100`;
		const records = await this.#request<CloudflareRecord[]>(`/zones/${encodeURIComponent(zoneId)}/dns_records?${query}`, 'GET');
		return records
			.filter((record) => record.type === 'A' || record.type === 'AAAA')
			.map((record) => this.#record(record));
	}

	async createRecord(input: DnsRecordInput): Promise<DnsRecord> {
		const zoneId = await this.#zone();
		const record = await this.#request<CloudflareRecord>(`/zones/${encodeURIComponent(zoneId)}/dns_records`, 'POST', this.#body(input));
		return this.#record(record);
	}

	async updateRecord(id: string, input: DnsRecordInput): Promise<DnsRecord> {
		const zoneId = await this.#zone();
		const record = await this.#request<CloudflareRecord>(
			`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`,
			'PUT',
			this.#body(input),
		);
		return this.#record(record);
	}

	async deleteRecord(id: string): Promise<void> {
		const zoneId = await this.#zone();
		await this.#request<unknown>(`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`, 'DELETE');
	}

	#record(record: CloudflareRecord): DnsRecord {
		return {
			id: record.id,
			name: normalizeDnsName(record.name),
			type: record.type as DnsRecordType,
			content: record.content,
			ttl: record.ttl ?? 1,
			proxied: record.proxied === true,
		};
	}

	#body(input: DnsRecordInput): Record<string, unknown> {
		return {
			type: input.type,
			name: normalizeDnsName(input.name),
			content: input.content,
			// Cloudflare only accepts TTL 1 on a proxied record; the client never fights it.
			ttl: input.proxied ? 1 : input.ttl,
			proxied: input.proxied,
			comment: input.comment ?? COMMENT,
		};
	}

	async #zone(): Promise<string> {
		if (this.#zoneId) return this.#zoneId;
		const name = this.config.zoneName;
		if (!name) throw new DnsProviderError('Cloudflare zone is not configured: set YOAL_CLOUDFLARE_ZONE_ID or YOAL_CLOUDFLARE_ZONE_NAME.', false);
		const zones = await this.#request<CloudflareZone[]>(`/zones?name=${encodeURIComponent(name)}&per_page=1`, 'GET');
		const zone = zones.find((candidate) => normalizeDnsName(candidate.name) === name) ?? zones[0];
		if (!zone?.id) throw new DnsProviderError(`Cloudflare token cannot see the zone ${name}.`, false);
		this.#zoneId = zone.id;
		return zone.id;
	}

	async #request<T>(path: string, method: string, body?: Record<string, unknown>): Promise<T> {
		let response: Response;
		try {
			response = await this.fetchImpl(`${API}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${this.config.apiToken}`,
					'content-type': 'application/json',
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (error) {
			throw new DnsProviderError(`Cloudflare API unreachable: ${describe(error)}`, true);
		}

		let text: string;
		try {
			text = await response.text();
		} catch (error) {
			throw new DnsProviderError(`Cloudflare API response failed: ${describe(error)}`, true, response.status);
		}
		let payload: CloudflareEnvelope<T> | null = null;
		if (text.trim()) {
			try {
				payload = JSON.parse(text) as CloudflareEnvelope<T>;
			} catch {
				throw new DnsProviderError(`Cloudflare API returned a non-JSON response (${response.status}).`, response.status === 429 || response.status >= 500, response.status);
			}
		}
		const detail = payload?.errors?.map((error) => error.message ?? `code ${error.code ?? '?'}`).join('; ');
		if (!response.ok) {
			throw new DnsProviderError(
				`Cloudflare API ${response.status}${detail ? `: ${detail}` : ''}`,
				response.status === 429 || response.status >= 500,
				response.status,
			);
		}
		if (payload?.success === false) {
			throw new DnsProviderError(`Cloudflare API refused the change${detail ? `: ${detail}` : ''}.`, false, response.status);
		}
		return payload?.result as T;
	}
}

function describe(error: unknown): string {
	if (error instanceof Error) return error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timed out' : error.message;
	return String(error);
}
