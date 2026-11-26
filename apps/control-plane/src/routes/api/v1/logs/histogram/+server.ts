import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { logInput } from '../_lib/request';

/**
 * Counts per time bucket by severity, with deploy and alert markers (docs/LOGS.md §7.2). Same
 * inputs as search plus `buckets` (10–500, default 60). Answers a `LogHistogramResult`.
 */
const handler: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		return core.logExplorer.histogram(principal, await logInput(event.request, event.url, 'histogram'));
	});

export const GET = handler;
export const POST = handler;
