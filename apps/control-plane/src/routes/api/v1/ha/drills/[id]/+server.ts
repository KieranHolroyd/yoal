import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** One node offline drill with its measured times and failover events (D235). */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return json(core.nodeDrills.get(principal, event.params.id), 200, { 'cache-control': 'no-store' });
	});
