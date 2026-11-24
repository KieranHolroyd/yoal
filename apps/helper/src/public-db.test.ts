import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	PublicDbManager,
	assertPublicDbTlsName,
	caddyStorageName,
	parsePublicCidr,
	parsePublicDbFirewall,
	parsePublicDbTls,
	renderPublicDbFirewall,
} from './public-db.ts';
import { createHandler, type HelperRuntime } from './server.ts';
import type { CommandRunner } from './wireguard.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-public-db-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runnerFor(status: { ufw?: string; firewalld?: string; nftCheck?: number }, calls: string[][]): CommandRunner {
	return async (argv) => {
		calls.push(argv);
		if (argv[0] === 'ufw' && argv[1] === 'status') return { code: 0, stdout: status.ufw ?? 'Status: inactive', stderr: '' };
		if (argv[0] === 'firewall-cmd' && argv[1] === '--state') return { code: 0, stdout: status.firewalld ?? 'not running', stderr: '' };
		if (argv[0] === 'nft' && argv[1] === '-c' && status.nftCheck) return { code: status.nftCheck, stdout: '', stderr: 'syntax error' };
		return { code: 0, stdout: '', stderr: '' };
	};
}

describe('public-db firewall input', () => {
	test('accepts canonical IPv4 and IPv6 CIDRs per port', () => {
		expect(
			parsePublicDbFirewall({
				ports: [{ port: 24_000, allow: ['203.0.113.0/24', '2a01:4f8:c0c:0:0:0:0:0/48', '0.0.0.0/0', '203.0.113.0/24'] }],
			}),
		).toEqual([{ port: 24_000, v4: ['203.0.113.0/24', '0.0.0.0/0'], v6: ['2a01:4f8:c0c::/48'] }]);
		expect(parsePublicDbFirewall({ ports: [] })).toEqual([]);
	});

	test('refuses anything that is not a validated port and CIDR', () => {
		const bad: unknown[] = [
			null,
			{ ports: 'x' },
			{ ports: [], extra: 1 },
			{ ports: [{ port: 23_999, allow: [] }] },
			{ ports: [{ port: 25_000, allow: [] }] },
			{ ports: [{ port: 24_000.5, allow: [] }] },
			{ ports: [{ port: 24_000, allow: [] }, { port: 24_000, allow: [] }] },
			{ ports: [{ port: 24_000, allow: ['203.0.113.7/24'] }] },
			{ ports: [{ port: 24_000, allow: ['203.0.113.0'] }] },
			{ ports: [{ port: 24_000, allow: ['1.2.3.4/24; drop'] }] },
			{ ports: [{ port: 24_000, allow: ['010.0.0.0/8'] }] },
			{ ports: [{ port: 24_000, allow: ['2a01::1/16'] }] },
			{ ports: [{ port: 24_000, allow: [] , command: 'sh' }] },
			{ ports: [{ port: 24_000, allow: Array.from({ length: 53 }, (_, i) => `203.0.${i}.0/24`) }] },
		];
		for (const body of bad) expect(() => parsePublicDbFirewall(body)).toThrow();
		expect(() => parsePublicCidr('::/129', 'x')).toThrow();
	});

	test('renders per-port accepts, then drops the whole range', () => {
		const rules = renderPublicDbFirewall([
			{ port: 24_001, v4: ['0.0.0.0/0'], v6: ['::/0'] },
			{ port: 24_000, v4: ['203.0.113.0/24', '198.51.100.7/32'], v6: ['2a01:4f8::/32'] },
		]);
		expect(rules).toContain('delete table inet yoal-public-db');
		expect(rules).toContain('tcp dport 24000 ip saddr { 203.0.113.0/24, 198.51.100.7/32 } accept');
		expect(rules).toContain('tcp dport 24000 ip6 saddr { 2a01:4f8::/32 } accept');
		expect(rules).toContain('meta nfproto ipv4 tcp dport 24001 accept');
		expect(rules).toContain('meta nfproto ipv6 tcp dport 24001 accept');
		expect(rules.indexOf('tcp dport 24000 ip saddr')).toBeLessThan(rules.indexOf('tcp dport 24000-24999 drop'));
		expect(rules.indexOf('dport 24001')).toBeLessThan(rules.indexOf('24000-24999 drop'));
		// Empty: everything in the range is dropped.
		expect(renderPublicDbFirewall([])).toContain('tcp dport 24000-24999 drop');
	});
});

