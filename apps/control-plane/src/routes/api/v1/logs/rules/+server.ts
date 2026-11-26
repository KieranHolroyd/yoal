import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { readBody } from '../_lib/request';
import { projectParam } from '../_lib/project';

/**
 * Ingest and index rules (docs/LOGS.md §10.3–§10.4). GET lists the org's rules as `{ rules }`
 * (`?project=<slug>` for one project's own); POST creates one from a `LogRuleInput` (`name`,
 * `kind` exclude | sample | index_only | redact, `query`, `pattern`, `sampleRate`, `project`) and
 * answers `{ rule }` with 201. Writes need `logs:configure`.
 */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = projectParam(principal, event.url.searchParams.get('project'));
		return { rules: core.logRules.list(principal, project ? { projectId: project.id } : {}) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		return json({ rule: core.logRules.create(principal, await readBody(event.request)) }, 201);
	});
