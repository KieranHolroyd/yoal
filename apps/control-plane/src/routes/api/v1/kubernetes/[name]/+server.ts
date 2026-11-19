import type { RequestHandler } from './$types';
import { kubernetesUpdateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * One managed Kubernetes cluster. PATCH upgrades (one minor at a time), scales agents and changes
 * API access. DELETE is the soft delete (D59); `DELETE ?purge=1` on a cluster that is already in the
 * trash asks its node to remove the data now (also `POST ./purge`).
 */

const truthy = (value: string | null) => value === '1' || value === 'true';

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const includeDeleted = truthy(event.url.searchParams.get('includeDeleted'));
		return { cluster: core.kubernetes.get(principal, event.params.name, { includeDeleted }) };
	});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, kubernetesUpdateSchema);
		return { cluster: core.kubernetes.update(principal, event.params.name, input) };
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		if (truthy(event.url.searchParams.get('purge'))) {
			core.kubernetes.purgeNow(principal, event.params.name);
			return { ok: true };
		}
		return { cluster: core.kubernetes.delete(principal, event.params.name) };
	});
