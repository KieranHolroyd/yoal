import { fail } from '@sveltejs/kit';
import { SYSTEM_TOGGLES, systemToggleChanges } from '@yoal/contracts';
import { configState, queueConfig, requireOwnerPage } from '../_platform.server.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → System (docs/OPS.md §4.3): every on/off setting in yoal.env as a toggle. Values are
 * read from this process's environment, which is the env file as of the last (re)start; saving
 * queues a `configure` request for the root helper, which restarts the control plane.
 */

export const load: PageServerLoad = ({ locals }) => {
	requireOwnerPage(locals);
	return {
		...configState(),
		toggles: SYSTEM_TOGGLES.map((toggle) => {
			const raw = process.env[toggle.key];
			return {
				key: toggle.key,
				label: toggle.label,
				area: toggle.area,
				description: toggle.description,
				default: toggle.default,
				optIn: toggle.optIn,
				risky: toggle.risky,
				value: toggle.parse(raw),
				/** What yoal.env holds, so a pinned or unreadable value is visible. Never a secret. */
				raw: raw ?? null
			};
		})
	};
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		requireOwnerPage(locals);
		const data = await request.formData();
		const desired: Record<string, boolean> = {};
		for (const toggle of SYSTEM_TOGGLES) {
			const value = data.get(toggle.key);
			if (value === '1' || value === '0') desired[toggle.key] = value === '1';
		}
		const { set, unset } = systemToggleChanges(desired, process.env);
		const count = Object.keys(set).length + unset.length;
		if (count === 0) return fail(400, { message: 'Nothing changed; the settings already match.' });
		return queueConfig(
			locals,
			{ action: 'configure', section: 'system', set: set as Record<string, string>, unset },
			`Saving ${count} ${count === 1 ? 'setting' : 'settings'}. The dashboard restarts for a few seconds.`
		);
	}
};
