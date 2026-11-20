import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Members of a database and the last role/generation each reported (W9-SPEC §5.6). Consumers poll
 * the members themselves; this is the control-plane view for operators and the dashboard.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const database = core.databases.get(principal, event.params.name);
		return {
			generation: database.primaryGeneration,
			members: core.databaseMembers.members(database.id),
			roles: core.databaseMembers.members(database.id).map((member) => ({
				nodeId: member.nodeId,
				role: core.databaseMembers.memberRole(database.id, member.nodeId)?.role ?? 'streaming',
				generation: core.databaseMembers.memberRole(database.id, member.nodeId)?.generation ?? database.primaryGeneration,
			})),
		};
	});
