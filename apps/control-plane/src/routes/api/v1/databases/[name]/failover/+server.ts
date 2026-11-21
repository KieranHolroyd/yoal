import type { RequestHandler } from './$types';
import { databaseFailoverArmRequestSchema, databaseFailoverDrillRequestSchema } from '@yoal/contracts';
import { z } from 'zod';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Per-database automatic failover (HA-PLAN W11, docs/build-plan/W11-SPEC.md §3/§12).
 *
 * `GET` is the honest policy view: the configured mode, the persisted evidence and every current
 * refusal. `POST` is one audited operator action; the server owns every gate, so the CLI, REST, MCP
 * and dashboard cannot disagree about whether `auto` may be armed.
 */
const actionSchema = z.discriminatedUnion('action', [
	z.object({ action: z.literal('arm'), arm: databaseFailoverArmRequestSchema }),
	z.object({ action: z.literal('disarm') }),
	z.object({ action: z.literal('drill'), drill: databaseFailoverDrillRequestSchema }),
]);

export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		return { failover: core.failoverPolicies.view(principal, event.params.name) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, actionSchema);
		if (input.action === 'arm')
			return json({ failover: await core.failoverPolicies.arm(principal, event.params.name, input.arm) });
		if (input.action === 'disarm')
			return json({ failover: await core.failoverPolicies.disarm(principal, event.params.name) });
		return json({ drill: await core.failoverPolicies.drill(principal, event.params.name, input.drill) });
	});
