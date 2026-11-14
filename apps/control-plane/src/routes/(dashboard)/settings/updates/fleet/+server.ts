import { json } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import { fleetView } from '../fleet.server.js';
import type { RequestHandler } from './$types';

/** Polled by the updates page: node versions and the running rollout, without the page's checks. */
export const GET: RequestHandler = ({ locals }) => {
	if (!locals.principal || !core.ctx.platformIam.can(locals.principal, 'platform:updates'))
		return json({ message: 'Forbidden' }, { status: 403 });
	return json(fleetView(locals.principal), { headers: { 'cache-control': 'no-store' } });
};
