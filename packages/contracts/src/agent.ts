import { registryMirrorDesiredSchema } from './registry.ts';
import { INGRESS_SET_CAPABILITY, ingressDesiredSchema, ingressHealthSchema } from './ingress.ts';
import { controlDesiredSchema, controlReportSchema } from './control-plane.ts';
import * as z from 'zod';
import { OFFLINE_DRILL_CAPABILITY, nodeOfflineDrillDesiredSchema } from './node-drill.ts';
import { nodeContainerConsoleDesiredSchema } from './container-console.ts';
import { nodeStudioDesiredSchema } from './database-studio.ts';
import { nodeHardwareSchema, nodeRoleSchema, nodeRoles, nodeZoneSchema } from './cluster.ts';
import { wireguardPublicKeySchema, wireguardStateSchema, wireguardStatusSchema } from './overlay.ts';
import {
	ENDPOINTS_GATEWAY_CAPABILITY,
	nodeIdentityCertificateSchema,
	readEndpointSchema,
	serviceEndpointSchema,
	serviceProviderSchema,
} from './endpoint.ts';
import { nodeCsrSchema, nodeTrustDesiredSchema, pemCsrSchema } from './node-ca.ts';
import {
	RELEASE_PHASE_CAPABILITY,
	imagePrePullSchema,
	releaseCommandResultSchema,
	releaseCommandTaskSchema,
	upstreamCounterSchema,
} from './release-phase.ts';
import { OBJECT_STORE_KINDS_CAPABILITY } from './object-store-target.ts';
import { databaseStudioPrincipalResultSchema, databaseStudioPrincipalTaskSchema } from './database-studio-principal.ts';
import { accessModes, deploymentStatuses, nodeStatuses, runtimes } from './model.ts';
import { domainKinds } from './domain.ts';
import { mailDesiredSchema } from './email.ts';
import { IDENTITY_CAPABILITY, identityDesiredSchema, identityUnitStatusSchema } from './identity.ts';
import { workloadDesiredSchema, workloadStatuses } from './workload.ts';
import { STORAGE_STS_CAPABILITY } from './object-storage.ts';
import { databaseMetricBucketSchema, databaseSnapshotSchema } from './database.ts';
import { brokerMetricBucketSchema, brokerQueueSnapshotSchema } from './broker.ts';
import {
	kubernetesBackupResultSchema,
	kubernetesBackupTaskSchema,
	kubernetesComponentReportSchema,
	kubernetesComponentRequestSchema,
	kubernetesComponentResultSchema,
	kubernetesRouteSchema,
	kubernetesStatusSampleSchema,
} from './kubernetes.ts';
import { databaseBackupResultSchema, databaseBackupTaskSchema } from './database-backup.ts';
import { PITR_REWIND_CAPABILITY, databasePitrResultSchema, databasePitrTaskSchema } from './database-pitr.ts';
import {
	databaseReplicaLinkSchema,
	databaseReplicaPromotionResultSchema,
	databaseReplicaPromotionTaskSchema,
	databaseReplicaRewindResultSchema,
	databaseReplicaRewindTaskSchema,
	databaseReplicationReportSchema,
	databaseReplicationTaskSchema,
} from './database-replication.ts';
import {
	DB_MEMBER_CAPABILITY,
	databaseMemberEventSchema,
	databaseMemberReportSchema,
	databaseMembersDesiredSchema,
	databaseSwitchoverResultSchema,
	databaseSwitchoverTaskSchema,
	databaseSyncResultSchema,
	databaseSyncTaskSchema,
} from './database-member.ts';
import {
	databaseCredentialResultSchema,
	databaseCredentialTaskSchema,
	databaseRotationResultSchema,
	databaseRotationTaskSchema,
} from './database.ts';
import {
	storageBucketConfigReportSchema,
	storageBucketDeletionSchema,
	storageBucketSnapshotSchema,
	storageMetricBucketSchema,
	storageGatewaySchema,
	storageRootKeyReportSchema,
	storageRouteSchema,
} from './object-storage.ts';
import { storageReplicationReportSchema } from './storage-replication.ts';
import { nodeStorageSchema, nodeStorageStatusSchema } from './storage.ts';
import {
	diskMountDesiredSchema,
	diskMountReportSchema,
	diskUnmountDesiredSchema,
	nodeVolumeDesiredSchema,
	volumeInventorySchema,
} from './volume.ts';
import { shareMountDesiredSchema, shareMountReportSchema, shareUnmountDesiredSchema } from './share.ts';
import { volumeProfileResultSchema, volumeProfileTaskSchema } from './disk.ts';
import { LINK_TESTS_CAPABILITY, linkProbeTargetSchema, linkSampleSchema, linkTestResultSchema, linkTestTaskSchema } from './link.ts';
import {
	appVolumeNodeRefSchema,
	appVolumeTaskResultSchema,
	appVolumeTaskSchema,
	appVolumeUsageSampleSchema,
} from './app-volume.ts';

/**
 * The agent protocol (DESIGN §3.3). The control plane stores desired state per node;
 * agents pull it, converge idempotently and report actual state.
 */

export const releaseSpecSchema = z.object({
	sha256: z.string().length(64),
	/** Presigned download URL. Null when the agent already has the release on disk. */
	url: z.string().nullable(),
	sizeBytes: z.number().int().nonnegative(),
	fileCount: z.number().int().nonnegative(),
	precompressed: z.boolean(),
});
export type ReleaseSpec = z.infer<typeof releaseSpecSchema>;

