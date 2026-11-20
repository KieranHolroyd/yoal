import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, certificateFleetFingerprint, type FeatureFlags, type Principal } from '@yoal/contracts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';
import { LegoAcmeIssuer, acmeIssuerFromEnv, type CertificateIssuer } from './certificates/issuer.ts';
import { CloudflareDnsProvider, challengeFqdn, cloudflareTokenFromEnv } from './certificates/dns.ts';

/**
 * W7 shared certificates (HA-PLAN H20): one lease per host, relay routing, sealed custody,
 * fingerprint equality, BYO never renewed, and reissue when an ingress leaves.
 */

const root = mkdtempSync(join(tmpdir(), 'yoal-certificates-'));
const clockStart = Date.parse('2026-11-20T10:00:00Z');
let clock = clockStart;
let counter = 0;

interface Pair {
	certPem: string;
	keyPem: string;
	notAfter: number;
}

/** A self-signed pair for `names`, valid for `days` (openssl keeps the test free of fixtures). */
function makePair(names: string[], days = 400): Pair {
	const base = join(root, `pair-${counter++}`);
	const cert = `${base}.crt`;
	const key = `${base}.key`;
	const result = Bun.spawnSync({
		cmd: [
			'openssl',
			'req',
			'-x509',
			'-newkey',
			'ec',
			'-pkeyopt',
			'ec_paramgen_curve:prime256v1',
			'-nodes',
			'-keyout',
			key,
			'-out',
			cert,
			'-days',
			String(days),
			'-subj',
			`/CN=${names[0]}`,
			'-addext',
			`subjectAltName=${names.map((name) => `DNS:${name}`).join(',')}`,
		],
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return {
		certPem: readFileSync(cert, 'utf8'),
		keyPem: readFileSync(key, 'utf8'),
		notAfter: clock + days * 86_400_000,
	};
}

interface Fixture {
	core: Core;
	opened: ReturnType<typeof createDb>;
	dir: string;
	owner: Principal;
	nodes: Array<{ id: string; token: string }>;
	setClock(value: number): void;
	addIngress(name: string, address: string): { id: string; token: string };
}

function fixture(features: Partial<FeatureFlags> = {}): Fixture {
	const dir = mkdtempSync(join(root, 'core-'));
	const opened = createDb({ path: ':memory:' });
	let now = clockStart;
	const core = createCore({
		db: opened.db,
		sqlite: opened.sqlite,
		version: '0.1.0',
		config: {
			dataDir: dir,
			platformOrigin: 'https://control.test',
			contentDomain: 'sites.test',
			objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
			masterKey: new Uint8Array(32).fill(7),
			siteCookieSecret: 'site-cookie-secret-123',
			objectStoreSecret: 'object-secret-123',
			desiredAgentVersion: '0.1.0',
			now: () => now,
			features: { ...DEFAULT_FEATURES, INGRESS_SET: true, SHARED_CERTIFICATES: true, ...features },
		},
	});
	const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
	const nodes: Array<{ id: string; token: string }> = [];
	const addIngress = (name: string, address: string) => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, name).token, name });
		// The first join would be the edge by compatibility; these are worker ingresses, which is the
		// fleet shape the ingress set adds. Written directly so the test does not need a real edge.
		opened.sqlite.run(
			"UPDATE nodes SET mode = 'worker', roles_json = '[\"ingress\"]', private_address = ?, network_mode = 'yoal' WHERE id = ?",
			[address, joined.nodeId],
		);
		core.nodes.heartbeat(joined.token, {
			nodeId: joined.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 0,
			status: 'online',
			caddyOk: true,
			capabilities: ['ingress-set'],
			releases: [],
		});
		nodes.push({ id: joined.nodeId, token: joined.token });
		return { id: joined.nodeId, token: joined.token };
	};
	return {
		core,
		opened,
		dir,
		owner,
		nodes,
		setClock(value: number) {
			now = value;
		},
		addIngress,
	};
}

