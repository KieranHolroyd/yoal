import * as z from 'zod';
import { SLUG_PATTERN } from './slugs.ts';
import { storageTargetSchema } from './disk.ts';

/**
 * Managed Kubernetes (docs/KUBERNETES.md).
 *
 * A cluster is an org resource that Yoal provisions, runs, upgrades and backs up, the way it runs a
 * managed broker. Each k3s server or agent is a **machine**: a container the helper starts from a
 * pinned `rancher/k3s` image under its fixed `kubernetes` profile. Yoal never schedules its own
 * workloads on Kubernetes; a cluster is a tenant product (DESIGN §1).
 *
 * The node component (K2) is optional: a node runs machines only after an operator installs it, and
 * the agent then advertises `kubernetes` plus one capability per isolation tier that works there.
 */

// ---------------------------------------------------------------- ids, ports, capabilities

export const KUBERNETES_CLUSTER_ID_PREFIX = 'kc_';
/** Machine ids double as workload ids on the node; the helper reserves this prefix. */
export const KUBERNETES_MACHINE_ID_PREFIX = 'km_';

/** Per-node loopback ports: the API server (6443 inside) and the bundled ingress (80 inside). */
export const KUBERNETES_API_PORT_MIN = 22_000;
export const KUBERNETES_API_PORT_MAX = 22_499;
export const KUBERNETES_INGRESS_PORT_MIN = 22_500;
export const KUBERNETES_INGRESS_PORT_MAX = 22_999;

/** The node has the Kubernetes component installed and its prerequisites still pass. */
export const KUBERNETES_CAPABILITY = 'kubernetes';
export const KUBERNETES_USERNS_CAPABILITY = 'kubernetes-userns';
export const KUBERNETES_TRUSTED_CAPABILITY = 'kubernetes-trusted';

/** Node label a platform owner sets to dedicate a node to one org's Kubernetes machines (K24). */
export const KUBERNETES_DEDICATED_LABEL = 'kubernetes';
/** `kubernetes=dedicated` (the platform owner's org) or `kubernetes=dedicated:<orgId>`. */
export const KUBERNETES_DEDICATED_VALUE = 'dedicated';

/** Node-local paths the installer writes and the helper reads (never taken from the wire). */
export const KUBERNETES_COMPONENT_ROOT = '/usr/lib/yoal/k3s';
export const KUBERNETES_COMPONENT_MARKER = `${KUBERNETES_COMPONENT_ROOT}/installed.json`;

// ---------------------------------------------------------------- versions (K1)

export interface KubernetesVersionInfo {
	/** `1.37`: what users pick and upgrade between. */
	minor: string;
	/** The pinned k3s release of that minor. */
	release: string;
	/** Multi-arch image index, pinned by digest (D61). */
	image: string;
	/** SHA-256 of the k3s airgap images bundle per architecture, checked before it is written. */
	airgap: { amd64: string; arm64: string };
	/** Upstream end of support (approximate, from the Kubernetes release calendar). */
	endOfSupport: string;
}

/**
 * The supported minors, newest first. A new k3s patch is a data change shipped in a release; the
 * maintenance window applies it to every cluster of that minor (K15). Dropping a minor here moves its
 * clusters forward one minor at their next window.
 */
export const kubernetesVersions: readonly KubernetesVersionInfo[] = [
	{
		minor: '1.37',
		release: 'v1.37.2+k3s1',
		image: 'docker.io/rancher/k3s:v1.37.2-k3s1@sha256:21ea6e0fac4e3930c2ce8aa40ddd41a8b18cb3e9a0222c030dc005e7e88c4332',
		airgap: {
			amd64: '35a5af1e69b57b8b627a4f6b1c29ea104209b661067b8c97fd40dc3f860bfcd2',
			arm64: 'ca384f1a77aa83024bd82ad26fa4774971adb038e656a3b5b9af926be445a442',
		},
		endOfSupport: '2027-10-28',
	},
	{
		minor: '1.36',
		release: 'v1.36.6+k3s1',
		image: 'docker.io/rancher/k3s:v1.36.6-k3s1@sha256:88d3fac10eb4a429d3c5275f4868fe4b13620f6bbca5bdb5dca0627ac76ae2a0',
		airgap: {
			amd64: 'b3029b1a682b8597587e89f5b1c48493e579a6ea1d0ec6a9aac718a8c356e5be',
			arm64: '881b93edba1b9d91cb0a4ea09ca08298d0f22ec9442ce9a80e697da97945532c',
		},
		endOfSupport: '2027-06-28',
	},
	{
		minor: '1.35',
		release: 'v1.35.10+k3s1',
		image: 'docker.io/rancher/k3s:v1.35.10-k3s1@sha256:8262ca99a558dca0c0437443421986480b2359f9118f2371359f88a41514522f',
		airgap: {
			amd64: 'c10a9f07c357cfc41488f29c15872621ac8664c9864b3d1148a10155c9a1c2ff',
			arm64: '60236f6ff33231eab0572af562d70d2e55a815f9bdb5a13a827d7f7840d6ea54',
		},
		endOfSupport: '2027-02-28',
	},
];