export const routeAccessSchema = z.object({
	mode: z.enum(accessModes),
	/** HMAC key the agent uses to verify/sign host-only cookies (never the platform key). */
	siteKey: z.string().min(16),
	/** Hashed password for `password` mode, verified by the control plane. */
	loginUrl: z.string().url(),
	/** The Yoal Access policy this host uses; present when `mode` is `access`. */
	policyId: z.string().nullable().optional(),
	/** `false` when the policy is disabled; the edge fails closed before any token or cookie. */
	policyEnabled: z.boolean().optional(),
	/**
	 * Service-token rules for this host (IAM.md I25). Only header names, SHA-256 hashes and the
	 * action are published, so the agent can allow a machine before redirecting a browser.
	 */
	serviceTokens: z
		.array(
			z.object({
				header: z.string().min(1).max(80),
				tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
				action: z.enum(['allow', 'deny']),
			}),
		)
		.max(100)
		.optional(),
	/** Whether a non-service-token rule exists; absent means an older control plane. */
	hasPersonRules: z.boolean().optional(),
});
export type RouteAccess = z.infer<typeof routeAccessSchema>;

export const routeSpecSchema = z.object({
	projectId: z.string(),
	slug: z.string(),
	host: z.string(),
	deploymentId: z.string(),
	release: z.string().length(64),
	access: routeAccessSchema,
	accessMode: z.enum(accessModes),
	spa: z.boolean(),
	cleanUrls: z.boolean(),
	trailingSlash: z.enum(['always', 'never', 'ignore']),
	notFound: z.string().nullable(),
	redirects: z.array(z.object({
		from: z.string(),
		to: z.string(),
		status: z.number().int(),
	})).default([]),
	headers: z.array(z.object({
		path: z.string(),
		headers: z.record(z.string(), z.string()),
	})).default([]),
	/** When set, the edge proxies to a worker node instead of serving from local disk. */
	upstream: z.string().nullable().default(null),
	/** Several healthy worker upstreams for a multi-node replica set (C4). */
	upstreams: z.array(z.string()).max(20).optional(),
	/**
	 * Set when this node must not proxy the route to its app (D225): it has no workload or upstream
	 * yet, or its loopback port is held by another app or by the platform. The
	 * agent serves the branded 503 instead. `upstream` then names a socket nothing listens on, so
	 * an agent that predates this field fails closed too, and never serves the release as files.
	 */
	unavailable: z.string().max(500).optional(),
	/**
	 * Health path used by Caddy's active checks across replicas. On a node holding one copy of a spread
	 * app (no `upstreams`), the path its Caddy answers for an overlay probe on a protected route, with
	 * that path's status only (F7).
	 */
	healthPath: z.string().max(512).optional(),
	/** Seconds between those active checks (`replicas.healthIntervalSeconds`); agents default to 5. */
	healthIntervalSeconds: z.number().int().min(1).max(300).optional(),
	/**
	 * HA-PLAN H25: the path the edge's active checks use to decide whether a copy takes traffic,
	 * when it differs from `healthPath`. Sent only to an agent that declares `release-phase`.
	 */
	readinessPath: z.string().max(512).optional(),
	/**
	 * Functions only (D110): static assets are served first from the release, with the workerd
	 * host as the fallback (and the target for `runWorkerFirst` globs). Present only on the node
	 * that holds the release; the edge proxies here like any other worker-placed site.
	 */
	function: z
		.object({
			assetsDirectory: z.string().nullable().default(null),
			runWorkerFirst: z.array(z.string()).default([]),
			/**
			 * Phase 4: every replica socket for this route, in order, when a stateless function
			 * runs `replicas > 1`. Caddy load-balances across them. Absent for a single host, whose
			 * `upstream` above is the one target; the edge route never carries `function` and keeps
			 * using `upstream` as before.
			 */
			upstreams: z.array(z.string()).optional(),
		})
		.optional(),
	/**
	 * True for the `<slug>.<contentDomain>` route that follows the production pointer. Production
	 * is served through a per-project symlink (promote = symlink swap); previews are rooted
	 * directly at their immutable release. Older control planes omit it; agents then derive it
	 * from the host.
	 */
	production: z.boolean().optional(),
});
export type RouteSpec = z.infer<typeof routeSpecSchema>;

/** A requested agent/helper update (D99): `generation` changes on every request, including retries. */
export const nodeUpdateTaskSchema = z.object({
	generation: z.number().int().positive(),
	/** Semantic version of the signed release to install, without the `v`. */
	version: z.string().regex(/^\d+\.\d+\.\d+$/),
	/** GitHub repository the signed release is published in (`owner/name`). */
	repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
});
export type NodeUpdateTask = z.infer<typeof nodeUpdateTaskSchema>;

