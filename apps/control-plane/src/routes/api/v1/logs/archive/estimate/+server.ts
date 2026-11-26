import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { logInputFromBody, readBody } from '../../_lib/request';

/**
 * What searching the archived part of a range would cost (docs/LOGS.md §10.1): bytes, files and
 * seconds, before the Explorer reruns the search with `archive: true`. Body: `scopes`, `from`, `to`
 * (or `range`). Answers a `LogArchiveEstimate`.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		return core.logArchive.estimate(principal, logInputFromBody(await readBody(event.request), 'read', Date.now()));
	});
