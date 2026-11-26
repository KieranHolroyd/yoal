import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { readBody } from '../../_lib/request';

/**
 * Replay the last 15 minutes of the hot tail through a draft rule (docs/LOGS.md §10.3): the share it
 * would drop or keep out of the index, and the top patterns it matches. Body: a
 * `LogRulePreviewInput`; answers a `LogRulePreviewResult`. Reads only scopes the caller can read.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		return core.logRules.preview(principal, await readBody(event.request));
	});
