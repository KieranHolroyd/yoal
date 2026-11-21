import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Evaluate one SLO (`?id=`) or every SLO in the project against telemetry over its window. */
export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const id = event.url.searchParams.get('id') ?? undefined;
		return { evaluations: await core.slos.evaluate(principal, event.params.slug, id) };
	});
