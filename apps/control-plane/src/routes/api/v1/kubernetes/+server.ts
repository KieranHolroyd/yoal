import type { RequestHandler } from './$types';
import { kubernetesCreateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Managed Kubernetes clusters (docs/KUBERNETES.md §11). Every check lives in `core.kubernetes`. */

const truthy = (value: string | null) => value === '1' || value === 'true';

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const includeDeleted = truthy(event.url.searchParams.get('includeDeleted'));
		return { clusters: core.kubernetes.list(principal, { includeDeleted }) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, kubernetesCreateSchema);
		return json({ cluster: core.kubernetes.create(principal, input) }, 201);
	});
