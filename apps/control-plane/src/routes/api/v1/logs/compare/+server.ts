import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { analysisInput } from '../_lib/analysis';

/**
 * Compare (docs/LOGS.md §8.2): the query's patterns in `from..to` against a baseline window,
 * classified new, rising, falling, gone or steady by per-minute rate. POST takes a
 * `logCompareInputSchema` body; GET the read query string plus `baseline=previous|offset:<ms>|
 * deploy:<id>|range:<from>-<to>`. Needs `logs:query`. Answers a `LogCompareResult`; lite mode is a
 * 422 `needs_clickhouse`.
 */
const handler: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		return core.logExplorer.compare(
			principal,
			await analysisInput(event.request, event.url, 'compare')
		);
	});

export const GET = handler;
export const POST = handler;
