import { describe, expect, test } from 'bun:test';
import { steeringContext, steeringNode } from '../conformance.ts';
import { createExternalLbDriver, DEFAULT_INGRESS_HEALTH_PORT, INGRESS_HEALTH_PATH } from './index.ts';

const now = Date.parse('2026-11-20T12:00:00Z');
const fleet = (overrides: Array<Record<string, unknown>> = [{}, {}]) =>
	overrides.map((entry, index) =>
		steeringNode({ id: `node-${index + 1}`, name: `node-${index + 1}`, zone: String.fromCharCode(97 + index), ...entry }),
	);

describe('external-lb driver (H18)', () => {
	test('probes externally, writes nothing and reports the configured client-address mode', () => {
		const native = createExternalLbDriver(steeringContext(fleet()));
		expect(native.capabilities).toEqual({ probes: 'external', writes: false, preservesClientIp: 'native' });

		const proxied = createExternalLbDriver(steeringContext(fleet(), { proxyProtocol: 'v2' }));
		expect(proxied.capabilities).toEqual({ probes: 'external', writes: false, preservesClientIp: 'proxy-protocol' });

		const headers = createExternalLbDriver(steeringContext(fleet(), { trustedProxies: ['10.0.0.10/32'] }));
		expect(headers.capabilities).toEqual({ probes: 'external', writes: false, preservesClientIp: 'header' });
	});

	test('preflight names the node that cannot answer the health endpoint', () => {
		const driver = createExternalLbDriver(steeringContext(fleet([{}, { capable: false }, { status: 'pending' }])));
		const findings = driver.preflight();
		expect(findings).toEqual([
			{ nodeId: 'node-2', reason: expect.stringContaining('does not advertise ingress-set') },
			{ nodeId: 'node-3', reason: expect.stringContaining('never sent a heartbeat') },
		]);
	});

	test('preflight refuses an empty fleet', () => {
		const findings = createExternalLbDriver(steeringContext([])).preflight();
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ nodeId: null });
		expect(findings[0]!.reason).toContain('at least one ingress node');
	});

	test('preflight refuses a PROXY header no trusted proxy would be allowed to send', () => {
		const findings = createExternalLbDriver(steeringContext(fleet(), { proxyProtocol: 'v2' })).preflight();
		expect(findings).toEqual([{ nodeId: null, reason: expect.stringContaining('trustedProxies is empty') }]);
		// Listing the balancer makes the same configuration pass.
		expect(createExternalLbDriver(steeringContext(fleet(), { proxyProtocol: 'v2', trustedProxies: ['10.0.0.10/32'] })).preflight()).toEqual(
			[],
		);
	});

	test('preflight refuses a drain shorter than the balancer removal bound', () => {
		const short = createExternalLbDriver(steeringContext(fleet(), { drainSeconds: 5 })).preflight();
		expect(short).toEqual([{ nodeId: null, reason: expect.stringContaining('drainSeconds is 5s') }]);
		expect(createExternalLbDriver(steeringContext(fleet(), { drainSeconds: 15 })).preflight()).toEqual([]);
	});

	test('observe reports the health endpoint the balancer should probe', async () => {
		const observed = (await createExternalLbDriver(steeringContext(fleet(), { healthPort: 9000 })).observe()) as {
			health: { path: string; port: number; http: boolean; https: boolean };
		};
		expect(observed.health).toEqual({ path: INGRESS_HEALTH_PATH, port: 9000, http: true, https: true });
		const fallback = (await createExternalLbDriver(steeringContext(fleet())).observe()) as { health: { port: number } };
		expect(fallback.health.port).toBe(DEFAULT_INGRESS_HEALTH_PORT);
	});

	test('a draining or silent node is not offered traffic', async () => {
		const driver = createExternalLbDriver(steeringContext(fleet([{}, { status: 'draining' }, { status: 'offline' }])));
		await driver.desired();
		expect(await driver.observe()).toMatchObject({ healthy: ['node-1'], draining: ['node-2'], serving: ['node-1'] });
	});

	test('a stale heartbeat is not healthy even while the row still says online', async () => {
		const stale = createExternalLbDriver(steeringContext(fleet([{ lastHeartbeatAt: now - 31_000 }])));
		expect(await stale.observe()).toMatchObject({ healthy: [], serving: [] });
	});
});