describe('PublicDbManager.applyFirewall', () => {
	test('checks, applies and leaves host managers alone on a bare nftables host', async () => {
		const calls: string[][] = [];
		const path = join(dir, 'bare.nft');
		const manager = new PublicDbManager({ runner: runnerFor({}, calls), paths: { configPath: path } });
		expect(await manager.applyFirewall([{ port: 24_000, v4: ['203.0.113.0/24'], v6: [] }])).toEqual({
			table: 'inet yoal-public-db',
			ports: 1,
			hostManager: 'none',
		});
		expect(calls[0]).toEqual(['nft', '-c', '-f', path]);
		expect(calls[1]).toEqual(['nft', '-f', path]);
		expect(readFileSync(path, 'utf8')).toContain('tcp dport 24000 ip saddr { 203.0.113.0/24 } accept');
	});

	test('a failed check applies nothing', async () => {
		const calls: string[][] = [];
		const manager = new PublicDbManager({ runner: runnerFor({ nftCheck: 1 }, calls), paths: { configPath: join(dir, 'bad.nft') } });
		await expect(manager.applyFirewall([])).rejects.toThrow('nftables check failed');
		expect(calls.some((call) => call[0] === 'nft' && call[1] === '-f')).toBe(false);
	});

	test('opens the range in ufw while ports exist and closes it when none do', async () => {
		const calls: string[][] = [];
		const manager = new PublicDbManager({ runner: runnerFor({ ufw: 'Status: active' }, calls), paths: { configPath: join(dir, 'ufw.nft') } });
		expect((await manager.applyFirewall([{ port: 24_000, v4: ['203.0.113.0/24'], v6: [] }])).hostManager).toBe('ufw');
		expect(calls).toContainEqual(['ufw', 'allow', '24000:24999/tcp']);
		await manager.applyFirewall([]);
		expect(calls).toContainEqual(['ufw', 'delete', 'allow', '24000:24999/tcp']);
	});

	test('uses runtime and permanent firewalld ports', async () => {
		const calls: string[][] = [];
		const manager = new PublicDbManager({ runner: runnerFor({ firewalld: 'running' }, calls), paths: { configPath: join(dir, 'fw.nft') } });
		await manager.applyFirewall([{ port: 24_000, v4: [], v6: ['2a01:4f8::/32'] }]);
		expect(calls).toContainEqual(['firewall-cmd', '--add-port=24000-24999/tcp']);
		expect(calls).toContainEqual(['firewall-cmd', '--permanent', '--add-port=24000-24999/tcp']);
		await manager.applyFirewall([]);
		expect(calls).toContainEqual(['firewall-cmd', '--permanent', '--remove-port=24000-24999/tcp']);
	});
});

