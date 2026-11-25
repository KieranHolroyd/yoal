import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * What this install can answer and which scopes the caller may read (docs/LOGS.md §0, §7.2):
 * `engine` (`sqlite` = lite mode), ClickHouse health and index lag, features, and the scope
 * picker list. Answers `LogCapabilities`.
 */
const handler: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return core.logExplorer.capabilities(principal);
	});

export const GET = handler;
export const POST = handler;
