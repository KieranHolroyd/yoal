import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { readBody } from '../_lib/request';

/**
 * Saved log queries (docs/LOGS.md §7.2). GET lists your personal queries and the org's shared
 * ones as `{ queries }`; POST creates one from a `LogSavedQueryInput` body (`name`, `q`, `scopes`,
 * `range`, `columns`, `visibility`) and answers `{ query }` with 201.
 */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { queries: core.logExplorer.saved.list(principal) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		return json({ query: core.logExplorer.saved.create(principal, await readBody(event.request)) }, 201);
	});