export const desiredStateSchema = z.object({
	version: z.number().int(),
	nodeId: z.string(),
	agentVersion: z.string(),
	generatedAt: z.string(),
	/** Content domain for hostname construction. */
	contentDomain: z.string(),
	/** Platform origin, for Caddy's on-demand TLS `ask` endpoint (custom domains). */
	platformOrigin: z.string().url().optional(),
	/** This node's `yoal-workloads.slice` budget; the agent applies it before starting units. */
	sliceMemoryMb: z.number().int().positive().optional(),
	/** CPUWeight for the same slice; omitted by older control planes (agent default 200). */
	sliceCpuWeight: z.number().int().positive().optional(),
	/** Where this node should keep its data; omitted by older control planes (D48). */
	storage: nodeStorageSchema.optional(),
	/** Releases this node must have locally, keyed by sha256. */
	releases: z.array(releaseSpecSchema),
	/** Every route on this node, production and preview. */
	routes: z.array(routeSpecSchema),
	/** Share links and sessions revoked since the last reconcile. */
	revocations: z.array(z.object({
		id: z.string(),
		kind: z.enum(['shareLink', 'session', 'email']),
		revokedAt: z.string(),
	})).default([]),
	/** Old slugs that 301 to a renamed project (DESIGN §5.1). */
	hostRedirects: z.array(z.object({
		host: z.string(),
		to: z.string(),
	})).default([]),
	/**
	 * Production hosts of live projects with nothing deployed yet. The edge answers them with a
	 * default "nothing deployed yet" page until the first production deployment adds a real route.
	 * `dashboardUrl` links the owner to the project; older control planes omit the list.
	 */
	placeholders: z.array(z.object({
		host: z.string(),
		projectId: z.string(),
		dashboardUrl: z.string().url().optional(),
	})).default([]),
	/** Tier 2/3 workloads placed on this node (DESIGN §3.4.1), managed databases included. */
	workloads: z.array(workloadDesiredSchema).default([]),
	/** Purged databases whose data dir this node must delete, then report (D59). */
	databasePurges: z.array(z.string()).default([]),
	/** Backup dumps and restores this node must execute (docs/DATABASES.md §9). */
	databaseBackupTasks: z.array(databaseBackupTaskSchema).default([]),
	/** pgBackRest base backups, PITR restores and status checks (docs/PITR.md). */
	databasePitrTasks: z.array(databasePitrTaskSchema).default([]),
	/** Credential rotations this node must apply (docs/DATABASES.md §4). */
	databaseRotations: z.array(databaseRotationTaskSchema).default([]),
	/** Named database credentials to grant or revoke (plan 04b). */
	databaseCredentialTasks: z.array(databaseCredentialTaskSchema).default([]),
	/** Read-only studio principals to (re)apply, by generation (plan 22 track G). Never the password. */
	databaseStudioPrincipals: z.array(databaseStudioPrincipalTaskSchema).default([]),
	/** Database ids whose PgBouncer sidecar must be restarted (docs/DATABASES.md §11). */
	databasePoolerRestarts: z.array(z.string()).default([]),
	/**
	 * Streaming replication this node serves as a primary (docs/CLUSTERING.md §9.2, C7): keep the
	 * `yoal_repl` role, its `pg_hba` rule and exactly these slots. The password is fetched from
	 * `/api/agent/database-replication/:databaseId`, never carried here.
	 */
	databaseReplication: z.array(databaseReplicationTaskSchema).default([]),
	/** Upstream sockets the agent serves for the replica workloads on this node (C7). */
	databaseReplicaLinks: z.array(databaseReplicaLinkSchema).default([]),
	/** Replicas on this node to promote and hand over to their database id (§9.3). */
	databaseReplicaPromotions: z.array(databaseReplicaPromotionTaskSchema).default([]),
	/** Old primaries on this node to rewind onto the new primary and adopt as replicas (W10). */
	databaseReplicaRewinds: z.array(databaseReplicaRewindTaskSchema).optional(),
	/**
	 * Members of every database on this node, for role discovery (W9-SPEC §5.6) and for the
	 * primary's node to keep the sync setting in force. No secret rides here.
	 */
	databaseMembers: z.array(databaseMembersDesiredSchema).default([]),
	/** Sync-set steps the primary's node must apply (H23). Fixed verbs, never SQL. */
	databaseSyncTasks: z.array(databaseSyncTaskSchema).default([]),
	/** Drain/resume steps of a planned switchover on the old primary's node (W10). */
	databaseSwitchovers: z.array(databaseSwitchoverTaskSchema).default([]),
	/** Disks this node must know about, so disk-backed data dirs can be verified (D76, D169). */
	volumes: z.array(nodeVolumeDesiredSchema).default([]),
	/** Network shares this node keeps mounted under `/mnt/yoal-shares` (docs/STORAGE.md §3, D143). */
	shareMounts: z.array(shareMountDesiredSchema).default([]),
	/** Share mounts to remove; the node unmounts and reports `unmountedShares`. */
	shareUnmounts: z.array(shareUnmountDesiredSchema).default([]),
	/** Disks this node keeps mounted under `/mnt/yoal-disks` by filesystem UUID (docs/STORAGE.md §3). */
	diskMounts: z.array(diskMountDesiredSchema).default([]),
	/** Disk mounts to remove; the node unmounts and reports `unmountedDisks`. */
	diskUnmounts: z.array(diskUnmountDesiredSchema).default([]),
	/** Disk benchmarks to run, one at a time (docs/STORAGE.md §5.1). */
	volumeProfileTasks: z.array(volumeProfileTaskSchema).default([]),
	/** The other overlay nodes, to sample a round trip to on every cycle (CLUSTERING §4.6, D216). */
	linkProbes: z.array(linkProbeTargetSchema).default([]),
	/** Link tests this node takes part in, as the listener or the prober. */
	linkTests: z.array(linkTestTaskSchema).default([]),
	/** Live app volumes placed on this node; the agent measures their usage (docs/VOLUMES.md). */
	appVolumes: z.array(appVolumeNodeRefSchema).default([]),
	/** Trashed app volumes past their retention window: delete the directory, then report. */
	appVolumePurges: z.array(appVolumeNodeRefSchema).default([]),
	/** App-volume snapshots and restores this node must run. */
	appVolumeTasks: z.array(appVolumeTaskSchema).default([]),
	/** Internal S3 gateway routes the control plane uses to manage object contents (D81). */
	storageGateway: storageGatewaySchema.default({ listen: null, routes: [] }),
	/** Native studio front (plan 22): listen port and live session ids, or null when off. */
	studio: nodeStudioDesiredSchema.nullable().default(null),
	/** Internal gateway route the control plane uses to reach the node's studio front (D96). */
	databaseGateway: storageGatewaySchema.default({ listen: null, routes: [] }),
	/**
	 * Container console front (D127): listen port, or null to stay closed. Its gateway routes ride
	 * `databaseGateway` with `console.internal` hosts.
	 */
	containerConsole: nodeContainerConsoleDesiredSchema.nullable().default(null),
	/**
	 * Install this signed release's agent and helper (D99). Present while an update an operator
	 * requested is outstanding for this node; the helper verifies the release signature itself.
	 */
	nodeUpdate: nodeUpdateTaskSchema.nullable().default(null),
	/**
	 * A running offline drill for this node (D235, `./node-drill.ts`): go dark until `endsAt`. Only
	 * present while one runs and only to an agent that declares `offline-drill`.
	 */
	offlineDrill: nodeOfflineDrillDesiredSchema.optional(),
	/** Managed overlay state for this node (C1); absent on external/pre-C1 nodes. */
	wireguard: wireguardStateSchema.optional(),
	/** Consumer-side loopback endpoints for attached remote services (C2). */
	serviceEndpoints: z.array(serviceEndpointSchema).default([]),
	/** Provider-side overlay listeners for services this node hosts (C2). */
	serviceProviders: z.array(serviceProviderSchema).default([]),
	/**
	 * Read endpoints on this consumer node (HA-PLAN H24): stable ports in 23000–23999 that follow a
	 * database's read replicas. Only for an agent that declares `endpoints-gateway`.
	 */
	readEndpoints: z.array(readEndpointSchema).max(1_000).optional(),
	/**
	 * The install CA bundle, this node's signed leaf and the revoked serials (HA-PLAN H24 "Trust").
	 * Public material only. Only for an agent that declares `endpoints-gateway`.
	 */
	nodeTrust: nodeTrustDesiredSchema.optional(),
	/**
	 * Release commands this node must run once each (HA-PLAN H25, I16), keyed by `runId` under a
	 * `releaseId`. Only for an agent that declares `release-phase`.
	 */
	releaseCommands: z.array(releaseCommandTaskSchema).max(20).optional(),
	/**
	 * Container images to pull ahead of a rollout or a failover (HA-PLAN H25 "image pre-pull").
	 * Only for an agent that declares `release-phase`.
	 */
	imagePrePulls: z.array(imagePrePullSchema).max(200).optional(),
	/** Public storage endpoints this node serves (S3): byte-for-byte proxies, not sites. */
	storageRoutes: z.array(storageRouteSchema).default([]),
	/**
	 * The platform registry's pull-through cache (docs/REGISTRY.md G4): the node points Podman's
	 * `registries.conf.d` mirrors for these upstreams at the registry and logs in with its node
	 * token. Absent when no mirror is on, which removes the node's mirror config.
	 */
	registryMirror: registryMirrorDesiredSchema.nullable().default(null),
	/** Purged storage instances whose data dir this node must delete, then report (S8). */
	storagePurges: z.array(z.string()).default([]),
	/** Purged queue brokers whose data dir this node must delete, then report (D111). */
	brokerPurges: z.array(z.string()).default([]),
	/** Purged Kubernetes machines whose data dir this node must delete, then report. */
	kubernetesPurges: z.array(z.string()).default([]),
	/** Public routes to Kubernetes API servers and cluster ingress (docs/KUBERNETES.md K7, K11). */
	kubernetesRoutes: z.array(kubernetesRouteSchema).default([]),
	/**
	 * Manifest generation per server machine here. When it changes the agent fetches the files from
	 * `/api/agent/kubernetes/manifests/<machineId>` (they can hold attachment passwords) and hands
	 * them to the helper, without restarting the machine.
	 */
	kubernetesManifests: z
		.array(z.object({ machineId: z.string(), generation: z.string(), nodes: z.array(z.string()).max(64).default([]) }))
		.default([]),
	/** Install or remove the optional Kubernetes component on this node (docs/KUBERNETES.md K2). */
	kubernetesComponentRequest: kubernetesComponentRequestSchema.nullable().default(null),
	/** Datastore snapshots and restores for server machines here (K14). */
	kubernetesBackupTasks: z.array(kubernetesBackupTaskSchema).default([]),
	/**
	 * Present only on the mail node (docs/EMAIL.md §3.5): run `yoal-mail` and keep it fed. No
	 * secrets: the agent fetches keys and credential hashes from `/api/agent/email-state`.
	 */
	mail: mailDesiredSchema.nullable().default(null),
	/**
	 * Present only on the node that runs `yoal-identity` (docs/IAM.md §11.2): the pool projection
	 * the agent pushes to the identity process. Carries ids, hosts and non-secret client metadata;
	 * never a client secret, signing key or user.
	 */
	identity: identityDesiredSchema.nullable().default(null),
	/** Custom domains this node serves; TLS is on-demand and authorized by the control plane. */
	domains: z.array(z.object({
		host: z.string(),
		projectId: z.string(),
		kind: z.enum(domainKinds),
		/** When set, this host 301s to the sibling (apex↔www). */
		redirectTo: z.string().nullable().default(null),
	})).default([]),
	/**
	 * Ingress-set payload (HA-PLAN H17/G5). Present only for a node in the ingress set while
	 * `INGRESS_SET` is on, and only to an agent that declares `ingress-set`; omitted everywhere
	 * else, which keeps a flag-off payload byte-identical. Carries no secret.
	 */
	ingress: ingressDesiredSchema.optional(),
	/**
	 * Control-plane HA (HA-PLAN H21, W9). Present only while `CONTROL_STANDBY` is on: the control
	 * address list in preference order and the highest epoch the primary asserts. Omitted with the
	 * flag off, so a single-node install receives a byte-identical payload.
	 */
	control: controlDesiredSchema.optional(),
});
export type DesiredState = z.infer<typeof desiredStateSchema>;

