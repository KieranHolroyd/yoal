import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Recent catalogue drill runs, newest first: `{ runs: HaDrillRunView[] }` (`?limit=`, 1–200, default 50). */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const limit = Number(event.url.searchParams.get('limit') ?? 50);
		return json({ runs: core.haDrills.list(principal, Number.isFinite(limit) ? limit : 50) }, 200, { 'cache-control': 'no-store' });
	});
