import { describe, expect, test } from 'bun:test';
import { desiredStateSchema, nodeLogRecordSchema, type NodeLogBatch } from '@yoal/contracts';
import {
	DEFAULT_EDGE_SAMPLE_RATE,
	EdgeRequestLogs,
	accessLogHosts,
	buildAccessRecord,
	createClientIpHasher,
	shouldShipAccess,
	userAgentFamily,
} from './edge-request-logs.ts';
import { NodeLogBatcher } from './log-records.ts';
import { AccessLogAggregator, type AccessLogEntry } from './telemetry.ts';

const SECRET = Buffer.alloc(32, 7);
const hashIp = createClientIpHasher(SECRET);
const REQUEST_ID = '0b9f7c1e-3a52-4f7e-9d6e-2b1d4c0a8f11';

/** A line shaped like Caddy 2's JSON access log with the LP6 echo header. */
function entry(overrides: Partial<AccessLogEntry> & { status?: number } = {}): AccessLogEntry {
	return {
		ts: 1_764_072_131.204,
		status: 502,
		size: 1234,
		duration: 1.2345,
		request: {
			remote_ip: '10.47.0.9',
			client_ip: '198.51.100.23',
			proto: 'HTTP/2.0',
			method: 'GET',
			host: 'App.Example.com',
			uri: '/v1/orders?token=secret&page=2',
			headers: { 'User-Agent': ['Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15'], Cookie: ['REDACTED'] },
		},
		resp_headers: { 'X-Request-Id': [REQUEST_ID], 'Content-Type': ['text/html'] },
		...overrides,
	};
}

describe('buildAccessRecord', () => {
	test('maps a Caddy line to an access record without the query string or the address', () => {
		const built = buildAccessRecord(entry(), { hashIp });
		expect(built).not.toBeNull();
		const { host, status, requestId, record } = built!;
		expect(host).toBe('app.example.com');
		expect(status).toBe(502);
		expect(requestId).toBe(REQUEST_ID);
		expect(record).toEqual({
			ts: 1_764_072_131_204,
			source: 'access',
			severityNumber: 17,
			body: 'GET /v1/orders 502 1235ms',
			attributes: {
				'http.method': 'GET',
				'http.host': 'app.example.com',
				'http.path': '/v1/orders',
				'http.route': '/v1/orders',
				'http.status': '502',
				duration_ms: '1234.5',
				bytes: '1234',
				'user_agent.family': 'safari',
				'http.protocol': 'HTTP/2.0',
				'client.ip_hash': hashIp('198.51.100.23', 1_764_072_131_204),
				request_id: REQUEST_ID,
			},
			resource: {},
			requestId: REQUEST_ID,
		});
		expect(JSON.stringify(record)).not.toContain('secret');
		expect(JSON.stringify(record)).not.toContain('198.51.100.23');
		expect(nodeLogRecordSchema.safeParse(record).success).toBe(true);
	});

	test('severity follows the status: 5xx error, 4xx warn, else info', () => {
		const severity = (status: number) => buildAccessRecord(entry({ status }), { hashIp })!.record.severityNumber;
		expect(severity(503)).toBe(17);
		expect(severity(404)).toBe(13);
		expect(severity(301)).toBe(9);
		expect(severity(200)).toBe(9);
		expect(severity(0)).toBe(9);
	});

	test('a trusted proxy\'s incoming id is read when no echo was logged; junk ids are ignored', () => {
		const fromRequest = entry({ resp_headers: {} });
		fromRequest.request!.headers = { 'X-Request-Id': ['upstream-lb-1234'] };
		expect(buildAccessRecord(fromRequest, { hashIp })!.requestId).toBe('upstream-lb-1234');
		const junk = entry({ resp_headers: { 'X-Request-Id': ['<script>alert(1)</script>'] } });
		expect(buildAccessRecord(junk, { hashIp })!.requestId).toBeNull();
		expect(buildAccessRecord(junk, { hashIp })!.record.attributes.request_id).toBeUndefined();
	});

	test('a line without a host is not a site request', () => {
		expect(buildAccessRecord(entry({ request: { uri: '/' } }), { hashIp })).toBeNull();
	});

	test('the remote address stands in when Caddy resolved no client address', () => {
		const line = entry();
		delete line.request!.client_ip;
		expect(buildAccessRecord(line, { hashIp })!.record.attributes['client.ip_hash']).toBe(hashIp('10.47.0.9', 1_764_072_131_204));
	});
});

