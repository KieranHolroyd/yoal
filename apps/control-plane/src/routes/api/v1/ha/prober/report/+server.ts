import type { RequestHandler } from './$types';
import { externalProberReportSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';

/**
 * The external prober's only entry (HA-PLAN W15). It is token-authenticated, not session-based:
 * a prober outside the fleet has a registration token and nothing else. While `EXTERNAL_PROBER`
 * is off the route is absent, so no endpoint accepts a report.
 */
export const POST: RequestHandler = (event) => {
	if (!core.externalProber.enabled()) return Promise.resolve(json({ error: 'not_found' }, 404));
	return route(async () => {
		const authorization = event.request.headers.get('authorization');
		const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() || null : null;
		const report = await readJson(event.request, externalProberReportSchema);
		return core.externalProber.report(token, report);
	});
};
