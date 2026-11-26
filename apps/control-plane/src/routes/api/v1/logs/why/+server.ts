import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { analysisInput } from '../_lib/analysis';

/**
 * Why? (docs/LOGS.md §8.3): which field values are over-represented in a brushed `selection`
 * against the rest of `from..to`, ranked by lift. POST takes a `logWhyInputSchema` body; GET the
 * read query string plus `selection=<from>-<to>` and optional repeated `field`. Needs
 * `logs:query`. Answers a `LogWhyResult`; lite mode is a 422 `needs_clickhouse`.
 */
const handler: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		return core.logExplorer.why(principal, await analysisInput(event.request, event.url, 'why'));
	});

export const GET = handler;
export const POST = handler;
