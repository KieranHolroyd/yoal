import type { RequestHandler } from './$types';
import { controlPromoteRequestSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * `yoal ha control promote` (HA-PLAN H21, W9-SPEC §4.3/§4.5, CLUSTERING §6.5).
 *
 * The promotion is a compare-and-swap at the lease ETag this node just read. A stale
 * `expectedEpoch` is a 409, and `canPromote: false` (master key, config digest, migrations or
 * replay) refuses before the CAS. Nothing here can make two nodes primary: the arbiter decides.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, controlPromoteRequestSchema);
		const status = await core.controlPlane.promote(principal, input.expectedEpoch);
		return json({ promoted: true, controlPlane: status }, 200, { 'cache-control': 'no-store' });
	});
