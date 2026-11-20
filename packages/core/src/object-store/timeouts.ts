/**
 * Request timeouts for every remote object-store call (HA-PLAN W3; Wave 0 found that the S3 client
 * had none, so one stalled TCP connection could hang a lease renewal or a backup forever).
 *
 * Two shapes:
 * - a buffered call (metadata, small reads, conditional writes, listing) has one deadline that
 *   covers the request and reading its body (`withDeadline`);
 * - a streamed body has no total deadline, because a 50 GB backup legitimately takes hours. It has
 *   a stall timeout instead: the call is aborted when the *store* makes no progress for the
 *   timeout (`stallGuardedUpload`, `stallGuardedDownload`). Time spent waiting on our own producer or
 *   consumer never counts, so a slow `pg_dump` or a slow reader is not mistaken for a dead store.
 */

/** Default for every backend; a lease renewal must fail well inside its 30 s TTL budget. */
export const DEFAULT_OBJECT_STORE_TIMEOUT_MS = 15_000;

export class ObjectStoreTimeoutError extends Error {
	constructor(
		readonly operation: string,
		readonly timeoutMs: number,
	) {
		super(`${operation} timed out after ${timeoutMs} ms`);
		this.name = 'ObjectStoreTimeoutError';
	}
}

export function isObjectStoreTimeout(error: unknown): error is ObjectStoreTimeoutError {
	return error instanceof ObjectStoreTimeoutError;
}

/** Validate a configured timeout; anything unusable falls back to the default. */
export function objectStoreTimeout(value: number | undefined): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : DEFAULT_OBJECT_STORE_TIMEOUT_MS;
}

/**
 * Run `fn` with an abort signal that fires after `timeoutMs`. The returned promise rejects with
 * `ObjectStoreTimeoutError` at the deadline even when `fn` ignores the signal, so a caller is never
 * held past it.
 */
export async function withDeadline<T>(operation: string, timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const timeout = new ObjectStoreTimeoutError(operation, timeoutMs);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			controller.abort(timeout);
			reject(timeout);
		}, timeoutMs);
	});
	try {
		return await Promise.race([fn(controller.signal), deadline]);
	} catch (error) {
		if (controller.signal.aborted) throw timeout;
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

/** A restartable one-shot timer that aborts `controller` with a timeout error. */
class StallTimer {
	#timer: ReturnType<typeof setTimeout> | undefined;
	constructor(
		private readonly controller: AbortController,
		private readonly error: ObjectStoreTimeoutError,
	) {}
	start(): void {
		this.stop();
		this.#timer = setTimeout(() => this.controller.abort(this.error), this.error.timeoutMs);
	}
	stop(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}

/**
 * A streamed upload. `body` is re-wrapped so the timer runs only while the store owes us a read:
 * from handing it a chunk until it asks for the next one, and from the end of the body until the
 * response headers arrive. `send` receives the wrapped body and the abort signal.
 */
export async function stallGuardedUpload(
	operation: string,
	timeoutMs: number,
	body: ReadableStream<Uint8Array>,
	send: (body: ReadableStream<Uint8Array>, signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
	const controller = new AbortController();
	const error = new ObjectStoreTimeoutError(operation, timeoutMs);
	const timer = new StallTimer(controller, error);
	const reader = body.getReader();
	const guarded = new ReadableStream<Uint8Array>({
		async pull(stream) {
			timer.stop();
			const { done, value } = await reader.read();
			if (done) {
				stream.close();
				// The store now owes us its response.
				timer.start();
				return;
			}
			stream.enqueue(value);
			timer.start();
		},
		async cancel(reason) {
			timer.stop();
			await reader.cancel(reason).catch(() => undefined);
		},
	});
	// Until the store first pulls, it owes us that pull.
	timer.start();
	try {
		const response = await send(guarded, controller.signal);
		timer.stop();
		return response;
	} catch (cause) {
		timer.stop();
		if (controller.signal.aborted) throw error;
		throw cause;
	}
}

/**
 * A streamed download: `deadline` covers the response headers, then the body is wrapped so a read
 * that the store does not answer within `timeoutMs` aborts the request.
 */
export async function stallGuardedDownload(
	operation: string,
	timeoutMs: number,
	send: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
	const controller = new AbortController();
	const error = new ObjectStoreTimeoutError(operation, timeoutMs);
	const timer = new StallTimer(controller, error);
	timer.start();
	let response: Response;
	try {
		response = await send(controller.signal);
	} catch (cause) {
		timer.stop();
		if (controller.signal.aborted) throw error;
		throw cause;
	}
	timer.stop();
	if (!response.body) return response;
	const reader = response.body.getReader();
	const guarded = new ReadableStream<Uint8Array>({
		async pull(stream) {
			timer.start();
			try {
				const { done, value } = await reader.read();
				timer.stop();
				if (done) stream.close();
				else stream.enqueue(value);
			} catch (cause) {
				timer.stop();
				stream.error(controller.signal.aborted ? error : cause);
			}
		},
		async cancel(reason) {
			timer.stop();
			await reader.cancel(reason).catch(() => undefined);
		},
	});
	return new Response(guarded, { status: response.status, statusText: response.statusText, headers: response.headers });
}
