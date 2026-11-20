import type { RequestHandler } from './$types';
import { durabilitySettingsUpdateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Database durability and the synchronous set (HA-PLAN H23, W10). `GET` shows the requested policy,
 * the lease's `durability_effective` and the open transition; `PUT` begins the three-step change
 * (`sync` is refused unless its prerequisites hold). The close happens when the primary's node
 * reports the barrier, never here.
 */
export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		return { durability: await core.databaseMembers.status(principal, event.params.name) };
	});

export const PUT: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, durabilitySettingsUpdateSchema);
		return json({ durability: await core.databaseMembers.setDurability(principal, event.params.name, input) });
	});
