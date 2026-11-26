import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { logInput } from '../_lib/request';

/**
 * Pipe-stage queries (`| stats`, `| patterns`, `| dedup`, `| fields`; docs/LOGS.md §6.2). Needs
 * `logs:query`. Same inputs as search without paging. Answers a `LogTableResult`; lite mode
 * answers `| stats count() by bin(…)` and returns 422 `needs_clickhouse` for the rest.
 */
const handler: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		return core.logExplorer.table(principal, await logInput(event.request, event.url, 'read'));
	});

export const GET = handler;
export const POST = handler;
