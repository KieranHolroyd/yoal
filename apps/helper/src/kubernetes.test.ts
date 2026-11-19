import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	KUBERNETES_IMAGES,
	renderMachineNetworkUnit,
	renderMeminfo,
	KubernetesOps,
	parseKubernetes,
	parseManifestFiles,
	renderAuthConfig,
	renderK3sArgs,
	renderKubernetesUnit,
	reservedMemoryMb,
} from './kubernetes.ts';
import { prerequisiteProblems, tierPodmanArgs } from './kubernetes-component.ts';
import { parseWorkload, type WorkloadDesired } from './validate.ts';

const profile = {
	clusterId: 'kc_abc',
	role: 'server',
	ordinal: 0,
	serverId: 'km_server1',
	minor: '1.37',
	tier: 'userns',
	schedulable: true,
	ingressPort: 22500,
	traefik: true,
	apiHost: 'lab-org1.k8s.sites.test',
	issuer: 'https://control.test',
	release: 'v1.37.2+k3s1',
	datastore: 'sqlite',
	clusterInit: false,
	serverAddress: 'km-server1',
	overlayIp: null,
	machineSubnet: null,
};

function workload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'km_server1',
		projectId: 'kc_abc',
		projectSlug: 'lab',
		deploymentId: 'kc_abc',
		orgId: 'org_1',
		runtime: 'container',
		status: 'running',
		release: null,
		image: KUBERNETES_IMAGES['1.37'],
		upstream: '127.0.0.1:22000',
		memoryMb: 2048,
		cpus: 1,
		port: 22000,
		healthPath: '/',
		socketActivation: false,
		activationVersion: 'a'.repeat(64),
		env: {},
		secrets: [],
		dataSizeMb: null,
		kubernetes: profile,
		...overrides,
	};
}

