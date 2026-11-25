import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { logInput } from '../_lib/request';

/**
 * Lines around one record in its stream, like `grep -C` (docs/LOGS.md §7.2): `id`, `before`,
 * `after` (0–500, default 50). A record outside what the caller may read answers `anchor: null`.
 * Answers a `LogContextResult`.
 */
const handler: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		return core.logExplorer.context(principal, await logInput(event.request, event.url, 'context'));
	});

export const GET = handler;
export const POST = handler;
