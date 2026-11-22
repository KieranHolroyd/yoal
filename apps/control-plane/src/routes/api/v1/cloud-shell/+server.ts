import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** `GET /api/v1/cloud-shell`: the caller's own cloud shell and its limits (D236). */
export const GET: RequestHandler = (event) =>
	route(() => core.cloudShells.state(requirePrincipal(event)));
