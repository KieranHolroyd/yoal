import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * A kubeconfig whose user runs `yoal k8s token` (K8). It holds no credential. `?format=yaml`
 * returns the file itself, so `curl … > ~/.kube/yoal-<name>.yaml` works.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const kubeconfig = core.kubernetes.kubeconfig(principal, event.params.name);
		if (event.url.searchParams.get('format') === 'yaml')
			return new Response(kubeconfig.kubeconfig, {
				status: 200,
				headers: {
					'content-type': 'application/yaml; charset=utf-8',
					'content-disposition': `attachment; filename="yoal-${kubeconfig.cluster}.yaml"`
				}
			});
		return json({ kubeconfig });
	});
