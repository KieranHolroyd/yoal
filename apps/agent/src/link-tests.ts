import { connect, createServer, type Server, type Socket } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import {
	linkTestLimits,
	type DesiredState,
	type LinkProbeTarget,
	type LinkSample,
	type LinkTestResult,
	type LinkTestTask,
} from '@yoal/contracts';

/**
 * Link sampling and link tests between nodes (docs/CLUSTERING.md §4.6, D216).
 *
 * **Sampling** times a TCP connect to each other node's overlay address. A refused connection is
 * as good as an accepted one: the reset came back, so the round trip is known. Only silence counts
 * as loss.
 *
 * **A test** is one node listening and the other dialling, both told by the control plane with a
 * shared token for that one test. The wire format is a single header line and then raw bytes:
 *
 *   YOAL-LINK/1 <token> echo            every byte is sent straight back (latency, jitter)
 *   YOAL-LINK/1 <token> up              the dialler sends, the listener replies with its byte count
 *   YOAL-LINK/1 <token> down <ms>       the listener sends for <ms>, then closes
 *
 * The listener binds the overlay address only, lives for one test and drops any connection whose
 * first line is not the token, so it is not a general traffic sink.
 */

const HEADER = 'YOAL-LINK/1';
const CHUNK = Buffer.alloc(64 * 1024);
const HEADER_MAX = 256;
const MAX_CONNECTIONS = 32;

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

// ---------------------------------------------------------------------------------- sampling

/** One connect attempt: milliseconds to an answer (accepted or refused), or null on silence. */
export function connectRtt(address: string, port: number, timeoutMs = 2_000): Promise<number | null> {
	return new Promise((resolve) => {
		const started = performance.now();
		let settled = false;
		const socket = connect({ host: address, port });
		const finish = (value: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(value);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		socket.once('connect', () => finish(performance.now() - started));
		socket.once('error', (error: NodeJS.ErrnoException) =>
			// The peer answered with a reset: the path works and the time is a round trip.
			finish(error.code === 'ECONNREFUSED' ? performance.now() - started : null),
		);
	});
}

/** Sample every target a few times, one after another so the samples do not queue behind each other. */
export async function sampleLinks(targets: LinkProbeTarget[], attempts = 3, timeoutMs = 2_000): Promise<LinkSample[]> {
	return Promise.all(
		targets.map(async (target) => {
			const times: number[] = [];
			for (let attempt = 0; attempt < attempts; attempt++) {
				const rtt = await connectRtt(target.address, target.port, timeoutMs);
				if (rtt !== null) times.push(rtt);
			}
			return {
				nodeId: target.nodeId,
				rttMs: times.length ? round(times.reduce((sum, value) => sum + value, 0) / times.length) : null,
				minMs: times.length ? round(Math.min(...times)) : null,
				maxMs: times.length ? round(Math.max(...times)) : null,
				lossPercent: round(((attempts - times.length) / attempts) * 100),
			};
		}),
	);
}

// ---------------------------------------------------------------------------------- listener

/** Listen for one test. Resolves once bound; `close()` ends it early. */
export function serveLinkTest(task: Pick<LinkTestTask, 'address' | 'port' | 'token' | 'expiresAt'>, log: Log = () => undefined): Promise<{ close: () => void; port: number }> {
	const sockets = new Set<Socket>();
	const server: Server = createServer((socket) => {
		if (sockets.size >= MAX_CONNECTIONS) {
			socket.destroy();
			return;
		}
		sockets.add(socket);
		socket.setNoDelay(true);
		socket.once('close', () => sockets.delete(socket));
		socket.on('error', () => socket.destroy());
		handleConnection(socket, task.token);
	});
	const close = () => {
		clearTimeout(expiry);
		for (const socket of sockets) socket.destroy();
		server.close();
	};
	const expiry = setTimeout(close, Math.max(1_000, task.expiresAt - Date.now()));
	expiry.unref?.();
	return new Promise((resolve, reject) => {
		server.once('error', (error) => {
			clearTimeout(expiry);
			reject(error);
		});
		server.listen(task.port, task.address, () => {
			const bound = server.address();
			log('info', `Link test listener on ${task.address}:${task.port}`);
			resolve({ close, port: typeof bound === 'object' && bound ? bound.port : task.port });
		});
	});
}

function handleConnection(socket: Socket, token: string): void {
	let header = Buffer.alloc(0);
	let mode: 'echo' | 'up' | 'down' | null = null;
	let received = 0;
	const guard = setTimeout(() => socket.destroy(), (linkTestLimits.maxSeconds + 15) * 1000);
	guard.unref?.();
	socket.once('close', () => clearTimeout(guard));
	socket.on('data', (chunk: Buffer) => {
		if (mode === 'echo') {
			socket.write(chunk);
			return;
		}
		if (mode === 'up') {
			received += chunk.length;
			return;
		}
		if (mode === 'down') return;
		header = Buffer.concat([header, chunk]);
		const end = header.indexOf(0x0a);
		if (end === -1) {
			if (header.length > HEADER_MAX) socket.destroy();
			return;
		}
		const parts = header.subarray(0, end).toString('utf8').trim().split(' ');
		const rest = header.subarray(end + 1);
		if (parts[0] !== HEADER || !sameToken(parts[1] ?? '', token)) {
			socket.destroy();
			return;
		}
		if (parts[2] === 'echo') {
			mode = 'echo';
			if (rest.length) socket.write(rest);
		} else if (parts[2] === 'up') {
			mode = 'up';
			received = rest.length;
		} else if (parts[2] === 'down') {
			mode = 'down';
			const ms = Math.min(linkTestLimits.maxSeconds * 1000, Math.max(100, Number(parts[3]) || 0));
			pump(socket, ms);
		} else socket.destroy();
	});
	// The dialler half-closes when it has sent everything; the count tells it what arrived.
	socket.once('end', () => {
		if (mode === 'up') socket.end(`${received}\n`);
		else socket.end();
	});
}

/** Write as fast as the socket takes it for `ms`, then close. */
function pump(socket: Socket, ms: number): void {
	const until = performance.now() + ms;
	const write = () => {
		while (performance.now() < until) {
			if (socket.destroyed) return;
			if (!socket.write(CHUNK)) {
				socket.once('drain', write);
				return;
			}
		}
		socket.end();
	};
	write();
}

function sameToken(given: string, expected: string): boolean {
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------------- prober

function dial(task: Pick<LinkTestTask, 'address' | 'port' | 'token'>, mode: string, timeoutMs = 5_000): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: task.address, port: task.port });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`No answer from ${task.address}:${task.port}`));
		}, timeoutMs);
		socket.setNoDelay(true);
		socket.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		socket.once('connect', () => {
			clearTimeout(timer);
			socket.write(`${HEADER} ${task.token} ${mode}\n`);
			resolve(socket);
		});
	});
}

