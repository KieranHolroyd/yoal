import { json, route } from '#lib/server/api.js';
import { core } from '#lib/server/core.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { rolloutInput } from '../_rollout.server.js';
import type { RequestHandler } from './$types';

/**
 * The live plan preview in the Update fleet dialog: the waves a rollout with these options would
 * run now (CLUSTERING §3.11). Read-only; starting goes through the page's `?/startRollout` action.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const params = event.url.searchParams;
		const plan = core.nodeRollouts.plan(
			principal,
			rolloutInput((key) => params.get(key), params.getAll('nodeId'))
		);
		return json(plan, 200, { 'cache-control': 'no-store' });
	});
