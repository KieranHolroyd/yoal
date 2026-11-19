import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { K3S_ENTRYPOINT, KUBERNETES_COMPONENT_ROOT, KUBERNETES_IMAGES, type KubernetesTier } from './kubernetes.ts';

/**
 * The optional Kubernetes node component (docs/KUBERNETES.md §3, K2).
 *
 * Installing it prepares a node to run k3s machines: kernel modules and sysctls, the pinned k3s
 * images (pulled by digest), the airgap image bundle per minor (digest-checked, so a cluster never
 * pulls its add-ons from the internet), and a one-off probe of each isolation tier. The result is a
 * marker the agent reads to advertise `kubernetes` and its tiers. Nodes that never install it
 * download nothing.
 *
 * It runs three ways, all through this module: the installer (`--with-kubernetes`), the script
 * `scripts/install/kubernetes.ts` on an installed node, and the helper's fixed verb
 * `POST /v1/components/kubernetes`, which the dashboard drives through the agent.
 */

export const KUBERNETES_MARKER = join(KUBERNETES_COMPONENT_ROOT, 'installed.json');

/** Release and airgap digests per minor; the images themselves are pinned in `KUBERNETES_IMAGES`. */
export const KUBERNETES_RELEASES: Record<string, { release: string; airgap: Record<KubernetesArch, string> }> = {
	'1.37': {
		release: 'v1.37.2+k3s1',
		airgap: {
			amd64: '35a5af1e69b57b8b627a4f6b1c29ea104209b661067b8c97fd40dc3f860bfcd2',
			arm64: 'ca384f1a77aa83024bd82ad26fa4774971adb038e656a3b5b9af926be445a442',
		},
	},
	'1.36': {
		release: 'v1.36.6+k3s1',
		airgap: {
			amd64: 'b3029b1a682b8597587e89f5b1c48493e579a6ea1d0ec6a9aac718a8c356e5be',
			arm64: '881b93edba1b9d91cb0a4ea09ca08298d0f22ec9442ce9a80e697da97945532c',
		},
	},
	'1.35': {
		release: 'v1.35.10+k3s1',
		airgap: {
			amd64: 'c10a9f07c357cfc41488f29c15872621ac8664c9864b3d1148a10155c9a1c2ff',
			arm64: '60236f6ff33231eab0572af562d70d2e55a815f9bdb5a13a827d7f7840d6ea54',
		},
	},
};

export type KubernetesArch = 'amd64' | 'arm64';

export const KUBERNETES_MODULES = ['overlay', 'br_netfilter', 'nf_conntrack', 'iptable_nat', 'iptable_filter', 'xt_conntrack', 'vxlan'];
export const KUBERNETES_SYSCTLS: Record<string, string> = {
	'net.ipv4.ip_forward': '1',
	'net.bridge.bridge-nf-call-iptables': '1',
	'net.bridge.bridge-nf-call-ip6tables': '1',
	'fs.inotify.max_user_instances': '8192',
	'fs.inotify.max_user_watches': '1048576',
};
const MODULES_FILE = '/etc/modules-load.d/yoal-k8s.conf';
const SYSCTL_FILE = '/etc/sysctl.d/60-yoal-k8s.conf';
const MIN_MEMORY_MB = 1900;
const PROBE_TIMEOUT_MS = 240_000;

export interface ComponentRunner {
	run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface KubernetesComponentReport {
	minors: string[];
	tiers: KubernetesTier[];
	error: string | null;
	installedAt?: string;
}

/** The helper's background install/remove, as the agent polls it. */
export interface KubernetesComponentJob {
	running: boolean;
	action: 'install' | 'remove' | null;
	startedAt: string | null;
	finishedAt: string | null;
	error: string | null;
	report: KubernetesComponentReport | null;
}

export interface ComponentOptions {
	runner: ComponentRunner;
	podmanPath?: string;
	/** Defaults to `/usr/lib/yoal/k3s`. */
	root?: string;
	arch?: KubernetesArch;
	/** Minors to install; defaults to every pinned minor. */
	minors?: string[];
	/** Tiers to probe; defaults to both. An empty list skips the probe (and offers no tier). */
	probeTiers?: KubernetesTier[];
	fetch?: typeof fetch;
	log?: (message: string) => void;
	/** Paths for tests. */
	paths?: { modules?: string; sysctl?: string; meminfo?: string; cgroupControllers?: string };
}

export function kubernetesArch(machine: string): KubernetesArch | null {
	const value = machine.trim().toLowerCase();
	if (value === 'x64' || value === 'amd64' || value === 'x86_64') return 'amd64';
	if (value === 'arm64' || value === 'aarch64') return 'arm64';
	return null;
}

export function airgapUrl(minor: string, arch: KubernetesArch): string {
	const release = KUBERNETES_RELEASES[minor]?.release;
	if (!release) throw new Error(`No pinned k3s release for ${minor}`);
	return `https://github.com/k3s-io/k3s/releases/download/${encodeURIComponent(release)}/k3s-airgap-images-${arch}.tar.zst`;
}

/** Problems that stop the component from working on this host; empty when it can. */
export function prerequisiteProblems(paths: ComponentOptions['paths'] = {}): string[] {
	const problems: string[] = [];
	const controllersPath = paths.cgroupControllers ?? '/sys/fs/cgroup/cgroup.controllers';
	const controllers = existsSync(controllersPath) ? readFileSync(controllersPath, 'utf8').split(/\s+/) : [];
	if (controllers.length === 0 || !existsSync(controllersPath))
		problems.push('cgroup v2 is required (the unified hierarchy at /sys/fs/cgroup).');
	else
		for (const controller of ['cpu', 'memory', 'pids'])
			if (!controllers.includes(controller)) problems.push(`The cgroup ${controller} controller is not available.`);
	const meminfo = paths.meminfo ?? '/proc/meminfo';
	if (existsSync(meminfo)) {
		const kb = Number(/MemTotal:\s+(\d+)/.exec(readFileSync(meminfo, 'utf8'))?.[1] ?? 0);
		if (kb > 0 && kb / 1024 < MIN_MEMORY_MB) problems.push(`The node has ${Math.round(kb / 1024)} MB of memory; Kubernetes needs at least 2 GB.`);
	}
	return problems;
}

export function readMarker(root = KUBERNETES_COMPONENT_ROOT): KubernetesComponentReport | null {
	const path = join(root, 'installed.json');
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as KubernetesComponentReport;
	} catch {
		return null;
	}
}