/** Claim the lease as `nodeId` and upload a fresh pair, as the issuer/holder pair would. */
function issue(f: Fixture, nodeId: string, host: string, days = 400): Pair {
	const pair = makePair([host], days);
	f.core.certificates.claimLease(host, nodeId);
	f.core.certificates.ingest(nodeId, { host, certPem: pair.certPem, keyPem: pair.keyPem });
	return pair;
}

class FakeIssuer implements CertificateIssuer {
	calls: string[] = [];
	constructor(private readonly days = 400) {}
	async issue(host: string) {
		this.calls.push(host);
		const pair = makePair([host], this.days);
		return { certPem: pair.certPem, keyPem: pair.keyPem };
	}
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('flag off: today’s per-node ACME, no rows, no key', () => {
	test('fingerprint, activation and sweep are empty and nothing is written', () => {
		const f = fixture({ SHARED_CERTIFICATES: false, INGRESS_SET: false });
		f.addIngress('a', '10.47.0.2');
		expect(f.core.certificates.fingerprint()).toBeNull();
		expect(f.core.certificates.distribute(f.nodes[0]!.id)).toEqual({
			generation: 0,
			fingerprint: null,
			certificates: [],
			relays: [],
		});
		expect(f.core.certificates.sweep()).toEqual({ skipped: true, due: [], expiredLeases: [], alerts: [] });
		expect(() => f.core.certificates.claimLease('app.sites.test', f.nodes[0]!.id)).toThrow('SHARED_CERTIFICATES');
		expect(() => f.core.certificates.uploadByo(f.owner, { host: 'app.sites.test', ...makePair(['app.sites.test']) })).toThrow(
			'SHARED_CERTIFICATES',
		);
		expect(f.opened.sqlite.query('SELECT COUNT(*) AS n FROM ingress_certificates').get()).toEqual({ n: 0 });
		expect(f.opened.sqlite.query('SELECT COUNT(*) AS n FROM acme_leases').get()).toEqual({ n: 0 });
		// A heartbeat report is ignored, so a single-node install reports exactly what it did before.
		f.core.certificates.report(f.nodes[0]!.id, 'deadbeef');
		expect(f.core.certificates.reportedFingerprint(f.nodes[0]!.id)).toBeNull();
	});
});

describe('one ACME lease per host', () => {
	test('the second node does not steal a live lease, and takes it after expiry', () => {
		const f = fixture();
		const a = f.addIngress('a', '10.47.0.2');
		const b = f.addIngress('b', '10.47.0.3');
		const first = f.core.certificates.claimLease('app.sites.test', a.id);
		expect(first).toMatchObject({ nodeId: a.id, acquired: true });
		const second = f.core.certificates.claimLease('app.sites.test', b.id);
		expect(second).toMatchObject({ nodeId: a.id, acquired: false, token: first.token });
		f.setClock(clockStart + 601_000);
		const third = f.core.certificates.claimLease('app.sites.test', b.id);
		expect(third).toMatchObject({ nodeId: b.id, acquired: true });
		expect(third.token).not.toBe(first.token);
		expect(f.core.certificates.leaseFor('app.sites.test')?.nodeId).toBe(b.id);
	});

	test('renewal keeps the token and the host; release frees it at once', () => {
		const f = fixture();
		const a = f.addIngress('a', '10.47.0.2');
		const first = f.core.certificates.claimLease('app.sites.test', a.id);
		f.setClock(clockStart + 100_000);
		expect(f.core.certificates.renewLease('app.sites.test', a.id)).toBe(true);
		const renewed = f.core.certificates.leaseFor('app.sites.test')!;
		expect(renewed.token).toBe(first.token);
		expect(renewed.expiresAt).toBeGreaterThan(first.expiresAt);
		expect(f.core.certificates.releaseLease('app.sites.test', 'someone-else')).toBe(false);
		expect(f.core.certificates.releaseLease('app.sites.test', a.id)).toBe(true);
		expect(f.core.certificates.leaseFor('app.sites.test')).toBeNull();
	});
});

describe('HTTP-01 relay routing', () => {
	test('every other ingress relays the host to the holder over the overlay', () => {
		const f = fixture();
		const a = f.addIngress('a', '10.47.0.2');
		const b = f.addIngress('b', '10.47.0.3');
		f.core.certificates.claimLease('app.sites.test', a.id);
		expect(f.core.certificates.relaysFor()).toEqual([
			{ host: 'app.sites.test', upstream: 'http://10.47.0.2:8089' },
		]);
		// The holder itself needs no relay; the other node does.
		expect(f.core.certificates.distribute(a.id).relays).toEqual([]);
		expect(f.core.certificates.distribute(b.id).relays).toEqual([
			{ host: 'app.sites.test', upstream: 'http://10.47.0.2:8089' },
		]);
		f.setClock(clockStart + 601_000);
		f.core.certificates.expireLeases();
		expect(f.core.certificates.relaysFor()).toEqual([]);
	});
});

describe('custody: sealed at rest, never in a view', () => {
	test('the row holds ciphertext, the view holds no key and the activation does', () => {
		const f = fixture();
		const a = f.addIngress('a', '10.47.0.2');
		const pair = issue(f, a.id, 'app.sites.test');
		const raw = f.opened.sqlite
			.query<{ key_sealed: string; cert_pem: string; fingerprint: string }, []>('SELECT key_sealed, cert_pem, fingerprint FROM ingress_certificates')
			.get()!;
		expect(raw.key_sealed).not.toContain('PRIVATE KEY');
		expect(JSON.parse(raw.key_sealed)).toMatchObject({ ciphertext: expect.any(String), nonce: expect.any(String) });
		const view = f.core.certificates.view(f.owner);
		expect(JSON.stringify(view)).not.toContain('PRIVATE KEY');
		expect(Object.keys(view.certificates[0]!)).not.toContain('keyPem');
		expect(view.certificates[0]).toMatchObject({ host: 'app.sites.test', source: 'acme', fingerprint: raw.fingerprint });
		const activation = f.core.certificates.distribute(a.id);
		expect(activation.certificates[0]?.keyPem).toContain('PRIVATE KEY');
		expect(activation.certificates[0]?.chainPem).toBe(pair.certPem);
	});

	test('only the lease holder may upload, and only an ingress may fetch', () => {
		const f = fixture();
		const a = f.addIngress('a', '10.47.0.2');
		const b = f.addIngress('b', '10.47.0.3');
		const pair = makePair(['app.sites.test']);
		f.core.certificates.claimLease('app.sites.test', a.id);
		expect(() => f.core.certificates.ingest(b.id, { host: 'app.sites.test', certPem: pair.certPem, keyPem: pair.keyPem })).toThrow(
			'lease holder',
		);
		const worker = f.core.nodes.join({ token: f.core.nodes.createJoinToken(f.owner, 'w').token, name: 'w' });
		// A worker polls too; it gets nothing rather than an error on every poll.
		expect(f.core.certificates.distribute(worker.nodeId)).toEqual({
			generation: 0,
			fingerprint: null,
			certificates: [],
			relays: [],
		});
	});

	test('a mismatched pair or a certificate for another name is refused', () => {
		const f = fixture();
		const a = f.addIngress('a', '10.47.0.2');
		f.core.certificates.claimLease('app.sites.test', a.id);
		const app = makePair(['app.sites.test']);
		const other = makePair(['other.sites.test']);
		expect(() => f.core.certificates.ingest(a.id, { host: 'app.sites.test', certPem: app.certPem, keyPem: other.keyPem })).toThrow(
			'private key does not match',
		);
		// Coverage is checked on upload, where no lease is needed; the holder rule is separate.
		expect(() => f.core.certificates.uploadByo(f.owner, { host: 'other.sites.test', certPem: app.certPem, keyPem: app.keyPem })).toThrow(
			'does not cover',
		);
	});
});

describe('one fingerprint across ingresses', () => {
	test('two nodes get the same set and the same hash; a renewal changes it on both', async () => {
		const f = fixture();
		const a = f.addIngress('a', '10.47.0.2');
		const b = f.addIngress('b', '10.47.0.3');
		const first = issue(f, a.id, 'app.sites.test', 20);
		const fromA = f.core.certificates.distribute(a.id);
		const fromB = f.core.certificates.distribute(b.id);
		expect(fromA.fingerprint).toBe(fromB.fingerprint);
		expect(fromA.fingerprint).toBe(f.core.certificates.fingerprint());
		expect(fromA.fingerprint).toBe(certificateFleetFingerprint([{ host: 'app.sites.test', fingerprint: fromA.certificates[0]!.fingerprint }]));
		expect(fromA.certificates[0]!.chainPem).toBe(first.certPem);

		// A forced renewal: the fingerprint every node computes changes together.
		const issuer = new FakeIssuer(20);
		f.core.certificates.setIssuer(issuer);
		const renewal = await f.core.certificates.renewDue({ force: true });
		expect(renewal.renewed).toEqual(['app.sites.test']);
		expect(issuer.calls).toEqual(['app.sites.test']);
		const afterA = f.core.certificates.distribute(a.id);
		const afterB = f.core.certificates.distribute(b.id);
		expect(afterA.fingerprint).toBe(afterB.fingerprint);
		expect(afterA.fingerprint).not.toBe(fromA.fingerprint);
		expect(afterA.certificates[0]!.chainPem).not.toBe(first.certPem);
	});

	test('the heartbeat report is what the ingress set view shows', () => {
		const f = fixture();
		const a = f.addIngress('a', '10.47.0.2');
		issue(f, a.id, 'app.sites.test');
		const expected = f.core.certificates.fingerprint();
		// A node reports the hash it computed from what it serves.
		f.core.nodes.heartbeat(a.token, {
			nodeId: a.id,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			capabilities: ['ingress-set'],
			certificateFingerprint: expected,
			releases: [],
		});
		const view = f.core.ingressSet.view();
		expect(view.nodes.find((node) => node.id === a.id)?.certificateFingerprint).toBe(expected);
	});
});

describe('bring your own certificate', () => {
	test('is distributed but never renewed, and alerts at 30, 14 and 3 days', async () => {
		const f = fixture();
		const a = f.addIngress('a', '10.47.0.2');
		const byo = makePair(['byo.sites.test'], 25);
		f.core.certificates.uploadByo(f.owner, { host: 'byo.sites.test', certPem: byo.certPem, keyPem: byo.keyPem });
		expect(f.core.certificates.distribute(a.id).certificates[0]).toMatchObject({ host: 'byo.sites.test', source: 'byo' });
		const issuer = new FakeIssuer();
		f.core.certificates.setIssuer(issuer);

		const key = (days: number) => new RegExp(`^certificate:byo:${days}:byo\\.sites\\.test:\\d+$`);
		f.setClock(clockStart + 1_000);
		let sweep = f.core.certificates.sweep();
		expect(sweep.due).toEqual([]);
		expect(sweep.alerts.map((alert) => alert.key)).toEqual([expect.stringMatching(key(30))]);
		expect(sweep.alerts[0]!.severity).toBe('warning');

		f.setClock(clockStart + 12 * 86_400_000);
		sweep = f.core.certificates.sweep();
		expect(sweep.alerts.map((alert) => alert.key)).toEqual([expect.stringMatching(key(14))]);

		f.setClock(clockStart + 23 * 86_400_000);
		sweep = f.core.certificates.sweep();
		expect(sweep.alerts.map((alert) => alert.key)).toEqual([expect.stringMatching(key(3))]);
		expect(sweep.alerts[0]!.severity).toBe('critical');

		// A sweep never attempts issuance for a brought certificate.
		expect((await f.core.certificates.renewDue({ force: true })).renewed).toEqual([]);
		expect(issuer.calls).toEqual([]);

		// Asking to reissue every ACME host leaves it alone.
		expect(f.core.certificates.requestReissue(f.owner).requested).toEqual([]);
	});
});

describe('cold start on a flag-on fleet', () => {
	test('bootstrap names the wanted hosts and the issuer fills them', async () => {
		const f = fixture();
		const a = f.addIngress('a', '10.47.0.2');
		expect(f.core.certificates.wantedHosts()).toEqual(['*.sites.test', 'control.test', 'sites.test']);
		expect(f.core.certificates.bootstrap()).toEqual(['*.sites.test', 'control.test', 'sites.test']);
		const issuer = new FakeIssuer(20);
		f.core.certificates.setIssuer(issuer);
		const report = await f.core.certificates.renewDue({ force: true });
		expect(report.renewed.sort()).toEqual(['*.sites.test', 'control.test', 'sites.test']);
		expect(f.core.certificates.bootstrap()).toEqual([]);
		const activation = f.core.certificates.distribute(a.id);
		expect(activation.certificates.map((entry) => entry.host).sort()).toEqual(['*.sites.test', 'control.test', 'sites.test']);
	});

	test('a BYO upload is not overwritten by bootstrap or renewal', async () => {
		const f = fixture();
		const a = f.addIngress('a', '10.47.0.2');
		const byo = makePair(['sites.test'], 200);
		f.core.certificates.uploadByo(f.owner, { host: 'sites.test', certPem: byo.certPem, keyPem: byo.keyPem });
		expect(f.core.certificates.bootstrap()).toEqual(['*.sites.test', 'control.test']);
		const issuer = new FakeIssuer(20);
		f.core.certificates.setIssuer(issuer);
		const report = await f.core.certificates.renewDue({ force: true });
		expect(report.renewed.sort()).toEqual(['*.sites.test', 'control.test']);
		expect(issuer.calls).not.toContain('sites.test');
		expect(f.core.certificates.distribute(a.id).certificates.find((entry) => entry.host === 'sites.test')?.source).toBe('byo');
	});
});

describe('reissue when an ingress leaves', () => {
	test('removing the ingress role flags every ACME host and the next sweep replaces it', async () => {
		const f = fixture();
		const a = f.addIngress('a', '10.47.0.2');
		const b = f.addIngress('b', '10.47.0.3');
		const first = issue(f, a.id, 'app.sites.test', 30);
		const before = f.core.certificates.fingerprint();

		// Both an explicit role change and node removal reach the same path; the role change is the
		// one a drain-then-remove follows (CLUSTERING §7.4 "Remove").
		f.core.nodes.update(f.owner, b.id, { roles: ['compute'] });
		expect(f.core.certificates.sweep().due).toEqual(['app.sites.test']);

		const issuer = new FakeIssuer(30);
		f.core.certificates.setIssuer(issuer);
		const renewal = await f.core.certificates.renewDue({ force: true });
		expect(renewal.renewed).toEqual(['app.sites.test']);
		const after = f.core.certificates.fingerprint();
		expect(after).not.toBe(before);
		expect(f.core.certificates.distribute(a.id).certificates[0]!.chainPem).not.toBe(first.certPem);
		expect(f.core.certificates.sweep().due).toEqual([]);
	});

	test('removing a compute-only node does not reissue', () => {
		const f = fixture();
		const a = f.addIngress('a', '10.47.0.2');
		issue(f, a.id, 'app.sites.test');
		const worker = f.core.nodes.join({ token: f.core.nodes.createJoinToken(f.owner, 'worker').token, name: 'worker' });
		// The first join in a fresh database would be the edge; this one is a plain compute worker.
		f.opened.sqlite.run("UPDATE nodes SET mode = 'worker', roles_json = '[\"compute\"]' WHERE id = ?", [worker.nodeId]);
		f.core.nodes.remove(f.owner, worker.nodeId);
		expect(f.core.certificates.sweep().due).toEqual([]);
	});
});

describe('the control-plane issuer (S4 O1)', () => {
	test('lego runs once for the host, and the pair is read from a throwaway directory', async () => {
		const pair = makePair(['app.sites.test']);
		let args: string[] = [];
		const issuer = new LegoAcmeIssuer({
			bin: '/usr/local/bin/lego',
			email: 'ops@sites.test',
			dnsProvider: 'cloudflare',
			env: { CF_API_TOKEN: 'token' },
			exec: async (cmd) => {
				args = cmd;
				const path = cmd[cmd.indexOf('--path') + 1]!;
				const dir = join(path, 'certificates');
				const { mkdirSync } = await import('node:fs');
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, 'app.sites.test.crt'), pair.certPem);
				writeFileSync(join(dir, 'app.sites.test.key'), pair.keyPem);
				return { code: 0, stdout: '', stderr: '' };
			},
		});
		const issued = await issuer.issue('app.sites.test');
		expect(issued.certPem).toBe(pair.certPem);
		expect(issued.keyPem).toBe(pair.keyPem);
		expect(args).toContain('--accept-tos');
		expect(args).toContain('--dns');
		expect(args[args.indexOf('--domains') + 1]).toBe('app.sites.test');
		expect(args.at(-1)).toBe('run');
	});

