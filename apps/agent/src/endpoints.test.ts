import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, connect, type Server } from 'node:net';
import { ServiceForwarder, isGatewayAddress, wantsGateway, type NodeTrustMaterial } from './endpoints.ts';
import { TestPki } from './test-pki.ts';

const servers: Server[] = [];
const forwarders: ServiceForwarder[] = [];
const pkis: TestPki[] = [];

async function echoServer(): Promise<number> {
	const server = createServer((socket) => socket.pipe(socket));
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('no port');
	return address.port;
}

function readOnce(port: number, message: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: '127.0.0.1', port });
		socket.setEncoding('utf8');
		socket.on('error', reject);
		socket.on('end', () => reject(new Error('closed before a reply')));
		socket.on('close', () => reject(new Error('closed before a reply')));
		socket.on('connect', () => socket.write(message));
		socket.once('data', (data) => {
			socket.end();
			resolve(String(data));
		});
	});
}

afterEach(() => {
	for (const forwarder of forwarders.splice(0)) forwarder.close();
	for (const server of servers.splice(0)) server.close();
	for (const pki of pkis.splice(0)) pki.dispose();
});

describe('ServiceForwarder', () => {
	test('forwards a consumer loopback port to the provider target', async () => {
		const target = await echoServer();
		const forwarder = new ServiceForwarder();
		forwarders.push(forwarder);
		forwarder.converge(
			[
				{
					id: 'sep_1',
					kind: 'database',
					serviceId: 'db_1',
					localPort: 21111,
					upstream: { nodeId: 'nod_b', address: '127.0.0.1', port: target },
					tlsFingerprint: null,
				},
			],
			[],
		);
		await Bun.sleep(50);
		expect(await readOnce(21111, 'hello')).toBe('hello');
	});

	test('provider listener forwards an overlay port to loopback', async () => {
		const target = await echoServer();
		const forwarder = new ServiceForwarder();
		forwarders.push(forwarder);
		forwarder.converge([], [
			{ id: 'svc_1', listenAddress: '127.0.0.1', listenPort: 21112, targetPort: target, allowedClientFingerprints: [] },
		]);
		await Bun.sleep(50);
		expect(await readOnce(21112, 'world')).toBe('world');
	});

	test('removes listeners that disappear from desired state', async () => {
		const target = await echoServer();
		const forwarder = new ServiceForwarder();
		forwarders.push(forwarder);
		const endpoint = {
			id: 'sep_2',
			kind: 'database' as const,
			serviceId: 'db_2',
			localPort: 21113,
			upstream: { nodeId: 'nod_b', address: '127.0.0.1', port: target },
			tlsFingerprint: null,
		};
		forwarder.converge([endpoint], []);
		await Bun.sleep(50);
		expect(await readOnce(21113, 'x')).toBe('x');
		forwarder.converge([], []);
		await Bun.sleep(50);
		await expect(readOnce(21113, 'x')).rejects.toBeTruthy();
	});
});

// ---------------------------------------------------------------- HA-PLAN H24 (lane A)

async function freePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
	const address = probe.address();
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	if (!address || typeof address === 'string') throw new Error('no port');
	return address.port;
}

/** An echo server that prefixes replies with its name, so a test can tell upstreams apart. */
async function namedServer(name: string): Promise<number> {
	const server = createServer((socket) => socket.on('data', (data) => socket.write(`${name}:${String(data)}`)));
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return (server.address() as { port: number }).port;
}

/** Open a connection and keep it; `say` writes and waits for one reply. */
function hold(port: number, host = '127.0.0.1'): Promise<{ say(message: string): Promise<string>; socket: ReturnType<typeof connect> }> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host, port });
		socket.setEncoding('utf8');
		socket.once('error', reject);
		socket.once('connect', () =>
			resolve({
				socket,
				say: (message) =>
					new Promise((done, fail) => {
						socket.once('data', (data) => done(String(data)));
						socket.once('error', fail);
						socket.once('close', () => fail(new Error('closed')));
						socket.write(message);
					}),
			}),
		);
	});
}

function plainEndpoint(id: string, localPort: number, upstreamPort: number, extra: Record<string, unknown> = {}) {
	return {
		id,
		kind: 'database' as const,
		serviceId: `db_${id}`,
		localPort,
		upstream: { nodeId: 'nod_b', address: '127.0.0.1', port: upstreamPort },
		tlsFingerprint: null,
		...extra,
	};
}

