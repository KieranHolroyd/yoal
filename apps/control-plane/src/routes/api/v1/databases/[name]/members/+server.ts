import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Members of a database and the last role/generation each reported (W9-SPEC §5.6). Consumers poll
 * the members themselves; this is the control-plane view for operators and the dashboard.
 */
export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const database = core.databases.get(principal, event.params.name);
		const members = core.databaseMembers.members(database.id);
		const roles = [];
		for (const member of members) {
			const report = await core.databaseMembers.memberRole(database.id, member.nodeId);
			roles.push({
				nodeId: member.nodeId,
				role: report?.role ?? 'unknown',
				generation: report?.generation ?? null,
				epoch: report?.epoch ?? null,
				fenced: report?.fenced ?? false,
				readOnly: report?.readOnly ?? false,
				leaseGeneration: report?.leaseGeneration ?? null,
				observedAt: report?.observedAt ?? null,
			});
		}
		return { generation: database.primaryGeneration, members, roles };
	});
