import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import {
	ValidationError,
	assertId,
	assertInteger,
	assertRecord,
	assertString,
	workloadNetworkName,
	type WorkloadDesired,
} from './validate.ts';

/**
 * Managed Kubernetes machines (docs/KUBERNETES.md §5). Each k3s server or agent is a container
 * the helper starts from its own pinned registry (D61): the wire carries a minor, a role and a tier,
 * and the helper derives the image, flags, mounts and the API server's authentication config.
 *
 * Tiers (K4, §5.2):
 * - `userns`: privileged inside a per-container user namespace, so root in the machine maps to an
 *   unprivileged host uid range (D138).
 * - `trusted`: privileged without a user namespace. A cluster admin can become root on the node,
 *   which is why the control plane only places it on nodes dedicated to the cluster's org.
 */

export const KUBERNETES_ID_PREFIX = 'km_';
export const KUBERNETES_COMPONENT_ROOT = '/usr/lib/yoal/k3s';
/** Where the k3s data dir is mounted inside the machine. */
export const K3S_DATA_DIR = '/var/lib/rancher/k3s';
/** Helper-written files (entrypoint, meminfo, authentication config) mounted read-only here. */
export const K3S_YOAL_DIR = '/etc/yoal/k8s';
/** The image's declared VOLUMEs, each backed by a subdirectory of the machine's data dir. */
export const K3S_VOLUMES: ReadonlyArray<readonly [string, string]> = [
	['k3s', '/var/lib/rancher/k3s'],
	['kubelet', '/var/lib/kubelet'],
	['cni', '/var/lib/cni'],
	['log', '/var/log'],
];

/** k3d's cgroup v2 entrypoint (S1): evacuate the root cgroup, enable every controller, exec k3s. */
export const K3S_ENTRYPOINT = `#!/bin/sh
set -e
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  mkdir -p /sys/fs/cgroup/init
  xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs || :
  sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control
fi
# A restored etcd snapshot (K14): reset the member onto it once, then start normally.
restore=/var/lib/rancher/k3s/server/db/yoal-restore.db
if [ "$1" = server ] && [ -f "$restore" ]; then
  /bin/k3s "$@" --cluster-reset --cluster-reset-restore-path="$restore" || true
  rm -f "$restore"
fi
exec /bin/k3s "$@"
`;

/**
 * Traefik on the machine's own port 80 (S1): servicelb is off, so the web entrypoint binds a
 * hostPort in the machine's network namespace, which the unit publishes on loopback.
 */
export const TRAEFIK_CONFIG_MANIFEST = `apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    deployment:
      kind: DaemonSet
    nodeSelector:
      node-role.kubernetes.io/control-plane: "true"
    tolerations:
    - key: node-role.kubernetes.io/control-plane
      operator: Exists
      effect: NoSchedule
    service:
      type: ClusterIP
    ports:
      web:
        hostPort: 80
      websecure:
        hostPort: 443
`;

/** A /proc/meminfo whose totals are the machine's limit (S2), rendered from the host's. */
export function renderMeminfo(hostMeminfo: string, memoryMb: number): string {
	const kb = memoryMb * 1024;
	return hostMeminfo
		.split('\n')
		.map((line) => {
			const key = /^([A-Za-z_()]+):/.exec(line)?.[1];
			if (key === 'MemTotal' || key === 'MemFree' || key === 'MemAvailable') return `${`${key}:`.padEnd(16)}${String(kb).padStart(8)} kB`;
			if (key === 'SwapTotal' || key === 'SwapFree') return `${`${key}:`.padEnd(16)}${'0'.padStart(8)} kB`;
			return line;
		})
		.join('\n');
}
/** Name of the auto-deploy directory inside the data dir. */
export const K3S_MANIFESTS_SUBDIR = 'k3s/server/manifests';

/**
 * The helper's own copy of the version registry. A wider contract must not widen what the
 * privileged helper runs: a minor that is not here is refused.
 */
export const KUBERNETES_RELEASE_IMAGES: Record<string, string> = {
	'v1.37.2+k3s1': 'docker.io/rancher/k3s:v1.37.2-k3s1@sha256:21ea6e0fac4e3930c2ce8aa40ddd41a8b18cb3e9a0222c030dc005e7e88c4332',
	'v1.36.6+k3s1': 'docker.io/rancher/k3s:v1.36.6-k3s1@sha256:88d3fac10eb4a429d3c5275f4868fe4b13620f6bbca5bdb5dca0627ac76ae2a0',
	'v1.35.10+k3s1': 'docker.io/rancher/k3s:v1.35.10-k3s1@sha256:8262ca99a558dca0c0437443421986480b2359f9118f2371359f88a41514522f',
};

