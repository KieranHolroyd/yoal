import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Remove a route; `host` is the full hostname or its single label. */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.kubernetes.removeRoute(principal, event.params.name, event.params.host);
		return { ok: true };
	});
