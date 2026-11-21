import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const schema = z
	.object({
		identityNode: z.string().trim().min(1).max(100).nullable().optional(),
		mailNode: z.string().trim().min(1).max(100).nullable().optional(),
	})
	.strict();

/**
 * Move identity or mail to another node, or clear the pin (HA-PLAN H28/W12). Both are settings,
 * not hostnames; desired state follows on the next bump.
 */
export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, schema);
		return core.ha.move(principal, input);
	});
