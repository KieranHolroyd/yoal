import { error, fail } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import { features } from '#lib/server/config.js';
import { failStatus, formBoolean, formString, toFormFailure } from '../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → Kubernetes (docs/KUBERNETES.md §3, K2, K4): the optional node component on each node,
 * and which orgs may use the `trusted` tier. Platform admins only; core re-checks every call and
 * only accepts install/remove from a dashboard session.
 */

function requireAdmin(locals: App.Locals) {
	const principal = locals.principal;
	if (!principal || !core.ctx.platformIam.canAdminister(principal))
		error(403, 'Kubernetes components are managed by platform administrators.');
	return principal;
}

export const load: PageServerLoad = ({ locals }) => {
	const principal = requireAdmin(locals);
	return {
		enabled: features.KUBERNETES,
		components: core.kubernetes.components(principal),
		trustedOrgs: core.kubernetes.trustedOrgs(principal)
	};
};

export const actions: Actions = {
	install: async ({ request, locals }) => {
		const principal = requireAdmin(locals);
		const nodeId = formString(await request.formData(), 'nodeId');
		if (!nodeId) return fail(400, { message: 'Missing node.' });
		try {
			const view = core.kubernetes.requestComponent(principal, nodeId, 'install');
			return {
				success: `Installing the Kubernetes component on ${view.nodeName}. It takes a few minutes; this page refreshes while it runs.`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	remove: async ({ request, locals }) => {
		const principal = requireAdmin(locals);
		const data = await request.formData();
		const nodeId = formString(data, 'nodeId');
		if (!nodeId) return fail(400, { message: 'Missing node.' });
		const purge = formBoolean(data, 'purge');
		try {
			const view = core.kubernetes.requestComponent(principal, nodeId, 'remove', purge);
			return {
				success: `Removing the Kubernetes component from ${view.nodeName}${purge ? ' and deleting its cached images' : ''}.`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	grant: async ({ request, locals }) => {
		const principal = requireAdmin(locals);
		const orgId = formString(await request.formData(), 'orgId');
		if (!orgId)
			return fail(400, { message: 'Enter an org id.', fieldErrors: { orgId: 'Enter an org id.' } });
		try {
			core.kubernetes.grantTrusted(principal, orgId);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `${orgId} may now create trusted-tier clusters on nodes dedicated to it.` };
	},

	revoke: async ({ request, locals }) => {
		const principal = requireAdmin(locals);
		const orgId = formString(await request.formData(), 'orgId');
		if (!orgId) return fail(400, { message: 'Missing org id.' });
		try {
			core.kubernetes.revokeTrusted(principal, orgId);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `Revoked the trusted tier for ${orgId}.` };
	}
};
