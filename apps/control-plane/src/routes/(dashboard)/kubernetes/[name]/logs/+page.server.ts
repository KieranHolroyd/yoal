import { error } from '@sveltejs/kit';
import { CoreError } from '@yoal/core';
import type { KubernetesClusterView, ServiceLogQueryResult } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { kubernetesLogPage } from '#lib/server/kubernetes.js';
import { kubernetesCan } from '../../_lib/forms.server.js';
import type { PageServerLoad } from './$types';

/** Cluster machine and system logs. This page tails the JSON endpoint. */
export const load: PageServerLoad = ({ locals, params }) => {
	const principal = locals.principal!;
	let cluster: KubernetesClusterView;
	try {
		cluster = core.kubernetes.get(principal, params.name, { includeDeleted: true });
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}

	let initial: ServiceLogQueryResult | null = null;
	let logsError: string | null = null;
	try {
		initial = kubernetesLogPage(principal, params.name, { limit: 500 });
	} catch (caught) {
		logsError = caught instanceof Error ? caught.message : 'Could not read logs.';
	}
	return { cluster, initial, logsError, canRead: true, kubernetesCan: kubernetesCan(principal) };
};
