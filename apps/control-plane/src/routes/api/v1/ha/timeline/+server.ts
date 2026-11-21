import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Failovers, switchovers and drills in one chronological view (HA-PLAN W15). */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const limit = Number(event.url.searchParams.get('limit') ?? 100);
		return core.slos.timeline(principal, { limit: Number.isFinite(limit) ? limit : 100 });
	});