/**
 * Capabilities an agent build declares in its heartbeat. Add one whenever the control plane hands
 * out desired-state work an older agent would drop without a word.
 * - `studio-principal`: applies `databaseStudioPrincipals` (plan 22 track G).
 * - `node-update`: installs `nodeUpdate` through the helper's signed-release verb (D99).
 * - `node-update-guard`: confirms a node update after its first accepted heartbeat; the helper
 *   rolls the node back on its own if no confirm arrives within 10 minutes.
 * - `functions`: renders and runs `runtime: "function"` workloads (D110).
 * - `brokers`: runs `broker` workloads with the helper's fixed profile and purges `brokerPurges` (D111).
 * - `kubernetes` (not static: advertised only while the optional component is installed, like
 *   `process-node`): runs `kubernetes` machine workloads, purges `kubernetesPurges`, serves
 *   `kubernetesRoutes` and reports cluster status (docs/KUBERNETES.md). `kubernetes-userns` /
 *   `kubernetes-trusted` say which isolation tiers the node's probe accepted.
 * - `mail`: runs `yoal-mail` and bridges it to the control plane when `mail` is set (docs/EMAIL.md).
 * - `identity`: runs the separate `yoal-identity` user-pool process and pushes its projection
 *   (docs/IAM.md §11.2).
 * - `node-tasks`: leases one-shot queue and function test tasks (`node-task.ts`, D124).
 * - `container-console`: runs the console front for inspect, files and shells (D127).
 * - `app-volumes`: measures `appVolumes`, runs `appVolumeTasks` and purges `appVolumePurges`.
 * - `jobs`: leases job runs and starts them as transient units through the helper (plan 09).
 * - `database-replicas`: runs Postgres replica workloads, serves their link sockets, applies
 *   `databaseReplication` and `databaseReplicaPromotions` (docs/CLUSTERING.md §9.2, C7).
 * - `share-mounts`: mounts `shareMounts`, unmounts `shareUnmounts` and reports both.
 * - `disk-mounts`: mounts `diskMounts` by filesystem UUID, unmounts `diskUnmounts`, reports both.
 * - `volume-profiles`: benchmarks `volumeProfileTasks` through the helper and reports results.
 * - `workload-identity`: delivers a workload JWT file and serves the node-local metadata endpoint
 *   (docs/IAM.md I18).
 * - `link-tests`: samples a round trip to each `linkProbes` target and runs `linkTests`
 *   (docs/CLUSTERING.md §4.6).
 * - `run-leases`: removes a workload carrying `runLease` when the control plane has been out of
 *   reach for its TTL, and keeps it removed until contact returns (docs/CLUSTERING.md §8.4).
 * - `storage-sts`: understands temporary RustFS STS credentials in an activation
 *   (`storageSts`) instead of only sealed attachment keys (docs/IAM.md §7.4).
 */
