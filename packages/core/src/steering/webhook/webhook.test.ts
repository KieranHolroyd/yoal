import { describe, expect, test } from 'bun:test';
import type { SteeringDriver } from '@yoal/contracts';
import { verifyWebhookSignature } from '../../webhook-signature.ts';
import { describeSteeringConformance, steeringContext, steeringNode } from '../conformance.ts';
import { steeringConformanceCases } from '../conformance-cases.ts';
import type { SteeringDriverContext, SteeringNode } from '../types.ts';
import { WebhookDriver, type WebhookConfig } from './driver.ts';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const SECRET = 'whsec_test_only_never_returned';
const config: WebhookConfig = { url: 'https://ops.example.com/yoal/steering', allowHosts: ['ops.example.com'] };

class FakeFetch {
	readonly calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
	response: (call: number) => Response | Promise<Response> = () => Response.json({ accepted: true });
	fail: Error | null = null;

	readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
		const body = typeof init?.body === 'string' ? init.body : '';
		this.calls.push({ url, body, headers });
		if (this.fail) throw this.fail;
		return this.response(this.calls.length);
	};
}

function fleet(overrides: Array<Partial<SteeringNode>> = [{}, {}, {}]): SteeringNode[] {
	return overrides.map((entry, index) =>
		steeringNode({
			id: `node-${index + 1}`,
			name: `node-${index + 1}`,
			zone: String.fromCharCode(97 + index),
			address: `192.0.2.${index + 10}`,
			...entry,
		}),
	);
}

function create(options: {
	context?: SteeringDriverContext;
	config?: WebhookConfig | null;
	fetch?: FakeFetch;
	secret?: () => string | null;
} = {}): { driver: WebhookDriver; transport: FakeFetch } {
	const transport = options.fetch ?? new FakeFetch();
	return {
		driver: new WebhookDriver(options.context ?? steeringContext(fleet()), {
			config: options.config === undefined ? config : options.config,
			secret: options.secret ?? (() => SECRET),
			fetchImpl: transport.fetch as typeof fetch,
			timeoutMs: 1_000,
			retryDelaysMs: [5_000, 15_000],
		}),
		transport,
	};
}

describeSteeringConformance('webhook', {
	create: (context) => create({ context }).driver,
});

