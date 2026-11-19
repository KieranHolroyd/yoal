/**
 * Kubernetes manifests from natural language: the deterministic half of the pipeline
 * (docs/KUBERNETES.md §18). The model proposes objects; everything here checks and repairs them
 * against what this cluster actually offers, so a generated config either applies cleanly or says
 * exactly why not. Pure: no I/O, no model, testable on its own.
 */

/** What the linter knows about the target cluster. */
export interface ManifestContext {
	cluster: string;
	/** `1.37`. */
	minor: string;
	/** Default namespace for namespaced objects that name none. */
	namespace: string;
	/** `traefik` when the bundled ingress controller is on, else null. */
	ingressClass: string | null;
	/** Hosts claimed for this cluster's ingress (`shop.example.com`). */
	routeHosts: string[];
	/** The content domain new single-label hosts are claimed under. */
	contentDomain: string;
	/** Attachment Secrets Yoal writes, and the keys each holds. */
	secrets: Array<{ namespace: string; name: string; keys: string[]; kind: 'database' | 'broker' }>;
	storageClasses: string[];
	defaultStorageClass: string | null;
	/** Pod memory the cluster can hold in total, in MiB (allocatable across its nodes). */
	allocatableMemoryMi: number;
	/** The platform registry host, when it is on (`registry.example.com`). */
	registryHost: string | null;
}

export type FindingSeverity = 'error' | 'warning' | 'info';

export interface ManifestFinding {
	severity: FindingSeverity;
	/** Index into the documents, or null for the whole set. */
	document: number | null;
	/** `Deployment/web` style label. */
	object: string | null;
	/** JSON-path-ish location inside the object. */
	path: string | null;
	message: string;
	/** The linter changed the object to fix it. */
	fixed: boolean;
}

export type Manifest = Record<string, unknown>;

/** Current API versions for kinds this pipeline understands (Kubernetes 1.35+). */
export const KIND_API_VERSIONS: Record<string, { apiVersion: string; namespaced: boolean }> = {
	Namespace: { apiVersion: 'v1', namespaced: false },
	ConfigMap: { apiVersion: 'v1', namespaced: true },
	Secret: { apiVersion: 'v1', namespaced: true },
	Service: { apiVersion: 'v1', namespaced: true },
	ServiceAccount: { apiVersion: 'v1', namespaced: true },
	PersistentVolumeClaim: { apiVersion: 'v1', namespaced: true },
	Pod: { apiVersion: 'v1', namespaced: true },
	Deployment: { apiVersion: 'apps/v1', namespaced: true },
	StatefulSet: { apiVersion: 'apps/v1', namespaced: true },
	DaemonSet: { apiVersion: 'apps/v1', namespaced: true },
	Job: { apiVersion: 'batch/v1', namespaced: true },
	CronJob: { apiVersion: 'batch/v1', namespaced: true },
	Ingress: { apiVersion: 'networking.k8s.io/v1', namespaced: true },
	NetworkPolicy: { apiVersion: 'networking.k8s.io/v1', namespaced: true },
	HorizontalPodAutoscaler: { apiVersion: 'autoscaling/v2', namespaced: true },
	PodDisruptionBudget: { apiVersion: 'policy/v1', namespaced: true },
	Role: { apiVersion: 'rbac.authorization.k8s.io/v1', namespaced: true },
	RoleBinding: { apiVersion: 'rbac.authorization.k8s.io/v1', namespaced: true },
	ClusterRole: { apiVersion: 'rbac.authorization.k8s.io/v1', namespaced: false },
	ClusterRoleBinding: { apiVersion: 'rbac.authorization.k8s.io/v1', namespaced: false },
};

/** Kinds whose pod template lives where. */
const POD_TEMPLATES: Record<string, string[]> = {
	Deployment: ['spec', 'template', 'spec'],
	StatefulSet: ['spec', 'template', 'spec'],
	DaemonSet: ['spec', 'template', 'spec'],
	Job: ['spec', 'template', 'spec'],
	CronJob: ['spec', 'jobTemplate', 'spec', 'template', 'spec'],
	Pod: ['spec'],
};