describe('ServiceForwarder reloads (spike S10 restart bug)', () => {
	test('an unchanged converge rebinds nothing', async () => {
		const target = await echoServer();
		const port = await freePort();
		const forwarder = new ServiceForwarder();
		forwarders.push(forwarder);
		const endpoints = [plainEndpoint('sep_r1', port, target)];
		const provider = { id: 'svc_r1', listenAddress: '127.0.0.1', listenPort: await freePort(), targetPort: target, allowedClientFingerprints: [] };
		expect(forwarder.converge(endpoints, [provider])).toMatchObject({ started: 2, stopped: 0 });
		// Before the fix the stored signature never equalled the compared one: every converge
		// closed and reopened every consumer listener (and every plain provider listener).
		expect(forwarder.converge(endpoints, [provider])).toEqual({ started: 0, stopped: 0, updated: 0 });
	});

	test('a re-pointed upstream is swapped in place: open sessions stay, new ones follow', async () => {
		const a = await namedServer('a');
		const b = await namedServer('b');
		const port = await freePort();
		const forwarder = new ServiceForwarder();
		forwarders.push(forwarder);
		forwarder.converge([plainEndpoint('sep_r2', port, a)], []);
		await Bun.sleep(30);
		const open = await hold(port);
		expect(await open.say('1')).toBe('a:1');
		expect(forwarder.converge([plainEndpoint('sep_r2', port, b)], [])).toEqual({ started: 0, stopped: 0, updated: 1 });
		expect(await readOnce(port, '2')).toBe('b:2');
		expect(await open.say('3')).toBe('a:3');
		open.socket.destroy();
	});

	test('a newer version that moves the upstream cuts the old sessions (failover)', async () => {
		const a = await namedServer('a');
		const b = await namedServer('b');
		const port = await freePort();
		const forwarder = new ServiceForwarder();
		forwarders.push(forwarder);
		forwarder.converge([plainEndpoint('sep_r3', port, a, { version: 1 })], []);
		await Bun.sleep(30);
		const open = await hold(port);
		expect(await open.say('1')).toBe('a:1');
		const closed = new Promise<void>((resolve) => open.socket.once('close', () => resolve()));
		forwarder.converge([plainEndpoint('sep_r3', port, b, { version: 2 })], []);
		await closed;
		expect(await readOnce(port, '2')).toBe('b:2');
	});

	test('100 reloads with sessions open and new connections arriving: none refused', async () => {
		const target = await echoServer();
		const other = await namedServer('other');
		const port = await freePort();
		const churnPort = await freePort();
		const forwarder = new ServiceForwarder();
		forwarders.push(forwarder);
		const base = plainEndpoint('sep_load', port, target, { version: 1 });
		forwarder.converge([base], []);
		await Bun.sleep(30);
		const idle = await Promise.all(Array.from({ length: 10 }, () => hold(port)));
		let refused = 0;
		let served = 0;
		const dialer = setInterval(() => {
			readOnce(port, 'ping').then(
				(reply) => (reply === 'ping' ? (served += 1) : (refused += 1)),
				() => (refused += 1),
			);
		}, 50);
		for (let reload = 0; reload < 100; reload += 1) {
			// Another service comes and goes and re-points; this endpoint's own record is re-sent
			// unchanged, and the trust material changes generation, as a real reload would.
			const churn = reload % 2 === 0 ? [plainEndpoint('sep_churn', churnPort, other + (reload % 3))] : [];
			forwarder.converge([base, ...churn], [], { trust: null, gatewayAllowed: reload % 4 === 0 });
			await Bun.sleep(50);
		}
		clearInterval(dialer);
		await Bun.sleep(200);
		expect(refused).toBe(0);
		expect(served).toBeGreaterThanOrEqual(80);
		for (const [index, session] of idle.entries()) expect(await session.say(`idle${index}`)).toBe(`idle${index}`);
		for (const session of idle) session.socket.destroy();
	}, 20_000);
});

