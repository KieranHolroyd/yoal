import type { RequestHandler } from './$types';
import { haInitAnswersSchema, haInitRequestSchema, haProfiles, type HaProfile } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { CoreError } from '@yoal/core';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * `yoal ha init --profile single|ha|ha-dr` (HA-PLAN H27, §8, W14).
 *
 * `GET ?profile=&steering=&certificates=&standbyRegion=` returns the plan (`HaInitPlanView`): the
 * flags and settings the profile sets, what differs from the running install, the preflight and
 * every reason `apply` would refuse now. `POST { profile, answers, apply }` plans the same without
 * `apply`; with `apply: true` it makes the one cluster-config change (`HaInitApplyView`), audited
 * `ha.init`, or answers 409 with the blockers. Flags are never written: the plan prints the
 * `yoal.env` lines.
 */
export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const params = event.url.searchParams;
		const profile = params.get('profile') ?? 'ha';
		if (!haProfiles.includes(profile as HaProfile)) throw new CoreError('validation', `Unknown HA profile "${profile}".`, 422);
		const answers = haInitAnswersSchema.safeParse(
			Object.fromEntries(['steering', 'certificates', 'standbyRegion'].flatMap((key) => (params.get(key) ? [[key, params.get(key)]] : []))),
		);
		if (!answers.success) throw new CoreError('validation', 'Invalid ha init answers.', 422);
		const request = { profile: profile as HaProfile, answers: answers.data };
		core.haInit.plan(principal, request); // permission first, before the probe writes
		await core.haDoctor.probeArbiter();
		return json(core.haInit.plan(principal, request), 200, { 'cache-control': 'no-store' });
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, haInitRequestSchema);
		if (input.apply) return json(await core.haInit.apply(principal, input), 200, { 'cache-control': 'no-store' });
		core.haInit.plan(principal, input);
		await core.haDoctor.probeArbiter();
		return json(core.haInit.plan(principal, input), 200, { 'cache-control': 'no-store' });
	});
