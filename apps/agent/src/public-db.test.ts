import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { PublicDatabaseListener } from '@yoal/contracts';
import { PublicDatabaseProxy, type PublicDbCertificate } from './public-db.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-public-db-'));
let certificate: PublicDbCertificate;
let upstream: Server;
let upstreamPort = 0;
/** Startup users the fake database saw, in order. */
const upstreamUsers: string[] = [];
const proxies: PublicDatabaseProxy[] = [];

beforeAll(async () => {
	const result = Bun.spawnSync([
		'openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
		'-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=db.test',
		'-addext', 'subjectAltName=DNS:app-org1.db.test,DNS:*.db.test',
	]);
	if (result.exitCode !== 0) throw new Error(`openssl failed: ${result.stderr.toString()}`);
	certificate = { certPem: readFileSync(join(dir, 'cert.pem'), 'utf8'), keyPem: readFileSync(join(dir, 'key.pem'), 'utf8') };
	// A fake Postgres: answers a startup with AuthenticationOk + ReadyForQuery, or 28P01 for `bad`;
	// a non-Postgres client (first byte not a length) is echoed.
	upstream = createServer((socket) => {
		let buffer = Buffer.alloc(0);
		let started = false;
		socket.on('error', () => undefined);
		socket.on('data', (chunk: Buffer) => {
			if (started) return void socket.write(chunk);
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.toString('utf8').startsWith('PING')) {
				started = true;
				return void socket.write(buffer);
			}
			if (buffer.length < 8 || buffer.length < buffer.readInt32BE(0)) return;
			started = true;
			const parts = buffer.subarray(8, buffer.readInt32BE(0)).toString('utf8').split('\0');
			const user = parts[parts.indexOf('user') + 1] ?? '';
			upstreamUsers.push(user);
			if (user === 'bad') return void socket.end(pgMessage('E', Buffer.from('SFATAL\0C28P01\0Mpassword authentication failed\0\0')));
			const ok = Buffer.alloc(4);
			socket.write(Buffer.concat([pgMessage('R', ok), pgMessage('Z', Buffer.from('I'))]));
		});
	});
	await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
	upstreamPort = (upstream.address() as { port: number }).port;
});

afterEach(() => {
	for (const proxy of proxies.splice(0)) proxy.close();
});

afterAll(() => {
	upstream.close();
	rmSync(dir, { recursive: true, force: true });
});

function pgMessage(type: string, body: Buffer): Buffer {
	const out = Buffer.alloc(5);
	out.write(type, 0, 'ascii');
	out.writeInt32BE(4 + body.length, 1);
	return Buffer.concat([out, body]);
}

function startup(user: string): Buffer {
	const body = Buffer.from(`user\0${user}\0database\0app\0\0`, 'utf8');
	const out = Buffer.alloc(8);
	out.writeInt32BE(8 + body.length, 0);
	out.writeInt32BE(196_608, 4);
	return Buffer.concat([out, body]);
}

function sslRequest(): Buffer {
	const out = Buffer.alloc(8);
	out.writeInt32BE(8, 0);
	out.writeInt32BE(80_877_103, 4);
	return out;
}

function listener(overrides: Partial<PublicDatabaseListener> = {}): PublicDatabaseListener {
	return {
		id: 'db_1',
		port: 0,
		protocol: 'postgres',
		host: 'app-org1.db.test',
		certificateNames: ['app-org1.db.test', '*.db.test'],
		allow: ['127.0.0.1/32'],
		users: ['app'],
		upstreamPort,
		maxConnections: 5,
		expiresAt: null,
		version: 1,
		...overrides,
	};
}

async function until(check: () => boolean, ms = 3_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error('timed out waiting');
		await Bun.sleep(10);
	}
}

async function start(config: PublicDatabaseListener = listener(), options: { limits?: { authFailures?: number } } = {}) {
	const proxy = new PublicDatabaseProxy({ bindHosts: ['127.0.0.1'], ...(options.limits ? { limits: options.limits } : {}) });
	proxies.push(proxy);
	proxy.converge([config], { firewallReady: true, certificates: new Map([['*.db.test', certificate]]) });
	await until(() => proxy.boundPort(config.id) !== null);
	return { proxy, port: proxy.boundPort(config.id)! };
}