describe('ServiceForwarder gateway address (HA-PLAN H24)', () => {
	test('desired state wants a gateway bind only when an endpoint names one, so flag-off is a no-op', () => {
		const plain = plainEndpoint('sep_w1', 21211, 1);
		expect(wantsGateway([plain])).toBe(false);
		expect(wantsGateway([])).toBe(false);
		expect(wantsGateway([plain], [])).toBe(false);
		expect(wantsGateway([{ ...plain, gatewayAddress: '10.89.0.1' }])).toBe(true);
		const read = {
			id: 'rep_w1',
			kind: 'database' as const,
			serviceId: 'db_w1',
			role: 'read' as const,
			localPort: 23211,
			upstreams: [{ nodeId: 'nod_b', address: '127.0.0.1', port: 1, trust: 'pinned' as const, tlsFingerprint: null }],
			version: 1,
		};
		expect(wantsGateway([], [read])).toBe(false);
		expect(wantsGateway([], [{ ...read, gatewayAddress: '10.89.0.1' }])).toBe(true);
	});

	test('binds loopback only until the endpoint guard allows the gateway', async () => {
		const target = await echoServer();
		const port = await freePort();
		const forwarder = new ServiceForwarder();
		forwarders.push(forwarder);
		const endpoint = plainEndpoint('sep_g1', port, target, { gatewayAddress: '10.89.0.1' });
		forwarder.converge([endpoint], [], { gatewayAllowed: false });
		await Bun.sleep(30);
		expect(forwarder.listening()[port]).toEqual(['127.0.0.1']);
		expect(await readOnce(port, 'lo')).toBe('lo');
	});

	test('a gateway address that does not exist yet is retried, and loopback keeps serving', async () => {
		const target = await echoServer();
		const port = await freePort();
		const logs: string[] = [];
		const forwarder = new ServiceForwarder({ log: (_level, message) => logs.push(message) });
		forwarders.push(forwarder);
		// A private address never configured on a test host: the bind fails like a bridge not up yet.
		const endpoint = plainEndpoint('sep_g2', port, target, { gatewayAddress: '10.99.99.99' });
		forwarder.converge([endpoint], [], { gatewayAllowed: true });
		forwarder.converge([endpoint], [], { gatewayAllowed: true });
		await Bun.sleep(100);
		expect(forwarder.listening()[port]).toEqual(['127.0.0.1']);
		expect(await readOnce(port, 'still')).toBe('still');
		// Logged once per failure, not once per converge.
		expect(logs.filter((line) => line.includes('10.99.99.99')).length).toBe(1);
	});

	test.skipIf(process.platform !== 'linux')('listens on the gateway address too, same port, and drops it when unset', async () => {
		const target = await echoServer();
		const port = await freePort();
		const forwarder = new ServiceForwarder();
		forwarders.push(forwarder);
		const endpoint = plainEndpoint('sep_g3', port, target, { gatewayAddress: '127.0.0.2' });
		forwarder.converge([endpoint], [], { gatewayAllowed: true });
		await Bun.sleep(50);
		expect(forwarder.listening()[port]).toEqual(['127.0.0.1', '127.0.0.2']);
		expect((await hold(port, '127.0.0.2')).say('gw')).resolves.toBe('gw');
		forwarder.converge([plainEndpoint('sep_g3', port, target)], [], { gatewayAllowed: true });
		await Bun.sleep(50);
		expect(forwarder.listening()[port]).toEqual(['127.0.0.1']);
	});
});

describe('ServiceForwarder read endpoints (HA-PLAN H24)', () => {
	test('balances over the replicas and falls back to the last upstream', async () => {
		const r1 = await namedServer('r1');
		const r2 = await namedServer('r2');
		const primary = await namedServer('p');
		const dead = await freePort();
		const port = await freePort();
		const forwarder = new ServiceForwarder();
		forwarders.push(forwarder);
		const upstream = (nodeId: string, upstreamPort: number) => ({ nodeId, address: '127.0.0.1', port: upstreamPort, trust: 'pinned' as const, tlsFingerprint: null });
		const read = (upstreams: ReturnType<typeof upstream>[]) => ({ id: 'rep_1', kind: 'database' as const, serviceId: 'db_1', role: 'read' as const, localPort: port, upstreams, version: 0 });
		forwarder.converge([], [], { readEndpoints: [read([upstream('n1', r1), upstream('n2', r2), upstream('n0', primary)])] });
		await Bun.sleep(30);
		const replies = [await readOnce(port, 'x'), await readOnce(port, 'x'), await readOnce(port, 'x'), await readOnce(port, 'x')];
		expect(replies.sort()).toEqual(['r1:x', 'r1:x', 'r2:x', 'r2:x']);
		forwarder.converge([], [], { readEndpoints: [read([upstream('n1', dead), upstream('n0', primary)])] });
		expect(await readOnce(port, 'y')).toBe('p:y');
	});
});

