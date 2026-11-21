import type { RequestHandler } from './$types';
import { haDrillAllRequestSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * `yoal ha drill --all` (HA-PLAN H27, §8 step 5): every fleet, non-destructive, untyped scenario
 * against the resources in `targets`, one at a time (`HaDrillAllView`), and each skipped scenario
 * with its reason. `confirm: true` adds the scenarios that need it; a typed one never runs here.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, haDrillAllRequestSchema);
		return json(await core.haDrills.runAll(principal, input), 200, { 'cache-control': 'no-store' });
	});