const DNS1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DEFAULT_REQUESTS = { cpu: '50m', memory: '64Mi' };
const DEFAULT_MEMORY_LIMIT = '256Mi';
export const GENERATED_ANNOTATION = 'yoal.io/generated-by';
export const MAX_MANIFESTS = 40;

export interface LintResult {
	manifests: Manifest[];
	findings: ManifestFinding[];
	/** True when no finding is an error. */
	ok: boolean;
}

/**
 * Check and repair a set of manifests for one cluster. Fixes are conservative (missing defaults,
 * current API versions, controller-specific settings Yoal owns); anything that changes meaning is
 * reported, not rewritten.
 */
export function lintManifests(input: unknown[], context: ManifestContext, options: { annotate?: boolean } = {}): LintResult {
	const findings: ManifestFinding[] = [];
	const manifests: Manifest[] = [];
	const note = (finding: Omit<ManifestFinding, 'fixed'> & { fixed?: boolean }) => findings.push({ fixed: false, ...finding });

	if (input.length === 0) note({ severity: 'error', document: null, object: null, path: null, message: 'No manifests were produced.' });
	if (input.length > MAX_MANIFESTS)
		note({ severity: 'error', document: null, object: null, path: null, message: `At most ${MAX_MANIFESTS} manifests at a time.` });

	input.slice(0, MAX_MANIFESTS).forEach((raw, index) => {
		if (!isRecord(raw)) {
			note({ severity: 'error', document: index, object: null, path: null, message: 'Each manifest must be an object.' });
			return;
		}
		const doc = structuredClone(raw) as Manifest;
		manifests.push(doc);
		const kind = typeof doc.kind === 'string' ? doc.kind : '';
		const metadata = isRecord(doc.metadata) ? doc.metadata : ((doc.metadata = {}), doc.metadata as Record<string, unknown>);
		const name = typeof metadata.name === 'string' ? metadata.name : '';
		const label = `${kind || '?'}/${name || '?'}`;
		const at = (path: string | null) => ({ document: manifests.length - 1, object: label, path });

		if (!kind) note({ severity: 'error', ...at('kind'), message: 'Missing kind.' });
		if (!name) note({ severity: 'error', ...at('metadata.name'), message: 'Missing metadata.name.' });
		else if (!DNS1123.test(name) || name.length > 63)
			note({ severity: 'error', ...at('metadata.name'), message: `"${name}" is not a valid name (lowercase letters, digits, hyphens; at most 63).` });

		const known = KIND_API_VERSIONS[kind];
		if (!known) {
			if (kind) note({ severity: 'warning', ...at('kind'), message: `${kind} is not a built-in kind Yoal checks; the cluster must already have its CRD.` });
		} else if (doc.apiVersion !== known.apiVersion) {
			note({
				severity: 'info',
				...at('apiVersion'),
				message: `${kind} uses ${known.apiVersion}${doc.apiVersion ? ` (was ${String(doc.apiVersion)})` : ''}.`,
				fixed: true,
			});
			doc.apiVersion = known.apiVersion;
		}

		// Namespaces: fill the default for namespaced kinds, drop one from cluster-scoped kinds.
		if (known?.namespaced && typeof metadata.namespace !== 'string') metadata.namespace = context.namespace;
		if (known && !known.namespaced && 'namespace' in metadata) {
			delete metadata.namespace;
			note({ severity: 'info', ...at('metadata.namespace'), message: `${kind} is cluster-scoped; the namespace was dropped.`, fixed: true });
		}
		if (typeof metadata.namespace === 'string' && !DNS1123.test(metadata.namespace))
			note({ severity: 'error', ...at('metadata.namespace'), message: `"${metadata.namespace}" is not a valid namespace.` });

		if (options.annotate !== false) {
			const annotations = isRecord(metadata.annotations) ? metadata.annotations : ((metadata.annotations = {}), metadata.annotations as Record<string, string>);
			(annotations as Record<string, string>)[GENERATED_ANNOTATION] = 'yoal-ai';
		}

		switch (kind) {
			case 'Service':
				lintService(doc, context, note, at);
				break;
			case 'Ingress':
				lintIngress(doc, context, note, at);
				break;
			case 'PersistentVolumeClaim':
				lintPvc(doc, context, note, at);
				break;
			case 'Secret':
				if (isRecord(doc.data) || isRecord(doc.stringData))
					note({
						severity: 'warning',
						...at('data'),
						message: 'This Secret carries literal values. Keep passwords out of configs: attach the database or broker in Yoal instead, which writes the Secret for you.',
					});
				break;
		}
		const podPath = POD_TEMPLATES[kind];
		if (podPath) {
			const pod = dig(doc, podPath);
			if (!isRecord(pod)) note({ severity: 'error', ...at(podPath.join('.')), message: 'Missing the pod template.' });
			else lintPod(pod, podPath.join('.'), kind, context, note, at);
		}
		if (kind === 'Deployment' || kind === 'StatefulSet') lintSelector(doc, note, at);
	});

	lintReferences(manifests, context, note);
	lintCapacity(manifests, context, note);
	lintDuplicates(manifests, note);
	return { manifests, findings, ok: !findings.some((finding) => finding.severity === 'error') };
}