/** The current pin per minor (what the component pre-pulls). */
export const KUBERNETES_IMAGES: Record<string, string> = {
	'1.37': 'docker.io/rancher/k3s:v1.37.2-k3s1@sha256:21ea6e0fac4e3930c2ce8aa40ddd41a8b18cb3e9a0222c030dc005e7e88c4332',
	'1.36': 'docker.io/rancher/k3s:v1.36.6-k3s1@sha256:88d3fac10eb4a429d3c5275f4868fe4b13620f6bbca5bdb5dca0627ac76ae2a0',
	'1.35': 'docker.io/rancher/k3s:v1.35.10-k3s1@sha256:8262ca99a558dca0c0437443421986480b2359f9118f2371359f88a41514522f',
};

export type KubernetesTier = 'userns' | 'trusted';

export interface WorkloadKubernetes {
	clusterId: string;
	role: 'server' | 'agent';
	ordinal: number;
	release: string;
	serverId: string;
	datastore: 'sqlite' | 'etcd';
	clusterInit: boolean;
	serverAddress: string;
	overlayIp: string | null;
	machineSubnet: string | null;
	minor: string;
	tier: KubernetesTier;
	schedulable: boolean;
	ingressPort: number;
	traefik: boolean;
	apiHost: string | null;
	issuer: string;
}

const HOST_PATTERN = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function kubernetesImage(minor: string): string {
	const image = KUBERNETES_IMAGES[minor];
	if (!image) throw new ValidationError(`Kubernetes ${minor} is not supported by this helper`);
	return image;
}

export function kubernetesReleaseImage(release: string): string {
	const image = KUBERNETES_RELEASE_IMAGES[release];
	if (!image) throw new ValidationError(`k3s ${release} is not pinned in this helper`);
	return image;
}

