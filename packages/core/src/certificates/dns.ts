import { readFileSync } from 'node:fs';
import {
	type DnsChallengeProvider,
	type DnsChallengeProviderKind,
	type DnsChallengeRecord,
	normalizeCertificateHost,
} from '@yoal/contracts';

/**
 * DNS-01 providers (HA-PLAN H20 item 1). `cloudflare` is the one Caddy already uses today; the
 * interface is what `azure-dns`, `route53` and `rfc2136` implement in their own changes. The S4
 * cloud run found two things that shape it:
 *
 * - A failed cleanup must be loud, not logged and forgotten: `cleanup` throws, and `sweep` is the
 *   backstop that removes challenge TXT records left by any incident (Cloudflare caps zone records).
 * - One token with `Zone:DNS:Edit` is enough: zone discovery, create, delete and list all work with
 *   it. The token is read from `YOAL_CLOUDFLARE_API_TOKEN` or the install's token file.
 */
export interface DnsProviderOptions {
	token?: string;
	/** Injected for tests; production uses the global fetch. */
	fetch?: typeof fetch;
	apiBase?: string;
}

/** `_acme-challenge.<host>`, with a wildcard's `*.` removed (the CA queries the base name). */
export function challengeFqdn(host: string): string {
	return `_acme-challenge.${normalizeCertificateHost(host).replace(/^\*\./, '')}`;
}

/** The platform's Cloudflare DNS token, from the environment or the file the installer writes. */
export function cloudflareTokenFromEnv(env: Record<string, string | undefined> = process.env): string | null {
	const direct = env.YOAL_CLOUDFLARE_API_TOKEN?.trim();
	if (direct) return direct;
	const file = env.YOAL_CLOUDFLARE_TOKEN_FILE?.trim();
	if (!file) return null;
	try {
		return readFileSync(file, 'utf8').trim() || null;
	} catch {
		return null;
	}
}

interface CloudflareRecord {
	id: string;
	name: string;
	content: string;
	created_on?: string;
}

interface CloudflareEnvelope<T> {
	success?: boolean;
	result?: T;
	errors?: Array<{ message?: string }>;
}

/**
 * The Cloudflare DNS-01 provider. Every call throws on a non-2xx or `success: false` answer; the
 * issuer's retry loop owns the backoff. Zone ids are cached for the process lifetime.
 */
export class CloudflareDnsProvider implements DnsChallengeProvider {
	readonly name = 'cloudflare' as const;
	private readonly token: string;
	private readonly fetchImpl: typeof fetch;
	private readonly apiBase: string;
	private readonly zones = new Map<string, string>();

	constructor(token: string, options: Omit<DnsProviderOptions, 'token'> = {}) {
		if (!token.trim()) throw new Error('A Cloudflare DNS token is required for DNS-01.');
		this.token = token.trim();
		this.fetchImpl = options.fetch ?? fetch;
		this.apiBase = (options.apiBase ?? 'https://api.cloudflare.com/client/v4').replace(/\/$/, '');
	}

	async present(record: DnsChallengeRecord): Promise<void> {
		const existing = await this.records(record.fqdn);
		if (existing.some((entry) => entry.content === record.value)) return;
		const zone = await this.zoneFor(record.fqdn);
		await this.request(`/zones/${zone}/dns_records`, {
			method: 'POST',
			body: JSON.stringify({ type: 'TXT', name: record.fqdn, content: record.value, ttl: 60 }),
		});
	}

	async cleanup(record: DnsChallengeRecord): Promise<void> {
		const existing = await this.records(record.fqdn);
		const zone = await this.zoneFor(record.fqdn);
		for (const entry of existing.filter((row) => row.content === record.value)) {
			await this.request(`/zones/${zone}/dns_records/${entry.id}`, { method: 'DELETE' });
		}
	}

	/** Delete challenge TXT records for `hosts` older than `olderThanMs`; returns how many went. */
	async sweep(hosts: readonly string[], olderThanMs: number): Promise<number> {
		const cutoff = Date.now() - olderThanMs;
		let removed = 0;
		for (const host of new Set(hosts.map(challengeFqdn))) {
			const existing = await this.records(host);
			const stale = existing.filter((row) => {
				const created = row.created_on ? Date.parse(row.created_on) : Number.NaN;
				return !Number.isFinite(created) || created < cutoff;
			});
			if (stale.length === 0) continue;
			const zone = await this.zoneFor(host);
			for (const entry of stale) {
				await this.request(`/zones/${zone}/dns_records/${entry.id}`, { method: 'DELETE' });
				removed += 1;
			}
		}
		return removed;
	}

	/** The TXT records currently at `fqdn` (one API page is enough for a challenge name). */
	private async records(fqdn: string): Promise<CloudflareRecord[]> {
		const zone = await this.zoneFor(fqdn);
		const result = await this.request<CloudflareRecord[]>(
			`/zones/${zone}/dns_records?type=TXT&name=${encodeURIComponent(fqdn)}&per_page=100`,
		);
		return result ?? [];
	}

	/** Discover the zone that contains `fqdn` by asking for each parent name, longest first. */
	private async zoneFor(fqdn: string): Promise<string> {
		const labels = normalizeCertificateHost(fqdn).split('.');
		for (let index = 0; index < labels.length - 1; index += 1) {
			const candidate = labels.slice(index).join('.');
			const cached = this.zones.get(candidate);
			if (cached) return cached;
			const zones = await this.request<Array<{ id: string; name: string }>>(
				`/zones?name=${encodeURIComponent(candidate)}&per_page=1`,
			);
			const zone = zones?.[0];
			if (zone) {
				this.zones.set(candidate, zone.id);
				return zone.id;
			}
		}
		throw new Error(`Cloudflare has no zone for ${fqdn}.`);
	}

	private async request<T>(path: string, init: RequestInit = {}): Promise<T | null> {
		const response = await this.fetchImpl(`${this.apiBase}${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${this.token}`,
				'content-type': 'application/json',
				...init.headers,
			},
		});
		const text = await response.text();
		let body: CloudflareEnvelope<T> | null = null;
		try {
			body = text ? (JSON.parse(text) as CloudflareEnvelope<T>) : null;
		} catch {
			body = null;
		}
		if (!response.ok || body?.success === false)
			throw new Error(
				`Cloudflare ${init.method ?? 'GET'} ${path} failed (${response.status}): ${
					body?.errors?.map((error) => error.message).filter(Boolean).join('; ') || text.slice(0, 200) || 'no body'
				}`,
			);
		return (body?.result ?? null) as T | null;
	}
}

/**
 * Build a provider by kind. Only `cloudflare` exists on this tree; the others throw a clear error
 * naming their owner so a configuration typo never looks like a transient DNS failure.
 */
export function dnsProviderFor(
	kind: DnsChallengeProviderKind,
	options: DnsProviderOptions = {},
	env: Record<string, string | undefined> = process.env,
): DnsChallengeProvider {
	if (kind === 'cloudflare') {
		const token = options.token?.trim() || cloudflareTokenFromEnv(env);
		if (!token) throw new Error('DNS-01 with Cloudflare needs YOAL_CLOUDFLARE_API_TOKEN or YOAL_CLOUDFLARE_TOKEN_FILE.');
		return new CloudflareDnsProvider(token, options);
	}
	throw new Error(`DNS-01 provider "${kind}" is not implemented on this build (HA-PLAN H20).`);
}