type Note = (finding: Omit<ManifestFinding, 'fixed'> & { fixed?: boolean }) => void;
type At = (path: string | null) => { document: number; object: string; path: string | null };

function lintService(doc: Manifest, context: ManifestContext, note: Note, at: At): void {
	const spec = ensureRecord(doc, 'spec');
	if (spec.type === 'LoadBalancer') {
		spec.type = 'ClusterIP';
		note({
			severity: 'info',
			...at('spec.type'),
			message: `This cluster has no load balancer, so the Service is ClusterIP. Expose HTTP through an Ingress on a claimed host${
				context.routeHosts.length > 0 ? ` (${context.routeHosts.join(', ')})` : ''
			}.`,
			fixed: true,
		});
	} else if (spec.type === 'NodePort')
		note({ severity: 'warning', ...at('spec.type'), message: 'NodePort Services are not reachable from outside the cluster on Yoal; use an Ingress.' });
	if (!Array.isArray(spec.ports) || spec.ports.length === 0) note({ severity: 'error', ...at('spec.ports'), message: 'A Service needs at least one port.' });
}

function lintIngress(doc: Manifest, context: ManifestContext, note: Note, at: At): void {
	const spec = ensureRecord(doc, 'spec');
	if (!context.ingressClass) {
		note({ severity: 'error', ...at('spec'), message: `The cluster's ingress controller is off; turn Traefik back on for "${context.cluster}" or remove the Ingress.` });
		return;
	}
	if (spec.ingressClassName !== context.ingressClass) {
		spec.ingressClassName = context.ingressClass;
		note({ severity: 'info', ...at('spec.ingressClassName'), message: `Ingress class set to ${context.ingressClass}.`, fixed: true });
	}
	if ('tls' in spec) {
		delete spec.tls;
		note({ severity: 'info', ...at('spec.tls'), message: 'TLS sections removed: Yoal terminates HTTPS in front of the cluster with its own certificates.', fixed: true });
	}
	const metadata = ensureRecord(doc, 'metadata');
	const annotations = isRecord(metadata.annotations) ? metadata.annotations : null;
	for (const key of Object.keys(annotations ?? {}))
		if (key.startsWith('cert-manager.io/')) {
			delete annotations![key];
			note({ severity: 'info', ...at(`metadata.annotations.${key}`), message: 'cert-manager annotations removed (Yoal issues the certificate).', fixed: true });
		}
	const rules = Array.isArray(spec.rules) ? spec.rules : [];
	if (rules.length === 0) note({ severity: 'error', ...at('spec.rules'), message: 'An Ingress needs at least one rule with a host.' });
	rules.forEach((rule, index) => {
		if (!isRecord(rule)) return;
		const host = typeof rule.host === 'string' ? rule.host.toLowerCase() : '';
		if (!host) {
			note({ severity: 'error', ...at(`spec.rules[${index}].host`), message: 'Every rule needs a host; Yoal routes by host.' });
			return;
		}
		if (!context.routeHosts.includes(host)) {
			const label = host.endsWith(`.${context.contentDomain}`) ? host.slice(0, -context.contentDomain.length - 1) : null;
			note({
				severity: 'warning',
				...at(`spec.rules[${index}].host`),
				message:
					label && !label.includes('.')
						? `${host} is not routed to this cluster yet. Claim it with \`yoal k8s route add ${context.cluster} ${label}\` (or Routes on the cluster page).`
						: `${host} is not one of this cluster's hosts. Use a single label under ${context.contentDomain} and claim it as a route${
								context.routeHosts.length > 0 ? `, or one of: ${context.routeHosts.join(', ')}` : ''
							}.`,
			});
		}
	});
}