/** The listener may not be up yet (it starts on its own node's next pull), so the first dial retries. */
async function dialWhenReady(task: Pick<LinkTestTask, 'address' | 'port' | 'token' | 'expiresAt'>, mode: string): Promise<Socket> {
	let last: unknown;
	while (Date.now() < task.expiresAt - 1_000) {
		try {
			return await dial(task, mode, 3_000);
		} catch (error) {
			last = error;
			await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
	}
	throw new Error(`The other node never started listening (${last instanceof Error ? last.message : 'no answer'}).`);
}

async function measureEcho(socket: Socket, count: number): Promise<{ rttMs: number; jitterMs: number }> {
	const times: number[] = [];
	try {
		for (let index = 0; index < count; index++) {
			const started = performance.now();
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('The echo timed out.')), 3_000);
				socket.once('data', () => {
					clearTimeout(timer);
					resolve();
				});
				socket.write('x');
			});
			times.push(performance.now() - started);
		}
	} finally {
		socket.destroy();
	}
	const mean = times.reduce((sum, value) => sum + value, 0) / times.length;
	// Jitter as the mean difference between consecutive round trips (RFC 3550's idea, unsmoothed).
	const deltas = times.slice(1).map((value, index) => Math.abs(value - times[index]!));
	return { rttMs: round(mean), jitterMs: round(deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : 0) };
}

/** Push for `ms`; the listener's count is what counts, so buffered-but-unsent bytes are not flattered. */
function upload(socket: Socket, ms: number): Promise<{ bytes: number; seconds: number }> {
	return new Promise((resolve, reject) => {
		const started = performance.now();
		const until = started + ms;
		let reply = '';
		socket.on('data', (chunk: Buffer) => {
			reply += chunk.toString('utf8');
		});
		socket.once('error', reject);
		socket.once('close', () => {
			const bytes = Number(reply.trim());
			if (!Number.isFinite(bytes)) reject(new Error('The listener closed without reporting a count.'));
			else resolve({ bytes, seconds: (performance.now() - started) / 1000 });
		});
		const write = () => {
			while (performance.now() < until) {
				if (socket.destroyed) return;
				if (!socket.write(CHUNK)) {
					socket.once('drain', write);
					return;
				}
			}
			socket.end();
		};
		write();
	});
}

function download(socket: Socket): Promise<{ bytes: number; seconds: number }> {
	return new Promise((resolve, reject) => {
		let bytes = 0;
		let first = 0;
		let last = 0;
		socket.on('data', (chunk: Buffer) => {
			const now = performance.now();
			if (!first) first = now;
			last = now;
			bytes += chunk.length;
		});
		socket.once('error', reject);
		socket.once('close', () => resolve({ bytes, seconds: Math.max(0.001, (last - first) / 1000) }));
	});
}

