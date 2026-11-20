import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Revoke the live certificate for one host (HA-PLAN H20). The key stops being distributed. */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return core.certificates.remove(principal, decodeURIComponent(event.params.host));
	});
