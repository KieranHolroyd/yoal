import * as z from 'zod';
import { hasPermission } from '@yoal/contracts';
import { json, readJson, route } from '#lib/server/api.js';
import { runConfirmed } from '#lib/server/assistant/orchestrator.js';
import type { RequestHandler } from './$types';

const bodySchema = z.object({ token: z.string().min(1).max(20_000) });

/** How long an action may run before the answer switches to a kept-alive stream. */
const QUICK_MS = 4_000;
/** Below Bun's 10 s idle timeout (`CONNECTION_IDLE_TIMEOUT`), which drops a silent request. */
const KEEPALIVE_MS = 4_000;

type Outcome =
	| { ok: true; value: Awaited<ReturnType<typeof runConfirmed>> }
	| { ok: false; message: string };

function failed(message: string): Response {
	return json({ error: 'confirmation_failed', message }, 400);
}

/**
 * Execute one destructive assistant action the user approved in the chat. The token is signed and
 * bound to this user and org (docs/ASSISTANT.md); the normal service-layer permissions still apply.
 *
 * Most actions answer within a few seconds and get a plain JSON answer. A slower one (a cloud
 * shell command, D237, or a deploy) is answered `200` with spaces every few seconds and the JSON
 * at the end: whitespace before a JSON value is insignificant, so the client parses it unchanged,
 * and a failure is the same `{ error, message }` body with the status left at 200.
 */
export const POST: RequestHandler = async ({ locals, request }) =>
	route(async () => {
		const principal = locals.principal;
		if (!principal) return json({ error: 'unauthorized' }, 401);
		if (!hasPermission(principal, 'project:read'))
			return json(
				{ error: 'forbidden', message: 'You need project read access to use the assistant.' },
				403
			);
		const { token } = await readJson(request, bodySchema);
		const work: Promise<Outcome> = runConfirmed(principal, token).then(
			(value) => ({ ok: true, value }),
			(error: unknown) => ({
				ok: false,
				message: error instanceof Error ? error.message : 'Could not confirm.'
			})
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const quick = await Promise.race([
			work,
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), QUICK_MS);
			})
		]);
		clearTimeout(timer);
		if (quick) return quick.ok ? json(quick.value) : failed(quick.message);

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				const keepalive = setInterval(() => {
					try {
						controller.enqueue(encoder.encode(' '));
					} catch {
						clearInterval(keepalive);
					}
				}, KEEPALIVE_MS);
				const outcome = await work;
				clearInterval(keepalive);
				try {
					controller.enqueue(
						encoder.encode(
							JSON.stringify(
								outcome.ok
									? outcome.value
									: { error: 'confirmation_failed', message: outcome.message }
							)
						)
					);
					controller.close();
				} catch {
					// The browser went away; the action itself already ran to completion.
				}
			}
		});
		return new Response(stream, {
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'cache-control': 'no-store',
				'x-accel-buffering': 'no'
			}
		});
	});
