import type { RequestHandler } from './$types';
import { externalProberRegistrationInputSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Registered external probers (HA-PLAN W15). Empty and disabled while `EXTERNAL_PROBER` is off. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return core.externalProber.list(principal);
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, externalProberRegistrationInputSchema);
		return json(core.externalProber.register(principal, input), 201);
	});
