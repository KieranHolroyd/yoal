import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Restart the cluster's machines; the node re-applies them on its next converge. */
export const POST: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return json({ cluster: core.kubernetes.restart(principal, event.params.name) }, 202);
	});