	test('a non-zero lego exit is an error with its stderr, never a silent skip', async () => {
		const issuer = new LegoAcmeIssuer({
			bin: 'lego',
			email: 'ops@sites.test',
			exec: async () => ({ code: 1, stdout: '', stderr: 'zone lookup failed' }),
		});
		await expect(issuer.issue('app.sites.test')).rejects.toThrow('zone lookup failed');
	});

	test('a failed order keeps the old pair and waits 6 h before retrying', async () => {
		const f = fixture();
		const a = f.addIngress('a', '10.47.0.2');
		const first = issue(f, a.id, 'app.sites.test', 10);
		f.core.certificates.setIssuer({
			issue: async () => {
				throw new Error('DNS API unreachable');
			},
		});
		const failed = await f.core.certificates.renewDue({ force: true });
		expect(failed.errors).toEqual([{ host: 'app.sites.test', error: 'DNS API unreachable' }]);
		expect(f.core.certificates.distribute(a.id).certificates[0]!.chainPem).toBe(first.certPem);
		const waiting = await f.core.certificates.renewDue({ force: true });
		expect(waiting.skipped).toBe('retry_wait');
	});

	test('no lego binary or account email means no issuer, which the sweep reports', async () => {
		expect(acmeIssuerFromEnv({})).toBeNull();
		expect(acmeIssuerFromEnv({ YOAL_LEGO_BIN: '/bin/lego' })).toBeNull();
		expect(acmeIssuerFromEnv({ YOAL_LEGO_BIN: '/bin/lego', YOAL_ACME_EMAIL: 'ops@sites.test' })).toBeInstanceOf(LegoAcmeIssuer);

		const f = fixture();
		const a = f.addIngress('a', '10.47.0.2');
		issue(f, a.id, 'app.sites.test', 10);
		f.core.certificates.setIssuer(null);
		const report = await f.core.certificates.renewDue({ force: true });
		expect(report.skipped).toBe('no_issuer');
		expect(report.due).toEqual(['app.sites.test']);
		// The old pair is still distributed: a failed renewal must never blank the fleet.
		expect(f.core.certificates.distribute(a.id).certificates).toHaveLength(1);
	});
});

