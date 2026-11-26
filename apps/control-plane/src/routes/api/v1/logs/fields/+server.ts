import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { logInput } from '../_lib/request';

/**
 * Facet summaries (docs/LOGS.md §7.2): top values per field. Same inputs as search plus `field`
 * (repeated) and `topValues` (1–50). Lite mode summarises the built-ins only. Answers a
 * `LogFieldsResult`.
 */
const handler: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		return core.logExplorer.fields(principal, await logInput(event.request, event.url, 'fields'));
	});

export const GET = handler;
export const POST = handler;