/** `km-<hex>`: the machine's alias on the org network; same derivation as the contract. */
export function kubernetesMachineAlias(id: string): string {
	return `km-${id.replace(/^km_/, '').toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
}

export function assertKubernetesId(value: unknown, label = 'machine id'): string {
	const id = assertId(value, label);
	if (!id.startsWith(KUBERNETES_ID_PREFIX) || id.length === KUBERNETES_ID_PREFIX.length)
		throw new ValidationError(`${label} must start with "${KUBERNETES_ID_PREFIX}"`);
	return id;
}

export function parseKubernetes(value: unknown, label = 'workload.kubernetes'): WorkloadKubernetes {
	const record = assertRecord(value, label);
	const allowed = new Set([
		'clusterId',
		'role',
		'ordinal',
		'serverId',
		'minor',
		'tier',
		'schedulable',
		'ingressPort',
		'traefik',
		'apiHost',
		'issuer',
		'release',
		'datastore',
		'clusterInit',
		'serverAddress',
		'overlayIp',
		'machineSubnet',
	]);
	for (const key of Object.keys(record))
		if (!allowed.has(key)) throw new ValidationError(`${label}.${key} is not supported`);
	const clusterId = assertId(record.clusterId, `${label}.clusterId`);
	const role = record.role;
	if (role !== 'server' && role !== 'agent') throw new ValidationError(`${label}.role must be "server" or "agent"`);
	const ordinal = assertInteger(record.ordinal, `${label}.ordinal`, 0, 64);
	const serverId = assertKubernetesId(record.serverId, `${label}.serverId`);
	const minor = assertString(record.minor, `${label}.minor`, { max: 8 });
	kubernetesImage(minor);
	const tier = record.tier;
	if (tier !== 'userns' && tier !== 'trusted') throw new ValidationError(`${label}.tier must be "userns" or "trusted"`);
	if (typeof record.schedulable !== 'boolean') throw new ValidationError(`${label}.schedulable must be a boolean`);
	if (typeof record.traefik !== 'boolean') throw new ValidationError(`${label}.traefik must be a boolean`);
	const ingressPort = assertInteger(record.ingressPort, `${label}.ingressPort`, 0, 65_535);
	if (ingressPort !== 0 && ingressPort < 1024) throw new ValidationError(`${label}.ingressPort must be unprivileged`);
	let apiHost: string | null = null;
	if (record.apiHost !== null && record.apiHost !== undefined) {
		apiHost = assertString(record.apiHost, `${label}.apiHost`, { max: 253 }).toLowerCase();
		if (!HOST_PATTERN.test(apiHost)) throw new ValidationError(`${label}.apiHost is not a host name`);
	}
	const issuer = assertString(record.issuer, `${label}.issuer`, { max: 512 });
	let parsed: URL;
	try {
		parsed = new URL(issuer);
	} catch {
		throw new ValidationError(`${label}.issuer must be a URL`);
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new ValidationError(`${label}.issuer must be http(s)`);
	if (parsed.search || parsed.hash || parsed.username) throw new ValidationError(`${label}.issuer must be a plain origin`);
	const release = assertString(record.release, `${label}.release`, { max: 32 });
	kubernetesReleaseImage(release);
	if (!release.startsWith(`v${minor}.`)) throw new ValidationError(`${label}.release must belong to ${minor}`);
	const datastore = record.datastore ?? 'sqlite';
	if (datastore !== 'sqlite' && datastore !== 'etcd') throw new ValidationError(`${label}.datastore must be "sqlite" or "etcd"`);
	const clusterInit = record.clusterInit ?? false;
	if (typeof clusterInit !== 'boolean') throw new ValidationError(`${label}.clusterInit must be a boolean`);
	if (clusterInit && (role !== 'server' || datastore !== 'etcd'))
		throw new ValidationError(`${label}.clusterInit is only for the first etcd server`);
	const serverAddress = assertString(record.serverAddress, `${label}.serverAddress`, { max: 253 }).toLowerCase();
	if (!IPV4.test(serverAddress) && !/^km-[a-z0-9-]{1,64}$/.test(serverAddress))
		throw new ValidationError(`${label}.serverAddress must be a machine alias or an overlay address`);
	const overlayIp = record.overlayIp === undefined || record.overlayIp === null ? null : assertString(record.overlayIp, `${label}.overlayIp`, { max: 15 });
	const machineSubnet =
		record.machineSubnet === undefined || record.machineSubnet === null ? null : assertString(record.machineSubnet, `${label}.machineSubnet`, { max: 18 });
	if (overlayIp !== null || machineSubnet !== null) {
		if (!overlayIp || !IPV4.test(overlayIp)) throw new ValidationError(`${label}.overlayIp must be an IPv4 address`);
		if (!machineSubnet || !/^(?:\d{1,3}\.){3}0\/24$/.test(machineSubnet)) throw new ValidationError(`${label}.machineSubnet must be a /24`);
		if (!overlayIp.startsWith(machineSubnet.slice(0, machineSubnet.lastIndexOf('.') + 1)))
			throw new ValidationError(`${label}.overlayIp must be inside the machine subnet`);
		const host = Number(overlayIp.split('.')[3]);
		if (host < 2 || host > 254) throw new ValidationError(`${label}.overlayIp host part must be 2–254`);
	}
	if (role === 'server' && ordinal !== 0 && datastore !== 'etcd')
		throw new ValidationError(`${label}.ordinal must be 0 for a SQLite server`);
	return {
		clusterId,
		role,
		ordinal,
		serverId,
		minor,
		tier,
		schedulable: record.schedulable,
		ingressPort: role === 'server' ? ingressPort : 0,
		traefik: record.traefik,
		apiHost,
		issuer: issuer.replace(/\/+$/, ''),
		release,
		datastore,
		clusterInit,
		serverAddress,
		overlayIp,
		machineSubnet,
	};
}

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * The API server's structured authentication configuration (K8). The platform issuer is trusted
 * for this cluster's audience only, the org claim must match, and the username and groups come from
 * Yoal's claims. Kubernetes requires an https issuer, so a plain-http dev install gets none (only
 * the admin certificate works there).
 */
export function renderAuthConfig(input: { issuer: string; clusterId: string; orgId: string }): string | null {
	if (!input.issuer.startsWith('https://')) return null;
	if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.orgId)) throw new ValidationError('orgId is not safe for the auth config');
	return [
		'apiVersion: apiserver.config.k8s.io/v1',
		'kind: AuthenticationConfiguration',
		'jwt:',
		'- issuer:',
		`    url: ${JSON.stringify(input.issuer)}`,
		'    audiences:',
		`    - ${JSON.stringify(`k8s:${input.clusterId}`)}`,
		'  claimValidationRules:',
		`  - expression: 'has(claims.org_id) && claims.org_id == "${input.orgId}"'`,
		'    message: the token is for another organisation',
		'  claimMappings:',
		'    username:',
		`      expression: '"yoal:" + claims.sub'`,
		'    groups:',
		`      expression: 'has(claims.k8s_groups) ? claims.k8s_groups : []'`,
		'    uid:',
		`      expression: 'claims.sub'`,
		'  userValidationRules:',
		`  - expression: "!user.username.startsWith('system:')"`,
		'    message: the system prefix is reserved',
		'',
	].join('\n');
}

/** Memory the kubelet keeps for the machine's own processes (k3s, containerd). */
export function reservedMemoryMb(memoryMb: number): number {
	// S2: with 512Mi reserved the OOM killer took k3s itself; 768Mi is the floor.
	return Math.min(1536, Math.max(768, Math.round(memoryMb * 0.3)));
}

/** k3s argv after the image entrypoint. Every value is derived or validated; nothing is passed through. */
export function renderK3sArgs(input: {
	workload: WorkloadDesired;
	kubernetes: WorkloadKubernetes;
	authConfig: boolean;
}): string[] {
	const { workload, kubernetes } = input;
	const alias = kubernetesMachineAlias(workload.id);
	const reserve = reservedMemoryMb(workload.memoryMb);
	const common = [
		`--node-name=${workload.id.replace(/_/g, '-').toLowerCase()}`,
		// The cgroup limit, not the host's memory, is what pods may use (K16).
		`--kubelet-arg=system-reserved=memory=${reserve}Mi`,
		// k3s sets no memory signal by default; list all three so the kubelet evicts before the OOM killer (S2).
		'--kubelet-arg=eviction-hard=memory.available<200Mi,nodefs.available<5%,imagefs.available<5%',
		'--kubelet-arg=fail-swap-on=false',
	];
	// On a multi-node cluster the machine's own routed address is its node IP (K6), so flannel and
	// etcd use it and peers on other nodes reach it over the overlay.
	// flannel ignores --node-ip and follows the default route unless pinned to the routed interface (S3).
	if (kubernetes.overlayIp) common.push(`--node-ip=${kubernetes.overlayIp}`, `--flannel-iface=${KUBERNETES_MACHINE_IFACE}`);
	const join = `--server=https://${kubernetes.serverAddress}:6443`;
	if (kubernetes.role === 'agent') return ['agent', join, ...common];
	const joining = kubernetes.datastore === 'etcd' && !kubernetes.clusterInit;
	const args = [
		'server',
		...(kubernetes.clusterInit ? ['--cluster-init'] : []),
		...(joining ? [join] : []),
		...(kubernetes.overlayIp ? [`--tls-san=${kubernetes.overlayIp}`, `--advertise-address=${kubernetes.overlayIp}`] : []),
		'--disable=servicelb',
		'--write-kubeconfig-mode=0600',
		`--tls-san=${alias}`,
		'--tls-san=127.0.0.1',
		...(kubernetes.apiHost ? [`--tls-san=${kubernetes.apiHost}`] : []),
		...(kubernetes.traefik ? [] : ['--disable=traefik']),
		...(kubernetes.schedulable ? [] : ['--node-taint=node-role.kubernetes.io/control-plane:NoSchedule']),
		// Anonymous requests are refused everywhere (S1, S5); Caddy also turns them away first.
		'--kube-apiserver-arg=anonymous-auth=false',
		...(input.authConfig ? [`--kube-apiserver-arg=authentication-config=${K3S_YOAL_DIR}/auth.yaml`] : []),
		// Bring a restored etcd snapshot back before the first normal start (the entrypoint handles it).
		...common,
	];
	return args;
}

