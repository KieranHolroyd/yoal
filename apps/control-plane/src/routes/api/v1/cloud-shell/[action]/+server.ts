import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * The caller's own cloud shell (D236). `start` and `reset` need a signed-in person (the shell runs
 * as them); every action needs `cloudShell:use`.
 *
 *   POST start   start it (picks a node the first time) → { shell }
 *   POST stop    stop it; the disk stays → { shell }
 *   POST reset   stop it and delete its disk → { reset }
 */
export const POST: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		switch (event.params.action) {
			case 'start':
				return { shell: core.cloudShells.start(principal) };
			case 'stop':
				return { shell: core.cloudShells.stop(principal) };
			case 'reset':
				return core.cloudShells.reset(principal);
			default:
				return json({ error: 'not_found', message: 'Use start, stop or reset.' }, 404);
		}
	});