describe('webhook driver (H18)', () => {
	test('declares a signed, writing driver that reads the operator acknowledgement', () => {
		const { driver } = create();
		expect(driver.capabilities).toEqual({ probes: 'external', writes: true, preservesClientIp: 'native' });
	});

	test('preflight refuses a missing URL, plain http, a private target or a host outside the allowlist', () => {
		expect(create({ config: null }).driver.preflight()).toContainEqual({ nodeId: null, reason: expect.stringContaining('no operator URL') });
		expect(create({ config: { url: 'http://ops.example.com/x' } }).driver.preflight()).toContainEqual({
			nodeId: null,
			reason: expect.stringContaining('must use https'),
		});
		expect(create({ config: { url: 'https://127.0.0.1/x' } }).driver.preflight()).toContainEqual({
			nodeId: null,
			reason: expect.stringContaining('loopback or private'),
		});
		expect(create({ config: { url: 'https://other.example.com/x', allowHosts: ['ops.example.com'] } }).driver.preflight()).toContainEqual({
			nodeId: null,
			reason: expect.stringContaining('not in the allowlist'),
		});
	});

	test('preflight names a node that cannot serve the ingress health endpoint', () => {
		const findings = create({ context: steeringContext(fleet([{}, { capable: false }, {}])) }).driver.preflight();
		expect(findings).toContainEqual({ nodeId: 'node-2', reason: expect.stringContaining('does not advertise ingress-set') });
	});

	test('preflight refuses when the sealed secret cannot be opened', () => {
		const findings = create({ secret: () => null }).driver.preflight();
		expect(findings).toContainEqual({ nodeId: null, reason: expect.stringContaining('HMAC secret is missing') });
	});

	test('POSTs the signed desired set and never puts the secret in the body', async () => {
		const { driver, transport } = create();
		await driver.desired();
		expect(transport.calls).toHaveLength(1);
		const call = transport.calls[0]!;
		expect(call.url).toBe(config.url);
		expect(call.body).not.toContain(SECRET);
		const payload = JSON.parse(call.body) as { kind: string; ingress: { healthy: string[]; serving: string[]; nodes: unknown[] } };
		expect(payload.kind).toBe('webhook');
		expect(payload.ingress.healthy).toEqual(['node-1', 'node-2', 'node-3']);
		expect(payload.ingress.serving).toEqual(['node-1', 'node-2', 'node-3']);
		expect(payload.ingress.nodes).toHaveLength(3);
		expect(verifyWebhookSignature(SECRET, call.body, call.headers['x-yoal-signature'], { nowMs: NOW })).toBe(true);
		expect(verifyWebhookSignature('a-different-secret', call.body, call.headers['x-yoal-signature'], { nowMs: NOW })).toBe(false);
	});

	test('the same desired set is sent once; a change is sent again', async () => {
		let nodes = fleet();
		const context: SteeringDriverContext = { now: () => NOW, nodes: () => nodes, settings: () => ({}) as never };
		const { driver, transport } = create({ context });
		await driver.desired();
		await driver.desired();
		expect(transport.calls).toHaveLength(1);
		nodes = fleet([{}, {}, { status: 'offline' }]);
		await driver.desired();
		expect(transport.calls).toHaveLength(2);
	});

	test('a 5xx is retried only after the backoff bound', async () => {
		let now = NOW;
		const context: SteeringDriverContext = { now: () => now, nodes: () => fleet(), settings: () => ({}) as never };
		const transport = new FakeFetch();
		transport.response = () => new Response('nope', { status: 503 });
		const { driver } = create({ context, fetch: transport });
		await driver.desired();
		expect(transport.calls).toHaveLength(1);
		expect(driver.report().error).toContain('HTTP 503');
		now += 4_000;
		await driver.desired();
		expect(transport.calls).toHaveLength(1);
		now += 1_500;
		await driver.desired();
		expect(transport.calls).toHaveLength(2);
	});

	test('a timeout is retried and never leaks a secret in the error', async () => {
		const transport = new FakeFetch();
		transport.fail = new DOMException('The operation timed out.', 'TimeoutError');
		const { driver } = create({ fetch: transport });
		await driver.desired();
		expect(driver.report().error).toContain('no answer within 1s');
		expect(driver.report().error).not.toContain(SECRET);
		expect(driver.report().nextAttemptAt).toBe(NOW + 5_000);
	});

	test('a 400 is not retried until the desired set changes', async () => {
		let nodes = fleet();
		const context: SteeringDriverContext = { now: () => NOW, nodes: () => nodes, settings: () => ({}) as never };
		const transport = new FakeFetch();
		transport.response = () => new Response('bad', { status: 400 });
		const { driver } = create({ context, fetch: transport });
		await driver.desired();
		await driver.desired();
		expect(transport.calls).toHaveLength(1);
		nodes = fleet([{}, { status: 'offline' }, {}]);
		await driver.desired();
		expect(transport.calls).toHaveLength(2);
	});

	test('an acknowledgement cannot withdraw the last healthy ingress', async () => {
		const transport = new FakeFetch();
		transport.response = () => Response.json({ accepted: true, serving: [] });
		const { driver } = create({ fetch: transport });
		await driver.desired();
		expect(driver.report().error).toContain('last healthy ingress');
		expect(driver.report().records).toEqual(['node-1', 'node-2', 'node-3']);
		const observed = (await driver.observe()) as { serving: string[] };
		expect(observed.serving).toEqual(['node-1', 'node-2', 'node-3']);
	});

	test('an acknowledgement naming an unknown node is refused', async () => {
		const transport = new FakeFetch();
		transport.response = () => Response.json({ accepted: true, serving: ['node-9'] });
		const { driver } = create({ fetch: transport });
		await driver.desired();
		expect(driver.report().error).toContain('not an ingress node');
	});

	test('a response that is not an acknowledgement is a failure, not success', async () => {
		const transport = new FakeFetch();
		transport.response = () => Response.json({ ok: true });
		const { driver } = create({ fetch: transport });
		await driver.desired();
		expect(driver.report().error).toContain('did not acknowledge');
	});

	test('observe never exposes the secret or a query string', async () => {
		const { driver } = create({ config: { url: 'https://ops.example.com/steer?token=abc', allowHosts: ['ops.example.com'] } });
		const observed = JSON.stringify(await driver.observe());
		expect(observed).not.toContain(SECRET);
		expect(observed).not.toContain('token=abc');
	});

	test('the shared conformance cases pass, including the signature extra', async () => {
		const { driver, transport } = create();
		const cases = steeringConformanceCases({
			driver: driver as SteeringDriver,
			expectedKind: 'webhook',
			writes: () => transport.calls.length,
			apply: () => driver.desired(),
			lastHealthy: async () => {
				const { driver: last, transport: lastTransport } = create();
				await last.desired();
				const context = steeringContext(fleet([{ status: 'offline' }, { status: 'offline' }, { status: 'offline' }]));
				const allDown = new WebhookDriver(context, { config, secret: () => SECRET, fetchImpl: lastTransport.fetch as typeof fetch, timeoutMs: 1_000 });
				// Seed the intended set from the healthy pass, then fail every node.
				await last.desired();
				await allDown.desired();
				return { withdrawn: allDown.report().withdrawn, records: allDown.report().records };
			},
			extraCases: [
				{
					name: 'every request carries a verifiable signature over the raw body',
					run: async () => {
						await driver.desired();
						for (const call of transport.calls)
							expect(verifyWebhookSignature(SECRET, call.body, call.headers['x-yoal-signature'], { nowMs: NOW })).toBe(true);
					},
				},
			],
		});
		for (const testCase of cases) await testCase.run();
	});
});
