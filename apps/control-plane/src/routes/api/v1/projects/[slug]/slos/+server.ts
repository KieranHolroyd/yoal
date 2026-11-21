import type { RequestHandler } from './$types';
import { sloObjectInputSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** W15: one project's SLO objects (HA-PLAN §4 W15). Empty while `SLO_OBJECTS` is off. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { slos: core.slos.list(principal, event.params.slug) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, sloObjectInputSchema);
		return json(await core.slos.upsert(principal, event.params.slug, input), 201);
	});
