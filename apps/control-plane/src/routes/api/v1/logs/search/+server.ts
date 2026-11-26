import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { logInput } from '../_lib/request';

/**
 * Log rows (docs/LOGS.md §6–§7): `q`, `scope` (repeated `kind:id`; none = everything readable),
 * `from`/`to` (epoch ms or ISO) or `range`, `limit`, `cursor`, `order`. GET reads the query
 * string, POST the JSON body. Answers a `LogSearchResult`.
 */
const handler: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		return core.logExplorer.search(principal, await logInput(event.request, event.url, 'search'));
	});

export const GET = handler;
export const POST = handler;
