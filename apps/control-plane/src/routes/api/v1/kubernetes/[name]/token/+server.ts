import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * A 15-minute cluster token for the caller (K8), carrying the in-cluster group their role grants.
 * `yoal k8s token` (the kubectl exec plugin) calls this; API keys can too, so CI needs no stored
 * kubeconfig. Never cached; MCP has no equivalent (D58).
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const token = await core.kubernetes.token(principal, event.params.name);
		return json({ token }, 200, { 'cache-control': 'no-store' });
	});