/** The agent capability that says a build fences leased workloads by itself. */
export const RUN_LEASES_CAPABILITY = 'run-leases';

/**
 * HA Wave 1 capabilities (HA-PLAN §9, docs/build-plan/HA-WAVE-1.md). Declared here, but not in
 * `nodeCapabilities` yet: an agent build adds each one to that list in the same change that makes
 * it act on the fields it gates, so no node claims what it cannot do.
 * - `endpoints-gateway` (lane A): `serviceEndpoints[].role|gatewayAddress|trust|version`,
 *   `serviceProviders[].clientAuth|allowedClientNodeIds`, `readEndpoints`, `nodeTrust`,
 *   `workloads[].addHosts`, and sends `nodeCsr`.
 * - `release-phase` (lane D): `releaseCommands`, `imagePrePulls`, `workloads[].readinessPath|drainSeconds|
 *   stopTimeoutSeconds`, `routes[].readinessPath`, and sends `releaseCommandResults` and `upstreamCounters`.
 * - `object-store-kinds` (lane E): parses PITR activations with `databasePitrAnyActivationSchema`
 *   and renders `azure`/`gcs` repositories from their top-level `store` and `storeCredentials`.
 *   This group is not in desired state: a PITR repository reaches the node only through the
 *   activation endpoint, which refuses a non-`s3` repository to a node without the capability
 *   (`packages/core/src/pitr-store-gate.ts`) and leaves `repo` out of it, so an older agent's
 *   parse fails closed instead of writing an S3 config.
 * `packages/core/src/capability-gate.ts` strips the first two groups from desired state for a node
 * without the capability, or for every node while the feature's flag is off.
 */
export const haWave1Capabilities = [ENDPOINTS_GATEWAY_CAPABILITY, RELEASE_PHASE_CAPABILITY, OBJECT_STORE_KINDS_CAPABILITY] as const;
export type HaWave1Capability = (typeof haWave1Capabilities)[number];

export const nodeCapabilities = [
	'studio-principal',
	'node-update',
	'node-update-guard',
	'functions',
	'brokers',
	'mail',
	IDENTITY_CAPABILITY,
	'node-tasks',
	'container-console',
	'app-volumes',
	'jobs',
	'database-replicas',
	// W10: applies the sync set, barrier, switchover drain/resume, rewind and member probes.
	DB_MEMBER_CAPABILITY,
	// HA-PLAN W10: replica PITR/backup-from-replica and the pg_rewind verb.
	PITR_REWIND_CAPABILITY,
	'share-mounts',
	'volume-profiles',
	'disk-mounts',
	'workload-identity',
	STORAGE_STS_CAPABILITY,
	LINK_TESTS_CAPABILITY,
	RUN_LEASES_CAPABILITY,
	// Parses the ingress-set desired payload, renders public listeners/TLS and fetches activation.
	INGRESS_SET_CAPABILITY,
	// The helper accepts /24 Kubernetes machine subnets in WireGuard peers (docs/KUBERNETES.md §10).
	'wg-subnets',
	// Goes dark for a node offline drill (D235): no heartbeats or pulls, failing ingress probe.
	OFFLINE_DRILL_CAPABILITY,
] as const;
export type NodeCapability = (typeof nodeCapabilities)[number];

/** Most certificates one heartbeat reports (content apex + wildcard, platform host, custom domains). */
export const HEARTBEAT_CERTS_MAX = 200;

