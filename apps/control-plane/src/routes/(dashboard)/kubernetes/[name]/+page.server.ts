import { error, fail, redirect } from '@sveltejs/kit';
import { hasPermission } from '@yoal/contracts';
import { CoreError } from '@yoal/core';
import {
	KUBERNETES_MAX_AGENTS,
	KUBERNETES_MAX_MEMORY_MB,
	KUBERNETES_MIN_MEMORY_MB,
	kubernetesAccessKeyCreateSchema,
	kubernetesAttachSchema,
	kubernetesRestoreSchema,
	kubernetesRouteCreateSchema,
	kubernetesUpdateSchema,
	type KubernetesAccessKeyView,
	type KubernetesBackupView,
	type KubernetesClusterView,
	type KubernetesTier
} from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { contentDomain } from '#lib/server/config.js';
import { failStatus, formBoolean, formString, toFormFailure } from '../../_lib/errors.js';
import { fieldErrorsFrom, optionalNumber } from '../../databases/_lib/forms.server.js';
import { cidrList, kubernetesCan } from '../_lib/forms.server.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params }) => {
	const principal = locals.principal!;
	let cluster: KubernetesClusterView;
	try {
		cluster = core.kubernetes.get(principal, params.name, { includeDeleted: true });
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}

	let accessKeys: KubernetesAccessKeyView[] = [];
	if (!cluster.deletedAt) {
		try {
			accessKeys = core.kubernetes.accessKeys(principal, params.name);
		} catch {
			// The list is a nicety; the page still works without it.
		}
	}

	let backups: KubernetesBackupView[] = [];
	try {
		backups = core.kubernetes.backups(principal, params.name);
	} catch {
		// Shown as empty; the tab explains.
	}

	// Restore targets for "Restore into new cluster".
	let nodes: Array<{ id: string; name: string; tiers: KubernetesTier[] }> = [];
	try {
		nodes = core.kubernetes
			.capableNodes(principal)
			.map(({ id, name, tiers }) => ({ id, name, tiers }));
	} catch {
		// `auto` still works.
	}

	// Attachments need the database or broker on the cluster's node for now (D56).
	const sameNode = (item: { nodeId: string }) => item.nodeId === cluster.nodeId;
	let databases: Array<{ name: string; label: string }> = [];
	let brokers: Array<{ name: string; label: string }> = [];
	try {
		databases = core.databases
			.list(principal)
			.filter(sameNode)
			.map((item) => ({ name: item.name, label: `${item.name} (${item.engineLabel})` }));
	} catch {
		// No database:read.
	}
	try {
		brokers = core.brokers
			.list(principal)
			.filter(sameNode)
			.map((item) => ({ name: item.name, label: `${item.name} (${item.engineLabel})` }));
	} catch {
		// No broker:read.
	}

	return {
		cluster,
		accessKeys,
		backups,
		nodes,
		databases,
		brokers,
		contentDomain,
		limits: {
			minMemoryMb: KUBERNETES_MIN_MEMORY_MB,
			maxMemoryMb: KUBERNETES_MAX_MEMORY_MB,
			maxAgents: KUBERNETES_MAX_AGENTS
		},
		kubernetesCan: kubernetesCan(principal),
		/** "Write config" (§18): Apply needs kubernetes:edit; the cluster's RBAC still decides. */
		canApplyConfig: hasPermission(principal, 'kubernetes:edit')
	};
};

const failed = (caught: unknown, extra: Record<string, unknown> = {}) =>
	fail(failStatus(caught), { ...toFormFailure(caught), ...extra });

