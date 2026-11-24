import type { RequestHandler } from './$types';
import { databasePublicAccessInputSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Public database access from outside Yoal (docs/DATABASES.md §19, D241). GET needs
 * `database:read`; PUT enables or replaces the whole configuration and needs `database:expose`
 * (step-up, never MCP); DELETE turns it off with `database:update`. The view carries no secret.
 */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { publicAccess: core.databasePublicAccess.get(principal, event.params.name) };
	});

export const PUT: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, databasePublicAccessInputSchema);
		return { publicAccess: core.databasePublicAccess.enable(principal, event.params.name, input) };
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { publicAccess: core.databasePublicAccess.disable(principal, event.params.name) };
	});
