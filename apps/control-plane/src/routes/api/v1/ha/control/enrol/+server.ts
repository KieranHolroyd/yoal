import type { RequestHandler } from './$types';
import { controlEnrolRequestSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Enrol a warm control standby (HA-PLAN H21, W9-SPEC §4.5).
 *
 * A platform-admin session that has proved a strong second factor sends the standby's CSR. The
 * primary signs it with the install CA and returns a sealed bundle (master key + allowlisted
 * config) plus a one-time activation code. The code and the bundle never enter desired state,
 * the audit log or a server log. The operator runs the matching command on the standby, which
 * writes its enrolment record and verifies the fingerprint.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, controlEnrolRequestSchema);
		const result = await core.controlPlane.enrol(principal, input);
		return json(result, 200, { 'cache-control': 'no-store' });
	});