/**
 * Every k3s release a machine may run, by release: the current pin of each minor plus earlier pins
 * kept until clusters on them have been patched in their window (K15). Add the old entry here when
 * bumping a pin; drop it once no cluster can still be on it.
 */
export const kubernetesReleaseImages: Record<string, string> = Object.fromEntries(
	kubernetesVersions.map((info) => [info.release, info.image]),
);

export function kubernetesImageForRelease(release: string): string | null {
	return kubernetesReleaseImages[release] ?? null;
}

/** `1.37` from `v1.37.2+k3s1`. */
export function kubernetesMinorOf(release: string): string {
	return /^v?(\d+\.\d+)\./.exec(release)?.[1] ?? '';
}

export const kubernetesMinors = kubernetesVersions.map((info) => info.minor);
export const DEFAULT_KUBERNETES_MINOR = kubernetesVersions[0]!.minor;

export function kubernetesVersion(minor: string): KubernetesVersionInfo | null {
	return kubernetesVersions.find((info) => info.minor === minor) ?? null;
}

/** The next minor up from `minor`, or null when it is the newest (upgrades move one at a time). */
export function nextKubernetesMinor(minor: string): string | null {
	const index = kubernetesMinors.indexOf(minor);
	return index > 0 ? kubernetesMinors[index - 1]! : null;
}

/** `1.37.2` from `v1.37.2+k3s1`, for display. */
export function kubernetesDisplayVersion(release: string): string {
	return release.replace(/^v/, '').replace(/\+k3s\d+$/, '');
}

// ---------------------------------------------------------------- enums

/** How a machine is isolated from its node (K4, §5.2). `vm` is reserved for a later tier. */
export const kubernetesTiers = ['userns', 'trusted'] as const;
export type KubernetesTier = (typeof kubernetesTiers)[number];

export const kubernetesPurposes = ['lab', 'production'] as const;
export type KubernetesPurpose = (typeof kubernetesPurposes)[number];

export const kubernetesApiAccessModes = ['public', 'private'] as const;
export type KubernetesApiAccess = (typeof kubernetesApiAccessModes)[number];

/** `server+agent` is a single-machine cluster: the server runs workloads too. */
export const kubernetesMachineRoles = ['server', 'agent'] as const;
export type KubernetesMachineRole = (typeof kubernetesMachineRoles)[number];

export const kubernetesStatuses = ['pending', 'starting', 'running', 'degraded', 'failed', 'stopped'] as const;
export type KubernetesStatus = (typeof kubernetesStatuses)[number];

export const kubernetesAccessRoles = ['view', 'edit', 'admin'] as const;
export type KubernetesAccessRole = (typeof kubernetesAccessRoles)[number];

/** In-cluster group a token or access key carries for each Yoal permission (K9). */
export const KUBERNETES_GROUPS: Record<KubernetesAccessRole, string> = {
	admin: 'yoal:admins',
	edit: 'yoal:editors',
	view: 'yoal:viewers',
};

/** The ClusterRole each group is bound to by the helper-written RBAC manifest. */
export const KUBERNETES_GROUP_ROLES: Record<KubernetesAccessRole, string> = {
	admin: 'cluster-admin',
	edit: 'edit',
	view: 'view',
};

