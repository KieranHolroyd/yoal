import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** One catalogue drill run (`HaDrillRunView`); a handed-off one reads its D235 or W11 record live. */
export const GET: RequestHandler = (event) =>
	route(() => json(core.haDrills.get(requirePrincipal(event), event.params.id), 200, { 'cache-control': 'no-store' }));
