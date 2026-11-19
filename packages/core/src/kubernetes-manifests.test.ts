import { describe, expect, test } from 'bun:test';
import { lintManifests, manifestsToYaml, parseManifestYaml, parseMemoryMi, type ManifestContext } from './kubernetes-manifests.ts';

const context: ManifestContext = {
	cluster: 'lab',
	minor: '1.37',
	namespace: 'apps',
	ingressClass: 'traefik',
	routeHosts: ['shop.sites.test'],
	contentDomain: 'sites.test',
	secrets: [{ namespace: 'apps', name: 'yoal-db', keys: ['URL', 'HOST', 'PASSWORD'], kind: 'database' }],
	storageClasses: ['local-path'],
	defaultStorageClass: 'local-path',
	allocatableMemoryMi: 1024,
	registryHost: 'registry.sites.test',
};

const deployment = (overrides: Record<string, unknown> = {}) => ({
	apiVersion: 'apps/v1',
	kind: 'Deployment',
	metadata: { name: 'web' },
	spec: {
		replicas: 1,
		selector: { matchLabels: { app: 'web' } },
		template: {
			metadata: { labels: { app: 'web' } },
			spec: { containers: [{ name: 'web', image: 'nginx:1.27', ports: [{ containerPort: 80 }], readinessProbe: { httpGet: { path: '/', port: 80 } } }] },
		},
	},
	...overrides,
});

const messages = (result: ReturnType<typeof lintManifests>, severity?: string) =>
	result.findings.filter((finding) => !severity || finding.severity === severity).map((finding) => finding.message).join('\n');