// ---------------------------------------------------------------- sizes

/** S2: k3s idles at ~650 MB and needs 768 MiB reserved; below 2 GiB pods get almost nothing. */
export const KUBERNETES_MIN_MEMORY_MB = 2048;
export const KUBERNETES_DEFAULT_MEMORY_MB = 2048;
export const KUBERNETES_MAX_MEMORY_MB = 65_536;
export const KUBERNETES_DEFAULT_CPUS = 1;
/** A cluster has one server in v1 and up to this many agent machines (K2.5). */
export const KUBERNETES_MAX_AGENTS = 8;
/** Token lifetime for `yoal k8s token` (K8). */
export const KUBERNETES_TOKEN_TTL_SECONDS = 900;
/** Audience prefix of cluster tokens: `k8s:<clusterId>`. */
export const KUBERNETES_TOKEN_AUDIENCE_PREFIX = 'k8s:';
/** Claim that carries the in-cluster groups. */
export const KUBERNETES_GROUPS_CLAIM = 'k8s_groups';
/** Sub-zone of the content domain that holds every cluster's API host (K7). */
export const KUBERNETES_API_ZONE = 'k8s';

// ---------------------------------------------------------------- schemas

export const kubernetesNameSchema = z
	.string()
	.min(3)
	.max(40)
	.regex(SLUG_PATTERN, 'Use lowercase letters, digits and single hyphens; start and end with a letter or digit.')
	.refine((name) => !name.includes('--'), 'Double hyphens are not allowed.');

const cidrSchema = z
	.string()
	.max(64)
	.regex(/^[0-9a-fA-F:.]+\/\d{1,3}$/, 'Use CIDR notation, e.g. 203.0.113.0/24.');

/** A daily maintenance window, in the platform timezone (K15). */
export const kubernetesWindowSchema = z.object({
	/** Start hour, 0–23. */
	hour: z.number().int().min(0).max(23).default(3),
	/** Length in hours. */
	hours: z.number().int().min(1).max(8).default(2),
});
export type KubernetesWindow = z.infer<typeof kubernetesWindowSchema>;

export const kubernetesCreateSchema = z.object({
	name: kubernetesNameSchema,
	/** A supported minor (`1.37`); defaults to the newest. */
	version: z.string().max(8).optional(),
	/** `auto` or a node id. Resolved once at create time (D41). */
	placement: z.string().min(1).max(64).default('auto'),
	/** `userns` unless the node only offers `trusted` and the org holds the grant (K4). */
	tier: z.enum(kubernetesTiers).optional(),
	purpose: z.enum(kubernetesPurposes).default('lab'),
	/** Memory and CPU per machine. */
	memoryMb: z.number().int().min(KUBERNETES_MIN_MEMORY_MB).max(KUBERNETES_MAX_MEMORY_MB).default(KUBERNETES_DEFAULT_MEMORY_MB),
	cpus: z.number().positive().max(32).default(KUBERNETES_DEFAULT_CPUS),
	/** Extra agent machines on the same node (K2.5). Zero is a single combined machine. */
	agents: z.number().int().min(0).max(KUBERNETES_MAX_AGENTS).default(0),
	/** `system`, `fast`, `bulk` or a disk name; omitted uses the default from Settings → Storage. */
	storage: storageTargetSchema.optional(),
	apiAccess: z.enum(kubernetesApiAccessModes).default('public'),
	/** Optional CIDR allowlist for the public API route. Empty allows any address. */
	allowCidrs: z.array(cidrSchema).max(50).default([]),
	window: kubernetesWindowSchema.optional(),
	/** Apply new pinned patches automatically in the window (K15). */
	autoPatch: z.boolean().default(true),
	/** Keep the bundled Traefik ingress controller (K11). */
	traefik: z.boolean().default(true),
	/** One server (SQLite) or three (embedded etcd, HA, K17). Three needs three capable nodes. */
	servers: z.union([z.literal(1), z.literal(3)]).default(1),
	/** Spread machines across these nodes (K6); omitted keeps every machine on one node unless `servers` is 3. */
	nodes: z.array(z.string().min(1).max(64)).max(16).optional(),
	/** Datastore snapshot interval, hours (K14). Defaults: 24 for lab, 1 for production. */
	backupHours: z.number().int().min(1).max(168).optional(),
	backupRetentionDays: z.number().int().min(1).max(90).default(7),
	/** Ship pod logs to Yoal (K23). Defaults on for production. */
	shipper: z.boolean().optional(),
});
export type KubernetesCreate = z.input<typeof kubernetesCreateSchema>;