/** Read until `predicate(bytes)` or the socket closes; resolves with what arrived. */
function collect(socket: Socket | TLSSocket, predicate: (data: Buffer) => boolean = () => false): Promise<{ data: Buffer; closed: boolean }> {
	return new Promise((resolve) => {
		let data = Buffer.alloc(0);
		let settled = false;
		const finish = (closed: boolean) => {
			if (settled) return;
			settled = true;
			resolve({ data, closed });
		};
		socket.on('data', (chunk: Buffer) => {
			data = Buffer.concat([data, chunk]);
			if (predicate(data)) finish(false);
		});
		socket.on('close', () => finish(true));
		socket.on('error', () => finish(true));
	});
}

/** libpq's default path: SSLRequest, 'S', TLS, startup. */
async function pgOverSslRequest(port: number, user: string): Promise<TLSSocket> {
	const raw = connect(port, '127.0.0.1');
	await new Promise<void>((resolve) => raw.once('connect', () => resolve()));
	raw.write(sslRequest());
	const answer = await new Promise<string>((resolve) => raw.once('data', (chunk: Buffer) => resolve(chunk.toString())));
	expect(answer).toBe('S');
	const tls = tlsConnect({ socket: raw, servername: 'app-org1.db.test', rejectUnauthorized: false });
	await new Promise<void>((resolve) => tls.once('secureConnect', () => resolve()));
	tls.write(startup(user));
	return tls;
}

const authOk = (data: Buffer) => data.length >= 9 && data[0] === 0x52 && data.readInt32BE(5) === 0;