/** Quote one argv entry for a Quadlet `Exec=` line. */
function quoteExec(arg: string): string {
	return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

export interface KubernetesUnitOptions {
	workload: WorkloadDesired;
	envFile: string;
	dataDir: string;
	/** Host directory holding the entrypoint, `meminfo` and (servers) `auth.yaml`, mounted read-only. */
	yoalDir: string | null;
	/** The airgap images directory for this minor, or null when the component has none. */
	airgapDir: string | null;
	networkUnit: string;
	/** `yoal-k8s.network` when the machine has a routed address (K6). */
	machineNetworkUnit?: string | null;
	userns: string;
	slice: string;
	authConfig: boolean;
}

/**
 * Quadlet `.container` for one machine. Ports publish on loopback only (D56): the API (server) and
 * the bundled ingress (server, when on). Agents publish nothing and join the server over the org
 * network.
 */
export function renderKubernetesUnit(options: KubernetesUnitOptions): string {
	const { workload } = options;
	const kubernetes = workload.kubernetes;
	if (!kubernetes) throw new ValidationError('renderKubernetesUnit needs a kubernetes workload');
	const server = kubernetes.role === 'server';
	const lines: string[] = [];
	lines.push('[Unit]');
	lines.push(
		`Description=Yoal Kubernetes ${kubernetes.role} ${workload.id} (${workload.projectSlug}, ${kubernetes.minor}, ${kubernetes.tier})`,
	);
	lines.push('After=network-online.target');
	lines.push('Wants=network-online.target');
	lines.push('StartLimitIntervalSec=600');
	lines.push('StartLimitBurst=10');
	lines.push('');
	lines.push('[Container]');
	lines.push(`ContainerName=yoal-workload-${workload.id}`);
	lines.push(`Image=${kubernetesReleaseImage(kubernetes.release)}`);
	// cgroup v2 nesting (S1): the entrypoint moves k3s out of the container's root cgroup so the
	// kubelet can delegate controllers to kubepods, as k3d does.
	lines.push(`Entrypoint=${K3S_YOAL_DIR}/entrypoint.sh`);
	lines.push(`Exec=${renderK3sArgs({ workload, kubernetes, authConfig: options.authConfig }).map(quoteExec).join(' ')}`);
	lines.push(`HostName=${kubernetesMachineAlias(workload.id)}`);
	if (server) {
		lines.push(`PublishPort=127.0.0.1:${workload.port}:6443`);
		if (kubernetes.ingressPort > 0) lines.push(`PublishPort=127.0.0.1:${kubernetes.ingressPort}:80`);
	}
	// Multi-node machines are first on the routed `yoal-k8s` network with a fixed address (K6); every
	// machine also joins its org network so attachments resolve.
	if (kubernetes.overlayIp && options.machineNetworkUnit)
		lines.push(`Network=${options.machineNetworkUnit}:ip=${kubernetes.overlayIp},interface_name=${KUBERNETES_MACHINE_IFACE}`);
	lines.push(`Network=${options.networkUnit}`);
	lines.push(`NetworkAlias=${kubernetesMachineAlias(workload.id)}`);
	lines.push(`EnvironmentFile=${options.envFile}`);
	// k3s needs a writable /run and its own cgroup tree; containerd runs nested inside.
	lines.push('Tmpfs=/run');
	lines.push('Tmpfs=/var/run');
	lines.push('PodmanArgs=--privileged');
	// In a user namespace the kubelet cannot shield k3s from the OOM killer itself (S2).
	lines.push('PodmanArgs=--oom-score-adj=-999');
	lines.push('PodmanArgs=--cgroupns=private');
	lines.push('SecurityLabelDisable=true');
	// The image declares these as VOLUMEs; each gets a directory under the data dir so no anonymous
	// volume is left behind (S1). Root in a `userns` machine is an unprivileged host uid (D138), and
	// `U` hands the directories to it.
	if (kubernetes.tier === 'userns') lines.push(`UserNS=${options.userns}`);
	const owned = kubernetes.tier === 'userns' ? ':U' : '';
	for (const [sub, target] of K3S_VOLUMES) lines.push(`Volume=${options.dataDir}/${sub}:${target}${owned}`);
	if (options.airgapDir) lines.push(`Volume=${options.airgapDir}:${K3S_DATA_DIR}/agent/images:ro`);
	if (options.yoalDir) {
		lines.push(`Volume=${options.yoalDir}:${K3S_YOAL_DIR}:ro`);
		// MemTotal is the unit's limit, so the kubelet's capacity matches MemoryMax (S2, K16).
		lines.push(`Volume=${options.yoalDir}/meminfo:/proc/meminfo:ro`);
	}
	lines.push('');
	lines.push('[Service]');
	// k3s exits 0 on some fatal errors (a bad auth config, S5), so restart on any exit.
	lines.push('Restart=always');
	lines.push('RestartSec=10');
	// The first start pulls the image and imports the airgap bundle.
	lines.push('TimeoutStartSec=900');
	lines.push('TimeoutStopSec=90');
	lines.push(`MemoryMax=${workload.memoryMb}M`);
	lines.push(`CPUQuota=${Math.max(1, Math.round(workload.cpus * 100))}%`);
	lines.push('TasksMax=8192');
	lines.push('Delegate=yes');
	lines.push(`Slice=${options.slice}`);
	lines.push('');
	lines.push('[Install]');
	lines.push('WantedBy=default.target');
	return `${lines.join('\n')}\n`;
}

/** The env file entries k3s reads: the join token, and the server URL for agents. */
export function kubernetesEnv(workload: WorkloadDesired, token: string | undefined): Record<string, string> {
	if (!token || !/^[A-Za-z0-9_-]{16,200}$/.test(token))
		throw new ValidationError('A Kubernetes machine needs its join token in the activation (YOAL_K8S_TOKEN)');
	return { K3S_TOKEN: token };
}

/** The network the machine joins. Every cluster belongs to an org, so agents can reach the server. */
export function kubernetesNetwork(workload: WorkloadDesired): string {
	return workloadNetworkName(workload);
}

// ---------------------------------------------------------------- manifests and status

export const MANIFEST_NAME = /^yoal-[a-z0-9-]{1,60}\.yaml$/;
const MANIFEST_MAX_BYTES = 512 * 1024;
const MANIFESTS_MAX = 200;

export function parseManifestFiles(value: unknown): Record<string, string> {
	const record = assertRecord(value, 'request.files');
	const names = Object.keys(record);
	if (names.length > MANIFESTS_MAX) throw new ValidationError(`At most ${MANIFESTS_MAX} manifests`);
	const out: Record<string, string> = {};
	for (const name of names) {
		if (!MANIFEST_NAME.test(name)) throw new ValidationError(`Manifest name ${name} is not allowed`);
		const content = assertString(record[name], `request.files.${name}`, { max: MANIFEST_MAX_BYTES });
		out[name] = content;
	}
	return out;
}

export interface KubernetesCommandRunner {
	run(argv: string[], options?: { stdin?: string }): Promise<{ code: number; stdout: string; stderr: string }>;
}

/**
 * Fixed operations on a running machine, through `podman exec … k3s kubectl` with the machine's
 * own admin kubeconfig. Nothing here takes a command, path or resource name from the wire.
 */
export class KubernetesOps {
	constructor(
		private readonly options: {
			runner: KubernetesCommandRunner;
			podmanPath: string;
			resolveDataDir: (id: string) => Promise<string>;
			chownLike: (path: string, reference: string) => Promise<void>;
		},
	) {}

	private container(id: string): string {
		return `yoal-workload-${assertKubernetesId(id)}`;
	}

	private kubectl(id: string, args: string[], stdin?: string) {
		return this.options.runner.run(
			[this.options.podmanPath, 'exec', ...(stdin !== undefined ? ['-i'] : []), this.container(id), 'k3s', 'kubectl', ...args],
			stdin !== undefined ? { stdin } : {},
		);
	}

	/**
	 * Replace the helper-owned manifests (`yoal-*.yaml`) in the auto-deploy directory. A manifest
	 * that is no longer wanted has its objects deleted first (k3s does not always remove them when
	 * the file goes), then the file. Other files there are never touched.
	 */
	async syncManifests(id: string, files: Record<string, string>): Promise<{ written: string[]; removed: string[] }> {
		const dataDir = await this.options.resolveDataDir(assertKubernetesId(id));
		const dir = join(dataDir, K3S_MANIFESTS_SUBDIR);
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		const existing = (await fs.readdir(dir).catch(() => [] as string[])).filter((name) => MANIFEST_NAME.test(name));
		const removed: string[] = [];
		for (const name of existing) {
			if (Object.hasOwn(files, name)) continue;
			const path = join(dir, name);
			const content = await fs.readFile(path, 'utf8').catch(() => null);
			if (content) {
				const result = await this.kubectl(id, ['delete', '--ignore-not-found', '--wait=false', '-f', '-'], content);
				if (result.code !== 0)
					throw new ValidationError(`Could not delete the objects of ${name}: ${result.stderr.trim().slice(0, 300)}`);
			}
			await fs.rm(path, { force: true });
			removed.push(name);
		}
		const written: string[] = [];
		for (const [name, content] of Object.entries(files)) {
			const path = join(dir, basename(name));
			const current = await fs.readFile(path, 'utf8').catch(() => null);
			if (current === content) continue;
			const temp = `${path}.tmp-${process.pid}`;
			await fs.writeFile(temp, content, { mode: 0o600 });
			await this.options.chownLike(temp, dataDir);
			await fs.rename(temp, path);
			written.push(name);
		}
		return { written, removed };
	}

	/**
	 * A datastore snapshot as a gzipped tar laid out like the k3s data dir (K14, S7): an online copy
	 * of SQLite (`server/db/state.db`) or a fresh etcd snapshot (`server/db/yoal-restore.db`), the
	 * join token, certificates and credentials, and local-path volume data (`storage/`). Written to a
	 * file first so the agent can stream it with a known size.
	 */
	async snapshot(id: string, datastore: 'sqlite' | 'etcd'): Promise<{ path: string; sizeBytes: number; cleanup: () => Promise<void> }> {
		const dataDir = await this.options.resolveDataDir(assertKubernetesId(id));
		const k3s = join(dataDir, 'k3s');
		const staging = join(dataDir, '.yoal-snapshot');
		await fs.rm(staging, { recursive: true, force: true });
		await fs.mkdir(join(staging, 'server', 'db'), { recursive: true, mode: 0o700 });
		const cleanup = async () => {
			await fs.rm(staging, { recursive: true, force: true });
		};
		try {
			if (datastore === 'sqlite') {
				const { Database } = await import('bun:sqlite');
				const db = new Database(join(k3s, 'server', 'db', 'state.db'), { readonly: true });
				try {
					await fs.writeFile(join(staging, 'server', 'db', 'state.db'), db.serialize(), { mode: 0o600 });
				} finally {
					db.close();
				}
			} else {
				const dir = '/var/lib/rancher/k3s/server/db/yoal-snapshots';
				const saved = await this.options.runner.run([
					this.options.podmanPath,
					'exec',
					this.container(id),
					'k3s',
					'etcd-snapshot',
					'save',
					'--name',
					'yoal',
					'--dir',
					dir,
				]);
				if (saved.code !== 0) throw new ValidationError(`etcd snapshot failed: ${saved.stderr.trim().slice(0, 300)}`);
				const hostDir = join(k3s, 'server', 'db', 'yoal-snapshots');
				const files = (await fs.readdir(hostDir)).filter((name) => name.startsWith('yoal'));
				const newest = (
					await Promise.all(files.map(async (name) => ({ name, mtime: (await fs.stat(join(hostDir, name))).mtimeMs })))
				).sort((a, b) => b.mtime - a.mtime)[0];
				if (!newest) throw new ValidationError('etcd snapshot produced no file');
				await fs.copyFile(join(hostDir, newest.name), join(staging, 'server', 'db', 'yoal-restore.db'));
				await fs.rm(hostDir, { recursive: true, force: true });
			}
			const include: string[] = [];
			for (const path of ['server/token', 'server/tls', 'server/cred', 'storage'])
				if (await fs.stat(join(k3s, path)).then(() => true, () => false)) include.push(path);
			const out = join(dataDir, '.yoal-snapshot.tar.gz');
			const tar = await this.options.runner.run(['tar', '-czf', out, '-C', k3s, ...include, '-C', staging, 'server/db']);
			if (tar.code !== 0) throw new ValidationError(`tar failed: ${tar.stderr.trim().slice(0, 300)}`);
			const sizeBytes = (await fs.stat(out)).size;
			return {
				path: out,
				sizeBytes,
				cleanup: async () => {
					await cleanup();
					await fs.rm(out, { force: true });
				},
			};
		} catch (error) {
			await cleanup();
			throw error;
		}
	}

	/**
	 * Unpack a snapshot into a machine that has never started (K14). Refused when its container
	 * exists: a restore only ever targets a new cluster.
	 */
	async restore(id: string, body: ReadableStream<Uint8Array> | null): Promise<void> {
		if (!body) throw new ValidationError('The restore needs a body');
		const exists = await this.options.runner.run([this.options.podmanPath, 'container', 'exists', this.container(id)]);
		if (exists.code === 0) throw new ValidationError('This machine already exists; a snapshot restores only into a new cluster');
		const dataDir = await this.options.resolveDataDir(assertKubernetesId(id));
		const k3s = join(dataDir, 'k3s');
		await fs.mkdir(k3s, { recursive: true, mode: 0o700 });
		const archive = join(dataDir, '.yoal-restore.tar.gz');
		await Bun.write(archive, new Response(body));
		try {
			// GNU tar refuses `..` members and strips leading slashes; ownership comes from `:U` at start.
			const tar = await this.options.runner.run(['tar', '-xzf', archive, '-C', k3s, '--no-same-owner']);
			if (tar.code !== 0) throw new ValidationError(`tar failed: ${tar.stderr.trim().slice(0, 300)}`);
		} finally {
			await fs.rm(archive, { force: true });
		}
	}

	/** Node readiness, API readiness and deprecated APIs in use, for the status sample. */
	async status(id: string, keep: readonly string[] = []): Promise<{
		apiReady: boolean;
		nodesReady: number;
		nodesTotal: number;
		deprecatedApis: string[];
	}> {
		const ready = await this.kubectl(id, ['get', '--raw', '/readyz']);
		const nodes = await this.kubectl(id, ['get', 'nodes', '-o', 'json']);
		let nodesReady = 0;
		let nodesTotal = 0;
		if (nodes.code === 0) {
			try {
				const parsed = JSON.parse(nodes.stdout) as {
					items?: Array<{ metadata?: { name?: string }; status?: { conditions?: Array<{ type?: string; status?: string }> } }>;
				};
				for (const item of parsed.items ?? []) {
					const name = item.metadata?.name ?? '';
					const ready = item.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True');
					// Nodes of removed machines, or of the cluster a restore came from, linger NotReady (S7).
					if (keep.length > 0 && !ready && /^[a-z0-9-]{1,63}$/.test(name) && !keep.includes(name)) {
						await this.kubectl(id, ['delete', 'node', name, '--wait=false']);
						continue;
					}
					nodesTotal += 1;
					if (ready) nodesReady += 1;
				}
			} catch {
				// A half-started API server answers with something else; report zero nodes.
			}
		}
		const deprecatedApis: string[] = [];
		const metrics = await this.kubectl(id, ['get', '--raw', '/metrics']);
		if (metrics.code === 0) {
			for (const line of metrics.stdout.split('\n')) {
				if (!line.startsWith('apiserver_requested_deprecated_apis{')) continue;
				const group = /group="([^"]*)"/.exec(line)?.[1] ?? '';
				const version = /version="([^"]*)"/.exec(line)?.[1] ?? '';
				const resource = /resource="([^"]*)"/.exec(line)?.[1] ?? '';
				const removed = /removed_release="([^"]*)"/.exec(line)?.[1] ?? '';
				const entry = `${group ? `${group}/` : ''}${version}/${resource}${removed ? ` (removed in ${removed})` : ''}`;
				if (!deprecatedApis.includes(entry)) deprecatedApis.push(entry.slice(0, 200));
				if (deprecatedApis.length >= 100) break;
			}
		}
		return { apiReady: ready.code === 0 && ready.stdout.trim() === 'ok', nodesReady, nodesTotal, deprecatedApis };
	}
}

