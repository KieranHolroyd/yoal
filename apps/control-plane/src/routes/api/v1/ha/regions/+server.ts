import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Regions (HA-PLAN H26, W13): each region with its zones and nodes, zones that name two regions,
 * the open region promotion and recent ones. `platform:ha`; read-only.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return json(core.regions.view(principal), 200, { 'cache-control': 'no-store' });
	});
