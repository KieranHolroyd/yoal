import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Nodes that can run clusters, with the isolation tiers each offers (the create form's choices).
 * A static segment beside `[name]`, like `blueprints/plan`; SvelteKit matches it first.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { nodes: core.kubernetes.capableNodes(principal) };
	});
