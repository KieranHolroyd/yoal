/**
 * A TCP proxy in front of a store that can hold one request or one response for a while.
 * Byte-level, so SigV4 (which signs the Host the client used) passes through untouched.
 *
 * - `delayNextResponse(ms)`: the next bytes the store sends back are held; the write has applied
 *   but the client sees nothing (and times out if its deadline is shorter).
 * - `delayNextRequest(ms)`: the next bytes a client sends are held; the store sees the write late,
 *   possibly after the client gave up. Held bytes are still delivered after the client leaves.
 */
import type { Socket, TCPSocketListener } from 'bun';

type Direction = 'request' | 'response';
interface Pipe {
	client: Socket<Pipe>;
	upstream: Socket<unknown> | null;
	toUpstream: Promise<void>;
	toClient: Promise<void>;
	pendingUpstream: Uint8Array[];
	clientClosed: boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DelayProxy {
	#listener: TCPSocketListener<Pipe> | null = null;
	#armed: Record<Direction, number> = { request: 0, response: 0 };
	readonly delayed: { direction: Direction; ms: number; at: number }[] = [];

	constructor(
		readonly upstreamHost: string,
		readonly upstreamPort: number,
	) {}

	get port(): number {
		if (!this.#listener) throw new Error('proxy not started');
		return this.#listener.port;
	}

	delayNextResponse(ms: number): void {
		this.#armed.response = ms;
	}

	delayNextRequest(ms: number): void {
		this.#armed.request = ms;
	}

	#take(direction: Direction): number {
		const ms = this.#armed[direction];
		if (ms > 0) {
			this.#armed[direction] = 0;
			this.delayed.push({ direction, ms, at: Date.now() });
		}
		return ms;
	}

	start(): this {
		const proxy = this;
		this.#listener = Bun.listen<Pipe>({
			hostname: '127.0.0.1',
			port: 0,
			socket: {
				open(client) {
					const pipe: Pipe = {
						client,
						upstream: null,
						toUpstream: Promise.resolve(),
						toClient: Promise.resolve(),
						pendingUpstream: [],
						clientClosed: false,
					};
					client.data = pipe;
					Bun.connect({
						hostname: proxy.upstreamHost,
						port: proxy.upstreamPort,
						socket: {
							open(upstream) {
								pipe.upstream = upstream;
								for (const chunk of pipe.pendingUpstream.splice(0)) upstream.write(chunk);
							},
							data(_upstream, chunk) {
								const bytes = new Uint8Array(chunk);
								const ms = proxy.#take('response');
								pipe.toClient = pipe.toClient.then(async () => {
									if (ms) await sleep(ms);
									if (!pipe.clientClosed) pipe.client.write(bytes);
								});
							},
							close() {
								void pipe.toClient.then(() => pipe.client.end());
							},
							error() {
								pipe.client.end();
							},
						},
					}).catch(() => client.end());
				},
				data(client, chunk) {
					const pipe = client.data;
					const bytes = new Uint8Array(chunk);
					const ms = proxy.#take('request');
					pipe.toUpstream = pipe.toUpstream.then(async () => {
						if (ms) await sleep(ms);
						if (pipe.upstream) pipe.upstream.write(bytes);
						else pipe.pendingUpstream.push(bytes);
					});
				},
				close(client) {
					const pipe = client.data;
					pipe.clientClosed = true;
					// Deliver anything still held, then give the store time to answer before hanging up.
					void pipe.toUpstream.then(async () => {
						await sleep(3_000);
						pipe.upstream?.end();
					});
				},
				error(client) {
					client.data.clientClosed = true;
				},
			},
		});
		return this;
	}

	stop(): void {
		this.#listener?.stop(true);
		this.#listener = null;
	}
}

/** A fetch that gives up after `ms`, like a lease client with a deadline. */
export function withTimeout(fetchImpl: typeof fetch, ms: number): typeof fetch {
	return ((input: string | URL | Request, init?: RequestInit) =>
		fetchImpl(input, { ...init, signal: AbortSignal.timeout(ms) })) as typeof fetch;
}

/**
 * The proxy's two cases at the fetch layer, for TLS endpoints a byte proxy cannot sit in front
 * of: a held request is really sent late (after the caller gave up), and a held response is
 * really applied but its answer is discarded once the caller's deadline passes.
 */
export function delayingFetch(fetchImpl: typeof fetch, timeoutMs: number) {
	let armed: { direction: 'request' | 'response'; ms: number } | null = null;
	const timeout = () =>
		new Promise<never>((_, reject) => setTimeout(() => reject(new DOMException('timed out', 'TimeoutError')), timeoutMs));
	const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
		const hold = armed;
		armed = null;
		if (!hold) return Promise.race([fetchImpl(input, init), timeout()]);
		const sent =
			hold.direction === 'request'
				? sleep(hold.ms).then(() => fetchImpl(input, init))
				: fetchImpl(input, init).then(async (response) => {
						await sleep(hold.ms);
						return response;
					});
		sent.catch(() => undefined);
		return Promise.race([sent, timeout()]);
	}) as typeof fetch;
	return {
		fetch: wrapped,
		arm: (direction: 'request' | 'response', ms: number) => {
			armed = { direction, ms };
		},
	};
}
