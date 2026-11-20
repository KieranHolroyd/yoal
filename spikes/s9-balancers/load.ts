/**
 * S9 load generator: raw HTTP/1.1 over TLS (or plain TCP) so every connection and every request is
 * accounted for. Writes one JSON line per event to `--out` and prints a JSON summary last.
 *
 *   rate: `--rps` requests/s for `--seconds`, half on `--ka` keep-alive connections and half on a
 *         new connection each (Connection: close).
 *   hold: open `--conns` keep-alive connections and hold them idle, run `--slow` connections that
 *         loop a 2 s request, and `--newrps` new-connection requests/s; at the end every surviving
 *         held connection sends one request.
 *
 * A request fails when it was written and did not get a 2xx: connect error, reset, early close,
 * 5 s timeout, or a non-2xx status.
 */
import net from 'node:net';
import tls from 'node:tls';
import { appendFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
	options: {
		mode: { type: 'string', default: 'rate' },
		target: { type: 'string' },
		tls: { type: 'boolean', default: false },
		host: { type: 'string', default: 'app.s9.test' },
		path: { type: 'string', default: '/' },
		rps: { type: 'string', default: '200' },
		seconds: { type: 'string', default: '30' },
		ka: { type: 'string', default: '20' },
		conns: { type: 'string', default: '1000' },
		slow: { type: 'string', default: '50' },
		newrps: { type: 'string', default: '20' },
		out: { type: 'string', default: '/out/load.jsonl' },
		timeout: { type: 'string', default: '5000' },
	},
});

const [targetHost, targetPort] = (args.target ?? '').split(':');
if (!targetHost || !targetPort) throw new Error('--target host:port is required');
const TIMEOUT = Number(args.timeout);
writeFileSync(args.out!, '');
const log = (event: Record<string, unknown>) => appendFileSync(args.out!, `${JSON.stringify({ t: Date.now(), ...event })}\n`);

interface Result {
	ok: boolean;
	status?: number;
	node?: string;
	close?: boolean;
	err?: string;
	ms: number;
}

let nextConnId = 0;

class Conn {
	readonly id = ++nextConnId;
	sock!: net.Socket;
	buf = Buffer.alloc(0);
	closed = false;
	closeReason = '';
	node = '';
	pending: { resolve: (r: Result) => void; started: number; timer: Timer } | null = null;
	onServerClose?: (conn: Conn, inflight: boolean) => void;

	static open(): Promise<Conn> {
		const conn = new Conn();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				conn.sock?.destroy();
				reject(new Error('connect-timeout'));
			}, TIMEOUT);
			const onReady = () => {
				clearTimeout(timer);
				resolve(conn);
			};
			conn.sock = args.tls
				? tls.connect({ host: targetHost, port: Number(targetPort), servername: args.host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] }, onReady)
				: net.connect({ host: targetHost, port: Number(targetPort) }, onReady);
			conn.sock.setNoDelay(true);
			conn.sock.on('data', (chunk: Buffer) => conn.onData(chunk));
			conn.sock.on('error', (error: Error & { code?: string }) => {
				clearTimeout(timer);
				conn.finish(error.code ?? error.message);
				reject(error);
			});
			conn.sock.on('end', () => conn.finish('eof'));
			conn.sock.on('close', () => conn.finish('close'));
		});
	}

	private finish(reason: string) {
		if (this.closed) return;
		this.closed = true;
		this.closeReason = reason;
		const inflight = this.pending !== null;
		if (this.pending) this.settle({ ok: false, err: `${reason}-inflight` });
		this.onServerClose?.(this, inflight);
		this.sock.destroy();
	}

	private settle(partial: Omit<Result, 'ms'>) {
		const pending = this.pending;
		if (!pending) return;
		this.pending = null;
		clearTimeout(pending.timer);
		pending.resolve({ ...partial, ms: Date.now() - pending.started });
	}

	private onData(chunk: Buffer) {
		this.buf = Buffer.concat([this.buf, chunk]);
		const end = this.buf.indexOf('\r\n\r\n');
		if (end < 0) return;
		const head = this.buf.subarray(0, end).toString('latin1').split('\r\n');
		const status = Number(head[0]!.split(' ')[1]);
		const headers = new Map<string, string>();
		for (const line of head.slice(1)) {
			const i = line.indexOf(':');
			headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
		}
		const length = headers.get('content-length');
		if (length === undefined) {
			this.buf = Buffer.alloc(0);
			this.settle({ ok: false, status, err: 'no-content-length' });
			return;
		}
		if (this.buf.length < end + 4 + Number(length)) return;
		this.buf = this.buf.subarray(end + 4 + Number(length));
		const node = headers.get('x-s9-node') ?? '';
		this.node = node || this.node;
		const close = (headers.get('connection') ?? '').toLowerCase() === 'close';
		this.settle({ ok: status >= 200 && status < 300, status, node, close });
		// A server that announced close is allowed to close: not a drop.
		if (close) {
			this.closed = true;
			this.closeReason = 'announced';
			this.sock.end();
		}
	}

	request(path: string, close = false): Promise<Result> {
		if (this.closed) return Promise.resolve({ ok: false, err: 'closed-before-send', ms: 0 });
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.settle({ ok: false, err: 'timeout' });
				this.sock.destroy();
				this.closed = true;
			}, TIMEOUT);
			this.pending = { resolve, started: Date.now(), timer };
			this.sock.write(`GET ${path} HTTP/1.1\r\nHost: ${args.host}\r\nUser-Agent: s9-load\r\n${close ? 'Connection: close\r\n' : ''}\r\n`);
		});
	}
}

