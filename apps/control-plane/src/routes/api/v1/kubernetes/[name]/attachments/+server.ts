import type { RequestHandler } from './$types';
import { kubernetesAttachSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Attach a database or broker (K12): Yoal writes its connection Secret into a namespace. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { attachments: core.kubernetes.get(principal, event.params.name).attachments };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, kubernetesAttachSchema);
		return json({ attachment: core.kubernetes.attach(principal, event.params.name, input) }, 201);
	});
