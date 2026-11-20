import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** The HA profile, its blockers, and the platform dependencies it asserts (HA-PLAN H27/H28, W12). */
export const GET: RequestHandler = (event) =>
	route(() => core.ha.view(requirePrincipal(event)));
