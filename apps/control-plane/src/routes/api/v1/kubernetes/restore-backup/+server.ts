import type { RequestHandler } from './$types';
import { kubernetesRestoreSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** A new cluster from a snapshot (docs/KUBERNETES.md K14). Restores never overwrite a live cluster. */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, kubernetesRestoreSchema);
		return json({ cluster: core.kubernetes.restoreBackup(principal, input) }, 201);
	});