export const kubernetesUpdateSchema = z.object({
	/** Move to the next minor (one at a time; downgrades are refused). */
	version: z.string().max(8).optional(),
	memoryMb: z.number().int().min(KUBERNETES_MIN_MEMORY_MB).max(KUBERNETES_MAX_MEMORY_MB).optional(),
	cpus: z.number().positive().max(32).optional(),
	agents: z.number().int().min(0).max(KUBERNETES_MAX_AGENTS).optional(),
	purpose: z.enum(kubernetesPurposes).optional(),
	apiAccess: z.enum(kubernetesApiAccessModes).optional(),
	allowCidrs: z.array(cidrSchema).max(50).optional(),
	window: kubernetesWindowSchema.optional(),
	autoPatch: z.boolean().optional(),
	traefik: z.boolean().optional(),
	/** 3 makes a single-server cluster highly available (SQLite → etcd, K17); servers never go down. */
	servers: z.literal(3).optional(),
	backupHours: z.number().int().min(1).max(168).optional(),
	backupRetentionDays: z.number().int().min(1).max(90).optional(),
	shipper: z.boolean().optional(),
	logRetentionDays: z.number().int().min(1).max(90).optional(),
});
export type KubernetesUpdate = z.input<typeof kubernetesUpdateSchema>;

export const kubernetesRestoreSchema = z.object({
	/** The backup id (`kb_…`) to restore from. */
	backup: z.string().min(4).max(100),
	/** Name of the new cluster; restores never overwrite a live one. */
	name: kubernetesNameSchema,
	placement: z.string().min(1).max(64).default('auto'),
});
export type KubernetesRestore = z.input<typeof kubernetesRestoreSchema>;

export const kubernetesRouteCreateSchema = z.object({
	/** A single label claimed under the content domain (`myapp` → `myapp.<contentDomain>`). */
	name: kubernetesNameSchema,
});
export type KubernetesRouteCreate = z.input<typeof kubernetesRouteCreateSchema>;

export const kubernetesAccessKeyCreateSchema = z.object({
	name: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits and hyphens.'),
	role: z.enum(kubernetesAccessRoles),
	/** ISO time; omitted never expires. */
	expiresAt: z.string().datetime().optional(),
});
export type KubernetesAccessKeyCreate = z.input<typeof kubernetesAccessKeyCreateSchema>;

export const kubernetesAttachSchema = z.object({
	kind: z.enum(['database', 'broker']),
	/** Name of the database or broker in the same org. */
	name: z.string().min(1).max(64),
	namespace: z
		.string()
		.min(1)
		.max(63)
		.regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'Use a Kubernetes namespace name.')
		.default('default'),
	/** Secret name; defaults to `yoal-<name>`. */
	secret: z
		.string()
		.min(1)
		.max(253)
		.regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, 'Use a Kubernetes object name.')
		.optional(),
});
export type KubernetesAttach = z.input<typeof kubernetesAttachSchema>;

// ---------------------------------------------------------------- views

export interface KubernetesBackupView {
	id: string;
	clusterName: string;
	kind: 'scheduled' | 'manual' | 'pre-upgrade';
	datastore: 'sqlite' | 'etcd';
	status: 'pending' | 'running' | 'ok' | 'failed';
	error: string | null;
	sizeBytes: number | null;
	minor: string;
	release: string;
	location: string;
	createdAt: string;
	finishedAt: string | null;
	expiresAt: string;
}

export interface KubernetesPodLogLine {
	seq: number;
	namespace: string;
	pod: string;
	container: string;
	stream: string;
	message: string;
	at: string;
}

export interface KubernetesMachineView {
	id: string;
	role: KubernetesMachineRole;
	/** Index among agents (0 for the server). */
	ordinal: number;
	nodeId: string;
	nodeName: string | null;
	status: KubernetesStatus;
	restarts: number;
	memoryMb: number;
	cpus: number;
	release: string;
	overlayIp: string | null;
}

