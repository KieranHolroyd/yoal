import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** End a running drill early; the node comes back on its next poll, within about 5 s (D235). */
export const POST: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return json(core.nodeDrills.cancel(principal, event.params.id), 200, { 'cache-control': 'no-store' });
	});