function writeMarker(root: string, report: KubernetesComponentReport): void {
	mkdirSync(root, { recursive: true, mode: 0o755 });
	const path = join(root, 'installed.json');
	writeFileSync(`${path}.new`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
	renameSync(`${path}.new`, path);
}

/** Install or refresh the component. Idempotent: present images and bundles are not fetched again. */
export async function installKubernetesComponent(options: ComponentOptions): Promise<KubernetesComponentReport> {
	const log = options.log ?? (() => undefined);
	const root = options.root ?? KUBERNETES_COMPONENT_ROOT;
	const podman = options.podmanPath ?? '/usr/bin/podman';
	const arch = options.arch ?? kubernetesArch(process.arch);
	if (!arch) throw new Error(`No k3s build for ${process.arch}`);

	const problems = prerequisiteProblems(options.paths);
	if (problems.length > 0) {
		const report = { minors: [], tiers: [], error: problems.join(' ') };
		writeMarker(root, report);
		return report;
	}

	// Kernel modules and sysctls, persisted so a reboot keeps them.
	const modulesPath = options.paths?.modules ?? MODULES_FILE;
	writeFileSync(modulesPath, `# Written by Yoal (docs/KUBERNETES.md)\n${KUBERNETES_MODULES.join('\n')}\n`, { mode: 0o644 });
	for (const module of KUBERNETES_MODULES) await options.runner.run(['modprobe', module]).catch(() => null);
	const sysctlPath = options.paths?.sysctl ?? SYSCTL_FILE;
	writeFileSync(
		sysctlPath,
		`# Written by Yoal (docs/KUBERNETES.md)\n${Object.entries(KUBERNETES_SYSCTLS)
			.map(([key, value]) => `${key} = ${value}`)
			.join('\n')}\n`,
		{ mode: 0o644 },
	);
	await options.runner.run(['sysctl', '--load', sysctlPath]).catch(() => null);

	const minors = options.minors ?? Object.keys(KUBERNETES_IMAGES);
	const installed: string[] = [];
	for (const minor of minors) {
		const image = KUBERNETES_IMAGES[minor];
		const release = KUBERNETES_RELEASES[minor];
		if (!image || !release) throw new Error(`Kubernetes ${minor} is not pinned in this release`);
		log(`pulling ${image}`);
		const pulled = await options.runner.run([podman, 'pull', '--quiet', image]);
		if (pulled.code !== 0) throw new Error(`podman pull ${image} failed: ${pulled.stderr.trim().slice(0, 300)}`);
		await ensureAirgap({ root, minor, arch, expected: release.airgap[arch], fetch: options.fetch ?? fetch, log });
		installed.push(minor);
	}

	const probeTiers = options.probeTiers ?? ['userns', 'trusted'];
	const tiers: KubernetesTier[] = [];
	const entrypoint = join(root, 'entrypoint.sh');
	mkdirSync(root, { recursive: true, mode: 0o755 });
	writeFileSync(entrypoint, K3S_ENTRYPOINT, { mode: 0o755 });
	for (const tier of probeTiers) {
		log(`probing the ${tier} tier (starts a throwaway k3s server)`);
		const result = await probeTier({ runner: options.runner, podman, image: KUBERNETES_IMAGES[installed[0]!]!, tier, log, entrypoint });
		if (result.ok) tiers.push(tier);
		else log(`the ${tier} tier does not work here: ${result.detail}`);
	}
	const report: KubernetesComponentReport = {
		minors: installed,
		tiers,
		error: tiers.length === 0 && probeTiers.length > 0 ? 'No isolation tier passed the probe on this node.' : null,
		installedAt: new Date().toISOString(),
	};
	writeMarker(root, report);
	return report;
}

async function ensureAirgap(input: {
	root: string;
	minor: string;
	arch: KubernetesArch;
	expected: string;
	fetch: typeof fetch;
	log: (message: string) => void;
}): Promise<void> {
	const dir = join(input.root, input.minor, 'images');
	const target = join(dir, `k3s-airgap-images-${input.arch}.tar.zst`);
	if (existsSync(target) && sha256File(target) === input.expected) return;
	const url = airgapUrl(input.minor, input.arch);
	input.log(`downloading the k3s ${input.minor} airgap bundle`);
	const response = await input.fetch(url);
	if (!response.ok) throw new Error(`airgap download failed: HTTP ${response.status} from ${url}`);
	const body = new Uint8Array(await response.arrayBuffer());
	const actual = createHash('sha256').update(body).digest('hex');
	if (actual !== input.expected) throw new Error(`airgap digest mismatch for ${input.minor}: expected ${input.expected}, got ${actual}`);
	mkdirSync(dir, { recursive: true, mode: 0o755 });
	const temporary = `${target}.new`;
	try {
		writeFileSync(temporary, body, { mode: 0o644 });
		renameSync(temporary, target);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function sha256File(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Podman flags per tier; the same set the helper renders into a machine's Quadlet unit. */
export function tierPodmanArgs(tier: KubernetesTier): string[] {
	const base = ['--privileged', '--cgroupns=private', '--security-opt', 'label=disable', '--tmpfs', '/run', '--tmpfs', '/var/run'];
	return tier === 'userns' ? [...base, '--userns=auto:size=65536'] : base;
}

/** Start a throwaway server and wait for its node to be Ready. */
export async function probeTier(input: {
	runner: ComponentRunner;
	podman: string;
	image: string;
	tier: KubernetesTier;
	log: (message: string) => void;
	/** Host path of the cgroup v2 entrypoint (S1). */
	entrypoint?: string;
	timeoutMs?: number;
	sleep?: (ms: number) => Promise<void>;
}): Promise<{ ok: boolean; detail: string }> {
	const name = `yoal-k8s-probe-${input.tier}`;
	const wait = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
	await input.runner.run([input.podman, 'rm', '--force', name]).catch(() => null);
	const started = await input.runner.run([
		input.podman,
		'run',
		'--detach',
		'--name',
		name,
		...tierPodmanArgs(input.tier),
		...(input.entrypoint ? ['--volume', `${input.entrypoint}:/yoal-entrypoint.sh:ro`, '--entrypoint', '/yoal-entrypoint.sh'] : []),
		input.image,
		'server',
		'--disable=traefik,servicelb,metrics-server,local-storage',
		'--disable-network-policy',
		'--write-kubeconfig-mode=0600',
	]);
	if (started.code !== 0) return { ok: false, detail: started.stderr.trim().slice(0, 300) || 'podman run failed' };
	try {
		const deadline = Date.now() + (input.timeoutMs ?? PROBE_TIMEOUT_MS);
		while (Date.now() < deadline) {
			const nodes = await input.runner.run([
				input.podman,
				'exec',
				name,
				'k3s',
				'kubectl',
				'get',
				'nodes',
				'-o',
				'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
			]);
			if (nodes.code === 0 && nodes.stdout.trim() === 'True') return { ok: true, detail: 'node Ready' };
			await wait(5_000);
		}
		const logs = await input.runner.run([input.podman, 'logs', '--tail', '20', name]).catch(() => null);
		return { ok: false, detail: `no Ready node in time${logs ? `: ${logs.stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}` };
	} finally {
		await input.runner.run([input.podman, 'rm', '--force', '--volumes', name]).catch(() => null);
	}
}

/** Remove the component. Refused while any machine container exists on the node. */
export async function removeKubernetesComponent(options: ComponentOptions & { purge?: boolean }): Promise<void> {
	const root = options.root ?? KUBERNETES_COMPONENT_ROOT;
	const podman = options.podmanPath ?? '/usr/bin/podman';
	const listed = await options.runner.run([podman, 'ps', '--all', '--format', '{{.Names}}', '--filter', 'name=yoal-workload-km_']);
	const machines = listed.stdout.split('\n').filter((line) => line.trim().startsWith('yoal-workload-km_'));
	if (machines.length > 0)
		throw new Error(`Kubernetes machines still run here (${machines.length}). Delete or move their clusters first.`);
	rmSync(join(root, 'installed.json'), { force: true });
	if (options.purge) {
		for (const image of Object.values(KUBERNETES_IMAGES)) await options.runner.run([podman, 'rmi', '--ignore', image]).catch(() => null);
		rmSync(root, { recursive: true, force: true });
		rmSync(options.paths?.modules ?? MODULES_FILE, { force: true });
		rmSync(options.paths?.sysctl ?? SYSCTL_FILE, { force: true });
	}
}