export interface KubernetesRouteView {
	id: string;
	host: string;
	createdAt: string;
}

export interface KubernetesAttachmentView {
	id: string;
	kind: 'database' | 'broker';
	name: string;
	namespace: string;
	secret: string;
	createdAt: string;
}

export interface KubernetesAccessKeyView {
	id: string;
	name: string;
	role: KubernetesAccessRole;
	createdBy: string;
	createdAt: string;
	expiresAt: string | null;
	revokedAt: string | null;
}

export interface KubernetesClusterView {
	id: string;
	name: string;
	minor: string;
	release: string;
	/** `1.37.2`. */
	displayVersion: string;
	/** The minor this cluster may move to next, or null on the newest. */
	upgradeTo: string | null;
	endOfSupport: string | null;
	tier: KubernetesTier;
	purpose: KubernetesPurpose;
	status: KubernetesStatus;
	message: string | null;
	nodeId: string;
	nodeName: string | null;
	memoryMb: number;
	cpus: number;
	agents: number;
	apiAccess: KubernetesApiAccess;
	allowCidrs: string[];
	/** `https://<name>-<org>.k8s.<contentDomain>`, or null when private. */
	apiUrl: string | null;
	window: KubernetesWindow;
	autoPatch: boolean;
	traefik: boolean;
	servers: number;
	datastore: 'sqlite' | 'etcd';
	/** Machines run on more than one node (K6). */
	multiNode: boolean;
	backup: { hours: number; retentionDays: number; nextAt: string | null; lastAt: string | null; lastStatus: string | null };
	/** A rollout in progress (patch, minor or HA conversion), else null. */
	upgrade: { from: string; to: string; startedAt: string; message: string | null } | null;
	/** Deprecated APIs still in use, from the newest status sample. */
	deprecatedApis: string[];
	shipper: boolean;
	logRetentionDays: number;
	restoring: boolean;
	machines: KubernetesMachineView[];
	routes: KubernetesRouteView[];
	attachments: KubernetesAttachmentView[];
	/** Nodes Ready / total, from the newest status sample; null before the first one. */
	nodesReady: number | null;
	nodesTotal: number | null;
	statsAt: string | null;
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
	purgeAt: string | null;
}

/** A minted cluster token (K8). Also rendered as a client.authentication.k8s.io ExecCredential. */
export interface KubernetesToken {
	token: string;
	expiresAt: string;
	audience: string;
	groups: string[];
}

/** A kubeconfig for the exec plugin; it holds no credential (K8). */
export interface KubernetesKubeconfig {
	cluster: string;
	server: string;
	kubeconfig: string;
}

/** Returned once when an access key is created (K19). */
export interface KubernetesAccessKeySecret extends KubernetesAccessKeyView {
	kubeconfig: string;
}

// ---------------------------------------------------------------- node protocol

/** The `kubernetes` profile on a machine workload sent to the helper (D61: minor + role only). */
export const workloadKubernetesSchema = z.object({
	clusterId: z.string().min(4).max(100),
	role: z.enum(kubernetesMachineRoles),
	ordinal: z.number().int().min(0).max(KUBERNETES_MAX_AGENTS),
	/** The k3s release this machine runs (a rollout moves one machine at a time, K15). */
	release: z.string().min(1).max(32),
	/** The server machine's id; agents join it at its alias on the org network. */
	serverId: z.string().min(4).max(100),
	minor: z.string().min(1).max(8),
	tier: z.enum(kubernetesTiers),
	/** The server has no separate agents: it runs pods too. */
	schedulable: z.boolean(),
	/** Loopback port for the bundled ingress (server only; 0 when Traefik is off). */
	ingressPort: z.number().int().min(0).max(65_535),
	traefik: z.boolean(),
	/** Public API host, added to the server certificate's SANs. Null when private. */
	apiHost: z.string().max(253).nullable(),
	/** The platform issuer the API server trusts (K8). */
	issuer: z.string().url().max(512),
	/** `sqlite` for one server, `etcd` for three (K17). */
	datastore: z.enum(['sqlite', 'etcd']).default('sqlite'),
	/** The first etcd server starts the cluster (`--cluster-init`, which also converts SQLite). */
	clusterInit: z.boolean().default(false),
	/** Where agents and joining servers reach the cluster: an alias (one node) or an overlay IP (K6). */
	serverAddress: z.string().min(1).max(253),
	/** Routed overlay address on the node's `yoal-k8s` network (K6); null keeps the org network only. */
	overlayIp: z.string().regex(/^(?:\d{1,3}\.){3}\d{1,3}$/).nullable().default(null),
	/** The node's machine subnet, for the `yoal-k8s` network (K6). */
	machineSubnet: z.string().regex(/^(?:\d{1,3}\.){3}0\/24$/).nullable().default(null),
});
export type WorkloadKubernetes = z.infer<typeof workloadKubernetesSchema>;