/** Run the prober's side of one test: latency first on a quiet link, then each direction under load. */
export async function probeLinkTest(task: LinkTestTask): Promise<Omit<LinkTestResult, 'taskId' | 'status'>> {
	const echo = await measureEcho(await dialWhenReady(task, 'echo'), linkTestLimits.echoCount);
	const ms = task.seconds * 1000;
	const streams = Array.from({ length: task.streams });
	const ups = await Promise.all(streams.map(async () => upload(await dial(task, 'up'), ms)));
	const downs = await Promise.all(streams.map(async () => download(await dial(task, `down ${ms}`))));
	const rate = (parts: Array<{ bytes: number; seconds: number }>): number => {
		const seconds = Math.max(...parts.map((part) => part.seconds));
		return Math.round((parts.reduce((sum, part) => sum + part.bytes, 0) * 8) / seconds);
	};
	return {
		rttMs: echo.rttMs,
		jitterMs: echo.jitterMs,
		uploadBps: rate(ups),
		downloadBps: rate(downs),
		bytes: [...ups, ...downs].reduce((sum, part) => sum + part.bytes, 0),
		seconds: round(Math.max(...ups.map((part) => part.seconds)) + Math.max(...downs.map((part) => part.seconds))),
	};
}

// ---------------------------------------------------------------------------------- runner

/**
 * Follows `linkTests` in desired state: starts a listener for each `serve` task, runs each `probe`
 * task once, and keeps results until a heartbeat delivers them. A task is never run twice while it
 * stays in desired state.
 */
export class LinkTestRunner {
	private readonly pending = new Map<string, LinkTestResult>();
	private readonly handled = new Set<string>();
	private readonly listeners = new Map<string, () => void>();
	private samples: LinkSample[] = [];
	private sampling = false;
	private readonly log: Log;

	constructor(options: { log?: Log } = {}) {
		this.log = options.log ?? (() => undefined);
	}

	/** Reconcile to desired state. Returns at once; tests run in the background. */
	runOnce(state: Pick<DesiredState, 'linkTests'>): void {
		const tasks = state.linkTests ?? [];
		const present = new Set(tasks.map((task) => task.id));
		for (const id of [...this.handled]) if (!present.has(id)) this.handled.delete(id);
		for (const [id, close] of this.listeners) {
			if (present.has(id)) continue;
			close();
			this.listeners.delete(id);
		}
		for (const task of tasks) {
			if (this.handled.has(task.id) || task.expiresAt <= Date.now()) continue;
			this.handled.add(task.id);
			if (task.role === 'serve') void this.serve(task);
			else void this.probe(task);
		}
	}

	/** Refresh the passive samples; overlapping calls are dropped. */
	async sample(state: Pick<DesiredState, 'linkProbes'>): Promise<void> {
		const targets = state.linkProbes ?? [];
		if (this.sampling) return;
		if (targets.length === 0) {
			this.samples = [];
			return;
		}
		this.sampling = true;
		try {
			this.samples = await sampleLinks(targets);
		} finally {
			this.sampling = false;
		}
	}

	links(): LinkSample[] {
		return this.samples;
	}

	results(): LinkTestResult[] {
		return [...this.pending.values()];
	}

	/** The control plane accepted these; final results are dropped, `running` is not sent twice. */
	acknowledge(results: readonly LinkTestResult[]): void {
		for (const result of results) {
			const current = this.pending.get(result.taskId);
			if (current && current.status === result.status) this.pending.delete(result.taskId);
		}
	}

	stop(): void {
		for (const close of this.listeners.values()) close();
		this.listeners.clear();
	}

	private async serve(task: LinkTestTask): Promise<void> {
		try {
			const listener = await serveLinkTest(task, this.log);
			this.listeners.set(task.id, listener.close);
		} catch (error) {
			// Only the prober reports; it will say the listener never came up.
			this.log('warn', `Link test listener on ${task.address}:${task.port} failed: ${message(error)}`);
		}
	}

	private async probe(task: LinkTestTask): Promise<void> {
		this.pending.set(task.id, { taskId: task.id, status: 'running' });
		this.log('info', `Link test to ${task.address}:${task.port} (${task.seconds}s per direction, ${task.streams} streams)`);
		try {
			this.pending.set(task.id, { taskId: task.id, status: 'ok', ...(await probeLinkTest(task)) });
		} catch (error) {
			this.pending.set(task.id, { taskId: task.id, status: 'failed', error: message(error).slice(0, 500) });
		}
	}
}

const round = (value: number): number => Math.round(value * 100) / 100;
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