describe('DNS-01 providers (H20 item 1)', () => {
	test('the challenge name drops a wildcard label', () => {
		expect(challengeFqdn('*.sites.test')).toBe('_acme-challenge.sites.test');
		expect(challengeFqdn('app.sites.test')).toBe('_acme-challenge.app.sites.test');
	});

	test('Cloudflare presents, cleans up, and a failed cleanup throws instead of leaking', async () => {
		const records: Array<{ id: string; name: string; content: string; created_on?: string }> = [];
		const calls: string[] = [];
		let failList = false;
		const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
			calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
			const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
			if (url.pathname === '/client/v4/zones') return json({ success: true, result: [{ id: 'zone_1', name: 'sites.test' }] });
			if (failList && url.pathname.includes('/dns_records') && !url.pathname.endsWith('/dns_records'))
				return json({ success: false, errors: [{ message: 'unreachable' }] }, 500);
			if (url.pathname.endsWith('/dns_records') && !init?.method) {
				const name = url.searchParams.get('name');
				return json({ success: true, result: records.filter((record) => record.name === name) });
			}
			if (url.pathname.endsWith('/dns_records') && init?.method === 'POST') {
				const body = JSON.parse(String(init.body)) as { name: string; content: string };
				records.push({ id: `rec_${records.length + 1}`, name: body.name, content: body.content, created_on: new Date(clock).toISOString() });
				return json({ success: true, result: records.at(-1) });
			}
			if (init?.method === 'DELETE') {
				const id = url.pathname.split('/').at(-1)!;
				const index = records.findIndex((record) => record.id === id);
				if (index >= 0) records.splice(index, 1);
				return json({ success: true, result: { id } });
			}
			return json({ success: false, errors: [{ message: 'unexpected' }] }, 400);
		}) as typeof fetch;
		const provider = new CloudflareDnsProvider('token-123', { fetch: fakeFetch, apiBase: 'https://cf.test/client/v4' });
		const record = { host: '*.sites.test', fqdn: challengeFqdn('*.sites.test'), value: 'txt-value' };
		await provider.present(record);
		expect(records.map((entry) => entry.content)).toEqual(['txt-value']);
		await provider.present(record); // idempotent: no duplicate
		expect(records).toHaveLength(1);
		await provider.cleanup(record);
		expect(records).toEqual([]);

		// A failed list/delete is an error, not a silent success (S4's leaked TXT records).
		await provider.present(record);
		failList = true;
		await expect(provider.cleanup(record)).rejects.toThrow('Cloudflare DELETE');
		expect(records).toHaveLength(1);
	});

	test('sweep removes only records older than the order lifetime', async () => {
		let deleted: string[] = [];
		const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
			const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
			if (url.pathname === '/client/v4/zones') return json({ success: true, result: [{ id: 'zone_1', name: 'sites.test' }] });
			if (url.pathname.endsWith('/dns_records') && !init?.method)
				return json({
					success: true,
					result: [
						{ id: 'old', name: '_acme-challenge.app.sites.test', content: 'old', created_on: new Date(Date.now() - 7_200_000).toISOString() },
						{ id: 'new', name: '_acme-challenge.app.sites.test', content: 'new', created_on: new Date().toISOString() },
					],
				});
			if (init?.method === 'DELETE') {
				deleted.push(url.pathname.split('/').at(-1)!);
				return json({ success: true, result: {} });
			}
			return json({ success: false });
		}) as typeof fetch;
		const provider = new CloudflareDnsProvider('t', { fetch: fakeFetch, apiBase: 'https://cf.test/client/v4' });
		expect(await provider.sweep(['app.sites.test'], 3_600_000)).toBe(1);
		expect(deleted).toEqual(['old']);
	});

	test('the token comes from the environment or the file the installer writes', () => {
		const dir = mkdtempSync(join(root, 'token-'));
		const file = join(dir, 'cloudflare.token');
		writeFileSync(file, 'from-file\n');
		expect(cloudflareTokenFromEnv({ YOAL_CLOUDFLARE_API_TOKEN: 'direct' })).toBe('direct');
		expect(cloudflareTokenFromEnv({ YOAL_CLOUDFLARE_TOKEN_FILE: file })).toBe('from-file');
		expect(cloudflareTokenFromEnv({})).toBeNull();
	});
});
