import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { readBody } from '../_lib/request';
import { projectParam } from '../_lib/project';

/**
 * Log retention, quotas, archive and edge sampling (docs/LOGS.md §10, LP9). `?project=<slug>` reads
 * or writes that project's row, `?scope=platform` the platform's (platform admins), otherwise the
 * caller's org. GET answers a `LogSettingsView`; PUT/PATCH take a `LogSettingsPatch` (`null`
 * clears a key so it inherits) and answer the new view.
 */

function target(event: Parameters<RequestHandler>[0]) {
	const principal = requirePrincipal(event);
	const project = projectParam(principal, event.url.searchParams.get('project'));
	const level = event.url.searchParams.get('scope') === 'platform' ? 'platform' : project ? 'project' : 'org';
	return { principal, level, project } as const;
}

export const GET: RequestHandler = (event) =>
	route(() => {
		const { principal, level, project } = target(event);
		return core.logSettings.view(principal, { level, project });
	});

const write: RequestHandler = (event) =>
	route(async () => {
		const { principal, level, project } = target(event);
		core.logSettings.update(principal, { level, project }, await readBody(event.request));
		return core.logSettings.view(principal, { level, project });
	});

export const PUT = write;
export const PATCH = write;
