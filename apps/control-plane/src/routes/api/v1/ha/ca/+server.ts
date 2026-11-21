import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** The install CA (HA-PLAN H24 "Trust"): the CAs nodes trust and the leaves they hold. Public fields only. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return json(core.nodeCa.statusFor(principal), 200, { 'cache-control': 'no-store' });
	});
