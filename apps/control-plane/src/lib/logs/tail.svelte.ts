import type { LogEngine, LogRecord, LogScopeRef, LogTailEvents } from '@yoal/contracts';
import { streamUrl } from './api.js';
import { tailEndIsRoutine } from './tail-end.js';

/**
 * The live tail over `GET /api/v1/logs/stream` (docs/LOGS.md §4.4, LP4). The server sends
 * `ready`, `records`, `sampled` and `end` events with an `id:` per batch, so an `EventSource`
 * that drops reconnects by itself with `Last-Event-ID` and misses nothing. If the browser gives
 * up (the connection closed for good), this reconnects with the last cursor, backing off. An `end`
 * with code `max_lifetime` (the server closes every tail after 6 h so access is re-checked) is
 * routine: it reconnects at once from the cursor, without showing an end.
 */

export type TailStatus = 'idle' | 'connecting' | 'live' | 'ended' | 'error';

export interface TailHandlers {
	onRecords: (records: LogRecord[]) => void;
	onEnd?: (reason: string) => void;
}

function parse<K extends keyof LogTailEvents>(event: Event): LogTailEvents[K] | null {
	try {
		return JSON.parse((event as MessageEvent<string>).data) as LogTailEvents[K];
	} catch {
		return null;
	}
}

export class LogTail {
	status = $state<TailStatus>('idle');
	engine = $state<LogEngine | null>(null);
	/** Lines the server skipped to keep this subscriber live, since the tail started. */
	sampled = $state(0);
	endReason = $state<string | null>(null);
	error = $state<string | null>(null);

	#source: EventSource | null = null;
	#cursor: string | null = null;
	#input: { scopes: readonly LogScopeRef[]; q: string } | null = null;
	#retry: ReturnType<typeof setTimeout> | null = null;
	#attempts = 0;

	readonly #handlers: TailHandlers;

	constructor(handlers: TailHandlers) {
		this.#handlers = handlers;
	}

	get cursor(): string | null {
		return this.#cursor;
	}

	/** Start (or restart) tailing; `cursor` resumes after a page the caller already has. */
	start(input: { scopes: readonly LogScopeRef[]; q: string; cursor?: string | null }): void {
		this.stop();
		this.#input = { scopes: input.scopes, q: input.q };
		this.#cursor = input.cursor ?? null;
		this.sampled = 0;
		this.endReason = null;
		this.error = null;
		this.#attempts = 0;
		this.#open();
	}

	stop(): void {
		if (this.#retry) clearTimeout(this.#retry);
		this.#retry = null;
		this.#source?.close();
		this.#source = null;
		if (this.status !== 'ended') this.status = 'idle';
	}

	#open(): void {
		if (!this.#input || typeof EventSource === 'undefined') return;
		this.status = 'connecting';
		const source = new EventSource(streamUrl({ ...this.#input, cursor: this.#cursor }));
		this.#source = source;
		const mine = () => this.#source === source;

		source.addEventListener('ready', (event) => {
			if (!mine()) return;
			const data = parse<'ready'>(event);
			if (data?.cursor) this.#cursor = data.cursor;
			if (data?.engine) this.engine = data.engine;
			this.status = 'live';
			this.error = null;
			this.#attempts = 0;
		});
		source.addEventListener('records', (event) => {
			if (!mine()) return;
			const data = parse<'records'>(event);
			if (!data) return;
			if (data.cursor) this.#cursor = data.cursor;
			this.status = 'live';
			if (Array.isArray(data.records) && data.records.length > 0)
				this.#handlers.onRecords(data.records);
		});
		source.addEventListener('sampled', (event) => {
			if (!mine()) return;
			const data = parse<'sampled'>(event);
			if (data && Number.isFinite(data.dropped)) this.sampled += data.dropped;
		});
		source.addEventListener('end', (event) => {
			if (!mine()) return;
			const data = parse<'end'>(event);
			if (tailEndIsRoutine(data)) {
				source.close();
				this.#source = null;
				this.status = 'connecting';
				this.#open();
				return;
			}
			this.endReason = data?.reason ?? 'ended';
			this.status = 'ended';
			source.close();
			this.#source = null;
			this.#handlers.onEnd?.(this.endReason);
		});
		source.onopen = () => {
			if (!mine()) return;
			this.error = null;
		};
		source.onerror = () => {
			if (!mine()) return;
			if (source.readyState === EventSource.CLOSED) {
				// The browser gave up (a 4xx/5xx, or the network went away): retry ourselves.
				this.#source = null;
				this.status = 'error';
				this.error = 'Lost the live tail; retrying…';
				const delay = Math.min(30_000, 1_000 * 2 ** this.#attempts++);
				this.#retry = setTimeout(() => this.#open(), delay);
			} else {
				// EventSource is reconnecting by itself, with Last-Event-ID.
				this.status = 'connecting';
			}
		};
	}
}
