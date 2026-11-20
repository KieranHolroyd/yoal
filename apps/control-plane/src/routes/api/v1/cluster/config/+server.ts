import type { RequestHandler } from './$types';
import * as z from 'zod';
import { clusterConfigUpdateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Cluster tunables (D107). Platform admins read; a platform admin's own session changes them. */
export const GET: RequestHandler = (event) =>
	route(() => ({ config: core.cluster.view(requirePrincipal(event)) }));

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		// Validate the shape here (422 on a bad body), but hand core the body as sent: core merges only
		// the keys the caller named, and the parsed value has every section's defaults filled in, which
		// would reset an operator's other settings (`{ overlay: { mtu } }` resetting `overlay.cidr`).
		const input = await readJson(event.request, z.unknown());
		const parsed = clusterConfigUpdateSchema.safeParse(input);
		if (!parsed.success) throw parsed.error;
		return { config: core.cluster.update(principal, input) };
	});
