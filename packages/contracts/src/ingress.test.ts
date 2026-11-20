import { describe, expect, test } from 'bun:test';
import {
	INGRESS_SET_CAPABILITY,
	acmeLeaseSchema,
	ingressCertificateSchema,
	ingressHealthSchema,
	ingressSettingsSchema,
	steeringDriverKinds,
} from './ingress.ts';

/** Wave 2 opening contracts (HA-PLAN H17–H20): defaults, the set, drivers and certificate shapes. */

describe('ingress settings (H19)', () => {
	test('today’s behaviour is the default: no proxy protocol, no trusted proxies, 20 s drain', () => {
		expect(ingressSettingsSchema.parse({})).toEqual({
			drainSeconds: 20,
			proxyProtocol: 'off',
			trustedProxies: [],
			healthPort: null,
		});
	});

	test('refuses an unknown proxy protocol and a drain longer than two minutes', () => {
		expect(() => ingressSettingsSchema.parse({ proxyProtocol: 'v3' })).toThrow();
		expect(() => ingressSettingsSchema.parse({ drainSeconds: 121 })).toThrow();
	});
});

describe('the ingress set and steering (H17, H18)', () => {
	test('the capability is stable and the drivers cover direct and the balancer kinds', () => {
		expect(INGRESS_SET_CAPABILITY).toBe('ingress-set');
		expect(steeringDriverKinds).toContain('direct');
		expect(steeringDriverKinds).toContain('external-lb');
		expect(steeringDriverKinds).toContain('dns-failover');
		expect(steeringDriverKinds).toContain('vip');
		expect(steeringDriverKinds).toContain('webhook');
	});

	test('the health endpoint has one shape and says why it is not ok', () => {
		expect(
			ingressHealthSchema.parse({
				status: 'unready',
				reason: 'releases',
				desiredStateVersion: 12,
				appliedStateVersion: 11,
				certificateFingerprint: null,
			}),
		).toMatchObject({ status: 'unready', reason: 'releases' });
		expect(() => ingressHealthSchema.parse({ status: 'ok', reason: 'caddy' })).toThrow();
	});
});

describe('shared certificates (H20)', () => {
	test('a certificate is identified by host and fingerprint, with its source', () => {
		expect(
			ingressCertificateSchema.parse({
				id: 'cert_1',
				host: 'app.example.com',
				serial: '01',
				fingerprint: 'ab'.repeat(32),
				source: 'acme',
				notAfter: 1_800_000_000_000,
				renewedAt: null,
				revokedAt: null,
			}),
		).toMatchObject({ host: 'app.example.com', source: 'acme' });
		expect(() => ingressCertificateSchema.parse({ id: 'x', host: 'a', serial: '1', fingerprint: 'f', source: 'self', notAfter: 1 })).toThrow();
	});

	test('an ACME lease names one holder node and expires', () => {
		expect(acmeLeaseSchema.parse({ host: 'a.example.com', nodeId: 'node_1', token: 't', expiresAt: 1 })).toMatchObject({ nodeId: 'node_1' });
	});
});
