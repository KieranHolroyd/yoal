import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Revoke an org's `trusted` tier grant; refused while it still has trusted clusters. */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.kubernetes.revokeTrusted(principal, event.params.orgId);
		return { ok: true, orgId: event.params.orgId };
	});
