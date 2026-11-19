import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Orgs granted the `trusted` isolation tier (K4), where a cluster admin can become root on the
 * org's dedicated node. Platform admins only; core refuses anyone else.
 */

const grantSchema = z.object({ orgId: z.string().min(1).max(100) });

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { orgs: core.kubernetes.trustedOrgs(principal) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const { orgId } = await readJson(event.request, grantSchema);
		core.kubernetes.grantTrusted(principal, orgId);
		return json({ ok: true, orgId }, 201);
	});
