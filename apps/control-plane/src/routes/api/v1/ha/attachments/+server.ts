import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Every database attachment and how each copy reaches it (HA-PLAN H24): through its stable
 * gateway endpoint, a loopback endpoint to another node, directly on the database's node, or not at
 * all. Ports and nodes only, never a credential. The MCP tool `get_attachment_endpoints` reads it.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return json(core.endpoints.attachmentsView(principal), 200, { 'cache-control': 'no-store' });
	});
