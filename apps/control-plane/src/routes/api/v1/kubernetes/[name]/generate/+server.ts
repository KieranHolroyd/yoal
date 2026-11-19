import type { RequestHandler } from './$types';
import { kubernetesGenerateSchema } from '@yoal/contracts';
import { errorResponse, readJson, route } from '#lib/server/api.js';
import { prepareKubernetesGeneration, type GenerateProgress } from '#lib/server/kubernetes-ai.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * A Kubernetes config from a plain-language request (docs/KUBERNETES.md §18): generated, linted and
 * repaired for this cluster, optionally dry-run on its API server as the caller. Nothing is applied.
 *
 * Generation takes tens of seconds, longer than the server's idle timeout, so the response streams:
 * `Accept: text/event-stream` gets `progress` events then one `result` (or `error`) event; any
 * other client gets JSON preceded by keep-alive whitespace (still valid JSON), with errors as
 * `{ error, message }`. Fast failures (no provider, no permission, bad YAML) keep their status.
 */
const KEEPALIVE_MS = 5_000;

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, kubernetesGenerateSchema);
		const run = await prepareKubernetesGeneration(principal, event.params.name, {
			prompt: input.prompt,
			namespace: input.namespace,
			...(input.yaml ? { yaml: input.yaml } : {}),
			dryRun: input.dryRun,
			signal: event.request.signal
		});
		const sse = (event.request.headers.get('accept') ?? '').includes('text/event-stream');
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				const send = (text: string) => {
					try {
						controller.enqueue(encoder.encode(text));
					} catch {
						// The client went away.
					}
				};
				const frame = (name: string, data: unknown) => send(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
				const timer = setInterval(() => send(sse ? ': keep-alive\n\n' : ' '), KEEPALIVE_MS);
				try {
					const result = await run((progress: GenerateProgress) => {
						if (sse) frame('progress', progress);
					});
					if (sse) frame('result', result);
					else send(JSON.stringify(result));
				} catch (error) {
					const response = errorResponse(error);
					const body = (await response.json().catch(() => ({ error: 'internal' }))) as Record<string, unknown>;
					if (sse) frame('error', { ...body, status: response.status });
					else send(JSON.stringify({ ...body, status: response.status }));
				} finally {
					clearInterval(timer);
					try {
						controller.close();
					} catch {
						// Already closed.
					}
				}
			}
		});
		return new Response(stream, {
			headers: {
				'content-type': sse ? 'text/event-stream' : 'application/json',
				'cache-control': 'no-store',
				'x-accel-buffering': 'no'
			}
		});
	});
