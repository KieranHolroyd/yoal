import type { RequestHandler } from './$types';
import { nodeDrillStartSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Node offline drills (D235, docs/CLUSTERING.md §12.7). `GET` lists the running drill, recent ones
 * and which nodes may be drilled; `POST` starts one, on a random eligible node unless `node` names
 * one. `yoal ha drill node-offline` and Settings → High availability both call these.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const limit = Number(event.url.searchParams.get('limit') ?? 10);
		return json(core.nodeDrills.view(principal, Number.isFinite(limit) ? limit : 10), 200, { 'cache-control': 'no-store' });
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, nodeDrillStartSchema);
		return json(core.nodeDrills.start(principal, input), 201, { 'cache-control': 'no-store' });
	});
