import type { RequestHandler } from './$types';
import { nodeLogBatchSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';

function nodeToken(request: Request): string {
	const header = request.headers.get('authorization') ?? '';
	if (!header.startsWith('Bearer ')) throw new Response('Unauthorized', { status: 401 });
	return header.slice(7).trim();
}

/**
 * Structured record ingest for node-shipped sources (docs/LOGS.md §5: Yoal's own units, edge
 * access lines, OTLP). Agents POST a `NodeLogBatch` with their node token. Tenancy comes from the
 * target, resolved server-side: a workload id to its project (only from a node that runs it), a
 * site host to the project serving it, a platform unit to this node's `platform` scope.
 *
 * Answers `{ ok: true, stored }`, plus `disabled: true` when the source is switched off
 * (`PLATFORM_LOGS`) so the agent backs off. 401 bad token, 403 another node's workload,
 * 400 a platform unit outside the allow-list, 422 a malformed batch.
 */
const handler: RequestHandler = async ({ request }) =>
	route(async () => {
		if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
		const node = core.nodes.authenticate(nodeToken(request));
		const batch = await readJson(request, nodeLogBatchSchema);
		const result = core.logs.appendRecords(node.id, batch);
		return { ok: true, ...result };
	});

export const POST = handler;
