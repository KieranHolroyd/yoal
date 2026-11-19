import type { RequestHandler } from './$types';
import { kubernetesRouteCreateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Public hostnames routed to the cluster's bundled ingress (K11). */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { routes: core.kubernetes.get(principal, event.params.name).routes };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, kubernetesRouteCreateSchema);
		return json({ route: core.kubernetes.addRoute(principal, event.params.name, input) }, 201);
	});
