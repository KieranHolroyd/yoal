import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Mesh mode's node pairs (CLUSTERING §4.7, D240): which pairs run direct, which are still being
 * probed and which fell back to a hub. The mode itself is `overlay.mode` in `/cluster/config`.
 */
export const GET: RequestHandler = (event) => route(() => ({ mesh: core.overlayMesh.view(requirePrincipal(event)) }));
