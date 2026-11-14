import { fail } from '@sveltejs/kit';
import { packingStrategies } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, formBoolean, formString, toFormFailure } from '../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

/** Fleet capacity and links (docs/CLUSTERING.md §3.10, §4.6). Platform admins only. */
export const load: PageServerLoad = ({ locals, depends }) => {
	depends('yoal:fleet');
	const principal = locals.principal!;
	try {
		return { scheduling: core.scheduling.view(principal), links: core.links.view(principal), denied: false };
	} catch {
		return { scheduling: null, links: null, denied: true };
	}
};

export const actions: Actions = {
	rebalance: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const strategy = formString(data, 'strategy');
		try {
			const result = core.scheduling.rebalance(principal, {
				apply: true,
				...(packingStrategies.includes(strategy as (typeof packingStrategies)[number])
					? { strategy: strategy as (typeof packingStrategies)[number] }
					: {}),
			});
			if (result.moved.length === 0)
				return fail(409, { message: result.skipped[0]?.reason ?? 'Nothing to move: the fleet is already in this shape.' });
			return {
				success: `${result.moved.length} move${result.moved.length === 1 ? '' : 's'} started${
					result.skipped.length ? `; ${result.skipped.length} skipped` : ''
				}.`,
			};
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
	},

	strategy: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			core.cluster.update(principal, {
				scheduling: {
					strategy: formString(data, 'strategy'),
					autoRebalance: formBoolean(data, 'autoRebalance'),
				},
			});
			return { success: 'Scheduling settings saved.' };
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
	},

	move: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const node = formString(data, 'node');
		try {
			const result = core.scheduling.move(principal, formString(data, 'project'), node ? { node } : {});
			return { success: `${result.project} is moving to ${result.to.name}.` };
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
	},

	linkTest: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const from = formString(data, 'from');
		const to = formString(data, 'to');
		try {
			const result = core.links.start(principal, { ...(from ? { from } : {}), ...(to ? { to } : {}) });
			if (result.queued.length === 0)
				return fail(409, { message: result.skipped[0]?.reason ?? 'No link could be tested.' });
			return { success: `${result.queued.length} link test${result.queued.length === 1 ? '' : 's'} queued.` };
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
	},
};