describe('kubernetes profile', () => {
	test('parses the wire profile and refuses anything extra', () => {
		expect(parseKubernetes(profile)).toMatchObject({ role: 'server', tier: 'userns', apiHost: 'lab-org1.k8s.sites.test' });
		expect(() => parseKubernetes({ ...profile, image: 'evil' })).toThrow(/not supported/);
		expect(() => parseKubernetes({ ...profile, minor: '1.20' })).toThrow(/not supported by this helper/);
		expect(() => parseKubernetes({ ...profile, release: 'v1.36.6+k3s1' })).toThrow(/belong to 1.37/);
		expect(() => parseKubernetes({ ...profile, serverAddress: 'evil.example.com' })).toThrow(/alias or an overlay/);
		expect(() => parseKubernetes({ ...profile, overlayIp: '10.48.5.10', machineSubnet: '10.48.6.0/24' })).toThrow(/inside the machine subnet/);
		expect(() => parseKubernetes({ ...profile, clusterInit: true })).toThrow(/first etcd server/);
		expect(() => parseKubernetes({ ...profile, tier: 'host' })).toThrow(/tier/);
		expect(() => parseKubernetes({ ...profile, apiHost: 'a b' })).toThrow(/host name/);
		expect(() => parseKubernetes({ ...profile, ingressPort: 80 })).toThrow(/unprivileged/);
	});

	test('a machine workload must use the pinned image and a km_ id', () => {
		expect(parseWorkload(workload()).kubernetes?.role).toBe('server');
		expect(() => parseWorkload(workload({ image: 'docker.io/rancher/k3s:latest' }))).toThrow(/must be docker.io\/rancher\/k3s/);
		expect(() => parseWorkload(workload({ id: 'wl_1' }))).toThrow(/km_/);
		expect(() => parseWorkload(workload({ kubernetes: undefined, id: 'km_x', image: 'nginx' }))).toThrow(/reserved for Kubernetes/);
		expect(() => parseWorkload(workload({ orgId: undefined }))).toThrow(/orgId/);
	});

	test('the auth config trusts the issuer for this cluster and org only', () => {
		const yaml = renderAuthConfig({ issuer: 'https://control.test', clusterId: 'kc_abc', orgId: 'org_1' })!;
		expect(yaml).toContain('url: "https://control.test"');
		expect(yaml).toContain('- "k8s:kc_abc"');
		expect(yaml).toContain('claims.org_id == "org_1"');
		expect(yaml).toContain(`'"yoal:" + claims.sub'`);
		expect(renderAuthConfig({ issuer: 'http://localhost:5173', clusterId: 'kc_abc', orgId: 'org_1' })).toBeNull();
		expect(() => renderAuthConfig({ issuer: 'https://x', clusterId: 'kc', orgId: 'o"; drop' })).toThrow();
	});

	test('k3s args: server flags derive from the profile; agents join the server alias', () => {
		const parsed = parseWorkload(workload()) as WorkloadDesired;
		const args = renderK3sArgs({ workload: parsed, kubernetes: parsed.kubernetes!, authConfig: true });
		expect(args[0]).toBe('server');
		expect(args).toContain('--disable=servicelb');
		expect(args).toContain('--tls-san=lab-org1.k8s.sites.test');
		expect(args).toContain('--kube-apiserver-arg=authentication-config=/etc/yoal/k8s/auth.yaml');
		expect(args).toContain(`--kubelet-arg=system-reserved=memory=${reservedMemoryMb(2048)}Mi`);
		expect(args.some((arg) => arg.startsWith('--node-taint'))).toBe(false);
		const agent = parseWorkload(workload({ id: 'km_agent1', kubernetes: { ...profile, role: 'agent', ordinal: 1 } })) as WorkloadDesired;
		const agentArgs = renderK3sArgs({ workload: agent, kubernetes: agent.kubernetes!, authConfig: false });
		expect(agentArgs.slice(0, 2)).toEqual(['agent', '--server=https://km-server1:6443']);
		// Multi-node: the routed address is the node IP; the first etcd server initialises the cluster.
		const ha = parseWorkload(
			workload({ kubernetes: { ...profile, datastore: 'etcd', clusterInit: true, overlayIp: '10.48.5.10', machineSubnet: '10.48.5.0/24' } }),
		) as WorkloadDesired;
		const haArgs = renderK3sArgs({ workload: ha, kubernetes: ha.kubernetes!, authConfig: true });
		expect(haArgs).toContain('--cluster-init');
		expect(haArgs).toContain('--node-ip=10.48.5.10');
		expect(haArgs).toContain('--flannel-iface=k8s0');
		expect(haArgs).toContain('--advertise-address=10.48.5.10');
		const joiner = parseWorkload(
			workload({
				id: 'km_server2',
				kubernetes: { ...profile, ordinal: 1, datastore: 'etcd', serverAddress: '10.48.5.10', overlayIp: '10.48.6.10', machineSubnet: '10.48.6.0/24' },
			}),
		) as WorkloadDesired;
		const joinArgs = renderK3sArgs({ workload: joiner, kubernetes: joiner.kubernetes!, authConfig: true });
		expect(joinArgs).toContain('--server=https://10.48.5.10:6443');
		expect(joinArgs).not.toContain('--cluster-init');
	});

	test('the unit publishes on loopback only and isolates per tier', () => {
		const parsed = parseWorkload(workload()) as WorkloadDesired;
		const options = {
			workload: parsed,
			envFile: '/run/yoal-workloads/km_server1/env',
			dataDir: '/var/lib/yoal/workloads/km_server1',
			yoalDir: '/run/yoal-workloads/km_server1/k8s',
			airgapDir: '/usr/lib/yoal/k3s/1.37/images',
			networkUnit: 'yoal-org-org_1.network',
			userns: 'auto:size=65536',
			slice: 'yoal-workloads.slice',
			authConfig: true,
		};
		const unit = renderKubernetesUnit(options);
		expect(unit).toContain('PublishPort=127.0.0.1:22000:6443');
		expect(unit).toContain('PublishPort=127.0.0.1:22500:80');
		expect(unit).not.toMatch(/PublishPort=(0\.0\.0\.0|10\.)/);
		expect(unit).toContain('UserNS=auto:size=65536');
		expect(unit).toContain('/k3s:/var/lib/rancher/k3s:U');
		expect(unit).toContain('/kubelet:/var/lib/kubelet:U');
		expect(unit).toContain('Entrypoint=/etc/yoal/k8s/entrypoint.sh');
		expect(unit).toContain('Volume=/run/yoal-workloads/km_server1/k8s/meminfo:/proc/meminfo:ro');
		expect(unit).toContain('Restart=always');
		expect(unit).toContain('PodmanArgs=--oom-score-adj=-999');
		expect(unit).toContain('MemoryMax=2048M');
		expect(unit).toContain('Volume=/usr/lib/yoal/k3s/1.37/images:/var/lib/rancher/k3s/agent/images:ro');
		const trusted = renderKubernetesUnit({
			...options,
			workload: parseWorkload(workload({ kubernetes: { ...profile, tier: 'trusted' } })) as WorkloadDesired,
		});
		expect(trusted).not.toContain('UserNS=');
		expect(trusted).toContain('PodmanArgs=--privileged');
	});

	test('manifest names are fixed to the yoal- prefix', () => {
		expect(parseManifestFiles({ 'yoal-rbac.yaml': 'x' })).toEqual({ 'yoal-rbac.yaml': 'x' });
		expect(() => parseManifestFiles({ '../etc/passwd': 'x' })).toThrow(/not allowed/);
		expect(() => parseManifestFiles({ 'other.yaml': 'x' })).toThrow(/not allowed/);
	});

	test('manifest sync writes new files and deletes the objects of removed ones', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-k8s-helper-'));
		try {
			const manifests = join(dir, 'k3s/server/manifests');
			mkdirSync(manifests, { recursive: true });
			writeFileSync(join(manifests, 'yoal-old.yaml'), 'kind: Secret\n');
			writeFileSync(join(manifests, 'user-own.yaml'), 'kind: ConfigMap\n');
			const calls: Array<{ argv: string[]; stdin?: string }> = [];
			const ops = new KubernetesOps({
				runner: { run: async (argv, options) => (calls.push({ argv, ...(options?.stdin ? { stdin: options.stdin } : {}) }), { code: 0, stdout: '', stderr: '' }) },
				podmanPath: '/usr/bin/podman',
				resolveDataDir: async () => dir,
				chownLike: async () => undefined,
			});
			const result = await ops.syncManifests('km_server1', { 'yoal-rbac.yaml': 'kind: ClusterRoleBinding\n' });
			expect(result).toEqual({ written: ['yoal-rbac.yaml'], removed: ['yoal-old.yaml'] });
			expect(calls[0]!.argv).toEqual(['/usr/bin/podman', 'exec', '-i', 'yoal-workload-km_server1', 'k3s', 'kubectl', 'delete', '--ignore-not-found', '--wait=false', '-f', '-']);
			expect(calls[0]!.stdin).toBe('kind: Secret\n');
			expect(readdirSync(manifests).sort()).toEqual(['user-own.yaml', 'yoal-rbac.yaml']);
			expect(readFileSync(join(manifests, 'yoal-rbac.yaml'), 'utf8')).toBe('kind: ClusterRoleBinding\n');
			// Unchanged content is not rewritten.
			expect((await ops.syncManifests('km_server1', { 'yoal-rbac.yaml': 'kind: ClusterRoleBinding\n' })).written).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('status parses node readiness and deprecated APIs', async () => {
		const ops = new KubernetesOps({
			runner: {
				run: async (argv) => {
					const joined = argv.join(' ');
					if (joined.endsWith('/readyz')) return { code: 0, stdout: 'ok', stderr: '' };
					if (joined.includes('get nodes'))
						return {
							code: 0,
							stdout: JSON.stringify({
								items: [
									{ status: { conditions: [{ type: 'Ready', status: 'True' }] } },
									{ status: { conditions: [{ type: 'Ready', status: 'False' }] } },
								],
							}),
							stderr: '',
						};
					return {
						code: 0,
						stdout: 'apiserver_requested_deprecated_apis{group="policy",removed_release="1.38",resource="podsecuritypolicies",subresource="",version="v1beta1"} 1\n',
						stderr: '',
					};
				},
			},
			podmanPath: '/usr/bin/podman',
			resolveDataDir: async () => '/tmp',
			chownLike: async () => undefined,
		});
		expect(await ops.status('km_server1')).toEqual({
			apiReady: true,
			nodesReady: 1,
			nodesTotal: 2,
			deprecatedApis: ['policy/v1beta1/podsecuritypolicies (removed in 1.38)'],
		});
	});
});

describe('kubernetes component', () => {
	test('prerequisites need cgroup v2 controllers and 2 GB', () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-k8s-pre-'));
		try {
			writeFileSync(join(dir, 'controllers'), 'cpuset cpu io memory pids\n');
			writeFileSync(join(dir, 'meminfo'), 'MemTotal:        4000000 kB\n');
			expect(prerequisiteProblems({ cgroupControllers: join(dir, 'controllers'), meminfo: join(dir, 'meminfo') })).toEqual([]);
			writeFileSync(join(dir, 'meminfo'), 'MemTotal:        1000000 kB\n');
			writeFileSync(join(dir, 'controllers'), 'cpu io\n');
			const problems = prerequisiteProblems({ cgroupControllers: join(dir, 'controllers'), meminfo: join(dir, 'meminfo') });
			expect(problems.join(' ')).toContain('memory controller');
			expect(problems.join(' ')).toContain('at least 2 GB');
			expect(prerequisiteProblems({ cgroupControllers: join(dir, 'missing'), meminfo: join(dir, 'meminfo') })[0]).toContain('cgroup v2');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('the probe uses the same isolation flags as the unit', () => {
		expect(tierPodmanArgs('userns')).toContain('--userns=auto:size=65536');
		expect(tierPodmanArgs('trusted')).not.toContain('--userns=auto:size=65536');
		expect(tierPodmanArgs('trusted')).toContain('--privileged');
	});
});

describe('kubernetes machine helpers', () => {
	test('meminfo reports the machine limit and no swap', () => {
		const out = renderMeminfo('MemTotal:       16000000 kB\nMemFree:         8000000 kB\nMemAvailable:   12000000 kB\nBuffers:           1000 kB\nSwapTotal:       2000000 kB\nSwapFree:        2000000 kB', 2048);
		expect(out).toContain('MemTotal:        2097152 kB');
		expect(out).toContain('MemAvailable:    2097152 kB');
		expect(out).toContain('SwapTotal:             0 kB');
		expect(out).toContain('Buffers:           1000 kB');
	});

	test('the machine network is the node subnet with headroom for WireGuard and VXLAN', () => {
		const unit = renderMachineNetworkUnit('10.48.5.0/24');
		expect(unit).toContain('Subnet=10.48.5.0/24');
		expect(unit).toContain('Gateway=10.48.5.1');
		expect(unit).toContain('Options=mtu=1370');
		expect(unit).toContain('Options=metric=50');
		expect(unit).toContain('PodmanArgs=--route=10.48.0.0/16,10.48.5.1');
		expect(() => renderMachineNetworkUnit('10.0.0.0/8')).toThrow();
	});
});

describe('machine nat (S3)', () => {
	test('machine-to-machine traffic keeps its source address', async () => {
		const { NetworkManager } = await import('./network.ts');
		const rules = new NetworkManager().renderMachineNat(['10.48.0.0/16']);
		expect(rules).toContain('priority srcnat - 10');
		expect(rules).toContain('ip saddr 10.48.0.0/16 ip daddr 10.48.0.0/16 snat ip to ip saddr');
	});
});
