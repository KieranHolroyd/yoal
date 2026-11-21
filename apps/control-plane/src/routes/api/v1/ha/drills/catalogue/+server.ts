import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** The drill catalogue (`HaDrillCatalogueView`): every scenario, where it runs and what it measures (HA-PLAN H27, §7.2). */
export const GET: RequestHandler = (event) =>
	route(() => json(core.haDrills.catalogue(requirePrincipal(event)), 200, { 'cache-control': 'no-store' }));
