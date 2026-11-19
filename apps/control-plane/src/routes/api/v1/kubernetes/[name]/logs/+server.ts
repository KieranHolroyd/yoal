import type { RequestHandler } from './$types';
import { route } from '#lib/server/api.js';
import { kubernetesLogPage, parseLogCursor } from '#lib/server/kubernetes.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Cluster machine and system logs, paged like any managed-service stream. `after` is the polling cursor. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const params = event.url.searchParams;
		const after = parseLogCursor(params.get('after'));
		const limitRaw = Number(params.get('limit') ?? 200);
		return kubernetesLogPage(principal, event.params.name, {
			...(after !== undefined ? { after } : {}),
			limit: Number.isFinite(limitRaw) ? limitRaw : 200
		});
	});