export const heartbeatSchema = z.object({
	nodeId: z.string(),
	agentVersion: z.string(),
	actualStateVersion: z.number().int().nonnegative(),
	status: z.enum(nodeStatuses),
	caddyOk: z.boolean(),
	/**
	 * What this agent build can do (`nodeCapabilities`). Lets the control plane refuse work an older
	 * agent would silently ignore instead of waiting on it. Absent from agents that predate it.
	 */
	capabilities: z.array(z.string().min(1).max(64)).max(32).optional(),
	stats: z.object({
		cpuPercent: z.number().nonnegative(),
		memoryBytes: z.number().int().nonnegative(),
		memoryTotalBytes: z.number().int().nonnegative(),
		diskUsedBytes: z.number().int().nonnegative(),
		diskTotalBytes: z.number().int().nonnegative(),
		/** Free space on the data filesystem; derived from total-used when an older agent omits it. */
		diskFreeBytes: z.number().int().nonnegative().optional(),
		uptimeSeconds: z.number().nonnegative(),
		load1: z.number().nonnegative(),
		/**
		 * TLS certificates this node's Caddy serves, probed locally (DESIGN §8 "cert expiring < 14 d").
		 * `host` is the SNI probed (`*.<contentDomain>` for the wildcard); `notAfter` is ISO 8601.
		 * Custom domains are listed only when the certificate's names cover the host; that report is
		 * what moves a verified domain to `active`.
		 */
		certs: z.array(z.object({ host: z.string().max(253), notAfter: z.string().max(40) })).max(HEARTBEAT_CERTS_MAX),
	}).partial().optional(),
	releases: z.array(z.object({ sha256: z.string(), sizeBytes: z.number().int().nonnegative() })).default([]),
	/** Hardware facts, refreshed at start-up and hourly (CLUSTERING §3.1). */
	hardware: nodeHardwareSchema.optional(),
	/** Latest WireGuard peer health, when this node runs a managed overlay (C1). */
	wireguard: wireguardStatusSchema.optional(),
	/**
	 * This node's WireGuard public key, sent while desired state puts it on the overlay. A node
	 * adopted into the overlay after it joined has no stored key until this arrives (C1).
	 */
	wireguardPublicKey: wireguardPublicKeySchema.optional(),
	/** Public node certificate for C2 mTLS; the private key never leaves the node. */
	nodeCertificate: nodeIdentityCertificateSchema.optional(),
	/**
	 * A CSR for the install CA (HA-PLAN H24 "Trust"), sent while the node has no valid leaf or is
	 * due to renew. The key pair is generated on the node; only the request travels.
	 */
	nodeCsr: nodeCsrSchema.optional(),
	/**
	 * The fleet certificate fingerprint this ingress serves (HA-PLAN H20, W7), from
	 * `certificateFleetFingerprint` over its delivered certificates. Every ingress reports the same
	 * value when distribution is healthy; a mismatch is what the preflight and dashboard compare.
	 * Null with `SHARED_CERTIFICATES` off, so a single-node install is unchanged.
	 */
	certificateFingerprint: z.string().max(128).nullable().optional(),
	/** Progress and outcomes of `releaseCommands` since the last heartbeat (HA-PLAN H25). */
	releaseCommandResults: z.array(releaseCommandResultSchema).max(20).optional(),
	/**
	 * What `GET /.well-known/yoal/health` currently answers (HA-PLAN H19). Sent by an ingress only;
	 * the endpoint itself is served by Caddy from the agent's state file, so this is the fleet view.
	 */
	ingressHealth: ingressHealthSchema.optional(),
	/**
	 * A control node's view of the arbitrated lease (HA-PLAN H21, W9). Present only on a control
	 * node while `CONTROL_STANDBY` is on; the control plane records it in `control_state` for
	 * `/api/v1/ha/status`. Omitted with the flag off, so a single-node payload is unchanged.
	 */
	control: controlReportSchema.optional(),
	/**
	 * Per-upstream request counters since the previous heartbeat (HA-PLAN H25 "Canary"), from this
	 * node's own Caddy. Sent by an agent that declares `release-phase`.
	 */
	upstreamCounters: z.array(upstreamCounterSchema).max(2_000).optional(),
	/** What the node's storage service last applied (D48). */
	storage: nodeStorageStatusSchema.optional(),
	/** Mounts and block devices the node reports, from which Settings → Storage lists disk candidates (D72, D80). */
	volumes: volumeInventorySchema.optional(),
	/** The node's view of every desired share mount, each heartbeat. */
	shareMounts: z.array(shareMountReportSchema).max(200).optional(),
	/** Share mount ids from `shareUnmounts` that are now unmounted. */
	unmountedShares: z.array(z.string().max(100)).max(200).optional(),
	/** The node's view of every desired disk mount, each heartbeat. */
	diskMounts: z.array(diskMountReportSchema).max(200).optional(),
	/** Disk mount ids from `diskUnmounts` that are now unmounted. */
	unmountedDisks: z.array(z.string().max(100)).max(200).optional(),
	/** Progress and results of `volumeProfileTasks`. */
	volumeProfileResults: z.array(volumeProfileResultSchema).max(50).optional(),
	/** The latest round-trip sample to each `linkProbes` target. */
	links: z.array(linkSampleSchema).max(64).optional(),
	/** Progress and results of the `linkTests` this node probes. */
	linkTestResults: z.array(linkTestResultSchema).max(32).optional(),
	/** Actual workload state, so the fleet view reflects restart loops and OOM kills (DESIGN §9). */
	workloads: z.array(z.object({
		id: z.string(),
		status: z.enum(workloadStatuses),
		restarts: z.number().int().nonnegative().default(0),
		memoryBytes: z.number().int().nonnegative().optional(),
		/** Cumulative CPU time the unit has used, in nanoseconds; a rate comes from two samples. */
		cpuNanos: z.number().nonnegative().optional(),
	})).optional(),
	/** Database ids whose data dir was deleted after a `databasePurges` entry (D59). */
	purgedDatabases: z.array(z.string()).optional(),
	/** Storage instance ids whose data dir was deleted after a `storagePurges` entry (S8). */
	purgedStorage: z.array(z.string()).optional(),
	/** Broker ids whose data dir was deleted after a `brokerPurges` entry (D111). */
	purgedBrokers: z.array(z.string()).optional(),
	/** Kubernetes machine ids whose data dir was deleted after a `kubernetesPurges` entry. */
	purgedKubernetes: z.array(z.string()).optional(),
	/** The optional Kubernetes component (installed minors, working tiers); absent when not installed. */
	kubernetes: kubernetesComponentReportSchema.optional(),
	/** One status sample per cluster whose server machine runs here. */
	kubernetesStatus: z.array(kubernetesStatusSampleSchema).max(200).optional(),
	/** The outcome of `kubernetesComponentRequest` once the helper's job finished. */
	kubernetesComponentResult: kubernetesComponentResultSchema.optional(),
	/** Outcomes of `kubernetesBackupTasks` since the last heartbeat. */
	kubernetesBackupResults: z.array(kubernetesBackupResultSchema).max(50).optional(),
	/** App volume ids whose directory was deleted after an `appVolumePurges` entry. */
	purgedAppVolumes: z.array(z.string().max(100)).max(500).optional(),
	/** Latest usage sample per app volume, sent after each measurement round. */
	appVolumeUsage: z.array(appVolumeUsageSampleSchema).max(1_000).optional(),
	/** Outcomes of `appVolumeTasks` since the last heartbeat. */
	appVolumeTaskResults: z.array(appVolumeTaskResultSchema).max(50).optional(),
	/** Outcomes of `databaseBackupTasks` since the last heartbeat. */
	databaseBackupResults: z.array(databaseBackupResultSchema).max(50).optional(),
	/** Outcomes of `databasePitrTasks` since the last heartbeat. */
	databasePitrResults: z.array(databasePitrResultSchema).max(50).optional(),
	/** Outcomes of `databaseRotations` since the last heartbeat. */
	databaseRotationResults: z.array(databaseRotationResultSchema).max(50).optional(),
	/** Outcomes of `databaseCredentialTasks` since the last heartbeat. */
	databaseCredentialResults: z.array(databaseCredentialResultSchema).max(50).optional(),
	/** Outcomes of `databaseStudioPrincipals` since the last heartbeat. */
	databaseStudioPrincipalResults: z.array(databaseStudioPrincipalResultSchema).max(50).optional(),
	/**
	 * A `nodeUpdate` generation that failed. Success needs no report: the restarted agent's
	 * `agentVersion` is the proof (D99).
	 */
	nodeUpdateResult: z.object({
		generation: z.number().int().positive(),
		error: z.string().max(2_000),
	}).optional(),
	/** Database ids whose pooler restart the node completed. */
	databasePoolerRestarted: z.array(z.string()).max(50).optional(),
	/** Latest configure outcome and slot sample per `databaseReplication` task (C7). */
	databaseReplication: z.array(databaseReplicationReportSchema).max(100).optional(),
	/** Outcomes of `databaseReplicaPromotions` since the last heartbeat. */
	databaseReplicaPromotionResults: z.array(databaseReplicaPromotionResultSchema).max(20).optional(),
	/** Outcomes of `databaseReplicaRewinds` since the last heartbeat. */
	databaseReplicaRewindResults: z.array(databaseReplicaRewindResultSchema).max(20).optional(),
	/** Role, generation and replay position of each member on this node (W9-SPEC §5.6). */
	databaseMembers: z.array(databaseMemberReportSchema).max(50).optional(),
	/** W11 membership events since the last heartbeat: fence notice/failure, promotions, retries. */
	databaseMemberEvents: z.array(databaseMemberEventSchema).max(50).optional(),
	/** Outcomes of `databaseSyncTasks` since the last heartbeat. */
	databaseSyncResults: z.array(databaseSyncResultSchema).max(20).optional(),
	/** Outcomes of `databaseSwitchovers` since the last heartbeat. */
	databaseSwitchoverResults: z.array(databaseSwitchoverResultSchema).max(20).optional(),
	/**
	 * Retired with the D60 studio console (D96). 0.7.x agents may still send console results;
	 * they are accepted and ignored. Remove once no 0.7.x agents remain.
	 */
	databaseConsoleResults: z.array(z.unknown()).max(50).optional(),
	/** TLS state derived from the helper's certificate files (CA PEM is public, never a key). */
	databaseTls: z
		.array(
			z.object({
				id: z.string().max(100),
				enabled: z.boolean(),
				caPem: z.string().max(16_384).nullable().optional(),
				error: z.string().max(2_000).nullable().optional(),
			}),
		)
		.max(200)
		.optional(),
	/** Outcomes of `objectStorage.deleteBuckets` entries since the last heartbeat. */
	storageBucketDeletions: z.array(storageBucketDeletionSchema).max(500).optional(),
	/** Bucket configuration convergence outcomes since the last heartbeat. */
	storageBucketConfigs: z.array(storageBucketConfigReportSchema).max(500).optional(),
	/** Progress of the replication links this node runs (OBJECT-STORAGE.md §12). */
	storageReplication: z.array(storageReplicationReportSchema).max(100).optional(),
	/** Root keys the agent proved (or saw refused) since the last heartbeat (§5). */
	storageRootKeys: z.array(storageRootKeyReportSchema).max(200).optional(),
	/** The identity unit's health on this node, so the fleet view can fall back to control-plane routes. */
	identityStatus: identityUnitStatusSchema.nullable().optional(),
});
export type Heartbeat = z.infer<typeof heartbeatSchema>;

