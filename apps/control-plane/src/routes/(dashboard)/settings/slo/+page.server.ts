import { error, fail } from '@sveltejs/kit';
import { sloObjectInputSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, formString, toFormFailure } from '../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → SLOs (HA-PLAN W15). A read view over every project's objectives with the current
 * error budget; creation and removal call the same service as the REST surface. Flag-off is empty
 * and says so rather than pretending a target exists.
 */

export const load: PageServerLoad = async ({ locals }) => {
	const principal = locals.principal;
	if (!principal || !core.ctx.platformIam.canView(principal))
		error(403, 'Service-level objectives are platform-wide; only platform admins can see them.');
	return {
		overview: await core.slos.overview(principal),
		/** The current org's projects, for the create form; the service still enforces project:update. */
		projects: core.projects.list(principal).map((project) => ({ slug: project.slug, name: project.name })),
		canEdit: core.ctx.platformIam.canAdminister(principal)
	};
};

function failure(cause: unknown) {
	return fail(failStatus(cause), toFormFailure(cause));
}

/** The value select uses a small preset set instead of a free-form query string. */
const indicators = ['http_availability', 'database_writable'] as const;

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			const input = sloObjectInputSchema.parse({
				name: formString(data, 'name'),
				description: formString(data, 'description') || null,
				indicator: formString(data, 'indicator') || indicators[0],
				target: Number(formString(data, 'target')) / 100,
				windowSeconds: Math.round(Number(formString(data, 'windowHours') || 24) * 3_600),
				burnAlerts: buildBurnAlerts(data),
				enabled: true
			});
			await core.slos.upsert(principal, formString(data, 'project'), input);
			return { success: `Saved “${input.name}”.` };
		} catch (cause) {
			return failure(cause);
		}
	},
	remove: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			core.slos.remove(principal, formString(data, 'project'), formString(data, 'id'));
			return { success: 'SLO removed.' };
		} catch (cause) {
			return failure(cause);
		}
	}
};

function buildBurnAlerts(data: FormData) {
	const severity = formString(data, 'burnSeverity');
	const burnRate = Number(formString(data, 'burnRate'));
	const windowMinutes = Number(formString(data, 'burnWindowMinutes'));
	if (severity === '' || severity === 'none' || !Number.isFinite(burnRate) || burnRate <= 0 || !Number.isFinite(windowMinutes) || windowMinutes <= 0)
		return [];
	const shortMinutes = Number(formString(data, 'burnShortMinutes'));
	return [
		{
			severity,
			burnRate,
			windowSeconds: Math.max(60, Math.round(windowMinutes * 60)),
			shortWindowSeconds:
				Number.isFinite(shortMinutes) && shortMinutes > 0 ? Math.max(60, Math.round(shortMinutes * 60)) : null
		}
	];
}
