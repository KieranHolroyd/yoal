import { fail, redirect } from '@sveltejs/kit';
import {
	DEFAULT_KUBERNETES_MINOR,
	KUBERNETES_DEFAULT_CPUS,
	KUBERNETES_DEFAULT_MEMORY_MB,
	KUBERNETES_MAX_AGENTS,
	KUBERNETES_MAX_MEMORY_MB,
	KUBERNETES_MIN_MEMORY_MB,
	kubernetesCreateSchema,
	kubernetesVersions,
	type KubernetesClusterView,
	type KubernetesTier
} from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { features } from '#lib/server/config.js';
import { failStatus, formString, toFormFailure } from '../_lib/errors.js';
import { fieldErrorsFrom, optionalNumber } from '../databases/_lib/forms.server.js';
import { cidrList, kubernetesCan } from './_lib/forms.server.js';
import type { Actions, PageServerLoad } from './$types';

/** Managed Kubernetes clusters (docs/KUBERNETES.md §11). Every check lives in `core.kubernetes`. */
export const load: PageServerLoad = ({ locals, url }) => {
	const principal = locals.principal!;
	const view = url.searchParams.get('view') === 'trash' ? ('trash' as const) : ('live' as const);

	let all: KubernetesClusterView[] = [];
	let denied = false;
	try {
		all = core.kubernetes.list(principal, { includeDeleted: true });
	} catch {
		denied = true;
	}

	let nodes: Array<{
		id: string;
		name: string;
		tiers: KubernetesTier[];
		dedicatedTo: string | null;
	}> = [];
	try {
		nodes = core.kubernetes.capableNodes(principal);
	} catch {
		// Creating still works with `auto`.
	}

	return {
		storageChoices: core.disks.choices('kubernetes'),
		view,
		denied,
		enabled: features.KUBERNETES,
		clusters: all.filter((item) => !item.deletedAt),
		trash: all.filter((item) => item.deletedAt),
		nodes,
		versions: kubernetesVersions.map((item) => ({
			minor: item.minor,
			release: item.release,
			endOfSupport: item.endOfSupport
		})),
		defaults: {
			minor: DEFAULT_KUBERNETES_MINOR,
			memoryMb: KUBERNETES_DEFAULT_MEMORY_MB,
			minMemoryMb: KUBERNETES_MIN_MEMORY_MB,
			maxMemoryMb: KUBERNETES_MAX_MEMORY_MB,
			cpus: KUBERNETES_DEFAULT_CPUS,
			maxAgents: KUBERNETES_MAX_AGENTS
		},
		kubernetesCan: kubernetesCan(principal)
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const values = {
			name: formString(data, 'name'),
			version: formString(data, 'version'),
			placement: formString(data, 'placement') || 'auto',
			tier: formString(data, 'tier'),
			memoryMb: formString(data, 'memoryMb'),
			cpus: formString(data, 'cpus'),
			agents: formString(data, 'agents'),
			storage: formString(data, 'storage'),
			apiAccess: formString(data, 'apiAccess') || 'public',
			allowCidrs: formString(data, 'allowCidrs'),
			purpose: formString(data, 'purpose') || 'lab',
			servers: formString(data, 'servers') || '1',
			nodes: data.getAll('nodes').map(String).filter(Boolean).join(','),
			backupHours: formString(data, 'backupHours'),
			shipper: formString(data, 'shipper')
		};
		const nodes = values.nodes ? values.nodes.split(',') : [];
		const input = {
			name: values.name,
			version: values.version || undefined,
			placement: nodes.length > 0 ? 'auto' : values.placement,
			tier: values.tier || undefined,
			memoryMb: optionalNumber(values.memoryMb),
			cpus: optionalNumber(values.cpus),
			agents: optionalNumber(values.agents),
			storage: values.storage || undefined,
			apiAccess: values.apiAccess,
			allowCidrs: cidrList(values.allowCidrs),
			purpose: values.purpose,
			servers: Number(values.servers),
			nodes: nodes.length > 0 ? nodes : undefined,
			backupHours: optionalNumber(values.backupHours),
			// Blank follows the purpose (on for production).
			shipper: values.shipper === 'on' ? true : values.shipper === 'off' ? false : undefined
		};
		const parsed = kubernetesCreateSchema.safeParse(input);
		if (!parsed.success)
			return fail(400, {
				message: 'Check the highlighted fields.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues),
				values
			});

		let created: KubernetesClusterView;
		try {
			created = core.kubernetes.create(principal, parsed.data);
		} catch (error) {
			return fail(failStatus(error), { ...toFormFailure(error), values });
		}
		redirect(303, `/kubernetes/${created.name}?created=1`);
	},

	restart: async ({ request, locals }) => {
		const principal = locals.principal!;
		const name = formString(await request.formData(), 'name');
		if (!name) return fail(400, { message: 'A cluster name is required.' });
		try {
			core.kubernetes.restart(principal, name);
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return { success: `Restarting ${name}. Its machines come back with their data.` };
	},

	restore: async ({ request, locals }) => {
		const principal = locals.principal!;
		const name = formString(await request.formData(), 'name');
		if (!name) return fail(400, { message: 'Missing cluster name.' });
		try {
			core.kubernetes.restore(principal, name);
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return {
			success: `“${name}” restored. Its node starts the machines again on the next reconcile.`
		};
	},

	purge: async ({ request, locals }) => {
		const principal = locals.principal!;
		const name = formString(await request.formData(), 'name');
		if (!name) return fail(400, { message: 'Missing cluster name.' });
		try {
			core.kubernetes.purgeNow(principal, name);
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return {
			success: `“${name}” is being deleted permanently. Its node removes the data, then it disappears from the trash.`
		};
	}
};
