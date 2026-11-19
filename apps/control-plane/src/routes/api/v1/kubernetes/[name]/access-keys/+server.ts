import type { RequestHandler } from './$types';
import { kubernetesAccessKeyCreateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Cluster access keys (K19): static kubeconfigs for tools that cannot run an exec plugin. The
 * kubeconfig is returned once, on create, and never stored or cached. MCP has no equivalent (D58).
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { keys: core.kubernetes.accessKeys(principal, event.params.name) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, kubernetesAccessKeyCreateSchema);
		const key = await core.kubernetes.createAccessKey(principal, event.params.name, input);
		return json({ key }, 201, { 'cache-control': 'no-store' });
	});