/** Pre-aggregated 1-minute access buckets; raw requests never reach the telemetry store (DESIGN §8). */
export const metricBucketSchema = z.object({
	host: z.string(),
	projectId: z.string().nullable().optional(),
	bucket: z.string(),
	requests: z.number().int().nonnegative(),
	status2xx: z.number().int().nonnegative(),
	status3xx: z.number().int().nonnegative(),
	status4xx: z.number().int().nonnegative(),
	status5xx: z.number().int().nonnegative(),
	bytes: z.number().int().nonnegative(),
	durationP50Ms: z.number().nonnegative(),
	durationP95Ms: z.number().nonnegative(),
	topPaths: z.array(z.object({ path: z.string(), count: z.number().int() })).default([]),
	topReferrers: z.array(z.object({ referrer: z.string(), count: z.number().int() })).default([]),
});
export type MetricBucket = z.infer<typeof metricBucketSchema>;

/**
 * One Analytics Engine datapoint from a function (docs/FUNCTIONS.md §4.5). `blobs`/`doubles`/
 * `indexes` are the Workers API arrays; the binding's dataset and the owning project/workload are
 * attached by the node so the dashboard can group without trusting the worker.
 */
export const analyticsEventSchema = z.object({
	ts: z.number().int().nonnegative(),
	projectId: z.string().max(100),
	workloadId: z.string().max(100),
	dataset: z.string().min(1).max(100),
	blobs: z.array(z.string().max(16_384)).max(20).default([]),
	doubles: z.array(z.number()).max(20).default([]),
	indexes: z.array(z.string().max(1024)).max(20).default([]),
});
export type AnalyticsEvent = z.infer<typeof analyticsEventSchema>;

