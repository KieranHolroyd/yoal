import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * `yoal doctor` (HA-PLAN H27, W14): the running install against its own profile, plus each
 * node's heartbeat, applied Caddy config, desired-state drift, agent version and data disk, in the
 * same `HaCheck` shape as the preflight. Reads only.
 */
export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		core.haDoctor.doctor(principal); // permission first, before the probe writes
		await core.haDoctor.probeArbiter();
		return json(core.haDoctor.doctor(principal), 200, { 'cache-control': 'no-store' });
	});