function lintPvc(doc: Manifest, context: ManifestContext, note: Note, at: At): void {
	const spec = ensureRecord(doc, 'spec');
	const requested = typeof spec.storageClassName === 'string' ? spec.storageClassName : null;
	if (requested && !context.storageClasses.includes(requested)) {
		if (context.defaultStorageClass) spec.storageClassName = context.defaultStorageClass;
		else delete spec.storageClassName;
		note({
			severity: 'warning',
			...at('spec.storageClassName'),
			message: `Storage class "${requested}" does not exist here; using ${context.defaultStorageClass ?? 'the default'} (${context.storageClasses.join(', ') || 'none listed'}).`,
			fixed: true,
		});
	}
	const modes = Array.isArray(spec.accessModes) ? spec.accessModes : [];
	if (modes.includes('ReadWriteMany') || modes.includes('ReadOnlyMany'))
		note({
			severity: 'warning',
			...at('spec.accessModes'),
			message: 'local-path volumes are ReadWriteOnce: only pods on one node can mount them. Keep shared state in a Yoal database or bucket.',
		});
	if (modes.length === 0) {
		spec.accessModes = ['ReadWriteOnce'];
		note({ severity: 'info', ...at('spec.accessModes'), message: 'Access mode set to ReadWriteOnce.', fixed: true });
	}
	const resources = ensureRecord(spec, 'resources');
	const requests = ensureRecord(resources, 'requests');
	if (typeof requests.storage !== 'string') {
		requests.storage = '1Gi';
		note({ severity: 'info', ...at('spec.resources.requests.storage'), message: 'Storage request set to 1Gi.', fixed: true });
	}
}