/** The routed network for multi-node machines on this node (K6): the node's /24, masqueraded out. */
export const KUBERNETES_MACHINE_NETWORK = 'yoal-k8s';
/** The machine's interface on that network, named so flannel can be pinned to it (S3). */
export const KUBERNETES_MACHINE_IFACE = 'k8s0';

/**
 * Quadlet `.network` for the node's machine subnet. Its MTU leaves room for WireGuard (80) and the
 * flannel VXLAN header (50) on the smallest overlay MTU (1280 + 90 headroom), so pods never
 * fragment across nodes.
 */
export function renderMachineNetworkUnit(subnet: string): string {
	if (!/^(?:\d{1,3}\.){3}0\/24$/.test(subnet)) throw new ValidationError('The machine subnet must be a /24');
	const prefix = subnet.slice(0, subnet.lastIndexOf('.') + 1);
	return [
		'# Generated by yoal-helper. Do not edit; changes are overwritten.',
		'[Network]',
		`NetworkName=${KUBERNETES_MACHINE_NETWORK}`,
		'Driver=bridge',
		`Subnet=${subnet}`,
		`Gateway=${prefix}1`,
		'Options=mtu=1370',
		// S3: a machine on two networks gets two equal default routes in random order, and flannel
		// follows the default route. This network wins (lower metric) and routes the supernet.
		'Options=metric=50',
		`PodmanArgs=--route=10.48.0.0/16,${prefix}1`,
		'DisableDNS=true',
		'',
	].join('\n');
}
