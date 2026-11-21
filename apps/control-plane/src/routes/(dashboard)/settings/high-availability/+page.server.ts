import { error, fail } from '@sveltejs/kit';
import { HA_DRILL_CATALOGUE, HA_INIT_FLAGS, projectHaTargetInputSchema, type FeatureName } from '@yoal/contracts';
import { features } from '#lib/server/config.js';
import { core } from '#lib/server/core.js';
import { failStatus, formString, toFormFailure } from '../../_lib/errors.js';
import { policyState, savePolicies } from '../_lib/policies.server.js';
import type { Actions, PageServerLoad } from './$types';

/** The flags the guided setup and the drill catalogue read: every flag a profile sets or a drill needs. */
const HA_PAGE_FLAGS: readonly FeatureName[] = [...new Set<FeatureName>([...HA_INIT_FLAGS, ...HA_DRILL_CATALOGUE.flatMap((entry) => entry.flags)])];

export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal;
	if (!principal || !core.ctx.platformIam.allows(principal, 'platform:ha'))
		error(403, 'High availability is for platform operators and admins.');
	const failover = core.failover.status(principal);
	// Durability is read per org; a database in another org shows without it.
	const durability = new Map(
		core.databases.list(principal).map((database) => [database.id, { configured: database.durability.configured, effective: database.durability.effective, standbyRegion: database.standbyRegion }])
	);
	return {
		...policyState(),
		status: core.ingress.status(principal),
		failover,
		/** The running control plane's flags, for the setup and drill gates (they are read from yoal.env at start). */
		flags: Object.fromEntries(HA_PAGE_FLAGS.map((name) => [name, features[name]])) as Partial<Record<FeatureName, boolean>>,
		/** `steering` from the cluster settings: what `ha init` and blueprints write. */
		steering: core.cluster.get().steering,
		/** The honest automatic database failover state (report-only until nodes can fence themselves). */
		databaseFailover: {
			autoPromoteFlag: features.DB_AUTO_PROMOTE,
			controllerEnabled: failover.enabled,
			handlerInstalled: failover.databaseHandler,
			selfFencing: core.databaseReplicas.selfFencing()
		},
		databaseDurability: Object.fromEntries(failover.databases.map((database) => [database.id, durability.get(database.id) ?? null])),
		/** The profile and platform-dependency preflight (HA-PLAN H27/H28, W12). */
		ha: core.ha.view(principal),
		/** W15: declared versus effective levels, the failover/drill timeline and outside-in probes. */
		targets: core.slos.targets(principal),
		/** Projects the signed-in operator may edit (their org); the fleet table stays read-only. */
		editableSlugs: core.projects.list(principal).map((project) => project.slug),
		timeline: core.slos.timeline(principal, { limit: 50 }),
		probers: core.externalProber.list(principal),
		/** Node offline drills: running, recent and which nodes may be drilled (D235). */
		drills: core.nodeDrills.view(principal),
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
	/** Disaster drill: take a random (or named) node off the control plane for a while (D235). */
	startDrill: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const node = formString(data, 'node');
		try {
			// The typed confirmation is checked on the server, not only in the dialog (HA-PLAN §10).
			const drill = core.haDrills.startNodeDrill(principal, {
				...(node ? { node } : {}),
				durationSeconds: Number(formString(data, 'durationSeconds')),
				includeControlNode: formString(data, 'includeControlNode') === 'true',
				confirm: formString(data, 'confirm')
			});
			return {
				success: `Drill started: ${drill.nodeName} is going offline for ${Math.round(drill.durationSeconds / 60)} min${drill.random ? ' (picked at random)' : ''}.`
			};
		} catch (cause) {
			return failure(cause);
		}
	},
	cancelDrill: async ({ request, locals }) => {
		const principal = locals.principal!;
		try {
			const drill = core.nodeDrills.cancel(principal, formString(await request.formData(), 'id'));
			return { success: `Drill on ${drill.nodeName} ended; it comes back within about 5 s.` };
		} catch (cause) {
			return failure(cause);
		}
	},
	/** W15: declare the HA level a project says it needs; an empty value clears the declaration. */
	saveHaTarget: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const slug = formString(data, 'slug');
		const raw = formString(data, 'target');
		try {
			const target = raw === '' ? null : raw;
			const view = core.slos.setHaTarget(principal, slug, projectHaTargetInputSchema.parse({ target }));
			return { success: `Saved: ${view.name} declares ${view.declared ?? 'no target'} and is ${view.effective ?? 'unplaced'}.` };
		} catch (cause) {
			return failure(cause);
		}
	},
	registerProber: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			const name = formString(data, 'name');
			const intervalSeconds = Number(formString(data, 'intervalSeconds') || 60);
			const installId = formString(data, 'installId') || null;
			const registration = core.externalProber.register(principal, { name, installId, intervalSeconds });
			return {
				success: `Prober registered. Copy the token now: it is not shown again.`,
				proberToken: registration.token,
				proberName: registration.prober.name
			};
		} catch (cause) {
			return failure(cause);
		}
	},
	revokeProber: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			const prober = core.externalProber.revoke(principal, formString(data, 'proberId'));
			return { success: `${prober.name} revoked; its next report is refused.` };
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
