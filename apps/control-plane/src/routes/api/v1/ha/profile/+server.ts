import type { RequestHandler } from './$types';
import * as z from 'zod';
import { haProfiles } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const schema = z.object({ profile: z.enum(haProfiles) }).strict();

/** The HA profile, its W12 blockers and the platform dependencies it asserts (HA-PLAN H27/H28, W12). */
export const GET: RequestHandler = (event) => route(() => core.ha.view(requirePrincipal(event)));

/**
 * Change the HA profile (HA-PLAN H27/H28, W12/W14). Turning it on is refused while a platform
 * dependency still lives on one node; the response names the exact fix. `POST /api/v1/ha/init`
 * is the guided path: it also sets the profile's cluster settings and records them for the way back.
 */
export const PUT: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, schema);
		return core.ha.setProfile(principal, input.profile);
	});