describe('ServiceForwarder install-CA trust (HA-PLAN H24)', () => {
	function pki(): TestPki {
		const created = new TestPki();
		pkis.push(created);
		return created;
	}

	/** One node's install-CA material, with an option to revoke the provider instead. */
	function material(ca: TestPki, nodeId: string, revoked: string[] = []): { trust: NodeTrustMaterial; serial: string } {
		const leaf = ca.leaf(nodeId);
		return {
			serial: leaf.serial,
			trust: {
				keyPem: leaf.keyPem,
				certPem: leaf.certPem,
				caBundlePem: ca.caPem,
				revokedSerials: new Set(revoked),
				generation: 1,
			},
		};
	}

	function provider(port: number, target: number, allowed: string[] = ['nod_a']) {
		return {
			id: 'svc_ca',
			listenAddress: '127.0.0.1',
			listenPort: port,
			targetPort: target,
			allowedClientFingerprints: [],
			clientAuth: 'install-ca' as const,
			allowedClientNodeIds: allowed,
		};
	}

	function consumer(port: number, upstreamPort: number, extra: Record<string, unknown> = {}) {
		return {
			id: 'sep_ca',
			kind: 'database' as const,
			serviceId: 'db_ca',
			localPort: port,
			upstream: { nodeId: 'nod_b', address: '127.0.0.1', port: upstreamPort },
			tlsFingerprint: null,
			trust: 'install-ca' as const,
			...extra,
		};
	}

	test.skipIf(!Bun.which('openssl'))('a CA leaf on each node forwards without any pinned fingerprint', async () => {
		const ca = pki();
		const target = await echoServer();
		const providerPort = await freePort();
		const localPort = await freePort();
		const server = new ServiceForwarder();
		const client = new ServiceForwarder();
		forwarders.push(server, client);
		server.converge([], [provider(providerPort, target)], { trust: material(ca, 'nod_b').trust });
		client.converge([consumer(localPort, providerPort)], [], { trust: material(ca, 'nod_a').trust });
		await Bun.sleep(50);
		expect(await readOnce(localPort, 'over-ca')).toBe('over-ca');
	});

	test.skipIf(!Bun.which('openssl'))('a revoked provider leaf fails closed, and the next upstream is tried', async () => {
		const ca = pki();
		const target = await echoServer();
		const providerPort = await freePort();
		const localPort = await freePort();
		const server = new ServiceForwarder();
		const client = new ServiceForwarder();
		forwarders.push(server, client);
		const providerMaterial = material(ca, 'nod_b');
		server.converge([], [provider(providerPort, target)], { trust: providerMaterial.trust });
		client.converge([consumer(localPort, providerPort)], [], { trust: material(ca, 'nod_a', [providerMaterial.serial]).trust });
		await Bun.sleep(50);
		await expect(readOnce(localPort, 'x')).rejects.toBeTruthy();
	});

	test.skipIf(!Bun.which('openssl'))('a provider whose certificate names another node is refused', async () => {
		const ca = pki();
		const target = await echoServer();
		const providerPort = await freePort();
		const localPort = await freePort();
		const server = new ServiceForwarder();
		const client = new ServiceForwarder();
		forwarders.push(server, client);
		// The listener presents a leaf for nod_c while the endpoint names nod_b.
		server.converge([], [provider(providerPort, target)], { trust: material(ca, 'nod_c').trust });
		client.converge([consumer(localPort, providerPort)], [], { trust: material(ca, 'nod_a').trust });
		await Bun.sleep(50);
		await expect(readOnce(localPort, 'x')).rejects.toBeTruthy();
	});

	test.skipIf(!Bun.which('openssl'))('a bundle from another CA is refused', async () => {
		const ca = pki();
		const other = pki();
		const target = await echoServer();
		const providerPort = await freePort();
		const localPort = await freePort();
		const server = new ServiceForwarder();
		const client = new ServiceForwarder();
		forwarders.push(server, client);
		server.converge([], [provider(providerPort, target)], { trust: material(ca, 'nod_b').trust });
		client.converge([consumer(localPort, providerPort)], [], { trust: material(other, 'nod_a').trust });
		await Bun.sleep(50);
		await expect(readOnce(localPort, 'x')).rejects.toBeTruthy();
	});

	test.skipIf(!Bun.which('openssl'))('a consumer without a leaf never dials; a provider without one refuses', async () => {
		const ca = pki();
		const target = await echoServer();
		const providerPort = await freePort();
		const localPort = await freePort();
		const server = new ServiceForwarder();
		const client = new ServiceForwarder();
		forwarders.push(server, client);
		// The provider has no leaf: it must not serve an install-ca listener.
		server.converge([], [provider(providerPort, target)], { trust: null });
		client.converge([consumer(localPort, providerPort)], [], { trust: null });
		await Bun.sleep(50);
		await expect(readOnce(localPort, 'x')).rejects.toBeTruthy();
	});

	test.skipIf(!Bun.which('openssl'))('the provider allows only the client node ids listed', async () => {
		const ca = pki();
		const target = await echoServer();
		const providerPort = await freePort();
		const localPort = await freePort();
		const server = new ServiceForwarder();
		const client = new ServiceForwarder();
		forwarders.push(server, client);
		server.converge([], [provider(providerPort, target, ['nod_c'])], { trust: material(ca, 'nod_b').trust });
		client.converge([consumer(localPort, providerPort)], [], { trust: material(ca, 'nod_a').trust });
		await Bun.sleep(50);
		await expect(readOnce(localPort, 'x')).rejects.toBeTruthy();
	});

	test.skipIf(!Bun.which('openssl'))('a provider listener moves from plain to TLS when the CA leaf arrives', async () => {
		const ca = pki();
		const target = await echoServer();
		const providerPort = await freePort();
		const localPort = await freePort();
		const server = new ServiceForwarder();
		const client = new ServiceForwarder();
		forwarders.push(server, client);
		// First converge: the CSR has not been signed yet, so the install-ca listener fails closed.
		server.converge([], [provider(providerPort, target)], { trust: null });
		client.converge([consumer(localPort, providerPort)], [], { trust: null });
		await Bun.sleep(30);
		await expect(readOnce(localPort, 'x')).rejects.toBeTruthy();
		// The signed leaves arrive in desired state: both listeners are replaced, not left plain.
		const transition = server.converge([], [provider(providerPort, target)], { trust: material(ca, 'nod_b').trust });
		expect(transition).toMatchObject({ stopped: 1, started: 1 });
		client.converge([consumer(localPort, providerPort)], [], { trust: material(ca, 'nod_a').trust });
		await Bun.sleep(50);
		expect(await readOnce(localPort, 'now')).toBe('now');
	});

	test('with the flag off (no trust, no gateway) the forwarder behaves as before', async () => {
		const target = await echoServer();
		const providerPort = await freePort();
		const localPort = await freePort();
		const forwarder = new ServiceForwarder();
		forwarders.push(forwarder);
		const result = forwarder.converge([plainEndpoint('sep_off', localPort, target)], [provider(providerPort, target, [])], {
			trust: null,
			gatewayAllowed: false,
			readEndpoints: [],
		});
		expect(result).toMatchObject({ started: 2, stopped: 0 });
		expect(forwarder.listening()[localPort]).toEqual(['127.0.0.1']);
		expect(await readOnce(localPort, 'unchanged')).toBe('unchanged');
	});
});

describe('gateway address validation (W4)', () => {
	test('only a private container-gateway address may be bound', () => {
		for (const address of ['10.89.0.1', '172.16.4.1', '192.168.1.1', '100.64.0.1']) expect(isGatewayAddress(address)).toBe(true);
		for (const address of ['127.0.0.1', '0.0.0.0', '203.0.113.7', '8.8.8.8', '10.89.0.1 evil', '010.0.0.1', '10.89.0']) expect(isGatewayAddress(address)).toBe(false);
	});
});
