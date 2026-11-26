import { error } from '@sveltejs/kit';
import { CoreError } from '@yoal/core';
import { hasPermission, type StorageView } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { storageCan } from '../../_lib/forms.server.js';
import type { PageServerLoad } from './$types';

/**
 * RustFS container logs (D82) in the Logs Explorer, locked to `storage:<id>` (docs/LOGS.md §7).
 * The agent drains the unit's journal like any other workload.
 */
export const load: PageServerLoad = ({ locals, params }) => {
	const principal = locals.principal!;
	let storage: StorageView;
	try {
		storage = core.storage.get(principal, params.name, { includeDeleted: true });
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}

	return {
		storage,
		canRead: hasPermission(principal, 'logs:read'),
		storageCan: storageCan(principal)
	};
};
