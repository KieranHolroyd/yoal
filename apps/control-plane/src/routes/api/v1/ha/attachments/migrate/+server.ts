import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const schema = z
	.object({
		/** False (the default) is a dry run: nothing changes. */
		apply: z.boolean().optional(),
		/** Slugs or ids; all apps when absent. */
		projects: z.array(z.string().trim().min(1).max(100)).max(500).optional(),
	})
	.strict();

/**
 * `yoal ha migrate attachments` (HA-PLAN §9). With ENDPOINTS_GATEWAY on, an app moves to its stable
 * endpoint on its own next deploy; this moves the rest at once. `GET` (or `POST` without `apply`)
 * lists what would move; `POST { apply: true }` moves them, which restarts each app once.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const projects = event.url.searchParams.getAll('project').filter(Boolean);
		return json(core.endpoints.migrationPlan(principal, projects.length ? { projects } : {}), 200, { 'cache-control': 'no-store' });
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, schema);
		return json(core.endpoints.migrateAttachments(principal, input), 200, { 'cache-control': 'no-store' });
	});