async function oneShot(path: string): Promise<Result> {
	const started = Date.now();
	let conn: Conn;
	try {
		conn = await Conn.open();
	} catch (error) {
		return { ok: false, err: `connect:${(error as { code?: string }).code ?? (error as Error).message}`, ms: Date.now() - started };
	}
	const result = await conn.request(path, true);
	conn.sock.destroy();
	return { ...result, ms: Date.now() - started };
}

const counts = new Map<string, number>();
const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);

function record(kind: string, conn: number | null, result: Result) {
	bump(`${kind}:${result.ok ? 'ok' : 'fail'}`);
	if (result.node) bump(`node:${result.node}`);
	log({ ev: 'req', kind, conn, ok: result.ok, status: result.status, node: result.node, err: result.err, ms: result.ms });
}

async function rate() {
	const rps = Number(args.rps);
	const seconds = Number(args.seconds);
	const pool: (Conn | null)[] = Array.from({ length: Number(args.ka) }, () => null);
	const opening = new Set<number>();
	let rr = 0;
	const inflight = new Set<Promise<unknown>>();
	const track = (p: Promise<unknown>) => {
		inflight.add(p);
		p.finally(() => inflight.delete(p));
	};

	const keepAlive = async () => {
		for (let tries = 0; tries < pool.length; tries++) {
			const slot = rr++ % pool.length;
			if (opening.has(slot)) continue;
			let conn = pool[slot];
			if (conn && conn.pending) continue;
			if (!conn || conn.closed) {
				if (conn) log({ ev: 'ka-reopen', conn: conn.id, node: conn.node, reason: conn.closeReason });
				opening.add(slot);
				try {
					conn = await Conn.open();
				} catch (error) {
					opening.delete(slot);
					record('ka', null, { ok: false, err: `connect:${(error as { code?: string }).code ?? (error as Error).message}`, ms: 0 });
					return;
				}
				opening.delete(slot);
				pool[slot] = conn;
			}
			record('ka', conn.id, await conn.request(args.path!));
			return;
		}
		bump('ka:saturated');
	};

	const start = Date.now();
	let sent = 0;
	await new Promise<void>((done) => {
		const tick = setInterval(() => {
			const elapsed = (Date.now() - start) / 1000;
			if (elapsed >= seconds) {
				clearInterval(tick);
				done();
				return;
			}
			while (sent < Math.floor(elapsed * rps)) {
				track(sent % 2 === 0 ? keepAlive() : oneShot(args.path!).then((r) => record('new', null, r)));
				sent++;
			}
		}, 2);
	});
	await Promise.all(inflight);
	for (const conn of pool) conn?.sock.destroy();
	return { sent };
}

async function hold() {
	const total = Number(args.conns);
	const seconds = Number(args.seconds);
	const held: Conn[] = [];
	const drops: { t: number; conn: number; node: string; inflight: boolean; reason: string }[] = [];
	let openFailures = 0;
	for (let i = 0; i < total; i += 50) {
		await Promise.all(
			Array.from({ length: Math.min(50, total - i) }, async () => {
				try {
					const conn = await Conn.open();
					const first = await conn.request(args.path!);
					if (!first.ok) throw new Error(first.err ?? `status-${first.status}`);
					conn.onServerClose = (c, inflight) => {
						drops.push({ t: Date.now(), conn: c.id, node: c.node, inflight, reason: c.closeReason });
						log({ ev: 'drop', conn: c.id, node: c.node, inflight, reason: c.closeReason });
					};
					held.push(conn);
				} catch {
					openFailures++;
				}
			}),
		);
	}
	log({ ev: 'held', count: held.length, openFailures });
	console.error(`held ${held.length} connections (${openFailures} failed to open)`);

	let stop = false;
	const slowLoops = Array.from({ length: Number(args.slow) }, async () => {
		let conn: Conn | null = null;
		while (!stop) {
			if (!conn || conn.closed) {
				try {
					conn = await Conn.open();
				} catch (error) {
					record('slow', null, { ok: false, err: `connect:${(error as Error).message}`, ms: 0 });
					await Bun.sleep(100);
					continue;
				}
			}
			record('slow', conn.id, await conn.request('/slow?ms=2000'));
		}
		conn?.sock.destroy();
	});
	const newRps = Number(args.newrps);
	const newLoop = (async () => {
		const pending: Promise<void>[] = [];
		while (!stop) {
			pending.push(oneShot(args.path!).then((r) => record('new', null, r)));
			await Bun.sleep(1000 / newRps);
		}
		await Promise.all(pending);
	})();

	await Bun.sleep(seconds * 1000);
	stop = true;
	await Promise.all([...slowLoops, newLoop]);

	// Verify: every held connection that is still open sends one more request.
	const alive = held.filter((c) => !c.closed);
	const verify = await Promise.all(alive.map((c) => c.request(args.path!)));
	for (const [i, r] of verify.entries()) record('verify', alive[i]!.id, r);
	for (const c of held) c.sock.destroy();
	return { held: held.length, openFailures, drops: drops.length, dropsInflight: drops.filter((d) => d.inflight).length, aliveAtEnd: alive.length, firstDrop: drops[0]?.t, lastDrop: drops.at(-1)?.t };
}

const started = Date.now();
const result = args.mode === 'hold' ? await hold() : await rate();
console.log(JSON.stringify({ mode: args.mode, started, ended: Date.now(), ...result, counts: Object.fromEntries([...counts].sort()) }));
process.exit(0);
