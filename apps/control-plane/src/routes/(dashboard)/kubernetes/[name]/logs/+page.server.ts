import { error } from '@sveltejs/kit';
import { CoreError } from '@yoal/core';
import { hasPermission, type KubernetesClusterView } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { kubernetesCan } from '../../_lib/forms.server.js';
import type { PageServerLoad } from './$types';

/**
 * Cluster machine and system logs in the Logs Explorer, locked to `k8s:<cluster id>`
 * (docs/LOGS.md §7). Pod output is the cluster page's Pod logs tab.
 */
export const load: PageServerLoad = ({ locals, params }) => {
	const principal = locals.principal!;
	let cluster: KubernetesClusterView;
	try {
		cluster = core.kubernetes.get(principal, params.name, { includeDeleted: true });
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}
	return {
		cluster,
		canRead: hasPermission(principal, 'logs:read'),
		kubernetesCan: kubernetesCan(principal)
	};
};
