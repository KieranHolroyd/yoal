import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * The optional Kubernetes node component on every node (K2): installed minors, working tiers,
 * pending install/remove requests and the last result. Platform admins only; core refuses others.
 * A static segment beside `[name]`, like `nodes` and `trusted-orgs`.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { components: core.kubernetes.components(principal) };
	});
