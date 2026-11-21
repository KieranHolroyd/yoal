import type { RequestHandler } from './$types';
import { haDrillRunRequestSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * `yoal ha drill <scenario> --resource <id>` (HA-PLAN H27, §10): one catalogue drill on one named
 * resource. `201` with the `HaDrillRunView`; `409` for a lab-only scenario, a missing flag or a
 * resource below its HA level; `422` without the typed confirmation.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, haDrillRunRequestSchema);
		return json(await core.haDrills.run(principal, input), 201, { 'cache-control': 'no-store' });
	});
