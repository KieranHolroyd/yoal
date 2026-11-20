import { error, fail } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import { failStatus, formString, toFormFailure } from '../../_lib/errors.js';
import { policyState, savePolicies } from '../_lib/policies.server.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal;
	if (!principal || !core.ctx.platformIam.allows(principal, 'platform:ha'))
		error(403, 'High availability is for platform operators and admins.');
	return {
		...policyState(),
		status: core.ingress.status(principal),
		failover: core.failover.status(principal),
		/** The profile and platform-dependency preflight (HA-PLAN H27/H28, W12). */
		ha: core.ha.view(principal),
		/** The policy editor writes platform settings, which is admin-only. */
		canEditPolicies: core.ctx.platformIam.canAdminister(principal)
	};
};

function failure(cause: unknown) {
	return fail(failStatus(cause), toFormFailure(cause));
}

/** The ingress driver and hold-downs are platform policies, edited here. */
export const actions: Actions = {
	savePolicies,
	saveProfile: async ({ request, locals }) => {
		const principal = locals.principal!;
		const profile = formString(await request.formData(), 'profile');
		try {
			core.ha.setProfile(principal, profile as 'single' | 'ha' | 'ha-dr');
			return { success: `The ${profile} profile is saved.` };
		} catch (cause) {
			return failure(cause);
		}
	},
	moveDependency: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			if (data.has('identityNode')) {
				const node = formString(data, 'identityNode');
				await core.ha.move(principal, { identityNode: node === '' ? null : node });
				return { success: node ? 'Identity moved.' : 'Identity placement returned to automatic.' };
			}
			if (data.has('mailNode')) {
				const node = formString(data, 'mailNode');
				await core.ha.move(principal, { mailNode: node === '' ? null : node });
				return { success: node ? 'Mail node moved.' : 'Mail node cleared.' };
			}
			return fail(400, { message: 'Choose identity or mail.' });
		} catch (cause) {
			return failure(cause);
		}
	}
};
