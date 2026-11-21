import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * The failover controller, the control-plane standby view while `CONTROL_STANDBY` is on, and W15's
 * effective-versus-declared HA levels (`ha.effective_below_target`), and the install CA while the
 * endpoint gateway uses it.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const status = core.failover.status(principal);
		return {
			...status,
			// W15 describes placement that already exists, so it is always present in the status; a
			// platform operator sees the same numbers the metric exports.
			haTargets: core.slos.targets(principal),
			...(core.controlPlane.enabled() ? { controlPlane: core.controlPlane.status() } : {}),
			// The install CA, only while ENDPOINTS_GATEWAY uses it: off, the document is unchanged.
			...(core.nodeCa.inUse() ? { nodeCa: core.nodeCa.status() } : {}),
		};
	});
