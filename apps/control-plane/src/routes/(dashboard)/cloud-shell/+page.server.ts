import { core } from '#lib/server/core.js';
import type { PageServerLoad } from './$types';

/**
 * Cloud shell (D236): the caller's own terminal. The page renders whatever the caller is allowed
 * to see; starting, stopping and resetting go through `/api/v1/cloud-shell/*`, and the terminal
 * through `/cloud-shell/console/*`.
 */
export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal;
	if (!principal) return { state: null, refusal: 'Sign in to use the cloud shell.' };
	try {
		return { state: core.cloudShells.state(principal), refusal: null };
	} catch (error) {
		return {
			state: null,
			refusal:
				error instanceof Error && 'permission' in error
					? 'Your role cannot open a cloud shell. It needs the cloudShell:use permission (deployer and up).'
					: error instanceof Error
						? error.message
						: 'The cloud shell is unavailable.'
		};
	}
};