describe('PublicDatabaseProxy', () => {
	test('SSLRequest, TLS, an allowed role and the database answering', async () => {
		const { proxy, port } = await start();
		const tls = await pgOverSslRequest(port, 'app');
		const { data } = await collect(tls, authOk);
		expect(authOk(data)).toBe(true);
		expect(upstreamUsers.at(-1)).toBe('app');
		expect(proxy.status()).toEqual([
			{ id: 'db_1', state: 'listening', error: null, open: 1, accepted: 1, refused: 0, authFailures: 0, banned: 0, version: 1 },
		]);
		tls.destroy();
	});

	test('direct TLS with ALPN postgresql (PG17 sslnegotiation=direct)', async () => {
		const { port } = await start();
		const tls = tlsConnect({ port, host: '127.0.0.1', servername: 'app-org1.db.test', rejectUnauthorized: false, ALPNProtocols: ['postgresql'] });
		await new Promise<void>((resolve) => tls.once('secureConnect', () => resolve()));
		expect(tls.alpnProtocol).toBe('postgresql');
		tls.write(startup('app'));
		expect(authOk((await collect(tls, authOk)).data)).toBe(true);
		tls.destroy();
	});

	test('a plaintext startup is refused with SQLSTATE 28000 and never reaches the database', async () => {
		const { proxy, port } = await start();
		const before = upstreamUsers.length;
		const raw = connect(port, '127.0.0.1');
		raw.write(startup('app'));
		const { data, closed } = await collect(raw);
		expect(closed).toBe(true);
		expect(data.toString()).toContain('C28000');
		expect(data.toString()).toContain('requires TLS');
		expect(upstreamUsers.length).toBe(before);
		expect(proxy.drainEvents()).toEqual([expect.objectContaining({ id: 'db_1', source: '127.0.0.1', reason: 'tls-required' })]);
	});

	test('a role not on the list is refused before the database sees it', async () => {
		const { proxy, port } = await start();
		const before = upstreamUsers.length;
		const tls = await pgOverSslRequest(port, 'postgres');
		const { data, closed } = await collect(tls);
		expect(closed).toBe(true);
		expect(data.toString()).toContain('role "postgres" is not allowed over public access');
		expect(upstreamUsers.length).toBe(before);
		expect(proxy.drainEvents().map((event) => [event.reason, event.detail])).toEqual([['role', 'postgres']]);
	});

	test('an empty role list on a Postgres listener refuses every role (fail closed)', async () => {
		const { proxy, port } = await start(listener({ users: [] }));
		const tls = await pgOverSslRequest(port, 'app');
		const { data, closed } = await collect(tls);
		expect(closed).toBe(true);
		expect(data.toString()).toContain('role "app" is not allowed');
		expect(proxy.status()[0]).toMatchObject({ accepted: 0, refused: 1 });
	});

	test('a source outside the allowlist is closed without a byte', async () => {
		const { proxy, port } = await start(listener({ allow: ['203.0.113.0/24', '2a01:4f8::/32'] }));
		const raw = connect(port, '127.0.0.1');
		const { data, closed } = await collect(raw);
		expect(closed).toBe(true);
		expect(data.length).toBe(0);
		expect(proxy.drainEvents()).toEqual([expect.objectContaining({ reason: 'source', source: '127.0.0.1' })]);
		expect(proxy.status()[0]).toMatchObject({ refused: 1, accepted: 0 });
	});

	test('a narrowing closes open connections it no longer allows, without rebinding', async () => {
		const { proxy, port } = await start();
		const tls = await pgOverSslRequest(port, 'app');
		const reading = collect(tls);
		await until(() => proxy.status()[0]!.accepted === 1);
		proxy.converge([listener({ users: ['reporting'], version: 2 })], { firewallReady: true, certificates: new Map([['*.db.test', certificate]]) });
		expect((await reading).closed).toBe(true);
		expect(proxy.boundPort('db_1')).toBe(port);
		expect(proxy.status()[0]).toMatchObject({ open: 0, version: 2, state: 'listening' });
		// Removing the source CIDR cuts too.
		const second = await pgOverSslRequest(port, 'reporting');
		const secondReading = collect(second);
		await until(() => proxy.status()[0]!.accepted === 2);
		proxy.converge([listener({ users: ['reporting'], allow: ['203.0.113.0/24'], version: 3 })], {
			firewallReady: true,
			certificates: new Map([['*.db.test', certificate]]),
		});
		expect((await secondReading).closed).toBe(true);
	});

	test('repeated failed logins ban the source', async () => {
		const { proxy, port } = await start(listener({ users: ['bad', 'app'] }), { limits: { authFailures: 2 } });
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const tls = await pgOverSslRequest(port, 'bad');
			const { data } = await collect(tls);
			expect(data.toString()).toContain('28P01');
		}
		await until(() => proxy.status()[0]!.banned === 1);
		const raw = connect(port, '127.0.0.1');
		expect((await collect(raw)).closed).toBe(true);
		const reasons = proxy.drainEvents().map((event) => event.reason);
		expect(reasons).toEqual(['auth-failed', 'auth-failed', 'banned', 'banned']);
		expect(proxy.status()[0]).toMatchObject({ authFailures: 2, banned: 1 });
	});

	test('the tls protocol terminates TLS from the first byte and pipes', async () => {
		const { proxy, port } = await start(listener({ protocol: 'tls', users: [] }));
		const tls = tlsConnect({ port, host: '127.0.0.1', servername: 'app-org1.db.test', rejectUnauthorized: false });
		await new Promise<void>((resolve) => tls.once('secureConnect', () => resolve()));
		tls.write('PING redis');
		const { data } = await collect(tls, (bytes) => bytes.toString() === 'PING redis');
		expect(data.toString()).toBe('PING redis');
		expect(proxy.status()[0]).toMatchObject({ accepted: 1, open: 1 });
		tls.destroy();
	});

	/** A bound listener with no certificate for it. */
	async function withoutCertificate(overrides: Partial<PublicDatabaseListener> = {}) {
		const proxy = new PublicDatabaseProxy({ bindHosts: ['127.0.0.1'] });
		proxies.push(proxy);
		proxy.converge([listener(overrides)], { firewallReady: true, certificates: new Map() });
		await until(() => proxy.boundPort('db_1') !== null);
		expect(proxy.status()[0]).toMatchObject({ state: 'no-certificate' });
		return { proxy, port: proxy.boundPort('db_1')! };
	}

	test('without a certificate, sslmode=prefer is declined TLS and told why, and never reaches the database', async () => {
		const { proxy, port } = await withoutCertificate();
		const before = upstreamUsers.length;
		const raw = connect(port, '127.0.0.1');
		raw.write(sslRequest());
		const answer = await new Promise<string>((resolve) => raw.once('data', (chunk: Buffer) => resolve(chunk.toString())));
		expect(answer).toBe('N');
		// libpq's prefer fallback: the startup message again, in plaintext.
		raw.write(startup('app'));
		const { data, closed } = await collect(raw);
		expect(closed).toBe(true);
		expect(data[0]).toBe(0x45);
		expect(data.toString()).toContain('C57P03');
		expect(data.toString()).toContain('no TLS certificate');
		expect(data.toString()).toContain('app-org1.db.test');
		expect(upstreamUsers.length).toBe(before);
		// One refusal per connection, not one for the SSLRequest and another for the startup.
		expect(proxy.drainEvents().map((event) => event.reason)).toEqual(['no-certificate']);
		expect(proxy.status()[0]).toMatchObject({ accepted: 0, open: 0 });
	});

	test('without a certificate, sslmode=require stops at the N and the refusal is still recorded', async () => {
		const { proxy, port } = await withoutCertificate();
		const raw = connect(port, '127.0.0.1');
		raw.write(sslRequest());
		const answer = await new Promise<string>((resolve) => raw.once('data', (chunk: Buffer) => resolve(chunk.toString())));
		expect(answer).toBe('N');
		raw.end();
		await until(() => proxy.status()[0]?.open === 0);
		expect(proxy.drainEvents().map((event) => event.reason)).toEqual(['no-certificate']);
	});

	test('without a certificate, direct TLS and TLS-first protocols are closed without a byte', async () => {
		const pg = await withoutCertificate();
		const direct = connect(pg.port, '127.0.0.1');
		direct.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 0x01, 0x00, 0x00, 0x01, 0x00]));
		const first = await collect(direct);
		expect(first).toEqual({ data: Buffer.alloc(0), closed: true });
		expect(pg.proxy.drainEvents().map((event) => event.reason)).toEqual(['no-certificate']);

		pg.proxy.close();
		const tlsFirst = await withoutCertificate({ protocol: 'tls', users: [] });
		const raw = connect(tlsFirst.port, '127.0.0.1');
		expect(await collect(raw)).toEqual({ data: Buffer.alloc(0), closed: true });
		expect(tlsFirst.proxy.drainEvents().map((event) => event.reason)).toEqual(['no-certificate']);
	});

	test('nothing binds until the firewall is applied, and an unreachable upstream is reported', async () => {
		const proxy = new PublicDatabaseProxy({ bindHosts: ['127.0.0.1'] });
		proxies.push(proxy);
		proxy.converge([listener({ upstreamPort: null })], { firewallReady: false, certificates: new Map([['*.db.test', certificate]]) });
		await Bun.sleep(50);
		expect(proxy.boundPort('db_1')).toBeNull();
		expect(proxy.status()[0]).toMatchObject({ state: 'firewall-pending' });
		proxy.converge([listener({ upstreamPort: null })], { firewallReady: false, helperOutdated: true, certificates: new Map() });
		expect(proxy.status()[0]).toMatchObject({ state: 'helper-outdated' });
		proxy.converge([listener({ upstreamPort: null })], { firewallReady: true, certificates: new Map([['*.db.test', certificate]]) });
		await until(() => proxy.boundPort('db_1') !== null);
		expect(proxy.status()[0]).toMatchObject({ state: 'unreachable' });
		// The listener leaving desired state closes it.
		proxy.converge([], { firewallReady: true, certificates: new Map() });
		expect(proxy.status()).toEqual([]);
	});

	test('expiry closes the listener and its connections on its own', async () => {
		const { proxy, port } = await start(listener({ expiresAt: new Date(Date.now() + 400).toISOString() }));
		const tls = await pgOverSslRequest(port, 'app');
		const reading = collect(tls);
		expect((await reading).closed).toBe(true);
		expect(proxy.status()[0]).toMatchObject({ state: 'expired', open: 0 });
		expect(proxy.boundPort('db_1')).toBeNull();
	});
});
