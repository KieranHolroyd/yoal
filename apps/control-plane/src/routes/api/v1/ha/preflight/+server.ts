import type { RequestHandler } from './$types';
import { haInitAnswersSchema, haProfiles, type HaProfile } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { CoreError } from '@yoal/core';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * `yoal ha preflight` (HA-PLAN H27, W14): every check (`HaPreflightReport`) against `?profile=`
 * (default: the install's own), assuming the `ha init` answers in `?steering=` and
 * `?certificates=`. Runs the arbiter's conditional-write probe first (cached for a minute). Reads
 * only. The W12 platform view this route used to return is at `GET /api/v1/ha/profile`.
 */
export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const params = event.url.searchParams;
		const profile = params.get('profile');
		if (profile !== null && !haProfiles.includes(profile as HaProfile))
			throw new CoreError('validation', `Unknown HA profile "${profile}".`, 422);
		const answers = haInitAnswersSchema.safeParse({
			...(params.get('steering') ? { steering: params.get('steering') } : {}),
			...(params.get('certificates') ? { certificates: params.get('certificates') } : {}),
		});
		if (!answers.success) throw new CoreError('validation', 'Unknown steering driver or certificate source.', 422);
		core.haDoctor.preflight(principal, (profile as HaProfile | null) ?? undefined); // permission first, before the probe writes
		await core.haDoctor.probeArbiter();
		return json(core.haDoctor.preflight(principal, (profile as HaProfile | null) ?? undefined, { answers: answers.data }), 200, {
			'cache-control': 'no-store',
		});
	});
