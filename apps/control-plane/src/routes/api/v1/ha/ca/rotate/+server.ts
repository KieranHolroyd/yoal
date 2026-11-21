import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Rotate the install CA (docs/OPS.md, "CA rotation"). The old CA stays trusted while every node
 * renews its leaf under the new one, so no endpoint loses mTLS. Platform admin only.
 */
export const POST: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return json(core.nodeCa.rotateAs(principal), 200, { 'cache-control': 'no-store' });
	});