function lintPod(pod: Record<string, unknown>, base: string, kind: string, context: ManifestContext, note: Note, at: At): void {
	for (const key of ['hostNetwork', 'hostPID', 'hostIPC'] as const)
		if (pod[key] === true)
			note({ severity: 'warning', ...at(`${base}.${key}`), message: `${key} shares the machine's namespaces with this pod; avoid it unless you need it.` });
	const volumes = Array.isArray(pod.volumes) ? pod.volumes : [];
	volumes.forEach((volume, index) => {
		if (isRecord(volume) && isRecord(volume.hostPath))
			note({
				severity: 'warning',
				...at(`${base}.volumes[${index}].hostPath`),
				message: 'hostPath mounts the machine\'s filesystem into the pod. Use a PersistentVolumeClaim for data.',
			});
	});
	const containers = Array.isArray(pod.containers) ? pod.containers : [];
	if (containers.length === 0) note({ severity: 'error', ...at(`${base}.containers`), message: 'The pod has no containers.' });
	const groups: Array<[string, unknown[]]> = [
		['containers', containers],
		['initContainers', Array.isArray(pod.initContainers) ? pod.initContainers : []],
	];
	for (const [group, list] of groups)
		list.forEach((container, index) => {
			if (!isRecord(container)) return;
			const path = `${base}.${group}[${index}]`;
			const name = typeof container.name === 'string' ? container.name : `#${index}`;
			if (typeof container.name !== 'string' || !DNS1123.test(container.name))
				note({ severity: 'error', ...at(`${path}.name`), message: 'Every container needs a valid name.' });
			const image = typeof container.image === 'string' ? container.image : '';
			if (!image) note({ severity: 'error', ...at(`${path}.image`), message: `Container ${name} has no image.` });
			else if (!/@sha256:/.test(image) && (!/:[^/]+$/.test(image) || image.endsWith(':latest')))
				note({
					severity: 'warning',
					...at(`${path}.image`),
					message: `${image} has no fixed tag; pin a version (or a digest) so a restart never pulls something new.`,
				});
			const security = isRecord(container.securityContext) ? container.securityContext : null;
			if (security?.privileged === true)
				note({ severity: 'warning', ...at(`${path}.securityContext.privileged`), message: `Container ${name} is privileged; it can act as root on the machine.` });
			// Requests make scheduling honest; a memory limit keeps one pod from evicting the rest.
			const resources = ensureRecord(container, 'resources');
			const requests = ensureRecord(resources, 'requests');
			const limits = ensureRecord(resources, 'limits');
			const added: string[] = [];
			if (requests.cpu === undefined) (requests.cpu = DEFAULT_REQUESTS.cpu), added.push(`cpu request ${DEFAULT_REQUESTS.cpu}`);
			if (requests.memory === undefined) {
				requests.memory = limits.memory ?? DEFAULT_REQUESTS.memory;
				added.push(`memory request ${String(requests.memory)}`);
			}
			if (limits.memory === undefined) {
				const request = parseMemoryMi(requests.memory);
				limits.memory = request !== null && request > parseMemoryMi(DEFAULT_MEMORY_LIMIT)! ? requests.memory : DEFAULT_MEMORY_LIMIT;
				added.push(`memory limit ${String(limits.memory)}`);
			}
			if (added.length > 0)
				note({ severity: 'info', ...at(`${path}.resources`), message: `Container ${name}: added ${added.join(', ')}.`, fixed: true });
			if (group === 'containers' && (kind === 'Deployment' || kind === 'StatefulSet') && Array.isArray(container.ports) && container.ports.length > 0 && !container.readinessProbe)
				note({ severity: 'info', ...at(`${path}.readinessProbe`), message: `Container ${name} has no readiness probe; rollouts cannot tell when it is ready.` });
		});
}

function lintSelector(doc: Manifest, note: Note, at: At): void {
	const spec = ensureRecord(doc, 'spec');
	const template = isRecord(spec.template) ? spec.template : null;
	const labels = isRecord(template?.metadata) && isRecord((template!.metadata as Record<string, unknown>).labels)
		? ((template!.metadata as Record<string, unknown>).labels as Record<string, unknown>)
		: null;
	const selector = isRecord(spec.selector) && isRecord(spec.selector.matchLabels) ? (spec.selector.matchLabels as Record<string, unknown>) : null;
	if (!selector || Object.keys(selector).length === 0) {
		if (labels && Object.keys(labels).length > 0) {
			spec.selector = { matchLabels: { ...labels } };
			note({ severity: 'info', ...at('spec.selector'), message: 'Selector set from the pod labels.', fixed: true });
		} else note({ severity: 'error', ...at('spec.selector'), message: 'A selector and matching pod labels are required.' });
		return;
	}
	for (const [key, value] of Object.entries(selector))
		if (!labels || labels[key] !== value)
			note({ severity: 'error', ...at('spec.selector.matchLabels'), message: `The selector ${key}=${String(value)} does not match the pod template's labels.` });
}

