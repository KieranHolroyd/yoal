import { readyzResponse } from '#lib/server/readyz.js';
import { core } from '#lib/server/core.js';
import type { RequestHandler } from './$types';

/**
 * Public readiness (docs/OPS.md §4.2.3). Reports the app/schema/agent versions, data directories,
 * disk headroom and backup target reachability. Never includes secrets or environment values.
 *
 * 200 = serving; 503 = the control plane or schema is not usable, which is what the self-updater
 * uses to decide whether a just-switched release should be rolled back.
 *
 * With `CONTROL_STANDBY` on, the same document carries the HA fields (role, epoch, lease,
 * replication, `canPromote`, CLUSTERING §6.1) and is 503 while `joining`, `fenced` or
 * `unavailable`. A standby answering 200 with `canPromote: false` is honest; the platform route's
 * `/readyz` health check uses exactly that distinction. Flag off: byte-identical report. The
 * running flags are added only on a direct (unproxied) request: see `readyzResponse`.
 */
export const GET: RequestHandler = async ({ request }) =>
	readyzResponse(await core.upgrades.readyz(), core.controlPlane.readyz(), () => core.haDoctor.runningFlags(), request);