/** A public route on an ingress node: the API server (TLS upstream) or the cluster's ingress (K7, K11). */
export const kubernetesRouteSchema = z.object({
	clusterId: z.string(),
	kind: z.enum(['api', 'ingress']),
	host: z.string(),
	/** `127.0.0.1:<port>` on the machine's node, `http://<address>` elsewhere. */
	upstream: z.string(),
	/** Every server's upstream for an HA API (K17); empty means `upstream` alone. */
	upstreams: z.array(z.string()).max(8).default([]),
	/** The upstream speaks TLS (the API server on its own node). */
	upstreamTls: z.boolean(),
	/** Refuse requests without `Authorization: Bearer` (API only, except health paths). */
	bearerOnly: z.boolean(),
	allowCidrs: z.array(z.string()).default([]),
});
export type KubernetesRoute = z.infer<typeof kubernetesRouteSchema>;

/** One cluster's status sample, read by the agent through the helper (once a minute). */
export const kubernetesStatusSampleSchema = z.object({
	clusterId: z.string().max(100),
	at: z.string(),
	apiReady: z.boolean(),
	nodesReady: z.number().int().nonnegative(),
	nodesTotal: z.number().int().nonnegative(),
	/** `apiserver_requested_deprecated_apis` entries still in use, `group/version/resource`. */
	deprecatedApis: z.array(z.string().max(200)).max(100).default([]),
});
export type KubernetesStatusSample = z.infer<typeof kubernetesStatusSampleSchema>;

/** The node component's report (K2): installed minors and the tiers its probe accepted. */
export const kubernetesComponentReportSchema = z.object({
	minors: z.array(z.string().max(8)).max(10),
	tiers: z.array(z.enum(kubernetesTiers)).max(4),
	error: z.string().max(500).nullable().default(null),
});
export type KubernetesComponentReport = z.infer<typeof kubernetesComponentReportSchema>;

/**
 * Activation file names the helper accepts for a server machine. Manifests land in k3s's
 * auto-deploy directory (`server/manifests/`); k3s re-applies them on every start, so deleting the
 * RBAC bindings inside the cluster cannot lock Yoal out (K9).
 */
export const KUBERNETES_MANIFEST_FILE = /^yoal-[a-z0-9-]{1,60}\.yaml$/;
/**
 * Traefik on the machine's own port 80 (S1): servicelb is off, so the web entrypoint binds a
 * hostPort in the machine's network namespace, which the unit publishes on loopback. The helper
 * writes the same file before the first start; keep the two identical.
 */
