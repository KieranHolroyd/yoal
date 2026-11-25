import type { RequestHandler } from './$types';
import type { LogTailEvents } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { logInputFromQuery } from '../_lib/request';

/** A comment line keeps proxies from closing an idle stream (docs/LOGS.md §4.4). */
const HEARTBEAT_MS = 15_000;
/** Lines that arrive together go out as one event. */
const COALESCE_MS = 200;

/**
 * Live tail over SSE (docs/LOGS.md §4.4, LP4). Query string: `q`, `scope` (repeated `kind:id`;
 * none = everything readable), `backfill` (newest N matching lines to send first, 0–1,000) and
 * `cursor` (or the `Last-Event-ID` header an EventSource sends on reconnect).
 *
 * Events follow `LogTailEvents`: `ready` `{ cursor, engine }`, then `records`
 * `{ records, cursor }` (each with `id: <cursor>`), `sampled` `{ dropped }` when the subscriber
 * fell behind or a reconnect missed more than 2,000 lines, and `end` `{ reason }`. Nothing polls
 * SQLite: appends publish to an in-process bus and each stream gets only what its query matches.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const params = event.url.searchParams;
		const input = logInputFromQuery(params, 'read', Date.now());
		const backfill = Number(params.get('backfill') ?? 0);
		const session = core.logExplorer.openTail(principal, {
			q: input.q as string,
			scopes: input.scopes as never,
			lastEventId: event.request.headers.get('last-event-id') ?? params.get('cursor'),
			backfill: Number.isFinite(backfill) ? backfill : 0,
		});
		const signal = event.request.signal;
		const encoder = new TextEncoder();

		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				let closed = false;
				let lastWrite = Date.now();
				const write = (text: string): void => {
					if (closed) return;
					try {
						controller.enqueue(encoder.encode(text));
						lastWrite = Date.now();
					} catch {
						closed = true;
					}
				};
				const send = <K extends keyof LogTailEvents>(name: K, data: LogTailEvents[K], id?: string): void =>
					write(`${id ? `id: ${id}\n` : ''}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

				try {
					send('ready', { cursor: session.cursor, engine: session.engine }, session.cursor);
					if (session.initial.dropped > 0) send('sampled', { dropped: session.initial.dropped });
					if (session.initial.records.length > 0)
						send('records', { records: session.initial.records, cursor: session.initial.cursor }, session.initial.cursor);

					while (!signal.aborted && !closed) {
						const wait = Math.max(0, HEARTBEAT_MS - (Date.now() - lastWrite));
						let batch = await session.next(wait, signal);
						if (batch.records.length > 0 || batch.dropped > 0) {
							await sleep(COALESCE_MS, signal);
							const more = await session.next(0, signal);
							batch = {
								records: [...batch.records, ...more.records],
								dropped: batch.dropped + more.dropped,
								cursor: more.cursor,
							};
						}
						if (batch.dropped > 0) send('sampled', { dropped: batch.dropped });
						if (batch.records.length > 0) send('records', { records: batch.records, cursor: batch.cursor }, batch.cursor);
						if (Date.now() - lastWrite >= HEARTBEAT_MS) write(`: ping ${Date.now()}\n\n`);
					}
				} catch (error) {
					send('end', { reason: error instanceof Error ? error.message : 'The log stream failed.' });
				} finally {
					closed = true;
					session.close();
					try {
						controller.close();
					} catch {
						// Already cancelled by the client.
					}
				}
			},
			cancel() {
				session.close();
			},
		});

		return new Response(stream, {
			headers: {
				'content-type': 'text/event-stream; charset=utf-8',
				'cache-control': 'no-cache, no-transform',
				connection: 'keep-alive',
				'x-accel-buffering': 'no',
			},
		});
	});

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = (): void => {
			clearTimeout(timer);
			signal.removeEventListener('abort', finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener('abort', finish, { once: true });
	});
}
