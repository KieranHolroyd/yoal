/**
 * DNS provider plugin boundary for `dns-failover` (HA-PLAN H18, CLUSTERING §7.2).
 *
 * A provider owns one zone account: it lists the A/AAAA records at a name, and creates, updates
 * or deletes one record at a time. It never decides which nodes belong in the set; the driver
 * does that under the controller lease. Keeping the surface this small is what lets another
 * provider be added as one directory (`azure-dns`, `route53`, `rfc2136`) without touching the
 * failover logic.
 */

export type DnsRecordType = 'A' | 'AAAA';

export interface DnsRecord {
	id: string;
	name: string;
	type: DnsRecordType;
	content: string;
	ttl: number;
	proxied: boolean;
}

export interface DnsRecordInput {
	name: string;
	type: DnsRecordType;
	content: string;
	ttl: number;
	proxied: boolean;
	comment?: string;
}

export interface DnsProvider {
	/** Stable provider name (`cloudflare`); appears in events and preflight messages. */
	readonly kind: string;
	/** Every A/AAAA record at `name`, including records Yoal does not own. */
	listRecords(name: string): Promise<DnsRecord[]>;
	createRecord(input: DnsRecordInput): Promise<DnsRecord>;
	updateRecord(id: string, input: DnsRecordInput): Promise<DnsRecord>;
	deleteRecord(id: string): Promise<void>;
}

/**
 * A provider failure. `retryable` separates a throttled or unreachable API (retry on the next
 * tick, with the record set unchanged) from a refusal that will not succeed until a human acts
 * (a bad token, a zone the token cannot see, an invalid record).
 */
export class DnsProviderError extends Error {
	constructor(
		message: string,
		readonly retryable = true,
		readonly status: number | null = null,
	) {
		super(message);
		this.name = 'DnsProviderError';
	}
}

/** True when a name is a plain hostname the provider can manage (no scheme, path or port). */
export function isDnsName(name: string): boolean {
	return /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(name);
}

/** Strip a trailing dot and lowercase, so comparisons against the provider agree. */
export function normalizeDnsName(name: string): string {
	return name.trim().toLowerCase().replace(/\.$/, '');
}
