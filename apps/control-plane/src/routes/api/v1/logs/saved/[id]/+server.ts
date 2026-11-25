import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { readBody } from '../../_lib/request';

/**
 * One saved log query, as `{ query }`. Your own: `logQuery:update` / `logQuery:delete`; someone
 * else's org query: `logQuery:manage`. Another person's personal query, or another org's, is 404.
 */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { query: core.logExplorer.saved.get(principal, event.params.id) };
	});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		return { query: core.logExplorer.saved.update(principal, event.params.id, await readBody(event.request)) };
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.logExplorer.saved.delete(principal, event.params.id);
		return { ok: true };
	});
