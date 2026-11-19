import type { KubernetesApplyOutcome } from '@yoal/contracts';
import type { Manifest } from './kubernetes-manifests.ts';

/**
 * A minimal Kubernetes API client for server-side apply (docs/KUBERNETES.md §18). It speaks to a
 * cluster's public API with the caller's own bearer token, so every request is decided by the
 * cluster's RBAC. Discovery maps a kind to its resource, server-side apply does create-or-update in
 * one request, and `dryRun=All` validates against the real API server without persisting anything.
 */

interface ApiResource {
	name: string;
	kind: string;
	namespaced: boolean;
	verbs?: string[];
}

const FIELD_MANAGER = 'yoal';
/** Namespaces and RBAC first, then config and storage, then workloads and what fronts them. */
const APPLY_ORDER = [
	'Namespace',
	'ServiceAccount',
	'ClusterRole',
	'ClusterRoleBinding',
	'Role',
	'RoleBinding',
	'ConfigMap',
	'Secret',
	'PersistentVolumeClaim',
	'Service',
	'Deployment',
	'StatefulSet',
	'DaemonSet',
	'Job',
	'CronJob',
	'HorizontalPodAutoscaler',
	'PodDisruptionBudget',
	'NetworkPolicy',
	'Ingress',
];

/** The fetch shape the client needs (swappable in tests). */
export type KubernetesFetch = (url: string, init?: RequestInit) => Promise<Response>;

export class KubernetesApiClient {
	private readonly discovered = new Map<string, Promise<ApiResource[]>>();

	constructor(
		private readonly baseUrl: string,
		private readonly token: string,
		private readonly fetcher: KubernetesFetch = (url, init) => fetch(url, init),
	) {}

	/** Apply every manifest in dependency order; one failure does not stop the rest. */
	async applyAll(manifests: Manifest[], options: { dryRun: boolean }): Promise<KubernetesApplyOutcome[]> {
		const order = (kind: string) => {
			const index = APPLY_ORDER.indexOf(kind);
			return index === -1 ? APPLY_ORDER.length : index;
		};
		const sorted = [...manifests].sort((a, b) => order(String(a.kind)) - order(String(b.kind)));
		const outcomes: KubernetesApplyOutcome[] = [];
		for (const manifest of sorted) outcomes.push(await this.apply(manifest, options));
		return outcomes;
	}

	async apply(manifest: Manifest, options: { dryRun: boolean }): Promise<KubernetesApplyOutcome> {
		const kind = String(manifest.kind ?? '');
		const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
		const name = String(metadata.name ?? '');
		const namespace = typeof metadata.namespace === 'string' ? metadata.namespace : null;
		const ref = { kind, name, namespace };
		try {
			const apiVersion = String(manifest.apiVersion ?? '');
			const resource = await this.resourceFor(apiVersion, kind);
			if (!resource) return { ...ref, ok: false, result: 'NotFound', message: `The cluster does not serve ${kind} in ${apiVersion}.` };
			const prefix = apiVersion.includes('/') ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
			const scope = resource.namespaced ? `/namespaces/${encodeURIComponent(namespace ?? 'default')}` : '';
			const query = new URLSearchParams({ fieldManager: FIELD_MANAGER, fieldValidation: 'Strict' });
			if (options.dryRun) query.set('dryRun', 'All');
			const existed = await this.exists(`${prefix}${scope}/${resource.name}/${encodeURIComponent(name)}`);
			// Server-side apply: create or update in one request; JSON is valid apply YAML.
			const response = await this.request(`${prefix}${scope}/${resource.name}/${encodeURIComponent(name)}?${query}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/apply-patch+yaml' },
				body: JSON.stringify(manifest),
			});
			if (response.ok) {
				const body = (await response.json().catch(() => ({}))) as { metadata?: { generation?: number; resourceVersion?: string } };
				return { ...ref, ok: true, result: existed ? 'configured' : 'created', message: body.metadata ? null : null };
			}
			const status = (await response.json().catch(() => null)) as { reason?: string; message?: string } | null;
			return {
				...ref,
				ok: false,
				result: status?.reason ?? `HTTP ${response.status}`,
				message: (status?.message ?? response.statusText).slice(0, 1000),
			};
		} catch (error) {
			return { ...ref, ok: false, result: 'Unreachable', message: error instanceof Error ? error.message : String(error) };
		}
	}

	private async exists(path: string): Promise<boolean> {
		const response = await this.request(path, { method: 'GET' });
		await response.body?.cancel().catch(() => undefined);
		return response.ok;
	}

	private async resourceFor(apiVersion: string, kind: string): Promise<ApiResource | null> {
		if (!/^[a-z0-9.-]*\/?v[0-9a-z]+$/.test(apiVersion)) return null;
		let pending = this.discovered.get(apiVersion);
		if (!pending) {
			const path = apiVersion.includes('/') ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
			pending = this.request(path, { method: 'GET' }).then(async (response) => {
				if (!response.ok) return [];
				const body = (await response.json()) as { resources?: ApiResource[] };
				return (body.resources ?? []).filter((resource) => !resource.name.includes('/'));
			});
			this.discovered.set(apiVersion, pending);
		}
		return (await pending).find((resource) => resource.kind === kind) ?? null;
	}

	private request(path: string, init: RequestInit): Promise<Response> {
		return this.fetcher(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
			...init,
			headers: { accept: 'application/json', ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${this.token}` },
			signal: AbortSignal.timeout(30_000),
		});
	}
}