export const actions: Actions = {
	/** Settings: scale, resize, API access, allowlist, maintenance window and auto-patching. */
	update: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const values = {
			agents: formString(data, 'agents'),
			memoryMb: formString(data, 'memoryMb'),
			cpus: formString(data, 'cpus'),
			apiAccess: formString(data, 'apiAccess'),
			allowCidrs: formString(data, 'allowCidrs'),
			windowHour: formString(data, 'windowHour'),
			windowHours: formString(data, 'windowHours')
		};
		const section = formString(data, 'section');
		const patch: Record<string, unknown> = {};
		if (section === 'size') {
			patch.agents = optionalNumber(values.agents);
			patch.memoryMb = optionalNumber(values.memoryMb);
			patch.cpus = optionalNumber(values.cpus);
		} else if (section === 'access') {
			patch.apiAccess = values.apiAccess || undefined;
			patch.allowCidrs = cidrList(values.allowCidrs);
		} else if (section === 'backups') {
			patch.backupHours = optionalNumber(formString(data, 'backupHours'));
			patch.backupRetentionDays = optionalNumber(formString(data, 'backupRetentionDays'));
		} else if (section === 'logs') {
			patch.shipper = formBoolean(data, 'shipper');
			patch.logRetentionDays = optionalNumber(formString(data, 'logRetentionDays'));
		} else if (section === 'maintenance') {
			patch.window = {
				hour: optionalNumber(values.windowHour),
				hours: optionalNumber(values.windowHours)
			};
			patch.autoPatch = formBoolean(data, 'autoPatch');
		} else return fail(400, { message: 'Unknown settings section.' });
		const parsed = kubernetesUpdateSchema.safeParse(patch);
		if (!parsed.success)
			return fail(400, {
				message: 'Check the highlighted fields.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues),
				values,
				section
			});
		try {
			core.kubernetes.update(principal, params.name, parsed.data);
		} catch (caught) {
			return failed(caught, { values, section });
		}
		return {
			success: `${params.name} updated. Machines restart where the change needs it.`,
			section
		};
	},

	/** Production only: snapshot, convert SQLite to etcd in place, then add two servers (K17). */
	makeHa: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.kubernetes.update(principal, params.name, { servers: 3 });
		} catch (caught) {
			return failed(caught);
		}
		return {
			success: `${params.name} is converting to three servers on etcd. Follow the rollout on Overview.`
		};
	},

	makeProduction: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.kubernetes.update(principal, params.name, { purpose: 'production' });
		} catch (caught) {
			return failed(caught);
		}
		return { success: `${params.name} is now a production cluster.` };
	},

	enableShipper: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.kubernetes.update(principal, params.name, { shipper: true });
		} catch (caught) {
			return failed(caught);
		}
		return { success: 'Log shipper enabled. Pod logs appear here within a minute of it starting.' };
	},

	backupNow: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			const backup = core.kubernetes.backupNow(principal, params.name);
			return { success: `Snapshot ${backup.id} queued. Its node takes it in the background.` };
		} catch (caught) {
			return failed(caught);
		}
	},

	/** A new cluster from a snapshot; never overwrites this one. */
	restoreBackup: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const parsed = kubernetesRestoreSchema.safeParse({
			backup: formString(data, 'backup'),
			name: formString(data, 'name'),
			placement: formString(data, 'placement') || 'auto'
		});
		if (!parsed.success)
			return fail(400, {
				message: 'Check the highlighted fields.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		let created: KubernetesClusterView;
		try {
			created = core.kubernetes.restoreBackup(principal, parsed.data);
		} catch (caught) {
			return failed(caught);
		}
		redirect(303, `/kubernetes/${created.name}?created=1`);
	},

	upgrade: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const version = formString(await request.formData(), 'version');
		if (!version) return fail(400, { message: 'Pick a version.' });
		try {
			core.kubernetes.update(principal, params.name, { version });
		} catch (caught) {
			return failed(caught);
		}
		return {
			success: `Upgrading ${params.name} to ${version}: servers first, then agents, one at a time.`
		};
	},

	/** The kubeconfig is in this response only; it is never part of page data (K19, as D58). */
	createKey: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const expires = formString(data, 'expiresAt');
		const parsed = kubernetesAccessKeyCreateSchema.safeParse({
			name: formString(data, 'name'),
			role: formString(data, 'role'),
			expiresAt: expires ? new Date(expires).toISOString() : undefined
		});
		if (!parsed.success)
			return fail(400, {
				message: 'Check the highlighted fields.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		try {
			const key = await core.kubernetes.createAccessKey(principal, params.name, parsed.data);
			return {
				success: `Access key ${key.name} created. Copy its kubeconfig now; it is not shown again.`,
				createdKey: { name: key.name, role: key.role, kubeconfig: key.kubeconfig }
			};
		} catch (caught) {
			return failed(caught);
		}
	},

	revokeKey: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const key = formString(await request.formData(), 'key');
		if (!key) return fail(400, { message: 'Missing key.' });
		try {
			core.kubernetes.revokeAccessKey(principal, params.name, key);
		} catch (caught) {
			return failed(caught);
		}
		return {
			success: `Revoked ${key}. Its ServiceAccount leaves the cluster on the next reconcile.`
		};
	},

	addRoute: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const parsed = kubernetesRouteCreateSchema.safeParse({
			name: formString(await request.formData(), 'name')
		});
		if (!parsed.success)
			return fail(400, {
				message: 'Check the highlighted fields.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		try {
			const route = core.kubernetes.addRoute(principal, params.name, parsed.data);
			return { success: `https://${route.host} now routes to the cluster's ingress.` };
		} catch (caught) {
			return failed(caught);
		}
	},

	removeRoute: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const host = formString(await request.formData(), 'host');
		if (!host) return fail(400, { message: 'Missing host.' });
		try {
			core.kubernetes.removeRoute(principal, params.name, host);
		} catch (caught) {
			return failed(caught);
		}
		return { success: `Removed ${host}.` };
	},

	attach: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const target = formString(data, 'target');
		const [kind, ...rest] = target.split(':');
		const parsed = kubernetesAttachSchema.safeParse({
			kind,
			name: rest.join(':'),
			namespace: formString(data, 'namespace') || undefined,
			secret: formString(data, 'secret') || undefined
		});
		if (!parsed.success)
			return fail(400, {
				message: 'Check the highlighted fields.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		try {
			const attachment = core.kubernetes.attach(principal, params.name, parsed.data);
			return {
				success: `Attached ${attachment.name} as Secret ${attachment.namespace}/${attachment.secret}.`
			};
		} catch (caught) {
			return failed(caught);
		}
	},

	detach: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const id = formString(await request.formData(), 'id');
		if (!id) return fail(400, { message: 'Missing attachment.' });
		try {
			core.kubernetes.detach(principal, params.name, id);
		} catch (caught) {
			return failed(caught);
		}
		return { success: 'Detached. The Secret is removed from the cluster.' };
	},

	restart: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.kubernetes.restart(principal, params.name);
		} catch (caught) {
			return failed(caught);
		}
		return { success: `Restarting ${params.name}. Its machines come back with their data.` };
	},

	delete: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.kubernetes.delete(principal, params.name);
		} catch (caught) {
			return failed(caught);
		}
		redirect(303, '/kubernetes?view=trash');
	},

	restore: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.kubernetes.restore(principal, params.name);
		} catch (caught) {
			return failed(caught);
		}
		return {
			success: `“${params.name}” restored. Its node starts the machines again on the next reconcile.`
		};
	},

	purge: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.kubernetes.purgeNow(principal, params.name);
		} catch (caught) {
			return failed(caught);
		}
		redirect(303, '/kubernetes?view=trash');
	}
};