/** Services must select pods in the set; secret and config references must exist. */
function lintReferences(manifests: Manifest[], context: ManifestContext, note: Note): void {
	const byKind = (kind: string) => manifests.filter((doc) => doc.kind === kind);
	const ns = (doc: Manifest) => (isRecord(doc.metadata) && typeof doc.metadata.namespace === 'string' ? doc.metadata.namespace : context.namespace);
	const nameOf = (doc: Manifest) => (isRecord(doc.metadata) && typeof doc.metadata.name === 'string' ? doc.metadata.name : '');
	const secrets = new Set([
		...byKind('Secret').map((doc) => `${ns(doc)}/${nameOf(doc)}`),
		...context.secrets.map((secret) => `${secret.namespace}/${secret.name}`),
	]);
	const configMaps = new Set(byKind('ConfigMap').map((doc) => `${ns(doc)}/${nameOf(doc)}`));
	const services = new Map(byKind('Service').map((doc) => [`${ns(doc)}/${nameOf(doc)}`, doc]));
	const podLabels: Array<{ namespace: string; labels: Record<string, unknown> }> = [];

	manifests.forEach((doc, index) => {
		const podPath = POD_TEMPLATES[String(doc.kind)];
		if (!podPath) return;
		const pod = dig(doc, podPath);
		const template = dig(doc, podPath.slice(0, -1));
		if (isRecord(template) && isRecord(template.metadata) && isRecord((template.metadata as Record<string, unknown>).labels))
			podLabels.push({ namespace: ns(doc), labels: (template.metadata as Record<string, unknown>).labels as Record<string, unknown> });
		if (!isRecord(pod)) return;
		const label = `${String(doc.kind)}/${nameOf(doc)}`;
		const containers = [...(Array.isArray(pod.containers) ? pod.containers : []), ...(Array.isArray(pod.initContainers) ? pod.initContainers : [])];
		for (const container of containers) {
			if (!isRecord(container)) continue;
			const refs: Array<{ kind: 'secret' | 'configMap'; name: string; key?: string }> = [];
			for (const from of Array.isArray(container.envFrom) ? container.envFrom : []) {
				if (isRecord(from) && isRecord(from.secretRef) && typeof from.secretRef.name === 'string') refs.push({ kind: 'secret', name: from.secretRef.name });
				if (isRecord(from) && isRecord(from.configMapRef) && typeof from.configMapRef.name === 'string') refs.push({ kind: 'configMap', name: from.configMapRef.name });
			}
			for (const env of Array.isArray(container.env) ? container.env : []) {
				const source = isRecord(env) && isRecord(env.valueFrom) ? env.valueFrom : null;
				if (source && isRecord(source.secretKeyRef) && typeof source.secretKeyRef.name === 'string')
					refs.push({ kind: 'secret', name: source.secretKeyRef.name, key: typeof source.secretKeyRef.key === 'string' ? source.secretKeyRef.key : undefined });
				if (source && isRecord(source.configMapKeyRef) && typeof source.configMapKeyRef.name === 'string') refs.push({ kind: 'configMap', name: source.configMapKeyRef.name });
			}
			for (const ref of refs) {
				const key = `${ns(doc)}/${ref.name}`;
				if (ref.kind === 'secret' && !secrets.has(key)) {
					const attached = context.secrets.filter((secret) => secret.name === ref.name);
					note({
						severity: 'warning',
						document: index,
						object: label,
						path: null,
						message: attached.length > 0
							? `Secret ${ref.name} exists in ${attached.map((secret) => secret.namespace).join(', ')}, not ${ns(doc)}. Attach it to this namespace or move the workload.`
							: `Secret ${ref.name} does not exist. Attach a database or broker to "${context.cluster}" (it writes the Secret), or include the Secret.`,
					});
				}
				if (ref.kind === 'secret' && ref.key) {
					const attached = context.secrets.find((secret) => `${secret.namespace}/${secret.name}` === key);
					if (attached && !attached.keys.includes(ref.key))
						note({
							severity: 'error',
							document: index,
							object: label,
							path: null,
							message: `Secret ${ref.name} has no key ${ref.key}; its keys are ${attached.keys.join(', ')}.`,
						});
				}
				if (ref.kind === 'configMap' && !configMaps.has(key))
					note({ severity: 'warning', document: index, object: label, path: null, message: `ConfigMap ${ref.name} is not in this config; it must already exist in ${ns(doc)}.` });
			}
		}
	});

	for (const [key, service] of services) {
		const spec = isRecord(service.spec) ? service.spec : null;
		const selector = spec && isRecord(spec.selector) ? spec.selector : null;
		if (!selector || Object.keys(selector).length === 0) continue;
		const [namespace] = key.split('/');
		const matched = podLabels.some(
			(pod) => pod.namespace === namespace && Object.entries(selector).every(([label, value]) => pod.labels[label] === value),
		);
		if (!matched && podLabels.length > 0)
			note({
				severity: 'warning',
				document: manifests.indexOf(service),
				object: `Service/${key.split('/')[1]}`,
				path: 'spec.selector',
				message: 'This Service selects no pods in the config.',
			});
	}
	for (const ingress of byKind('Ingress')) {
		const spec = isRecord(ingress.spec) ? ingress.spec : null;
		for (const rule of Array.isArray(spec?.rules) ? spec!.rules : []) {
			const paths = isRecord(rule) && isRecord(rule.http) && Array.isArray(rule.http.paths) ? rule.http.paths : [];
			for (const path of paths) {
				const backend = isRecord(path) && isRecord(path.backend) && isRecord(path.backend.service) ? path.backend.service : null;
				const name = backend && typeof backend.name === 'string' ? backend.name : null;
				if (name && !services.has(`${ns(ingress)}/${name}`))
					note({
						severity: 'warning',
						document: manifests.indexOf(ingress),
						object: `Ingress/${nameOf(ingress)}`,
						path: 'spec.rules',
						message: `Backend Service ${name} is not in this config; it must already exist.`,
					});
			}
		}
	}
}

