import type { RequestHandler } from './$types';
import * as z from 'zod';
import { haProfiles } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const schema = z.object({ profile: z.enum(haProfiles) }).strict();

/**
 * Change the HA profile (HA-PLAN H27/H28, W12/W14). Turning it on is refused while a platform
 * dependency still lives on one node; the response names the exact fix.
 */
export const PUT: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, schema);
		return core.ha.setProfile(principal, input.profile);
	});
