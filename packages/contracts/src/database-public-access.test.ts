import { describe, expect, test } from 'bun:test';
import {
	checkPublicCidr,
	cidrContains,
	databasePublicAccessInputSchema,
	formatCidr,
	parseCidr,
	parseIpAddress,
	publicAccessProtocol,
	publicDatabaseHost,
	publicDatabaseListenerSchema,
} from './database-public-access.ts';
import { PLATFORM_HOST_PORTS } from './host-ports.ts';
import { permissionCatalog } from './permissions.ts';

describe('public access CIDRs', () => {
	test('accepts public IPv4 and IPv6 ranges and canonicalises them', () => {
		expect(checkPublicCidr('203.0.113.0/24')).toEqual({ ok: true, cidr: '203.0.113.0/24' });
		expect(checkPublicCidr(' 8.8.8.8 ')).toEqual({ ok: true, cidr: '8.8.8.8/32' });
		expect(checkPublicCidr('2a01:4f8:c0c:1234::/64')).toEqual({ ok: true, cidr: '2a01:4f8:c0c:1234::/64' });
		expect(checkPublicCidr('2A01:04F8:0:0:0:0:0:1')).toEqual({ ok: true, cidr: '2a01:4f8::1/128' });
	});

	test('refuses host bits, broad prefixes and every non-internet range', () => {
		expect(checkPublicCidr('203.0.113.7/24')).toMatchObject({ ok: false, reason: expect.stringContaining('203.0.113.0/24') });
		expect(checkPublicCidr('0.0.0.0/0')).toMatchObject({ ok: false, reason: expect.stringContaining('broader than /8') });
		expect(checkPublicCidr('4.0.0.0/7')).toMatchObject({ ok: false });
		expect(checkPublicCidr('2a00::/16')).toMatchObject({ ok: false, reason: expect.stringContaining('/32') });
		for (const blocked of ['10.1.2.0/24', '10.47.0.1', '172.16.5.5', '192.168.1.0/24', '100.64.0.1', '127.0.0.1', '169.254.1.1', '224.0.0.1', '::1', 'fd00::/8', 'fe80::1', '::ffff:10.0.0.1'])
			expect(checkPublicCidr(blocked).ok).toBe(false);
		// A public range that contains a private one is refused too.
		expect(checkPublicCidr('8.0.0.0/8').ok).toBe(true);
		expect(checkPublicCidr('192.0.0.0/8').ok).toBe(false);
		expect(checkPublicCidr('nonsense').ok).toBe(false);
		expect(checkPublicCidr('1.2.3.4/33').ok).toBe(false);
		expect(checkPublicCidr('::ffff:1.2.3.0/120').ok).toBe(false);
	});

	test('matches IPv4, IPv6 and IPv4-mapped sources', () => {
		const v4 = parseCidr('203.0.113.0/24')!;
		expect(cidrContains(v4, parseIpAddress('203.0.113.200')!)).toBe(true);
		expect(cidrContains(v4, parseIpAddress('::ffff:203.0.113.9')!)).toBe(true);
		expect(cidrContains(v4, parseIpAddress('203.0.114.1')!)).toBe(false);
		const v6 = parseCidr('2a01:4f8::/32')!;
		expect(cidrContains(v6, parseIpAddress('2a01:4f8:1::5')!)).toBe(true);
		expect(cidrContains(v6, parseIpAddress('2a01:4f9::5')!)).toBe(false);
		expect(cidrContains(v6, parseIpAddress('203.0.113.1')!)).toBe(false);
		expect(cidrContains(parseCidr('0.0.0.0/0')!, parseIpAddress('1.1.1.1')!)).toBe(true);
		expect(formatCidr(parseCidr('::/0')!)).toBe('::/0');
		expect(formatCidr(parseCidr('2001:db8:0:1:0:0:0:1/128')!)).toBe('2001:db8:0:1::1/128');
	});
});

describe('public access contracts', () => {
	test('input defaults and limits', () => {
		const parsed = databasePublicAccessInputSchema.parse({ rules: [{ cidr: '203.0.113.0/24' }] });
		expect(parsed).toEqual({
			rules: [{ cidr: '203.0.113.0/24', label: '' }],
			allowAnywhere: false,
			credentials: [],
			expiresAt: null,
			maxConnections: 20,
		});
		expect(() => databasePublicAccessInputSchema.parse({ maxConnections: 501 })).toThrow();
		expect(() => databasePublicAccessInputSchema.parse({ extra: true })).toThrow();
	});

	test('engines, host and wire schema', () => {
		expect(publicAccessProtocol('postgres')).toBe('postgres');
		expect(publicAccessProtocol('valkey')).toBe('tls');
		expect(publicAccessProtocol('mysql')).toBeNull();
		expect(publicDatabaseHost('app', 'org_0123456789ABCDEF', 'Example.com')).toBe('app-89abcdef.db.example.com');
		expect(() =>
			publicDatabaseListenerSchema.parse({
				id: 'db_1', port: 23_999, protocol: 'tls', host: 'h', certificateNames: [], allow: [], users: [],
				upstreamPort: 1, maxConnections: 1, expiresAt: null, version: 0,
			}),
		).toThrow();
		expect(() =>
			publicDatabaseListenerSchema.parse({
				id: 'db_1', port: 24_000, protocol: 'tls', host: 'h', certificateNames: [], allow: ['203.0.113.7/24'], users: [],
				upstreamPort: 1, maxConnections: 1, expiresAt: null, version: 0,
			}),
		).toThrow();
	});

	test('the port range is a platform range and expose is never offered over MCP', () => {
		expect(PLATFORM_HOST_PORTS.some((range) => range.min === 24_000 && range.max === 24_999)).toBe(true);
		const meta = permissionCatalog['database:expose'];
		expect(meta).toMatchObject({ risk: 'secret', mcp: false, agentDefault: false });
	});
});