/** Requested memory against what the cluster can hold. */
function lintCapacity(manifests: Manifest[], context: ManifestContext, note: Note): void {
	let total = 0;
	for (const doc of manifests) {
		const podPath = POD_TEMPLATES[String(doc.kind)];
		if (!podPath || doc.kind === 'CronJob' || doc.kind === 'Job' || doc.kind === 'DaemonSet') continue;
		const replicas = doc.kind === 'Pod' ? 1 : isRecord(doc.spec) && typeof doc.spec.replicas === 'number' ? doc.spec.replicas : 1;
		const pod = dig(doc, podPath);
		if (!isRecord(pod)) continue;
		for (const container of Array.isArray(pod.containers) ? pod.containers : []) {
			const requests = isRecord(container) && isRecord(container.resources) && isRecord(container.resources.requests) ? container.resources.requests : null;
			total += (parseMemoryMi(requests?.memory) ?? 0) * replicas;
		}
	}
	if (context.allocatableMemoryMi > 0 && total > context.allocatableMemoryMi)
		note({
			severity: 'warning',
			document: null,
			object: null,
			path: null,
			message: `These workloads request ${total} MiB of memory but "${context.cluster}" can hold about ${context.allocatableMemoryMi} MiB. Lower the requests or replicas, or give the cluster more memory or agents.`,
		});
}

function lintDuplicates(manifests: Manifest[], note: Note): void {
	const seen = new Map<string, number>();
	manifests.forEach((doc, index) => {
		const metadata = isRecord(doc.metadata) ? doc.metadata : {};
		const key = `${String(doc.kind)}/${String(metadata.namespace ?? '')}/${String(metadata.name ?? '')}`;
		if (seen.has(key))
			note({ severity: 'error', document: index, object: `${String(doc.kind)}/${String(metadata.name)}`, path: null, message: 'The same object appears twice.' });
		seen.set(key, index);
	});
}

// ---------------------------------------------------------------- YAML

/**
 * Emit multi-document YAML in the style people write by hand: block maps and lists, plain scalars
 * where they are unambiguous, double quotes otherwise, `|` for multi-line strings.
 */
export function manifestsToYaml(manifests: Manifest[]): string {
	return manifests.map((doc) => emit(orderKeys(doc), 0).trimEnd()).join('\n---\n') + '\n';
}

const TOP_ORDER = ['apiVersion', 'kind', 'metadata', 'spec', 'data', 'stringData', 'type'];

function orderKeys(doc: Manifest): Manifest {
	const out: Manifest = {};
	for (const key of TOP_ORDER) if (key in doc) out[key] = doc[key];
	for (const [key, value] of Object.entries(doc)) if (!(key in out)) out[key] = value;
	return out;
}

