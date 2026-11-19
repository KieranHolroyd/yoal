import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Datastore snapshots of a cluster (docs/KUBERNETES.md K14): list, or take one now. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { backups: core.kubernetes.backups(principal, event.params.name) };
	});

export const POST: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return json({ backup: core.kubernetes.backupNow(principal, event.params.name) }, 202);
	});
