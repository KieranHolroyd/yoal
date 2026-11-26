import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { readBody } from '../../_lib/request';

/** One log rule, as `{ rule }` (docs/LOGS.md §10.3). PATCH takes a `LogRuleUpdate`; writes need `logs:configure`. */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { rule: core.logRules.get(principal, event.params.id) };
	});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		return { rule: core.logRules.update(principal, event.params.id, await readBody(event.request)) };
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.logRules.delete(principal, event.params.id);
		return { ok: true };
	});
