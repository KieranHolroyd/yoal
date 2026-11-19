import type { Env } from './env.ts';

/**
 * Send one event to Yoal app errors (docs/APP-ERRORS.md) without a Sentry SDK: the plain
 * `store` endpoint, authenticated by the DSN's public key. Yoal injects `SENTRY_DSN` into a
 * function automatically once app errors are enabled for the project.
 */
export async function reportError(
	env: Env,
	error: unknown,
	tags: Record<string, string> = {},
): Promise<{ status: number; eventId: string } | null> {
	if (!env.SENTRY_DSN) return null;
	const dsn = new URL(env.SENTRY_DSN);
	const projectId = dsn.pathname.split('/').filter(Boolean).pop();
	if (!projectId || !dsn.username) throw new Error('SENTRY_DSN is not a DSN this reporter understands.');
	// `https://<key>@<host>/ingest/<id>` → `https://<host>/ingest/api/<id>/store/`
	const base = dsn.pathname.replace(/\/[^/]+\/?$/, '');
	const endpoint = `${dsn.protocol}//${dsn.host}${base}/api/${projectId}/store/`;
	const eventId = crypto.randomUUID().replaceAll('-', '');
	const err = error instanceof Error ? error : new Error(String(error));
	const response = await fetch(endpoint, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-sentry-auth': `Sentry sentry_version=7, sentry_client=function-suite/1.0, sentry_key=${dsn.username}`,
		},
		body: JSON.stringify({
			event_id: eventId,
			timestamp: Date.now() / 1000,
			platform: 'javascript',
			level: 'error',
			environment: 'production',
			release: 'function-suite@1',
			tags: { suite: 'function-suite', ...tags },
			exception: {
				values: [{ type: err.name, value: err.message, stacktrace: { frames: frames(err.stack) } }],
			},
		}),
		signal: AbortSignal.timeout(5000),
	});
	await response.body?.cancel();
	return { status: response.status, eventId };
}

function frames(stack: string | undefined): Array<{ function: string; filename: string }> {
	return (stack ?? '')
		.split('\n')
		.slice(1, 20)
		.map((line) => {
			const match = /at (?:(.+?) \()?(.+?)\)?$/.exec(line.trim());
			return { function: match?.[1] ?? '?', filename: match?.[2] ?? line.trim() };
		})
		.reverse();
}
