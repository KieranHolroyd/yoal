/**
 * The HA lab, defined once (docs/HA-PLAN.md W1, docs/CLUSTERING.md §19.3). Both forms read this:
 * the nested-container form (`tests/lab/lab.ts`, what CI runs) and the real-VM form
 * (`tests/lab/vm/`, Lima, nightly). Names, addresses, roles, zones and pins live here and nowhere
 * else.
 *
 * Every Docker object the lab creates is named `yoal-w0-*` and labelled `yoal-w0=lab`, and `lab down`
 * removes only those. Host ports are high loopback ports, so nothing binds over a Yoal node, Caddy or
 * dev server already running on the machine.
 */

export type LabRole = 'control' | 'worker';

export interface LabNode {
	/** Fleet node name and container hostname. */
	name: string;
	/** Underlay address on the lab network (the WireGuard endpoint). */
	ip: string;
	/** `control`: the full installer (control plane + edge agent). `worker`: `install --join`. */
	role: LabRole;
	/** Failure domain (CLUSTERING §3.2): lab-c is the "home" site of §19.3. */
	zone: string;
	memory: string;
	cpus: number;
	/** 127.0.0.1:<port> → the node's :80, for the checker and for diagnostics. */
	hostHttpPort: number;
}

export const LAB = {
	prefix: 'yoal-w0',
	label: 'yoal-w0=lab',
	network: { name: 'yoal-w0-net', subnet: '172.30.147.0/24' },
	image: {
		/** Built from node.Dockerfile; the tag is a hash of its inputs. */
		node: 'yoal-w0-node',
		debianTag: 'trixie-20251117-slim',
		bunVersion: '1.4.4',
	},
	nodes: [
		{ name: 'lab-a', ip: '172.30.147.11', role: 'control', zone: 'cloud-a', memory: '4g', cpus: 3, hostHttpPort: 47080 },
		{ name: 'lab-b', ip: '172.30.147.12', role: 'worker', zone: 'cloud-b', memory: '3g', cpus: 2, hostHttpPort: 47081 },
		{ name: 'lab-c', ip: '172.30.147.13', role: 'worker', zone: 'home', memory: '3g', cpus: 2, hostHttpPort: 47082 },
		{ name: 'lab-ctl', ip: '172.30.147.14', role: 'worker', zone: 'ctl', memory: '2g', cpus: 1, hostHttpPort: 47083 },
	] satisfies LabNode[],
	s3lab: {
		/**
		 * MinIO RELEASE.2025-09-07T16-13-09Z, pinned by digest: MinIO no longer publishes release
		 * tags to registries (quay refuses the tag; the digest still resolves).
		 */
		minioImage: 'quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e',
		minioVersion: 'RELEASE.2025-09-07T16-13-09Z',
		minioIp: '172.30.147.21',
		proxyIp: '172.30.147.20',
		s3Port: 9000,
		controlPort: 9001,
		hostS3Port: 47900,
		hostControlPort: 47901,
		bucket: 'yoal-ha',
		accessKey: 'yoallab',
	},
	/** Cluster settings `lab up` applies (the HA scenarios need failover on). */
	cluster: { failover: true, sliceMb: 1536 },
	/** Where the checkout goes on each node, and the installer flags every lab node shares. */
	sourceDir: '/opt/yoal-lab-src',
	installFlags: ['--yes', '--skip-dns-check', '--no-python', '--no-node'],
	controlInstallFlags: ['--no-clickhouse'],
	/** Join-time TLS front on the control node (`node/tls-front.ts`). */
	joinTlsPort: 8443,
	helperSocket: '/run/yoal-helper/helper.sock',
} as const;

export const CONTROL = LAB.nodes.find((node) => node.role === 'control')!;
export const WORKERS = LAB.nodes.filter((node) => node.role === 'worker');

export function containerName(node: string): string {
	return `${LAB.prefix}-${node}`;
}

export function labNode(name: string): LabNode {
	const node = LAB.nodes.find((candidate) => candidate.name === name);
	if (!node) throw new Error(`unknown lab node "${name}" (one of ${LAB.nodes.map((n) => n.name).join(', ')})`);
	return node;
}
