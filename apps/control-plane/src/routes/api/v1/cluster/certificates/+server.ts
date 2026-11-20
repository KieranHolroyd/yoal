import type { RequestHandler } from './$types';
import { certificateUploadSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Shared certificates (HA-PLAN H20, W7): what the fleet serves, and the bring-your-own upload.
 * Both are platform-admin surfaces; a key is accepted but never returned by any read path.
 */
export const GET: RequestHandler = (event) => route(() => core.certificates.view(requirePrincipal(event)));

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, certificateUploadSchema);
		return core.certificates.uploadByo(principal, input);
	});
