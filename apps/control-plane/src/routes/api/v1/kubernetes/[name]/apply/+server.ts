import type { RequestHandler } from './$types';
import { kubernetesApplySchema } from '@yoal/contracts';
import { CoreError, parseManifestYaml } from '@yoal/core';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Server-side apply of YAML to a cluster as the caller (docs/KUBERNETES.md §18). `dryRun` validates
 * on the API server without changing anything. The cluster's RBAC decides, with the caller's token.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, kubernetesApplySchema);
		let manifests;
		try {
			manifests = parseManifestYaml(input.yaml);
		} catch (error) {
			throw new CoreError('validation', `The YAML does not parse: ${error instanceof Error ? error.message : String(error)}`, 400);
		}
		return core.kubernetes.applyManifests(principal, event.params.name, {
			manifests,
			dryRun: input.dryRun,
			namespace: input.namespace
		});
	});
