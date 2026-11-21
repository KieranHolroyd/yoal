import type { RequestHandler } from './$types';
import { databaseSwitchoverRequestSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Planned database switchover (HA-PLAN W10): checkpoint, stop writes, wait for LSN equality,
 * promote, re-point. The drain is carried out on the old primary's node through desired state; a
 * non-zero gap is refused and writes are resumed. `GET` lists recent switchovers.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { switchovers: core.databaseMembers.switchovers(principal, event.params.name) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, databaseSwitchoverRequestSchema);
		const header = event.request.headers.get('if-match')?.replace(/^W\//, '').replace(/"/g, '').trim();
		const ifMatch = header ? Number(header) : null;
		if (header && !Number.isInteger(ifMatch))
			return json({ error: 'If-Match must be the primary generation (an integer).' }, 400);
		return json({ switchover: await core.databaseMembers.switchover(principal, event.params.name, input, { ifMatch }) }, 202);
	});