export const KUBERNETES_TRAEFIK_MANIFEST = `apiVersion: helm.cattle.io/v1
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

/** Activation env carrying the cluster join token (servers and agents). */
export const KUBERNETES_TOKEN_ENV = 'YOAL_K8S_TOKEN';

/** A datastore snapshot or restore the node runs for one server machine (K14). */
export const kubernetesBackupTaskSchema = z.object({
	id: z.string().min(1).max(120),
	action: z.enum(['backup', 'restore']),
	machineId: z.string().min(4).max(100),
	datastore: z.enum(['sqlite', 'etcd']),
	/** Presigned PUT (backup) or GET (restore). */
	url: z.string().url(),
});
export type KubernetesBackupTask = z.infer<typeof kubernetesBackupTaskSchema>;

export const kubernetesBackupResultSchema = z.object({
	taskId: z.string().min(1).max(120),
	action: z.enum(['backup', 'restore']),
	status: z.enum(['ok', 'failed']),
	sizeBytes: z.number().int().nonnegative().optional(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
	error: z.string().max(1000).optional(),
});
export type KubernetesBackupResult = z.infer<typeof kubernetesBackupResultSchema>;

/** One batch from the cluster's log shipper (K23). */
export const kubernetesLogIngestSchema = z.array(
	z.object({
		namespace: z.string().min(1).max(253),
		pod: z.string().min(1).max(253),
		container: z.string().max(253).default(''),
		stream: z.string().max(16).default('stdout'),
		message: z.string().max(16_384),
		/** Unix ms, ISO time, or absent (now). */
		ts: z.union([z.number(), z.string()]).optional(),
	}),
).max(5000);
export type KubernetesLogIngest = z.infer<typeof kubernetesLogIngestSchema>;

/** A platform admin's request to install or remove the node component (Nodes → node → Components). */
export const kubernetesComponentRequestSchema = z.object({
	id: z.string().min(1).max(100),
	action: z.enum(['install', 'remove']),
	purge: z.boolean().default(false),
});
export type KubernetesComponentRequest = z.infer<typeof kubernetesComponentRequestSchema>;

/** The agent's answer once the helper's background job finished. */
export const kubernetesComponentResultSchema = z.object({
	id: z.string().min(1).max(100),
	ok: z.boolean(),
	message: z.string().max(1000).nullable(),
});
export type KubernetesComponentResult = z.infer<typeof kubernetesComponentResultSchema>;

/** The component's state on one node, for the dashboard. */
export interface KubernetesComponentView {
	nodeId: string;
	nodeName: string;
	installed: boolean;
	minors: string[];
	tiers: KubernetesTier[];
	error: string | null;
	/** A requested change the node has not finished yet. */
	pending: { action: 'install' | 'remove'; requestedAt: string } | null;
	lastResult: { action: 'install' | 'remove'; ok: boolean; message: string | null; at: string } | null;
	dedicatedTo: string | null;
	machines: number;
}

// ---------------------------------------------------------------- helpers

/** `km-<hex>`: the machine's alias on the org network; the helper derives the same. */
export function kubernetesMachineAlias(id: string): string {
	return `km-${id.replace(/^km_/, '').toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
}

/**
 * The API host. Cluster names are unique per org, not globally, so the host carries a short org
 * suffix: `<name>-<org8>.k8s.<contentDomain>`.
 */
export function kubernetesApiHost(name: string, orgId: string, contentDomain: string): string {
	const org = orgId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(-8);
	return `${name}-${org}.${KUBERNETES_API_ZONE}.${contentDomain}`;
}

export function kubernetesAudience(clusterId: string): string {
	return `${KUBERNETES_TOKEN_AUDIENCE_PREFIX}${clusterId}`;
}

/** Groups a principal's permissions grant in a cluster (highest wins, lower ones are implied). */
export function kubernetesGroupsFor(roles: { admin: boolean; edit: boolean; view: boolean }): string[] {
	if (roles.admin) return [KUBERNETES_GROUPS.admin];
	if (roles.edit) return [KUBERNETES_GROUPS.edit];
	if (roles.view) return [KUBERNETES_GROUPS.view];
	return [];
}

/** Parse a `kubernetes=dedicated[:<org>]` label value; null when the node is not dedicated. */
export function parseKubernetesDedication(value: string | undefined): { orgId: string | null } | null {
	if (!value) return null;
	if (value === KUBERNETES_DEDICATED_VALUE) return { orgId: null };
	if (value.startsWith(`${KUBERNETES_DEDICATED_VALUE}:`)) {
		const orgId = value.slice(KUBERNETES_DEDICATED_VALUE.length + 1);
		return orgId ? { orgId } : null;
	}
	return null;
}

