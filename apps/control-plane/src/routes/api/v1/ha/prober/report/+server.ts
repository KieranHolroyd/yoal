import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { handleProberReport } from '#lib/server/prober-report.js';

/**
 * The external prober's only entry (HA-PLAN W15). It is token-authenticated, not session-based:
 * a prober outside the fleet has a registration token and nothing else. The path is on the CSRF
 * cookieless list and exempt from the session/API-key gate; while `EXTERNAL_PROBER` is off the
 * handler answers 404, so no endpoint accepts a report.
 */
export const POST: RequestHandler = (event) => handleProberReport(event.request, core.externalProber);
