import { describe, expect, test } from 'bun:test';
import {
	ACME_CHALLENGE_PATH,
	ACME_LEASE_RENEW_MS,
	ACME_LEASE_TTL_MS,
	BYO_EXPIRY_ALERT_DAYS,
	CERT_RENEWAL_WINDOW_MS,
	INGRESS_SET_CAPABILITY,
	acmeLeaseSchema,
	certificateActivationSchema,
	certificateFleetFingerprint,
	certificateUploadSchema,
	dnsChallengeProviderKinds,
	ingressCertificateSchema,
	ingressHealthSchema,
	ingressSettingsSchema,
	steeringDriverKinds,
} from './ingress.ts';
import { heartbeatSchema } from './agent.ts';

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

	test('the lease and renewal windows are the CLUSTERING §7.3 numbers', () => {
		expect(ACME_LEASE_TTL_MS).toBe(600_000);
		expect(ACME_LEASE_RENEW_MS).toBe(120_000);
		expect(CERT_RENEWAL_WINDOW_MS).toBe(30 * 86_400_000);
		expect(BYO_EXPIRY_ALERT_DAYS).toEqual([30, 14, 3]);
		expect(ACME_CHALLENGE_PATH).toBe('/.well-known/acme-challenge/');
		expect(dnsChallengeProviderKinds).toEqual(['cloudflare', 'azure-dns', 'route53', 'rfc2136']);
	});

	test('the fleet fingerprint is order-free, and null with nothing to fingerprint', () => {
		expect(certificateFleetFingerprint([])).toBeNull();
		const entries = [
			{ host: 'b.example.com', fingerprint: 'bb' },
			{ host: 'a.example.com', fingerprint: 'AA' },
		];
		const fingerprint = certificateFleetFingerprint(entries);
		expect(fingerprint).toMatch(/^[a-f0-9]{32}$/);
		expect(certificateFleetFingerprint([...entries].reverse())).toBe(fingerprint);
		expect(certificateFleetFingerprint([{ host: 'a.example.com', fingerprint: 'aa' }])).not.toBe(fingerprint);
		expect(certificateFleetFingerprint([{ host: 'a.example.com', fingerprint: 'ab' }])).not.toBe(fingerprint);
	});

	test('an upload normalises the host and refuses a bad name or a non-PEM body', () => {
		const upload = certificateUploadSchema.parse({ host: 'App.Example.COM.', certPem: 'x'.repeat(64), keyPem: 'y'.repeat(64) });
		expect(upload.host).toBe('app.example.com');
		expect(certificateUploadSchema.parse({ host: '*.example.com', certPem: 'x'.repeat(64), keyPem: 'y'.repeat(64) }).host).toBe(
			'*.example.com',
		);
		expect(() => certificateUploadSchema.parse({ host: 'not a host', certPem: 'x'.repeat(64), keyPem: 'y'.repeat(64) })).toThrow();
		expect(() => certificateUploadSchema.parse({ host: 'a.example.com', certPem: 'short', keyPem: 'y'.repeat(64) })).toThrow();
	});

	test('the activation carries pairs and relays; the heartbeat carries one fingerprint', () => {
		const activation = certificateActivationSchema.parse({
			generation: 7,
			fingerprint: 'ab'.repeat(16),
			certificates: [
				{ host: 'app.example.com', fingerprint: 'f'.repeat(64), chainPem: 'c'.repeat(64), keyPem: 'k'.repeat(64), notAfter: 1, source: 'acme' },
			],
			relays: [{ host: 'app.example.com', upstream: 'http://10.47.0.2:8089' }],
		});
		expect(activation.certificates[0]?.source).toBe('acme');
		const heartbeat = heartbeatSchema.parse({ ...baseHeartbeat(), certificateFingerprint: 'ab'.repeat(16) });
		expect(heartbeat.certificateFingerprint).toBe('ab'.repeat(16));
		// An older agent that never sends it still parses.
		expect(heartbeatSchema.parse(baseHeartbeat()).certificateFingerprint).toBeUndefined();
	});
});

function baseHeartbeat() {
	return { nodeId: 'nod_1', agentVersion: '0.1.0', actualStateVersion: 1, status: 'online' as const, caddyOk: true, releases: [] };
}
