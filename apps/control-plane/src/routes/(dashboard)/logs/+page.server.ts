import { hasPermission } from '@yoal/contracts';
import type { PageServerLoad } from './$types';

/**
 * The org-wide Logs Explorer (docs/LOGS.md §7). Everything it shows comes from `/api/v1/logs/*`
 * on the client, scoped by the server to what the viewer may read; the load only says whether to
 * show it at all.
 */
export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	return { canRead: hasPermission(principal, 'logs:read') };
};