describe('client address hash', () => {
	test('stable within a UTC day, different the next day and under another secret', () => {
		const day = Date.UTC(2026, 10, 25, 1);
		expect(hashIp('198.51.100.23', day)).toBe(hashIp('198.51.100.23', day + 20 * 3_600_000));
		expect(hashIp('198.51.100.23', day)).not.toBe(hashIp('198.51.100.23', day + 24 * 3_600_000));
		expect(createClientIpHasher(Buffer.alloc(32, 8))('198.51.100.23', day)).not.toBe(hashIp('198.51.100.23', day));
		expect(hashIp('198.51.100.23', day)).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe('userAgentFamily', () => {
	test.each([
		['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0', 'edge'],
		['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36', 'chrome'],
		['Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0', 'firefox'],
		['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'bot'],
		['curl/8.5.0', 'curl'],
		['python-requests/2.32', 'python'],
		['Go-http-client/2.0', 'library'],
		['', 'none'],
		['SomethingElse/1', 'other'],
	])('%s → %s', (ua, family) => {
		expect(userAgentFamily(ua)).toBe(family);
	});
});

describe('shouldShipAccess', () => {
	test('every non-2xx/3xx ships, whatever the rate', () => {
		for (const status of [0, 101, 400, 404, 499, 500, 503]) expect(shouldShipAccess(status, 0, null, () => 0.99)).toBe(true);
	});

	test('2xx/3xx ship at the rate; deterministic per request id', () => {
		expect(shouldShipAccess(200, 1, null, () => 0.999)).toBe(true);
		expect(shouldShipAccess(200, 0, null, () => 0)).toBe(false);
		expect(shouldShipAccess(200, 0.1, null, () => 0.05)).toBe(true);
		expect(shouldShipAccess(304, 0.1, null, () => 0.5)).toBe(false);
		const ids = Array.from({ length: 20_000 }, (_, index) => `req-${index}-${index * 7919}`);
		const shipped = ids.filter((id) => shouldShipAccess(200, DEFAULT_EDGE_SAMPLE_RATE, id)).length;
		expect(shipped / ids.length).toBeGreaterThan(0.08);
		expect(shipped / ids.length).toBeLessThan(0.12);
		for (const id of ids.slice(0, 50)) expect(shouldShipAccess(200, 0.1, id)).toBe(shouldShipAccess(200, 0.1, id));
	});
});

describe('EdgeRequestLogs', () => {
	function harness(options: { rate?: number; enabled?: boolean; known?: string[] } = {}) {
		const posted: NodeLogBatch[] = [];
		const batcher = new NodeLogBatcher({ post: async (batch) => void posted.push(batch) });
		let draws = 0;
		const edge = new EdgeRequestLogs({
			batcher,
			hashIp,
			enabled: () => options.enabled ?? true,
			knownHost: (host) => (options.known ?? ['app.example.com']).includes(host),
			sampleRate: () => options.rate,
			// Every fourth draw wins at 10%: 0.05, 0.5, 0.5, 0.5, 0.05, …
			random: () => (draws++ % 4 === 0 ? 0.05 : 0.5),
		});
		return { posted, batcher, edge };
	}

	test('ships every error, a sample of successes, and reports the rest as dropped', async () => {
		const { posted, batcher, edge } = harness();
		for (let index = 0; index < 8; index += 1) edge.consume(entry({ status: 200, resp_headers: {} }));
		edge.consume(entry({ status: 500 }));
		edge.consume(entry({ status: 404 }));
		await batcher.flush();
		expect(posted).toHaveLength(1);
		const batch = posted[0]!;
		expect(batch.target).toEqual({ kind: 'site', host: 'app.example.com' });
		expect(batch.records.map((record) => record.attributes['http.status'])).toEqual(['200', '200', '500', '404']);
		expect(batch.dropped).toBe(6);
		expect(recordsValid(batch)).toBe(true);
		expect(edge.stats).toEqual({ seen: 10, shipped: 4, sampledOut: 6, skippedHosts: 0 });
	});

	test('a site rate of 1 ships everything; hosts the node does not serve are skipped', async () => {
		const { posted, batcher, edge } = harness({ rate: 1 });
		for (let index = 0; index < 5; index += 1) edge.consume(entry({ status: 200 }));
		edge.consume(entry({ status: 500, request: { host: 'scanner.invalid', uri: '/wp-login.php' } }));
		await batcher.flush();
		expect(posted[0]!.records).toHaveLength(5);
		expect(posted[0]!.dropped).toBe(0);
		expect(edge.stats.skippedHosts).toBe(1);
	});

	test('the kill switch stops records', async () => {
		const { posted, batcher, edge } = harness({ enabled: false });
		edge.consume(entry({ status: 500 }));
		await batcher.flush();
		expect(posted).toEqual([]);
	});

	test('aggregates still count every line, sampled or not', () => {
		const seen: AccessLogEntry[] = [];
		const aggregator = new AccessLogAggregator(() => 'prj_1', () => 1_764_072_200_000, (line) => seen.push(line));
		for (let index = 0; index < 10; index += 1) aggregator.addLine(JSON.stringify(entry({ status: 200 })));
		aggregator.flushReady(true);
		expect(aggregator.takePending()[0]!.requests).toBe(10);
		expect(seen).toHaveLength(10);
	});

	test('a throwing listener never costs the aggregates', () => {
		const aggregator = new AccessLogAggregator(() => null, () => 1_764_072_200_000, () => {
			throw new Error('boom');
		});
		aggregator.addLine(JSON.stringify(entry()));
		aggregator.addLine('null');
		aggregator.flushReady(true);
		expect(aggregator.takePending()[0]!.requests).toBe(1);
	});
});

describe('accessLogHosts', () => {
	test('routes and verified custom domains, with the production route\'s rate', () => {
		const SHA = 'c'.repeat(64);
		const route = (host: string, production: boolean, rate?: number) => ({
			projectId: 'prj_app',
			slug: 'app',
			host,
			deploymentId: 'dep_1',
			release: SHA,
			access: { mode: 'public', siteKey: 'site-key-000000000001', loginUrl: 'https://c.example.com/login' },
			accessMode: 'public',
			spa: false,
			cleanUrls: false,
			trailingSlash: 'ignore',
			notFound: null,
			production,
			...(rate !== undefined ? { accessLogSampleRate: rate } : {}),
		});
		const state = desiredStateSchema.parse({
			version: 1,
			nodeId: 'nod_1',
			agentVersion: '0.1.0',
			generatedAt: '2026-11-25T00:00:00.000Z',
			contentDomain: 'example.com',
			releases: [],
			routes: [route('app.example.com', true, 1), route('app-git-abc.example.com', false)],
			domains: [
				{ host: 'www.app.dev', projectId: 'prj_app', kind: 'custom', redirectTo: null },
				{ host: 'app.dev', projectId: 'prj_app', kind: 'apex', redirectTo: 'www.app.dev' },
			],
		});
		expect([...accessLogHosts(state)]).toEqual([
			['app.example.com', 1],
			['app-git-abc.example.com', undefined],
			['www.app.dev', 1],
		]);
	});
});

function recordsValid(batch: NodeLogBatch): boolean {
	return batch.records.every((record) => nodeLogRecordSchema.safeParse(record).success);
}
