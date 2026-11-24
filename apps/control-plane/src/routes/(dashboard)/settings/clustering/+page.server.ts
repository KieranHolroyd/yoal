import { fail } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import { failStatus, formBoolean, formString, toFormFailure } from '../../_lib/errors.js';
import { requireOwnerPage } from '../_platform.server.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const principal = requireOwnerPage(locals);
	const names = Object.fromEntries(core.nodes.overlayGraph().nodes.map((node) => [node.id, node.name]));
	return {
		config: core.cluster.get(),
		failover: core.failover.status(principal),
		mesh: { ...core.overlayMesh.view(principal), names }
	};
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		const principal = requireOwnerPage(locals);
		const data = await request.formData();
		const raw = String(data.get('config') ?? '').trim();
		if (!raw) return fail(400, { message: 'Configuration is empty.' });
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return fail(400, { message: 'Configuration must be valid JSON.' });
		}
		try {
			core.cluster.update(principal, parsed);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: 'Cluster configuration saved.' };
	},

	/** Overlay mode (CLUSTERING §4.7, D240): `hub`, or `mesh` for direct node-to-node paths. */
	overlay: async ({ request, locals }) => {
		const principal = requireOwnerPage(locals);
		const data = await request.formData();
		const mode = formBoolean(data, 'mesh') ? 'mesh' : 'hub';
		try {
			core.cluster.update(principal, { overlay: { mode } });
		} catch (caught) {
			return fail(failStatus(caught), { ...toFormFailure(caught), section: 'overlay' });
		}
		return {
			success:
				mode === 'mesh'
					? 'Mesh mode is on. Node pairs move to direct paths as their handshakes succeed.'
					: 'Mesh mode is off. Every node pair goes back to the hubs.',
			section: 'overlay'
		};
	},

	/** Fleet node updates (CLUSTERING §3.11, D217): rollout defaults and `autoRollout`. */
	updates: async ({ request, locals }) => {
		const principal = requireOwnerPage(locals);
		const data = await request.formData();
		const number = (key: string) => {
			const raw = formString(data, key);
			const value = Number(raw);
			return raw && Number.isFinite(value) ? value : raw;
		};
		const canary = formString(data, 'canary');
		try {
			core.cluster.update(principal, {
				updates: {
					autoRollout: formBoolean(data, 'autoRollout'),
					strategy: formString(data, 'strategy'),
					batchSize: number('batchSize'),
					drain: formBoolean(data, 'drain'),
					soakSeconds: number('soakSeconds'),
					maxFailures: number('maxFailures'),
					// Blank follows the strategy (on, except for parallel); undefined clears a saved choice.
					canary: canary === 'true' ? true : canary === 'false' ? false : undefined
				}
			});
		} catch (caught) {
			return fail(failStatus(caught), { ...toFormFailure(caught), section: 'updates' });
		}
		return { success: 'Node update settings saved.', section: 'updates' };
	}
};