describe('lintManifests', () => {
	test('a clean deployment passes and gets defaults filled', () => {
		const result = lintManifests([deployment()], context);
		expect(result.ok).toBe(true);
		const doc = result.manifests[0] as any;
		expect(doc.metadata.namespace).toBe('apps');
		expect(doc.metadata.annotations['yoal.io/generated-by']).toBe('yoal-ai');
		expect(doc.spec.template.spec.containers[0].resources).toEqual({ requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '256Mi' } });
	});

	test('structural errors are errors', () => {
		const result = lintManifests([{ kind: 'Deployment', metadata: { name: 'Bad_Name' }, spec: {} }, 'nope'], context);
		expect(result.ok).toBe(false);
		expect(messages(result, 'error')).toContain('not a valid name');
		expect(messages(result, 'error')).toContain('Missing the pod template');
		expect(messages(result, 'error')).toContain('must be an object');
	});

	test('LoadBalancer becomes ClusterIP; old API versions are upgraded', () => {
		const result = lintManifests(
			[{ apiVersion: 'v1', kind: 'Service', metadata: { name: 'web' }, spec: { type: 'LoadBalancer', selector: { app: 'web' }, ports: [{ port: 80 }] } }, { ...deployment(), apiVersion: 'extensions/v1beta1' }],
			context,
		);
		expect((result.manifests[0] as any).spec.type).toBe('ClusterIP');
		expect((result.manifests[1] as any).apiVersion).toBe('apps/v1');
		expect(result.ok).toBe(true);
	});

	test('ingress: class set, TLS dropped, unclaimed hosts explained', () => {
		const result = lintManifests(
			[
				{
					apiVersion: 'networking.k8s.io/v1',
					kind: 'Ingress',
					metadata: { name: 'web' },
					spec: { tls: [{ hosts: ['x'] }], rules: [{ host: 'blog.sites.test' }, { host: 'example.com' }] },
				},
			],
			context,
		);
		const spec = (result.manifests[0] as any).spec;
		expect(spec.ingressClassName).toBe('traefik');
		expect(spec.tls).toBeUndefined();
		expect(messages(result, 'warning')).toContain('yoal k8s route add lab blog');
		expect(messages(result, 'warning')).toContain('example.com is not one of');
		expect(lintManifests([{ kind: 'Ingress', metadata: { name: 'x' }, spec: { rules: [] } }], { ...context, ingressClass: null }).ok).toBe(false);
	});

	test('secret references must exist and keys must match the attachment', () => {
		const result = lintManifests(
			[
				deployment({
					spec: {
						selector: { matchLabels: { app: 'web' } },
						template: {
							metadata: { labels: { app: 'web' } },
							spec: {
								containers: [
									{
										name: 'web',
										image: 'app:1',
										env: [{ name: 'DB', valueFrom: { secretKeyRef: { name: 'yoal-db', key: 'DATABASE_URL' } } }],
										envFrom: [{ secretRef: { name: 'missing' } }],
									},
								],
							},
						},
					},
				}),
			],
			context,
		);
		expect(messages(result, 'error')).toContain('Secret yoal-db has no key DATABASE_URL; its keys are URL, HOST, PASSWORD');
		expect(messages(result, 'warning')).toContain('Secret missing does not exist');
	});

	test('literal secrets, hostPath, privileged and :latest are warned about', () => {
		const result = lintManifests(
			[
				{ apiVersion: 'v1', kind: 'Secret', metadata: { name: 's' }, stringData: { password: 'hunter2' } },
				deployment({
					spec: {
						selector: { matchLabels: { app: 'web' } },
						template: {
							metadata: { labels: { app: 'web' } },
							spec: {
								volumes: [{ name: 'root', hostPath: { path: '/' } }],
								containers: [{ name: 'web', image: 'nginx:latest', securityContext: { privileged: true } }],
							},
						},
					},
				}),
			],
			context,
		);
		const warnings = messages(result, 'warning');
		expect(warnings).toContain('literal values');
		expect(warnings).toContain('hostPath');
		expect(warnings).toContain('privileged');
		expect(warnings).toContain('no fixed tag');
	});

	test('storage class and access modes follow the cluster', () => {
		const result = lintManifests(
			[{ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'data' }, spec: { storageClassName: 'gp3', accessModes: ['ReadWriteMany'] } }],
			context,
		);
		const spec = (result.manifests[0] as any).spec;
		expect(spec.storageClassName).toBe('local-path');
		expect(spec.resources.requests.storage).toBe('1Gi');
		expect(messages(result, 'warning')).toContain('ReadWriteOnce');
	});

	test('selectors must match pod labels; capacity is checked across replicas', () => {
		const mismatch = lintManifests(
			[deployment({ spec: { selector: { matchLabels: { app: 'other' } }, template: { metadata: { labels: { app: 'web' } }, spec: { containers: [{ name: 'web', image: 'a:1' }] } } } })],
			context,
		);
		expect(messages(mismatch, 'error')).toContain('does not match');
		const big = lintManifests(
			[deployment({ spec: { replicas: 5, selector: { matchLabels: { app: 'web' } }, template: { metadata: { labels: { app: 'web' } }, spec: { containers: [{ name: 'web', image: 'a:1', resources: { requests: { memory: '512Mi' } } }] } } } })],
			context,
		);
		expect(messages(big, 'warning')).toContain('request 2560 MiB');
	});

	test('cluster-scoped kinds lose their namespace; duplicates are errors', () => {
		const result = lintManifests(
			[
				{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'apps', namespace: 'x' } },
				{ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'c' } },
				{ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'c' } },
			],
			context,
		);
		expect((result.manifests[0] as any).metadata.namespace).toBeUndefined();
		expect(messages(result, 'error')).toContain('appears twice');
	});
});

describe('YAML', () => {
	test('emits readable YAML that parses back to the same objects', () => {
		const docs = lintManifests(
			[deployment(), { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'c' }, data: { 'app.conf': 'a: 1\nb: 2\n', yes: 'no', port: '8080', empty: '' } }],
			context,
		).manifests;
		const yaml = manifestsToYaml(docs);
		expect(yaml).toContain('---\napiVersion: v1');
		expect(yaml).toContain('  app.conf: |\n    a: 1\n    b: 2');
		expect(yaml).toContain('"yes": "no"');
		expect(yaml).toContain('port: "8080"');
		const back = parseManifestYaml(yaml);
		expect(back).toEqual(JSON.parse(JSON.stringify(docs)));
	});

	test('parses Lists and rejects scalars', () => {
		expect(parseManifestYaml('kind: List\nitems:\n- kind: ConfigMap\n  metadata: {name: a}\n')).toHaveLength(1);
		expect(() => parseManifestYaml('just text')).toThrow();
	});

	test('memory quantities', () => {
		expect(parseMemoryMi('256Mi')).toBe(256);
		expect(parseMemoryMi('1Gi')).toBe(1024);
		expect(parseMemoryMi('nope')).toBeNull();
	});
});
