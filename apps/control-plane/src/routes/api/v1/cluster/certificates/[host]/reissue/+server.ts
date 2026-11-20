import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Force one host's certificate to be reissued on the next sweep (HA-PLAN H20). Needed after an
 * ingress leaves the fleet: the removed node still holds the old key (CLUSTERING §7.3).
 */
export const POST: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return core.certificates.requestReissue(principal, decodeURIComponent(event.params.host));
	});
