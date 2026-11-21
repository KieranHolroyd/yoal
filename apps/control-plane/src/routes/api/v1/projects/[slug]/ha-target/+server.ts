import type { RequestHandler } from './$types';
import { projectHaTargetInputSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** The declared HA target and the level placement achieves for one project (HA-PLAN W15). */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return core.slos.haTarget(principal, event.params.slug);
	});

export const PUT: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, projectHaTargetInputSchema);
		return core.slos.setHaTarget(principal, event.params.slug, input);
	});
