import { error } from '@sveltejs/kit';
import { CoreError } from '@yoal/core';
import { hasPermission, type BrokerView } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { brokerCan } from '../../_lib/forms.server.js';
import type { PageServerLoad } from './$types';

/** Broker container logs in the Logs Explorer, locked to `broker:<id>` (docs/LOGS.md §7). */
export const load: PageServerLoad = ({ locals, params }) => {
	const principal = locals.principal!;
	let broker: BrokerView;
	try {
		broker = core.brokers.get(principal, params.name, { includeDeleted: true });
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}
	return {
		broker,
		canRead: hasPermission(principal, 'logs:read'),
		brokerCan: brokerCan(principal)
	};
};
