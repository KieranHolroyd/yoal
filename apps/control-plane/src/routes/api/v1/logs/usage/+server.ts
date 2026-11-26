import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { projectParam } from '../_lib/project';

/**
 * Log ingest per project (and service scope) per UTC day, for showback (docs/QUOTAS.md, LOGS.md
 * §10.2): admitted lines and bytes, and lines dropped. `?days=7` (1–90), `?project=<slug>`.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = projectParam(principal, event.url.searchParams.get('project'));
		const days = Number(event.url.searchParams.get('days') ?? 7);
		return core.logQuotas.usage(principal, { days: Number.isFinite(days) ? days : 7, projectId: project?.id ?? null });
	});
