import { error } from '@sveltejs/kit';
import { CoreError } from '@yoal/core';
import { hasPermission, type DatabaseView } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { databaseCan } from '../../_lib/forms.server.js';
import type { PageServerLoad } from './$types';

/**
 * Postgres container logs (D82) in the Logs Explorer, locked to `database:<id>` (docs/LOGS.md §7).
 * The agent drains the unit's journal like any other workload; the explorer reads and tails it
 * through `/api/v1/logs/*`.
 */
export const load: PageServerLoad = ({ locals, params }) => {
	const principal = locals.principal!;
	let database: DatabaseView;
	try {
		database = core.databases.get(principal, params.name, { includeDeleted: true });
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}

	return {
		database,
		canRead: hasPermission(principal, 'logs:read'),
		dbCan: databaseCan(principal)
	};
};
