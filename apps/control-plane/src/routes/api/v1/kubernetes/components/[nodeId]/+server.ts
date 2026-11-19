import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Ask a node to install or remove the Kubernetes component. The node's helper runs it in the
 * background (installs take minutes); poll `GET ../` for `pending` and `lastResult`. Removal is
 * refused while machines run there. Core only accepts a platform admin's dashboard session.
 */

const requestSchema = z.object({
	action: z.enum(['install', 'remove']),
	purge: z.boolean().default(false)
});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const { action, purge } = await readJson(event.request, requestSchema);
		const component = core.kubernetes.requestComponent(
			principal,
			event.params.nodeId,
			action,
			purge
		);
		return json({ component }, 202);
	});
