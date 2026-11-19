import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Permanently delete a cluster that is already in the trash; its node removes the data. */
export const POST: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.kubernetes.purgeNow(principal, event.params.name);
		return json({ ok: true }, 202);
	});
