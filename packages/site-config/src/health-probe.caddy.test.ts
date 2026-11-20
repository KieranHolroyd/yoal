import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileSiteRoute } from './compile.ts';

/**
 * HA-PLAN Wave 1 F7, second review: the health-probe exemption on a protected copy, in a real
 * Caddy. Caddy's matchers compare a cleaned path while `reverse_proxy` forwards the raw one, so
 * every spelling below that matches must reach the app as exactly the health path, and the caller
 * must get only the status back. Everything else must hit the access check.
 *
 * Needs a Caddy binary: `YOAL_TEST_CADDY=/path/to/caddy bun test …`. Skipped without one (CI has
 * none). Raw TCP on both sides, since `fetch` and `Bun.serve` normalise `..` and would hide a leak.
 */
const CADDY = process.env.YOAL_TEST_CADDY;

interface Reply {
	status: number;
	head: string;
	body: string;
}

/** One raw HTTP/1.1 request, the target sent exactly as given. */
function raw(port: number, method: string, target: string): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, '127.0.0.1', () =>
			socket.write(`${method} ${target} HTTP/1.1\r\nHost: app.test\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`),
		);
		let data = '';
		socket.on('data', (chunk) => (data += chunk.toString()));
		socket.on('end', () => {
			const [head, ...rest] = data.split('\r\n\r\n');
			resolve({ status: Number(head!.split(' ')[1]), head: head!, body: rest.join('\r\n\r\n') });
		});
		socket.on('error', reject);
		socket.setTimeout(5_000, () => socket.destroy(new Error(`timeout: ${method} ${target}`)));
	});
}

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = createServer().listen(0, '127.0.0.1', () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});
}

describe.skipIf(!CADDY)('health probe of a protected copy in a real Caddy (F7)', () => {
	let dir: string;
	let upstream: Server;
	let upstreamPort: number;
	let deny: ReturnType<typeof Bun.serve>;
	const seen: string[] = [];
	const caddies: Array<ReturnType<typeof Bun.spawn>> = [];

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'yoal-probe-'));
		// The app: echoes the raw request line, sends a header that must never reach the prober, and
		// answers `/down` with 503.
		upstream = createServer((socket) => {
			let data = '';
			socket.on('data', (chunk) => {
				data += chunk.toString();
				if (!data.includes('\r\n\r\n')) return;
				const line = data.split('\r\n')[0]!;
				seen.push(line.replace(/ HTTP\/1\.1$/, ''));
				const body = `UPSTREAM ${line}\n`;
				const status = line.split(' ')[1]!.split('?')[0] === '/down' ? '503 Service Unavailable' : '200 OK';
				socket.end(`HTTP/1.1 ${status}\r\nContent-Length: ${body.length}\r\nX-Upstream-Secret: s3cr3t\r\nConnection: close\r\n\r\n${body}`);
			});
		}).listen(0, '127.0.0.1');
		await new Promise((resolve) => upstream.once('listening', resolve));
		upstreamPort = (upstream.address() as { port: number }).port;
		// The access check: always says no. A relative path keeps under macOS's 104-byte socket limit.
		deny = Bun.serve({ unix: join(dir, 'deny.sock'), fetch: () => new Response('DENY\n', { status: 401 }) });
	});

	afterAll(async () => {
		for (const caddy of caddies) {
			caddy.kill();
			await caddy.exited;
		}
		deny?.stop(true);
		upstream?.close();
		rmSync(dir, { recursive: true, force: true });
	});

	async function caddyFor(healthPath: string, cidr: string): Promise<number> {
		const port = await freePort();
		const route = compileSiteRoute({
			host: 'app.test',
			projectId: 'prj_probe',
			releasePath: '/nonexistent',
			agentSocket: 'deny.sock',
			accessMode: 'platform',
			site: { spa: false, cleanUrls: false, trailingSlash: 'ignore', notFound: null },
			redirects: [],
			headers: [],
			loginUrl: 'https://login.test',
			upstream: `http://127.0.0.1:${upstreamPort}`,
			healthPath,
			healthProbeCidr: cidr,
		});
		const config = {
			admin: { disabled: true, config: { persist: false } },
			apps: { http: { servers: { s: { listen: [`127.0.0.1:${port}`], routes: [route], automatic_https: { disable: true } } } } },
		};
		const file = join(dir, `caddy-${port}.json`);
		writeFileSync(file, JSON.stringify(config));
		caddies.push(
			Bun.spawn([CADDY!, 'run', '--config', file], {
				cwd: dir,
				env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data') },
				stdout: 'ignore',
				stderr: 'ignore',
			}),
		);
		for (let attempt = 0; attempt < 100; attempt++) {
			if (await raw(port, 'GET', '/__ready').then(() => true, () => false)) return port;
			await Bun.sleep(50);
		}
		throw new Error('caddy did not start');
	}

	async function expectProbe(port: number, method: string, target: string, healthPath: string, status = 200) {
		seen.length = 0;
		const reply = await raw(port, method, target);
		expect({ target, status: reply.status, body: reply.body, seen: [...seen] }).toEqual({
			target,
			status,
			body: '',
			seen: [`${method} ${healthPath}`],
		});
		expect(reply.head).not.toMatch(/x-upstream-secret/i);
	}

	async function expectDenied(port: number, method: string, target: string) {
		seen.length = 0;
		const reply = await raw(port, method, target);
		expect({ target, status: reply.status, seen: [...seen] }).toEqual({ target, status: 401, seen: [] });
	}

	test('every matching spelling reaches the app as exactly the health path; the rest is denied', async () => {
		const port = await caddyFor('/healthz', '127.0.0.0/8');
		for (const target of [
			'/healthz',
			'//healthz',
			'/./healthz',
			'/healthz?x=1',
			'/admin/../healthz',
			'/admin%2F..%2Fhealthz',
			'/admin/%2e%2e/healthz',
			'/%68ealthz',
		])
			await expectProbe(port, 'GET', target, '/healthz');
		await expectProbe(port, 'HEAD', '/healthz?x=1', '/healthz');
		for (const target of ['/HEALTHZ', '/healthz/', '/admin', '/'])
			await expectDenied(port, 'GET', target);
		await expectDenied(port, 'POST', '/healthz');
	});

	test('a health path of / exposes the root page\'s status only, never a query', async () => {
		const port = await caddyFor('/', '127.0.0.0/8');
		for (const target of ['/', '/?page=admin', '//?page=admin', '/admin/..', '/admin/../?page=admin'])
			await expectProbe(port, 'GET', target, '/');
		await expectDenied(port, 'GET', '/admin');
	});

	test('the app\'s failure status comes back, with no body', async () => {
		const port = await caddyFor('/down', '127.0.0.0/8');
		await expectProbe(port, 'GET', '/down?x=1', '/down', 503);
	});

	test('from outside the overlay range nothing is exempt', async () => {
		const port = await caddyFor('/healthz', '10.99.0.0/16');
		for (const target of ['/healthz', '//healthz', '/admin/../healthz']) await expectDenied(port, 'GET', target);
		await expectDenied(port, 'HEAD', '/healthz');
	});
});