function emit(value: unknown, indent: number): string {
	const pad = '  '.repeat(indent);
	if (Array.isArray(value)) {
		if (value.length === 0) return '[]';
		return value
			.map((item) => {
				if (isRecord(item) && Object.keys(item).length > 0) {
					const body = emit(item, indent + 1).replace(/^\s+/, '');
					return `${pad}- ${body}`;
				}
				if (Array.isArray(item) && item.length > 0) return `${pad}-\n${emit(item, indent + 1)}`;
				return `${pad}- ${scalar(item)}`;
			})
			.join('\n');
	}
	if (isRecord(value)) {
		const entries = Object.entries(value).filter(([, item]) => item !== undefined);
		if (entries.length === 0) return '{}';
		return entries
			.map(([key, item]) => {
				const k = keyText(key);
				if (isRecord(item) && Object.keys(item).length > 0) return `${pad}${k}:\n${emit(item, indent + 1)}`;
				if (Array.isArray(item) && item.length > 0) return `${pad}${k}:\n${emit(item, indent)}`;
				if (typeof item === 'string' && item.includes('\n')) {
					const body = item.replace(/\n$/, '').split('\n').map((line) => (line ? `${pad}  ${line}` : '')).join('\n');
					return `${pad}${k}: |${item.endsWith('\n') ? '' : '-'}\n${body}`;
				}
				return `${pad}${k}: ${scalar(item)}`;
			})
			.join('\n');
	}
	return `${pad}${scalar(value)}`;
}

function keyText(key: string): string {
	return /^[A-Za-z0-9_./-]+$/.test(key) && !RESERVED_PLAIN.test(key) ? key : JSON.stringify(key);
}

const RESERVED_PLAIN = /^(true|false|yes|no|on|off|null|~|y|n)$/i;

function scalar(value: unknown): string {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (isRecord(value)) return '{}';
	if (Array.isArray(value)) return '[]';
	const text = String(value);
	const plain =
		text.length > 0 &&
		!RESERVED_PLAIN.test(text) &&
		!/^[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(text) &&
		!/^0x|^0o/i.test(text) &&
		!/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(text) &&
		!/[:#]\s|\s#|:$|^\s|\s$/.test(text) &&
		!/[\u0000-\u001f]/.test(text);
	return plain ? text : JSON.stringify(text);
}

/** Parse YAML a person edited (or a model wrote) into manifest objects. Lists of `kind: List` are flattened. */
export function parseManifestYaml(text: string): Manifest[] {
	const parsed = (Bun.YAML.parse(text) as unknown) ?? [];
	// Several documents (or one document that is a list of manifests) parse to an array.
	const docs = Array.isArray(parsed) ? parsed : [parsed];
	const out: Manifest[] = [];
	for (const doc of docs) {
		if (doc === null || doc === undefined) continue;
		if (isRecord(doc) && doc.kind === 'List' && Array.isArray(doc.items)) out.push(...(doc.items.filter(isRecord) as Manifest[]));
		else if (isRecord(doc)) out.push(doc);
		else throw new Error('Every YAML document must be an object.');
	}
	return out;
}

// ---------------------------------------------------------------- helpers

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
	if (!isRecord(parent[key])) parent[key] = {};
	return parent[key] as Record<string, unknown>;
}

function dig(value: unknown, path: string[]): unknown {
	let current = value;
	for (const key of path) {
		if (!isRecord(current)) return undefined;
		current = current[key];
	}
	return current;
}

/** `256Mi` → 256, `1Gi` → 1024, `512M` → 488, plain bytes → MiB. Null when unparseable. */
export function parseMemoryMi(value: unknown): number | null {
	if (typeof value === 'number') return Math.round(value / 1024 / 1024);
	if (typeof value !== 'string') return null;
	const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(value.trim());
	if (!match) return null;
	const amount = Number(match[1]);
	const unit = match[2] ?? '';
	const bytes: Record<string, number> = { '': 1, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
	return Math.round((amount * bytes[unit]!) / 1024 ** 2);
}
