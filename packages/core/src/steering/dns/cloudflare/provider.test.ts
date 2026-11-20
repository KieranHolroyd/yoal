import { describe, expect, test } from 'bun:test';
import { DnsProviderError } from '../provider.ts';
import { CloudflareDnsProvider, cloudflareDnsConfigFromEnv } from './provider.ts';

/**
 * Cloudflare DNS against a fake API. No token, no zone, no network: every request is a recorded
 * call to an injected `fetch`.
 */

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

function fakeFetch(response: unknown, status = 200, calls: Call[] = []) {
	return async (url: string, init?: RequestInit) => {
		calls.push({
			url,
			method: init?.method ?? 'GET',
			headers: (init?.headers as Record<string, string>) ?? {},
			body: init?.body ? JSON.parse(init.body as string) : null,
		});
		return new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } });
	};
}

const zone = { id: 'zone_1', name: 'sites.test' };

describe('cloudflare DNS provider', () => {
	test('lists only A and AAAA records, normalized and with the real proxy state', async () => {
		const calls: Call[] = [];
		const provider = new CloudflareDnsProvider(
			{ apiToken: 'token', zoneId: 'zone_1' },
			fakeFetch(
				{
					success: true,
					result: [
						{ id: 'r1', name: 'Sites.Test.', type: 'A', content: '192.0.2.10', ttl: 1, proxied: true },
						{ id: 'r2', name: 'sites.test', type: 'AAAA', content: '2001:db8::10', ttl: 60, proxied: false },
						{ id: 'r3', name: 'sites.test', type: 'TXT', content: 'ignore me', ttl: 60 },
					],
				},
				200,
				calls,
			),
		);
		const records = await provider.listRecords('Sites.Test');
		expect(records).toEqual([
			{ id: 'r1', name: 'sites.test', type: 'A', content: '192.0.2.10', ttl: 1, proxied: true },
			{ id: 'r2', name: 'sites.test', type: 'AAAA', content: '2001:db8::10', ttl: 60, proxied: false },
		]);
		expect(calls[0]!.url).toContain('/zones/zone_1/dns_records?name=sites.test&per_page=100');
		expect(calls[0]!.headers.authorization).toBe('Bearer token');
	});

	test('creates a proxied record with TTL 1 and a DNS-only record with the requested TTL', async () => {
		const calls: Call[] = [];
		const provider = new CloudflareDnsProvider(
			{ apiToken: 'token', zoneId: 'zone_1' },
			fakeFetch({ success: true, result: { id: 'r1', name: 'sites.test', type: 'A', content: '192.0.2.10', ttl: 1, proxied: true } }, 200, calls),
		);
		await provider.createRecord({ name: 'sites.test', type: 'A', content: '192.0.2.10', ttl: 60, proxied: true });
		expect(calls[0]!.method).toBe('POST');
		expect(calls[0]!.body).toMatchObject({ type: 'A', name: 'sites.test', content: '192.0.2.10', ttl: 1, proxied: true });

		const dnsOnly = new CloudflareDnsProvider(
			{ apiToken: 'token', zoneId: 'zone_1' },
			fakeFetch({ success: true, result: { id: 'r2', name: 'sites.test', type: 'A', content: '192.0.2.11', ttl: 60, proxied: false } }, 200, calls),
		);
		await dnsOnly.createRecord({ name: 'sites.test', type: 'A', content: '192.0.2.11', ttl: 60, proxied: false });
		expect(calls[1]!.body).toMatchObject({ ttl: 60, proxied: false });
	});

	test('resolves a zone name once and caches the id', async () => {
		const calls: Call[] = [];
		const provider = new CloudflareDnsProvider(
			{ apiToken: 'token', zoneName: 'sites.test' },
			async (url, init) => {
				calls.push({ url, method: init?.method ?? 'GET', headers: (init?.headers as Record<string, string>) ?? {}, body: null });
				const result = url.includes('/zones?') ? [zone] : [];
				return new Response(JSON.stringify({ success: true, result }), { status: 200 });
			},
		);
		await provider.listRecords('sites.test');
		await provider.listRecords('sites.test');
		expect(calls.filter((call) => call.url.includes('/zones?'))).toHaveLength(1);
		expect(calls[0]!.url).toContain('/zones?name=sites.test');
		expect(calls[1]!.url).toContain('/zones/zone_1/dns_records');
	});

	test('a 429 and a 5xx are retryable; a 4xx is not', async () => {
		const throttle = new CloudflareDnsProvider({ apiToken: 't', zoneId: 'z' }, fakeFetch({ success: false, errors: [{ message: 'slow down' }] }, 429));
		await expect(throttle.listRecords('sites.test')).rejects.toMatchObject({ retryable: true, status: 429 });
		const server = new CloudflareDnsProvider({ apiToken: 't', zoneId: 'z' }, fakeFetch({ success: false, errors: [{ message: 'boom' }] }, 503));
		await expect(server.listRecords('sites.test')).rejects.toMatchObject({ retryable: true, status: 503 });
		const badToken = new CloudflareDnsProvider({ apiToken: 't', zoneId: 'z' }, fakeFetch({ success: false, errors: [{ message: 'bad token' }] }, 403));
		await expect(badToken.listRecords('sites.test')).rejects.toMatchObject({ retryable: false, status: 403 });
	});

	test('a success:false envelope is a refusal, not a retry', async () => {
		const provider = new CloudflareDnsProvider({ apiToken: 't', zoneId: 'z' }, fakeFetch({ success: false, errors: [{ message: 'invalid record' }] }, 200));
		await expect(provider.createRecord({ name: 'sites.test', type: 'A', content: '192.0.2.10', ttl: 60, proxied: false })).rejects.toMatchObject({
			retryable: false,
		});
	});

	test('a timeout is retryable and says so', async () => {
		const provider = new CloudflareDnsProvider(
			{ apiToken: 't', zoneId: 'z' },
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
				}),
			5,
		);
		const error = await provider.listRecords('sites.test').catch((cause) => cause);
		expect(error).toBeInstanceOf(DnsProviderError);
		expect(error).toMatchObject({ retryable: true });
		expect((error as Error).message).toContain('timed out');
	});

	test('a non-JSON response is reported without leaking the body', async () => {
		const provider = new CloudflareDnsProvider(
			{ apiToken: 't', zoneId: 'z' },
			async () => new Response('<html>gateway</html>', { status: 502 }),
		);
		await expect(provider.listRecords('sites.test')).rejects.toMatchObject({ retryable: true, status: 502 });
	});

	test('environment config is disabled until a token and a zone are both present', () => {
		expect(cloudflareDnsConfigFromEnv({})).toBeNull();
		expect(cloudflareDnsConfigFromEnv({ YOAL_CLOUDFLARE_API_TOKEN: 't' })).toBeNull();
		expect(cloudflareDnsConfigFromEnv({ YOAL_CLOUDFLARE_API_TOKEN: 't', YOAL_CLOUDFLARE_ZONE_NAME: 'Sites.Test' })).toEqual({
			apiToken: 't',
			zoneName: 'sites.test',
		});
	});
});
