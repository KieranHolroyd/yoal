import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Pod logs the cluster's shipper sent (docs/KUBERNETES.md K23). `after` is the polling cursor. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const params = event.url.searchParams;
		const after = params.get('after');
		const limit = Number(params.get('limit') ?? 200);
		return {
			lines: core.kubernetes.podLogs(principal, event.params.name, {
				...(after && /^\d+$/.test(after) ? { after: Number(after) } : {}),
				limit: Number.isFinite(limit) ? limit : 200,
				...(params.get('namespace') ? { namespace: params.get('namespace')! } : {}),
				...(params.get('pod') ? { pod: params.get('pod')! } : {}),
				...(params.get('q') ? { search: params.get('q')! } : {}),
			}),
		};
	});
