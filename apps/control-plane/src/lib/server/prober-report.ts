import {
	externalProberReportSchema,
	type ExternalProberAck,
	type ExternalProberReport,
} from '@yoal/contracts';

/**
 * The HTTP edge of the external prober sink (HA-PLAN W15).
 *
 * It is deliberately separate from the SvelteKit route so a test can drive a request through the
 * same gates without booting the app: the CSRF allowlist and the `isAuthenticatedApi` exception
 * are in `csrf.ts`/`hooks.server.ts`, and the token is checked **before** the body is read. That
 * ordering matters: an unauthenticated caller gets a 401 without making the control plane buffer
 * a payload, and a large body is bounded even when it lies about `Content-Length`.
 */
export interface ProberReportSink {
	enabled(): boolean;
	/** Throws when the token is absent, unknown or revoked. */
	authenticate(token: string | null): void;
	report(token: string | null, report: ExternalProberReport): Promise<ExternalProberAck>;
}

/** The contract's largest valid report is a few MB of target/error strings; 8 MiB leaves room. */
export const PROBER_REPORT_MAX_BYTES = 8 * 1024 * 1024;

export async function handleProberReport(request: Request, sink: ProberReportSink): Promise<Response> {
	if (!sink.enabled()) return json({ error: 'not_found' }, 404);
	const token = bearer(request);
	// Authenticate first: a bad/absent token never reaches body parsing or the size limit.
	try {
		sink.authenticate(token);
	} catch (error) {
		return failure(error);
	}
	const declared = Number(request.headers.get('content-length') ?? Number.NaN);
	if (Number.isFinite(declared) && declared > PROBER_REPORT_MAX_BYTES) return tooLarge();
	const body = await readBounded(request, PROBER_REPORT_MAX_BYTES);
	if (body === null) return tooLarge();
	let raw: unknown;
	try {
		raw = JSON.parse(body);
	} catch {
		return json({ error: 'invalid_json', message: 'Request body must be valid JSON' }, 400);
	}
	const parsed = externalProberReportSchema.safeParse(raw);
	if (!parsed.success)
		return json(
			{ error: 'validation', issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
			422,
		);
	try {
		return json(await sink.report(token, parsed.data));
	} catch (error) {
		return failure(error);
	}
}

function bearer(request: Request): string | null {
	const authorization = request.headers.get('authorization');
	if (!authorization?.startsWith('Bearer ')) return null;
	return authorization.slice(7).trim() || null;
}

/** Read at most `limit` bytes; null means the body crossed the limit (the stream is cancelled). */
async function readBounded(request: Request, limit: number): Promise<string | null> {
	const stream = request.body;
	if (!stream) return '';
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

function tooLarge(): Response {
	return json({ error: 'payload_too_large', message: `A prober report is limited to ${PROBER_REPORT_MAX_BYTES} bytes.` }, 413);
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
}

/** Map a core-style error by shape, so this module does not import the whole core graph. */
function failure(error: unknown): Response {
	if (error && typeof error === 'object') {
		const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
		if (typeof candidate.status === 'number')
			return json(
				{
					error: typeof candidate.code === 'string' ? candidate.code : 'error',
					message: typeof candidate.message === 'string' ? candidate.message : 'Request failed',
				},
				candidate.status,
			);
	}
	console.error('[prober] report failed:', error);
	return json({ error: 'internal', message: 'Internal server error' }, 500);
}