/** One tail-worker item for one function invocation (docs/FUNCTIONS.md §4.5, phase 3). */
export const functionTailEventSchema = z.object({
	ts: z.number().int().nonnegative(),
	projectId: z.string().max(100),
	workloadId: z.string().max(100),
	scriptName: z.string().max(200).default(''),
	outcome: z.string().max(64).default('unknown'),
	logs: z
		.array(z.object({ level: z.string().max(16), message: z.string().max(4_096) }))
		.max(50)
		.default([]),
	exceptions: z
		.array(z.object({ name: z.string().max(200), message: z.string().max(4_096) }))
		.max(20)
		.default([]),
	request: z
		.object({
			method: z.string().max(16),
			url: z.string().max(2_048),
			status: z.number().int().nonnegative().optional(),
		})
		.nullable()
		.default(null),
});
export type FunctionTailEvent = z.infer<typeof functionTailEventSchema>;

/** One uncovered range from an agent's bounded telemetry spool (HA-PLAN H28/W12). */
export const telemetrySpoolGapSchema = z.object({
	/** The host whose buckets were lost, or `*` when the spool could not attribute them. */
	host: z.string().min(1).max(253),
	/** Epoch ms, inclusive. */
	from: z.number().int().nonnegative(),
	/** Epoch ms, exclusive. */
	to: z.number().int().nonnegative(),
	/** Buckets dropped in the range. */
	buckets: z.number().int().nonnegative().default(0),
});
export type TelemetrySpoolGap = z.infer<typeof telemetrySpoolGapSchema>;

/**
 * The agent's disk spool (HA-PLAN H28): pending access-log buckets survive a control-plane outage
 * on disk, bounded by count and bytes. `gaps` names what the bound dropped, so the dashboard can
 * shade minutes it knows are missing rather than drawing them as zero traffic.
 */
export const telemetrySpoolSchema = z.object({
	queued: z.number().int().nonnegative().default(0),
	bytes: z.number().int().nonnegative().default(0),
	/** Buckets dropped since this spool was created (its bound was reached). */
	dropped: z.number().int().nonnegative().default(0),
	gaps: z.array(telemetrySpoolGapSchema).max(200).default([]),
});
export type TelemetrySpoolReport = z.infer<typeof telemetrySpoolSchema>;

export const telemetryBatchSchema = z.object({
	nodeId: z.string(),
	buckets: z.array(metricBucketSchema).max(5000).default([]),
	/** Managed database samples (D57). */
	databases: z.array(databaseMetricBucketSchema).max(5000).default([]),
	/** Latest table snapshot per database (only the newest is kept). */
	databaseSnapshots: z.array(databaseSnapshotSchema).max(200).default([]),
	/** Managed object storage samples (S7). */
	objectStorage: z.array(storageMetricBucketSchema).max(5000).default([]),
	/** Latest per-bucket usage per storage instance. */
	objectStorageBuckets: z.array(storageBucketSnapshotSchema).max(200).default([]),
	/** Managed queue broker samples (D123). */
	brokers: z.array(brokerMetricBucketSchema).max(5000).default([]),
	/** Latest stream listing per broker (only the newest is kept). */
	brokerQueues: z.array(brokerQueueSnapshotSchema).max(200).default([]),
	/** Analytics Engine datapoints written by function bindings (phase 2). */
	analytics: z.array(analyticsEventSchema).max(5000).default([]),
	/** Structured tail-worker items from function invocations (phase 3). */
	tails: z.array(functionTailEventSchema).max(2000).default([]),
	/** The agent's telemetry spool state; absent from older agents. */
	spool: telemetrySpoolSchema.optional(),
});
export type TelemetryBatch = z.infer<typeof telemetryBatchSchema>;

export const nodeHeartbeatResponseSchema = z.object({
	ok: z.boolean(),
	desiredStateVersion: z.number().int(),
});
export type NodeHeartbeatResponse = z.infer<typeof nodeHeartbeatResponseSchema>;

export const nodeJoinSchema = z.object({
	token: z.string().min(20),
	name: z.string().min(1).max(120),
	publicAddress: z.string().max(253).optional(),
	version: z.string().max(64).optional(),
	/** `yoal` asks the control plane for a managed overlay address. */
	networkMode: z.enum(['yoal', 'external']).default('external'),
	/** Public key generated by the node's helper; the private key never travels. */
	wireguardPublicKey: z.string().trim().regex(/^[A-Za-z0-9+/]{43}=$/).optional(),
	/**
	 * A CSR for the install CA, from a key pair the node generated (HA-PLAN H24 "Trust"). The
	 * signed leaf arrives in desired state (`nodeTrust`); without a CSR here the node sends one in
	 * its first heartbeat instead.
	 */
	csrPem: pemCsrSchema.optional(),
	/**
	 * HA Wave 5 (`node.sh --zone`, `--roles`, HA-PLAN §8 step 2): the node's zone and roles at join,
	 * the same fields Nodes → Edit node sets. Absent keeps today's defaults (zone `default`, roles
	 * from the node's mode).
	 */
	zone: nodeZoneSchema.optional(),
	roles: z.array(nodeRoleSchema).min(1).max(nodeRoles.length).optional(),
});
export type NodeJoin = z.infer<typeof nodeJoinSchema>;

export const deploymentEventSchema = z.object({
	type: z.string(),
	deploymentId: z.string(),
	projectId: z.string(),
	status: z.enum(deploymentStatuses),
	runtime: z.enum(runtimes),
	at: z.string(),
});
export type DeploymentEvent = z.infer<typeof deploymentEventSchema>;
