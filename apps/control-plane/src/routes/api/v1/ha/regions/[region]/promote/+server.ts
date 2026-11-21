import type { RequestHandler } from './$types';
import { regionPromoteRequestSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * `yoal ha region promote <region>` (HA-PLAN H26, W13). Run it on the control plane in the
 * surviving region. Without `confirm` it returns the plan (nothing is stored); with the region name
 * typed back, the plan hash, `acceptDataLoss: true` and a reason it promotes, in order, the control
 * plane, each database with a replica there, then steering, and returns the promotion record. A
 * platform admin signed in to the dashboard or CLI only; there is no MCP tool for it.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, regionPromoteRequestSchema);
		const result = await core.regions.promote(principal, event.params.region, input);
		return json(result, 'id' in result ? 201 : 200, { 'cache-control': 'no-store' });
	});
