import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** The failover controller, plus the control-plane standby view while `CONTROL_STANDBY` is on. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const status = core.failover.status(principal);
		if (!core.controlPlane.enabled()) return status;
		return { ...status, controlPlane: core.controlPlane.status() };
	});