describe('PublicDbManager.copyTls', () => {
	test('names are limited to the db zone', () => {
		expect(assertPublicDbTlsName('*.db.example.com')).toBe('*.db.example.com');
		expect(assertPublicDbTlsName('app-org1.db.example.com')).toBe('app-org1.db.example.com');
		for (const bad of ['*.example.com', 'example.com', 'smtp.example.com', '*.k8s.example.com', 'a.b.db.example.com', '*.db', '../db.example.com', '-a.db.example.com', 'A.db.example.com'])
			expect(() => assertPublicDbTlsName(bad)).toThrow();
		expect(() => parsePublicDbTls({ names: ['*.db.example.com'], extra: true })).toThrow();
		expect(parsePublicDbTls({ names: ['*.db.example.com', '*.db.example.com'] })).toEqual(['*.db.example.com']);
		expect(caddyStorageName('*.db.example.com')).toBe('wildcard_.db.example.com');
	});

	test('copies the newest certificate per name, reports changes and prunes old names', async () => {
		const caddy = join(dir, 'caddy');
		const out = join(dir, 'tls');
		const owner = join(dir, 'owner');
		mkdirSync(owner, { recursive: true });
		const put = (issuer: string, storage: string, cert: string, mtime: number) => {
			const folder = join(caddy, 'certificates', issuer, storage);
			mkdirSync(folder, { recursive: true });
			writeFileSync(join(folder, `${storage}.crt`), cert);
			writeFileSync(join(folder, `${storage}.key`), `key-${cert}`);
			utimesSync(join(folder, `${storage}.crt`), mtime, mtime);
		};
		put('acme-old', 'wildcard_.db.example.com', 'old', 1_000);
		put('acme-new', 'wildcard_.db.example.com', 'new', 2_000);
		mkdirSync(join(out, 'stale.db.example.com'), { recursive: true });
		const chowned: string[] = [];
		const manager = new PublicDbManager({
			paths: { caddyDataDir: caddy, tlsDir: out, ownerFrom: owner },
			chown: async (path) => {
				chowned.push(path);
			},
		});
		const first = await manager.copyTls(['*.db.example.com', 'app-org1.db.example.com']);
		expect(first).toEqual([
			{
				name: '*.db.example.com',
				found: true,
				changed: true,
				certPath: join(out, 'wildcard_.db.example.com', 'cert.pem'),
				keyPath: join(out, 'wildcard_.db.example.com', 'key.pem'),
			},
			{ name: 'app-org1.db.example.com', found: false, changed: false, certPath: null, keyPath: null },
		]);
		expect(readFileSync(join(out, 'wildcard_.db.example.com', 'cert.pem'), 'utf8')).toBe('new');
		expect(statSync(join(out, 'wildcard_.db.example.com', 'key.pem')).mode & 0o777).toBe(0o600);
		expect(existsSync(join(out, 'stale.db.example.com'))).toBe(false);
		expect(chowned.some((path) => path.endsWith('key.pem.tmp'))).toBe(true);
		expect((await manager.copyTls(['*.db.example.com']))[0]).toMatchObject({ found: true, changed: false });
		await expect(manager.copyTls(['*.example.com'])).rejects.toThrow();
	});
});

describe('public-db routes', () => {
	const runtime = {} as HelperRuntime;
	test('validate input before calling the manager and answer 404 on an old helper', async () => {
		const applied: unknown[] = [];
		const handler = createHandler(runtime, {
			version: '0.1.0',
			publicDb: {
				firewall: async (rules) => {
					applied.push(rules);
					return { table: 'inet yoal-public-db', ports: rules.length, hostManager: 'none' };
				},
				copyTls: async (names) => names.map((name) => ({ name, found: false, changed: false, certPath: null, keyPath: null })),
			},
		});
		const post = (path: string, body: unknown) =>
			handler(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
		const ok = await post('/v1/public-db/firewall', { ports: [{ port: 24_000, allow: ['203.0.113.0/24'] }] });
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ ok: true, table: 'inet yoal-public-db', ports: 1, hostManager: 'none' });
		expect((await post('/v1/public-db/firewall', { ports: [{ port: 22, allow: [] }] })).status).toBe(400);
		expect(applied).toHaveLength(1);
		const tls = await post('/v1/public-db/tls', { names: ['*.db.example.com'] });
		expect(await tls.json()).toEqual({ ok: true, results: [{ name: '*.db.example.com', found: false, changed: false, certPath: null, keyPath: null }] });
		expect((await post('/v1/public-db/tls', { names: ['*.example.com'] })).status).toBe(400);
		expect((await handler(new Request('http://localhost/v1/public-db/tls'))).status).toBe(405);
		const old = createHandler(runtime, { version: '0.1.0' });
		expect((await old(new Request('http://localhost/v1/public-db/firewall', { method: 'POST', body: '{}' }))).status).toBe(404);
	});
});
