import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Detach: the Secret is removed from the cluster; the database or broker is untouched. */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.kubernetes.detach(principal, event.params.name, event.params.id);
		return { ok: true };
	});
