import { describe, expect, test } from 'bun:test';
import {
	INGRESS_DRIFT_WINDOW_MS,
	INGRESS_HEALTH_PATH,
	INGRESS_HEALTH_PORT,
	INGRESS_SET_CAPABILITY,
	acmeLeaseSchema,
	ingressCertificateSchema,
	ingressDesiredSchema,
	ingressHealthSchema,
	ingressHealthWords,
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
		// Trusted proxies are CIDRs, so a malformed setting never reaches an ingress's Caddy.
		expect(ingressSettingsSchema.parse({ trustedProxies: ['10.209.1.5/32', 'fd00::/8'] }).trustedProxies).toEqual([
			'10.209.1.5/32',
			'fd00::/8',
		]);
		expect(() => ingressSettingsSchema.parse({ trustedProxies: ['10.209.1.5'] })).toThrow(/CIDR/);
		expect(() => ingressSettingsSchema.parse({ trustedProxies: ['10.0.0.0/33'] })).toThrow(/CIDR/);
		expect(() => ingressSettingsSchema.parse({ trustedProxies: ['fd00::/129'] })).toThrow(/CIDR/);
	});

	test('desired state adds only the fleet fingerprint, so settings stay one contract', () => {
		expect(ingressDesiredSchema.parse({})).toEqual({
			drainSeconds: 20,
			proxyProtocol: 'off',
			trustedProxies: [],
			healthPort: null,
			certificateFingerprint: null,
		});
	});

	test('the endpoint path, reserved port, drift window and words are fixed', () => {
		expect(INGRESS_HEALTH_PATH).toBe('/.well-known/yoal/health');
		expect(INGRESS_HEALTH_PORT).toBe(8099);
		expect(INGRESS_DRIFT_WINDOW_MS).toBe(120_000);
		expect(ingressHealthWords).toEqual({
			ok: 'ok',
			draining: 'draining',
			caddy: 'caddy',
			'desired-state': 'desired-state',
			releases: 'releases',
			certificates: 'certificates',
		});
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