/** A kubeconfig whose user is the `yoal k8s token` exec plugin. */
export function renderExecKubeconfig(input: { cluster: string; server: string; caPem?: string | null }): string {
	const context = `yoal-${input.cluster}`;
	const lines = [
		'apiVersion: v1',
		'kind: Config',
		'clusters:',
		`- name: ${context}`,
		'  cluster:',
		`    server: ${input.server}`,
		...(input.caPem ? [`    certificate-authority-data: ${Buffer.from(input.caPem).toString('base64')}`] : []),
		'users:',
		`- name: ${context}`,
		'  user:',
		'    exec:',
		'      apiVersion: client.authentication.k8s.io/v1',
		'      command: yoal',
		`      args: [k8s, token, ${input.cluster}, --output, exec-credential]`,
		'      interactiveMode: Never',
		'      provideClusterInfo: false',
		'contexts:',
		`- name: ${context}`,
		'  context:',
		`    cluster: ${context}`,
		`    user: ${context}`,
		`current-context: ${context}`,
		'',
	];
	return lines.join('\n');
}

/** A kubeconfig carrying a static bearer token (access keys, K19). */
export function renderTokenKubeconfig(input: { cluster: string; server: string; user: string; token: string }): string {
	const context = `yoal-${input.cluster}`;
	return [
		'apiVersion: v1',
		'kind: Config',
		'clusters:',
		`- name: ${context}`,
		'  cluster:',
		`    server: ${input.server}`,
		'users:',
		`- name: ${input.user}`,
		'  user:',
		`    token: ${input.token}`,
		'contexts:',
		`- name: ${context}`,
		'  context:',
		`    cluster: ${context}`,
		`    user: ${input.user}`,
		`current-context: ${context}`,
		'',
	].join('\n');
}

// ---------------------------------------------------------------- configs from natural language (§18)

export const kubernetesGenerateSchema = z.object({
	/** What to run, in plain words ("a Postgres-backed Next.js app on shop, 2 replicas"). */
	prompt: z.string().trim().min(3).max(4000),
	/** Namespace for objects that name none. */
	namespace: z
		.string()
		.min(1)
		.max(63)
		.regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'Use a Kubernetes namespace name.')
		.default('default'),
	/** Existing YAML to change instead of starting over ("make it 3 replicas"). */
	yaml: z.string().max(200_000).optional(),
	/** Also run a server-side dry run against the cluster with the caller's own permissions. */
	dryRun: z.boolean().default(false),
});
export type KubernetesGenerate = z.input<typeof kubernetesGenerateSchema>;

export const kubernetesApplySchema = z.object({
	yaml: z.string().min(1).max(200_000),
	/** Validate on the API server without changing anything. */
	dryRun: z.boolean().default(false),
	/** Namespace for objects that name none. */
	namespace: z
		.string()
		.min(1)
		.max(63)
		.regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
		.default('default'),
});
export type KubernetesApply = z.input<typeof kubernetesApplySchema>;

export interface KubernetesManifestFinding {
	severity: 'error' | 'warning' | 'info';
	document: number | null;
	object: string | null;
	path: string | null;
	message: string;
	fixed: boolean;
}

export interface KubernetesObjectRef {
	kind: string;
	name: string;
	namespace: string | null;
}

/** One object's outcome from a server-side apply or dry run. */
export interface KubernetesApplyOutcome extends KubernetesObjectRef {
	ok: boolean;
	/** `created`, `configured`, `unchanged`, or the API server's reason on failure. */
	result: string;
	message: string | null;
}

export interface KubernetesApplyResult {
	dryRun: boolean;
	ok: boolean;
	outcomes: KubernetesApplyOutcome[];
	/** Lint findings for the YAML as given (after its safe fixes). */
	findings: KubernetesManifestFinding[];
}

/** Progress events while a config is written (`event: progress` on the generate stream). */
export type KubernetesGenerateProgress =
	| { stage: 'generating'; round: number }
	| { stage: 'repairing'; round: number; errors: number }
	| { stage: 'dry-run' };

export interface KubernetesGenerateResult {
	summary: string;
	yaml: string;
	objects: KubernetesObjectRef[];
	findings: KubernetesManifestFinding[];
	/** Choices the model made that the prompt did not settle. */
	assumptions: string[];
	/** What it would need to know to do better; empty when the config is complete. */
	questions: string[];
	/** True when no finding is an error. */
	ok: boolean;
	/** Model rounds, including repairs after lint errors. */
	rounds: number;
	model: string;
	dryRun: KubernetesApplyResult | null;
}
