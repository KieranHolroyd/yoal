import { fail, type RequestEvent } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import { failStatus, formBoolean, formString, toFormFailure } from '../_lib/errors.js';

/**
 * Fleet node updates (docs/CLUSTERING.md §3.11, D217): turn the dashboard's form fields or query
 * parameters into the body `core.nodeRollouts.plan`/`start` validate. Values are passed through as
 * typed as possible and left to the contract's schema, so its messages reach the reader unchanged.
 */
export function rolloutInput(
	get: (key: string) => string | null,
	nodeIds: string[] = []
): Record<string, unknown> {
	const input: Record<string, unknown> = {};
	const text = (key: string) => get(key)?.trim() ?? '';
	const strategy = text('strategy');
	if (strategy) input.strategy = strategy;
	for (const key of ['batchSize', 'soakSeconds', 'maxFailures'] as const) {
		const raw = text(key);
		if (!raw) continue;
		const value = Number(raw);
		input[key] = Number.isFinite(value) ? value : raw;
	}
	for (const key of ['drain', 'canary'] as const) {
		const raw = text(key);
		if (raw === 'true' || raw === 'on' || raw === '1') input[key] = true;
		else if (raw === 'false' || raw === '0') input[key] = false;
	}
	const ids = nodeIds.map((id) => id.trim()).filter(Boolean);
	if (ids.length > 0) input.nodeIds = ids;
	return input;
}

/**
 * The form actions that start, resume and cancel a rollout. Nodes and Settings → Updates both show
 * the rollout, so both pages spread these into their `actions`.
 */
export const rolloutActions = {
	startRollout: async ({ request, locals }: RequestEvent) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			const rollout = core.nodeRollouts.start(
				principal,
				rolloutInput((key) => formString(data, key) || null, data.getAll('nodeId').map(String))
			);
			const nodes = rollout.nodes.length;
			return {
				success: `Fleet update to ${rollout.targetVersion} started: ${nodes} node${nodes === 1 ? '' : 's'} in ${rollout.waves} wave${rollout.waves === 1 ? '' : 's'}.`
			};
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
	},

	resumeRollout: async ({ request, locals }: RequestEvent) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const rolloutId = formString(data, 'rolloutId');
		if (!rolloutId) return fail(400, { message: 'Missing rollout id.' });
		const retryFailed = formBoolean(data, 'retryFailed');
		try {
			core.nodeRollouts.resume(principal, rolloutId, { retryFailed });
			return {
				success: retryFailed
					? 'Rollout resumed: the failed nodes are tried again first.'
					: 'Rollout resumed: the failed nodes are left as they are.'
			};
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
	},

	cancelRollout: async ({ request, locals }: RequestEvent) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const rolloutId = formString(data, 'rolloutId');
		if (!rolloutId) return fail(400, { message: 'Missing rollout id.' });
		try {
			core.nodeRollouts.cancel(principal, rolloutId);
			return {
				success:
					'Rollout cancelled. No further waves start; a node already installing finishes on its own.'
			};
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
	}
};
