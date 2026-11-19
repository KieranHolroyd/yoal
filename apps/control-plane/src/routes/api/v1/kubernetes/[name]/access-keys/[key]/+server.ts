import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Revoke an access key by name: its ServiceAccount and binding leave the cluster at once. */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.kubernetes.revokeAccessKey(principal, event.params.name, event.params.key);
		return { ok: true };
	});
