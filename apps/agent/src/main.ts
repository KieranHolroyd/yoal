import { existsSync, promises as fs, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
	desiredStateSchema,
	heartbeatSchema,
	nodeCapabilities,
	nodeDrillLimits,
	nodeDrillPollSchema,
	ENDPOINTS_GATEWAY_CAPABILITY,
	FUNCTIONS_PYTHON_CAPABILITY,
	PROCESS_NODE_CAPABILITY,
	RELEASE_PHASE_CAPABILITY,
	WORKERD_INSTALL_DIR,
	WORKERD_PINNED_VERSION,
	ingressHealthWords,
	workloadActivationSchema,
	ingressActivationSchema,
	type DesiredState,
	type Heartbeat,
	type IngressActivation,
	type IngressDesired,
	type IngressHealth,
	type NodeStudioDesired,
	type NodeContainerConsoleDesired,
	type NodeStatus,
	type PublicDatabaseListener,
	type VolumeInventory,
	type WireguardStatus,
	type WorkloadActivation,
	type WorkloadDesired,
	INGRESS_SET_CAPABILITY,
	HA_EPOCH_CAPABILITY,
	DB_MEMBER_SELF_FENCING_CAPABILITY,
} from '@yoal/contracts';
import type { TlsOptions } from '@yoal/site-config';
import { startAnalyticsSink, type AnalyticsSink } from './analytics-sink.ts';
import { CaddyAdmin } from './caddy.ts';
import { CertProbe, certProbeTargets, tlsCertReader, tlsCertFingerprint } from './certs.ts';
import { CERTIFICATE_REFRESH_MS, CertificateDelivery } from './certificates.ts';
import { ingressHealth, ingressHealthWord } from './ingress-health.ts';
import { LameDuck } from './lame-duck.ts';
import { OfflineDrill } from './offline-drill.ts';
import { buildCaddyConfig, isProductionRoute, tlsSubjects } from './caddy-config.ts';
import { loadConfig, splitIngressListen, type AgentConfig } from './config.ts';
import { controlSocketFetch } from './control-socket.ts';
import { DatabaseBackupRunner } from './database-backups.ts';
import { AppVolumeRunner } from './app-volumes.ts';
import { ShareMountRunner } from './share-mounts.ts';
import { DiskMountRunner } from './disk-mounts.ts';
import { VolumeProfileRunner } from './volume-profiles.ts';
import { LinkTestRunner } from './link-tests.ts';
import { ControlEndpoints } from './control-endpoints.ts';
import { readControlReport } from './control-report.ts';
import { RunLeaseClock, leaseState } from './run-lease.ts';
import { DatabasePitrRunner } from './database-pitr.ts';
import { DatabaseCredentialRunner } from './database-credentials.ts';
import { StudioPrincipalRunner } from './studio/principal.ts';
import { MailBridge } from './mail-bridge.ts';
import { IdentityBridge } from './identity-bridge.ts';
import { NodeUpdateRunner } from './node-update.ts';
import { DatabasePoolerRestartRunner } from './database-pooler-restarts.ts';
import { DatabaseReplicationRunner } from './database-replication.ts';
import { DatabaseDurabilityRunner } from './database-durability.ts';
import { DatabaseMemberRunner, memberOperations, reportOnlyPeerTransport } from './database-member.ts';
import { ReplicaLinkForwarder } from './replica-links.ts';
import { DatabaseRotationRunner } from './database-rotations.ts';
import { DATABASE_STATS_INTERVAL_MS, DatabaseStatsSampler } from './database-stats.ts';
import { FunctionScheduler } from './function-scheduler.ts';
import { FunctionQueueConsumers } from './function-queues.ts';
import { EventPublisher } from './event-publisher.ts';
import { NodeTaskRunner } from './node-tasks.ts';
import { JobRunner, ReleaseCommandRunner } from './jobs.ts';
import { HelperClient } from './helper-client.ts';
import { formatEnv, JOIN_USAGE, joinNode, nodeFilePath, parseJoinArgs } from './join.ts';
import { WorkloadLogDrain } from './log-drain.ts';
import { ReleaseManager, servesReleaseLocally } from './releases.ts';
import { databaseTlsHeartbeat, WorkloadRuntime, workloadHeartbeat } from './runtime.ts';
import { HardwareCollector } from './hardware.ts';
import { ServiceForwarder, wantsGateway } from './endpoints.ts';
import { PublicDatabaseProxy, type PublicDbCertificate } from './public-db.ts';
import { NodeCertificateManager } from './node-cert.ts';
import { NodeCaIdentity } from './node-ca.ts';
import { StatsCollector } from './stats.ts';
import { StorageReconciler, STORAGE_RECONCILE_INTERVAL_MS } from './storage-admin.ts';
import { StorageRequester } from './storage.ts';
import { StorageStatsSampler, STORAGE_STATS_INTERVAL_MS } from './storage-stats.ts';
import { StorageReplicator } from './storage-replicator.ts';
import { BROKER_STATS_INTERVAL_MS, BrokerStatsSampler } from './broker-stats.ts';
import { KubernetesSync, kubernetesCapabilities, readKubernetesComponent } from './kubernetes.ts';
import { atomicWriteFile, DesiredStateStore, desiredStateEtag, desiredStateRequest } from './state.ts';
import { postTelemetryBatch, TelemetryClient } from './telemetry.ts';
import { accessLogHosts, createClientIpHasher, EdgeRequestLogs } from './edge-request-logs.ts';
import { loadLogsSecret, NodeLogBatcher, postNodeLogBatch } from './log-records.ts';
import { OtlpLogsReceiver, otlpWorkloadEnv } from './otlp-logs.ts';
import { handleSiteRequest, normalizeHost, UsedTokenCache } from './verify.ts';
import { IngressSecretsStore, ingressListeners } from './ingress.ts';
import { AccessDecisionCache } from './yoal-access.ts';
import type { StudioFront } from './studio/front.ts';
import { ConsoleFront, controlPlaneConsoleActivationFetcher } from './console-front.ts';
import { WorkloadIdentityBroker, parseIdentityResponse } from './workload-identity.ts';

const HEARTBEAT_INTERVAL_MS = 10_000;
/** Refresh the ingress activation every six hours; retry a failed first fetch after a minute. */
const INGRESS_SECRETS_REFRESH_MS = 6 * 60 * 60 * 1000;
const INGRESS_SECRETS_RETRY_MS = 60_000;
// Bun's default idle timeout on the control plane is 10 s (adapter-bun CONNECTION_IDLE_TIMEOUT),
// so hold well under it. The server caps `wait` at 25 s for installs that raise the timeout.
const LONG_POLL_SECONDS = 8;
const LONG_POLL_TIMEOUT_MS = (LONG_POLL_SECONDS + 10) * 1_000;
const TELEMETRY_INTERVAL_MS = 60_000;
/** Unreferenced images are pruned at most this often (docs/REGISTRY.md R3). */
const IMAGE_PRUNE_INTERVAL_MS = 60 * 60_000;
/** Mounts change rarely; heartbeat every 10 s but re-read the helper's inventory once a minute. */
const VOLUME_INVENTORY_INTERVAL_MS = 60_000;
/** `@id` present in every config the agent loads (site-config's catch-all route). */
const CONVERGED_SENTINEL_ID = 'catch-all';
const TELEMETRY_POLL_MS = 1_000;
/** How often access and OTLP log records are shipped (docs/LOGS.md LP6, LP7). */
const LOG_RECORDS_INTERVAL_MS = 2_000;

class Backoff {
	private readonly initialMs: number;
	private readonly maxMs: number;
	private currentMs: number;

	constructor(initialMs: number, maxMs: number) {
		this.initialMs = initialMs;
		this.maxMs = maxMs;
		this.currentMs = initialMs;
	}

	next(): number {
		const value = this.currentMs;
		this.currentMs = Math.min(this.maxMs, this.currentMs * 2);
		return value;
	}

	reset(): void {
		this.currentMs = this.initialMs;
	}
}

class AgentRuntime {
	private readonly config: AgentConfig;
	private readonly store: DesiredStateStore;
	/** The control address list and persisted epoch (W9). Rotates on silence or a non-primary. */
	private readonly control: ControlEndpoints;
	/** This host's local control-plane `/readyz` for the heartbeat, or null when not co-located. */
	private readonly controlReadyzUrl: string | null;
	private readonly releases: ReleaseManager;
	private readonly caddy: CaddyAdmin;
	private readonly stats: StatsCollector;
	private readonly hardware: HardwareCollector;
	private readonly serviceForwarder: ServiceForwarder;
	private readonly nodeCertificate: NodeCertificateManager;
	/** The install-CA key, CSR and leaf (HA-PLAN H24 "Trust"); idle until desired state has `nodeTrust`. */
	private readonly nodeCa: NodeCaIdentity;
	/** Set once the helper's endpoint guard is in place; gateway listeners wait for it. */
	private endpointGuardReady = false;
	/** Public database listeners on this ingress (D241). */
	private readonly publicDb = new PublicDatabaseProxy({ log: (level, message) => log(level, message) });
	/** The rule set the helper last applied for them; listeners bind only while it matches. */
	private publicDbFirewallKey: string | null = null;
	private publicDbHelperOutdated = false;
	private publicDbCertificates = new Map<string, PublicDbCertificate>();
	private publicDbCertNames = '';
	private publicDbCertsAt = 0;
	/** Set once this process served a listener, so the heartbeat keeps reporting an emptied set. */
	private publicDbReported = false;
	private wireguardStatus: WireguardStatus | null = null;
	/** The helper's WireGuard public key, once fetched; the private key never leaves the helper. */
	private wireguardPublicKey: string | null = null;
	private wireguardStatusAt = 0;
	private readonly certs: CertProbe | null;
	/** Shared certificates delivered by the control plane (HA-PLAN H20); empty with the flag off. */
	private readonly certificateDelivery: CertificateDelivery;
	private readonly helper: HelperClient;
	/** Email (docs/EMAIL.md): runs and feeds yoal-mail when this node is the mail node. */
	private readonly mail: MailBridge;
	/** User pools (IAM.md §11.2): runs yoal-identity when this node is the identity node. */
	private readonly poolIdentity: IdentityBridge;
	private readonly workloads: WorkloadRuntime;
	/** Workload JWT delivery and the loopback metadata endpoint (IAM.md I18). */
	private readonly identity: WorkloadIdentityBroker;
	private readonly logDrain: WorkloadLogDrain;
	private readonly storage: StorageRequester;
	private readonly databaseStats: DatabaseStatsSampler;
	private readonly databaseBackups: DatabaseBackupRunner;
	/** App-volume usage, purges, snapshots and restores (docs/VOLUMES.md). */
	private readonly appVolumes: AppVolumeRunner;
	/** Network share mounts under /mnt/yoal-shares (docs/STORAGE.md §3, D143). */
	private readonly shareMounts: ShareMountRunner;
	private readonly diskMounts: DiskMountRunner;
	/** Disk benchmarks (docs/STORAGE.md §5.1). */
	private readonly volumeProfiles: VolumeProfileRunner;
	private readonly linkTests: LinkTestRunner;
	private readonly runLease: RunLeaseClock;
	/** The leased workloads this node was last holding back, so a change triggers one converge. */
	private fencedKey = '';
	private readonly databasePitr: DatabasePitrRunner;
	private readonly databaseRotations: DatabaseRotationRunner;
	private readonly databaseCredentials: DatabaseCredentialRunner;
	private readonly studioPrincipals: StudioPrincipalRunner;
	private readonly nodeUpdate: NodeUpdateRunner;
	private readonly databasePoolerRestarts: DatabasePoolerRestartRunner;
	/** Primary-side configure/sample and replica promotion (C7). */
	private readonly databaseReplication: DatabaseReplicationRunner;
	/** W10: sync set, switchover drain/resume, rewind and member probes. */
	private readonly databaseDurability: DatabaseDurabilityRunner;
	/**
	 * W11: the database member machine. It is report-only until this node has a direct arbiter
	 * transport and a peer channel; with `arbiter: null` it never fences or promotes (LANE-A-HANDOFF).
	 */
	private readonly databaseMember: DatabaseMemberRunner;
	/** Unix sockets the replica containers stream through (C7). */
	private readonly replicaLinks: ReplicaLinkForwarder;
	private readonly storageAdmin: StorageReconciler;
	private readonly storageStats: StorageStatsSampler;
	private readonly storageReplicator: StorageReplicator;
	private readonly brokerStats: BrokerStatsSampler;
	/** Manifest sync and status samples for Kubernetes machines (docs/KUBERNETES.md). */
	private readonly kubernetes: KubernetesSync;
	private readonly functions: FunctionScheduler;
	private readonly functionQueues: FunctionQueueConsumers;
	private readonly eventPublisher: EventPublisher;
	private readonly nodeTasks: NodeTaskRunner;
	/** App cron jobs and one-off commands (plan 09). */
	private readonly jobs: JobRunner;
	/** Release commands from desired state, at most once each (HA-PLAN H25, I16). */
	private readonly releaseCommands: ReleaseCommandRunner;

	private desired: DesiredState | null = null;
	private desiredEtag: string | null = null;
	/** Whether this process has pulled a full desired state yet; see `desiredStateRequest`. */
	private desiredPulledThisRun = false;
	private convergedVersion: number | null = null;
	/** The last config body applied, so a certificate delivery does not trigger a needless reload. */
	private appliedCaddyJson: string | null = null;
	private actualStateVersion = 0;
	private projectByHost = new Map<string, string>();
	/**
	 * docs/LOGS.md LP6: hosts whose access lines may become log records (routes and their verified
	 * custom domains), with the route's 2xx/3xx sample rate when desired state sets one.
	 */
	private accessLogHosts = new Map<string, number | undefined>();
	/** Edge access records and OTLP logs waiting for `POST /api/agent/log-records` (LP6, LP7). */
	private readonly logRecords: NodeLogBatcher;
	private edgeRequestLogs: EdgeRequestLogs | null = null;
	private otlpLogs: OtlpLogsReceiver | null = null;
	/** `<dataDir>/logs.key`, loaded on first use; null when it cannot be read or written. */
	private logsSecretValue: Buffer | null | undefined = undefined;
	private readonly usedTokens: UsedTokenCache;
	/** Shared ingress secrets fetched through the node-authenticated activation endpoint (G8). */
	private readonly ingressSecretsStore: IngressSecretsStore;
	private ingressSecrets: IngressActivation | null = null;
	private ingressSecretsAt = 0;
	private ingressSecretsWarned = false;
	/** Brief cache of verified Yoal Access decisions (IAM.md §11.1, S6). */
	private readonly accessCache: AccessDecisionCache;

	private caddyOk = false;
	/** HA-PLAN H19: the settings Caddy renders while this node is an ingress; null as a worker. */
	private ingress: IngressDesired | null = null;
	/** The last config this agent applied, so releases and versions are judged against what serves. */
	private appliedState: DesiredState | null = null;
	/** The word Caddy currently reads from the health state directory. */
	private healthWord: string | null = null;
	private latestIngressHealth: IngressHealth | null = null;
	/** Cached fingerprint of the certificate this node serves (a TLS handshake is not free). */
	private fingerprintRead: { value: string | null; at: number } | null = null;
	private readonly lameDuck: LameDuck;
	/** A node offline drill (D235): while active, this agent is dark to the control plane. */
	private readonly offlineDrill = new OfflineDrill();
	private stopping = false;
	private running = true;
	private server: ReturnType<typeof Bun.serve> | null = null;
	private readonly shutdownController = new AbortController();
	private resolveShutdown: (() => void) | null = null;
	private loops: Array<Promise<void>> = [];

	private lastReconcileAttemptAt = 0;
	/** The registry mirror last applied (G4); `undefined` until the first reconcile checks it. */
	private appliedMirror: string | undefined;
	private appliedMirrorHost: string | undefined;

	/** Image prune (docs/REGISTRY.md R3): at most hourly, after a reconcile, never two at once. */
	private lastImagePruneAt = 0;
	private imagePruneRunning = false;
	private imagePruneWarned = false;
	private lastReconcileSuccessAt = 0;
	private reconcileFailures = 0;
	private heartbeatFailures = 0;

	private telemetry: TelemetryClient | null = null;
	private telemetryStartWarned = false;
	/** Loopback sink function hosts POST Analytics Engine datapoints to (docs/FUNCTIONS.md §4.5). */
	private analyticsSink: AnalyticsSink | null = null;
	private heartbeatWasFailing = false;
	private pullBeforeConverge = false;
	private volumeInventory: VolumeInventory | null = null;
	private volumeInventoryAt = 0;
	/** Native studio front (plan 22), loaded only once desired state first enables it. */
	private studioFront: Promise<StudioFront> | null = null;
	private studioUpdates: Promise<void> = Promise.resolve();
	/** Container console front (D127), created once desired state first opens it. */
	private consoleFront: ConsoleFront | null = null;

	private readonly reconcileBackoff = new Backoff(1_000, 30_000);
	private readonly heartbeatBackoff = new Backoff(5_000, 60_000);

	constructor(config: AgentConfig) {
		this.config = config;
		this.accessCache = new AccessDecisionCache(config.accessCacheMs);
		// Redeemed callback ids survive a restart, so a one-time token cannot be replayed on the
		// same ingress after an update (HA-PLAN H17).
		this.usedTokens = new UsedTokenCache({ file: join(config.dataDir, 'redeemed-tokens.json') });
		this.ingressSecretsStore = new IngressSecretsStore(config.dataDir);
		// HA-PLAN H19 lame duck: 503 while still serving for `ingress.drainSeconds`, then stop.
		this.lameDuck = new LameDuck({
			drainSeconds: () => this.ingress?.drainSeconds ?? 0,
			onChange: (draining) =>
				draining
					? this.writeIngressHealthWord(ingressHealthWords.draining)
					: this.refreshIngressHealth(),
		});
		this.store = new DesiredStateStore(config.dataDir);
		this.control = new ControlEndpoints({
			dataDir: config.dataDir,
			initialUrl: config.controlUrl,
			log: (level, message) => log(level, message),
		});
		// The socket path is what makes `controlUrl/readyz` this host's control plane. Without one, an
		// explicit local URL is required: reading the public origin would report another node.
		this.controlReadyzUrl =
			config.controlLocalUrl ??
			(config.controlSocket ? `${config.controlUrl.replace(/\/+$/, '')}/readyz` : null);
		this.releases = new ReleaseManager(config.dataDir);
		this.caddy = new CaddyAdmin(config.caddyAdminSocket);
		this.stats = new StatsCollector(config.dataDir);
		this.hardware = new HardwareCollector();
		this.nodeCertificate = new NodeCertificateManager(config.dataDir, config.nodeId);
		this.nodeCa = new NodeCaIdentity(config.dataDir, config.nodeId, { log: (level, message) => log(level, message) });
		this.serviceForwarder = new ServiceForwarder({
			log: (level, message) => log(level, message),
			...(this.nodeCertificate.ensure() ? { certificate: this.nodeCertificate.ensure()! } : {}),
		});
		this.certificateDelivery = new CertificateDelivery({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			dataDir: config.dataDir,
			log,
		});
		this.certs = config.certProbe
			? new CertProbe(
					() =>
						certProbeTargets(
							this.desired ? this.contentDomain(this.desired) : config.contentDomain,
							config.platformHost,
							// Verified custom domains: a certificate here is what makes them `active`.
							(this.desired?.domains ?? []).map((domain) => domain.host),
						),
					tlsCertReader(config.certProbe),
				)
			: null;
		this.helper = new HelperClient(config.helperSocket);
		this.identity = new WorkloadIdentityBroker({
			mint: (id, audience, signal) => this.fetchWorkloadIdentity(id, audience, signal),
			helper: this.helper,
			log,
		});
		this.mail = new MailBridge({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			socketPath: process.env.YOAL_MAIL_SOCKET?.trim() || '/run/yoal/mail.sock',
			helper: this.helper,
			log,
		});
		this.poolIdentity = new IdentityBridge({
			socketPath: process.env.YOAL_IDENTITY_SOCKET?.trim() || '/run/yoal/identity.sock',
			helper: this.helper,
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			version: config.agentVersion,
			onStatusChange: () => {
				// Health changes the Caddy fallback decision, so converge even when desired state is
				// unchanged (a recovered unit must get its assigned pools back).
				this.convergedVersion = null;
			},
			log,
		});
		this.storage = new StorageRequester(config.storageStateFile, config.storageRequestFile);
		this.logDrain = new WorkloadLogDrain({
			helper: this.helper,
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			intervalMs: config.logDrainIntervalMs,
			log,
		});
		this.runLease = new RunLeaseClock({ path: join(config.dataDir, 'run-lease.json'), log });
		this.logRecords = new NodeLogBatcher({
			post: (batch) => postNodeLogBatch({ controlUrl: config.controlUrl, nodeToken: config.nodeToken }, batch),
		});
		this.workloads = new WorkloadRuntime({
			runLeaseValid: (ttlSeconds) => this.runLease.valid(ttlSeconds),
			helper: this.helper,
			releases: this.releases,
			fetchActivation: (id, signal) => this.fetchWorkloadActivation(id, signal),
			sliceMemoryMb: config.workloadSliceMb,
			socketDir: config.workloadSocketDir,
			healthTimeoutMs: config.workloadHealthTimeoutMs,
			statePath: join(config.dataDir, 'workloads-state.json'),
			bootId: readBootId(),
			log,
			onIdentity: (workload, identity) => {
				if (identity) this.identity.hold(workload.id, identity);
			},
			ensureIdentity: (workload, signal) => this.identity.refresh([workload], signal),
			// docs/LOGS.md LP7: OTEL_* for process/container apps, never replacing the app's own.
			...(config.otlpLogs
				? {
						extraEnv: (workload: WorkloadDesired, env: Readonly<Record<string, string>>) => {
							const secret = this.logsSecret();
							return secret ? otlpWorkloadEnv(workload, env, { secret, port: config.functionAnalyticsPort }) : {};
						},
					}
				: {}),
		});
		this.databaseStats = new DatabaseStatsSampler({ source: this.workloads, log });
		this.databaseBackups = new DatabaseBackupRunner({ helper: this.helper, log });
		this.appVolumes = new AppVolumeRunner({ helper: this.helper, log });
		this.volumeProfiles = new VolumeProfileRunner({ helper: this.helper, log });
		this.linkTests = new LinkTestRunner({ log });
		this.shareMounts = new ShareMountRunner({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			helper: this.helper,
			log,
		});
		this.diskMounts = new DiskMountRunner({ helper: this.helper, log });
		this.databasePitr = new DatabasePitrRunner({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			helper: this.helper,
			log,
		});
		this.databaseRotations = new DatabaseRotationRunner({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			helper: this.helper,
			log,
		});
		this.databaseCredentials = new DatabaseCredentialRunner({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			helper: this.helper,
			log,
		});
		this.studioPrincipals = new StudioPrincipalRunner({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			helper: this.helper,
			log,
		});
		this.databasePoolerRestarts = new DatabasePoolerRestartRunner({ helper: this.helper, log });
		this.databaseReplication = new DatabaseReplicationRunner({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			helper: this.helper,
			runtime: this.workloads,
			log,
		});
		this.databaseDurability = new DatabaseDurabilityRunner({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			nodeId: config.nodeId,
			helper: this.helper,
			log,
		});
		this.databaseMember = new DatabaseMemberRunner({
			nodeId: config.nodeId,
			helper: memberOperations(this.helper),
			// The foundation gives agents no direct arbiter transport or peer channel yet. Reporting
			// still works; automatic fencing/promotion stays disabled rather than guessed.
			arbiter: null,
			peer: reportOnlyPeerTransport(),
			log: (level, message) => log(level, message),
		});
		// Must equal the helper's YOAL_HELPER_REPLICATION_DIR (the installer uses /var/lib/yoal/agent).
		this.replicaLinks = new ReplicaLinkForwarder({
			root: join(config.dataDir, 'replication'),
			log: (level, message) => log(level, message),
			...(this.nodeCertificate.ensure() ? { certificate: this.nodeCertificate.ensure()! } : {}),
		});
		this.nodeUpdate = new NodeUpdateRunner({
			helper: this.helper,
			currentVersion: config.agentVersion,
			statePath: join(config.dataDir, 'node-update.json'),
			log,
		});
		// Buckets and scoped keys are desired state converged over the loopback S3/admin API; the
		// root key and user secrets stay in the workload runtime's memory (S4).
		this.storageAdmin = new StorageReconciler({ source: this.workloads, log });
		this.storageStats = new StorageStatsSampler({ source: this.workloads, log });
		// Bucket replication links this node runs (§12): copies objects to or from a peer instance
		// through the peer node's gateway, with each link's scoped key. Progress rides the heartbeat.
		this.storageReplicator = new StorageReplicator({
			source: this.workloads,
			statePath: join(config.dataDir, 'storage-replication.json'),
			log,
		});
		// Broker samples (D123) over each broker's own client connection; the password is fetched
		// from the activation on demand and kept only in the open connection.
		this.brokerStats = new BrokerStatsSampler({
			source: this.workloads,
			fetchActivation: (id, signal) => this.fetchWorkloadActivation(id, signal),
			log,
		});
		// Scale to zero, the runaway watchdog and cron all run on the node (FN4, FN5, FN9).
		this.functions = new FunctionScheduler({
			helper: this.helper,
			socketDir: config.workloadSocketDir,
			statePath: join(config.dataDir, 'function-cron-state.json'),
			// Without the access log there is no request signal; never idle-stop a serving host.
			activityEnabled: Boolean(config.caddyAccessLog),
			log,
		});
		this.kubernetes = new KubernetesSync({
			helper: this.helper,
			fetchManifests: (machineId, signal) => this.fetchKubernetesManifests(machineId, signal),
			isRunning: (machineId) => this.workloads.currentReports().some((report) => report.id === machineId && report.status === 'running'),
			log,
		});
		// Function queues on managed brokers (D112): pull batches and deliver them to the shim.
		this.functionQueues = new FunctionQueueConsumers({
			socketDir: config.workloadSocketDir,
			fetchActivation: (id, signal) => this.fetchWorkloadActivation(id, signal),
			noteActivity: (projectId) => this.functions.noteActivity(projectId),
			log,
		});
		// Event notifications (D122): publish the control plane's outbox into local brokers.
		this.eventPublisher = new EventPublisher({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			fetchActivation: (id, signal) => this.fetchWorkloadActivation(id, signal),
			log,
		});
		// Queue and function tools (D124): run the control plane's one-shot tasks for this node.
		this.nodeTasks = new NodeTaskRunner({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			socketDir: config.workloadSocketDir,
			fetchActivation: (id, signal) => this.fetchWorkloadActivation(id, signal),
			workloadStatus: async (id) => (await this.helper.status(id)).status,
			noteActivity: (projectId) => this.functions.noteActivity(projectId),
			log,
		});
		// Job runs (plan 09): lease, start through the helper, watch, drain output, report.
		this.jobs = new JobRunner({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			helper: this.helper,
			fetchActivation: (id, signal) => this.fetchWorkloadActivation(id, signal),
			statePath: join(config.dataDir, 'jobs-state.json'),
			log,
		});
		// Release commands (HA-PLAN H25): desired-state tasks, started before their deadline, run
		// once, killed by the node's own clock even while the control plane is unreachable.
		this.releaseCommands = new ReleaseCommandRunner({
			helper: this.helper,
			releases: this.releases,
			fetchActivation: (id, signal) => this.fetchWorkloadActivation(id, signal),
			statePath: join(config.dataDir, 'release-commands-state.json'),
			log,
		});
	}

	async run(): Promise<void> {
		// Register the stop promise before starting so a signal during startup cannot be lost.
		const stopped = new Promise<void>((resolve) => {
			this.resolveShutdown = resolve;
		});
		try {
			await this.start();
			await stopped;
		} finally {
			await this.shutdown();
		}
	}

	beginShutdown(): void {
		if (this.stopping) return;
		this.stopping = true;
		void this.drainThenStop();
	}

	/**
	 * HA-PLAN H19/I15: an ingress answers `503 draining` for `ingress.drainSeconds` while it still
	 * serves, then stops. A worker and a single-node install without ingress settings stop at once.
	 */
	private async drainThenStop(): Promise<void> {
		try {
			if (this.ingress) {
				log('info', `Draining ingress for ${this.ingress.drainSeconds}s before stopping`);
				await this.lameDuck.begin('shutdown');
			}
		} finally {
			this.running = false;
			this.shutdownController.abort();
			this.resolveShutdown?.();
		}
	}

	private async start(): Promise<void> {
		await fs.mkdir(this.config.dataDir, { recursive: true, mode: 0o755 });
		await this.releases.init();
		this.ingressSecrets = this.ingressSecretsStore.load();
		await this.control.load();

		const cached = await this.store.readCached();
		if (cached) {
			if (cached.state.nodeId !== this.config.nodeId) {
				log(
					'warn',
					`Ignoring cached desired state for node ${cached.state.nodeId}; this is ${this.config.nodeId}`,
				);
			} else {
				// Before anything converges from the cache: a fresh contact time must not fence, a stale one must.
				await this.runLease.load();
				this.desired = cached.state;
				this.desiredEtag = cached.etag;
				this.ingress = cached.state.ingress ?? null;
				this.applyStudio(cached.state.studio);
				this.applyConsole(cached.state.containerConsole);
				this.mail.apply(cached.state.mail);
				this.poolIdentity.apply(cached.state.identity);
				log('info', `Loaded cached desired state v${cached.state.version}`);
			}
		}

		await this.checkCaddy();
		await this.startServer();
		this.identity.start();

		// docs/LOGS.md LP6: access records ride the same tail as the aggregates, which still see
		// every line. Only with an access log configured (YOAL_CADDY_ACCESS_LOG) and the flag on.
		const logsSecret = this.config.edgeRequestLogs || this.config.otlpLogs ? this.logsSecret() : null;
		if (this.config.caddyAccessLog && this.config.edgeRequestLogs && logsSecret) {
			this.edgeRequestLogs = new EdgeRequestLogs({
				batcher: this.logRecords,
				hashIp: createClientIpHasher(logsSecret),
				knownHost: (host) => this.accessLogHosts.has(host),
				sampleRate: (host) => this.accessLogHosts.get(host),
			});
		}
		if (this.config.otlpLogs && logsSecret) {
			this.otlpLogs = new OtlpLogsReceiver({
				batcher: this.logRecords,
				secret: logsSecret,
				workloadOnNode: (id) => Boolean(this.desired?.workloads.some((workload) => workload.id === id)),
			});
		}

		if (this.config.caddyAccessLog) {
			this.telemetry = new TelemetryClient({
				controlUrl: this.config.controlUrl,
				nodeToken: this.config.nodeToken,
				nodeId: this.config.nodeId,
				accessLogPath: this.config.caddyAccessLog,
				// HA-PLAN H28: pending buckets survive a control-plane outage on disk, bounded so a
				// long outage cannot fill the node. The gap list rides the next telemetry POST.
				spoolDir: join(this.config.dataDir, 'telemetry-spool'),
				spoolMaxBuckets: this.config.telemetrySpoolBuckets,
				spoolMaxBytes: this.config.telemetrySpoolBytes,
				// Access-log aggregation is the request signal scale-to-zero measures (FN4). Resolve
				// first, then record activity, so telemetry behaviour itself is unchanged.
				resolveProject: (host) => {
					const projectId = this.projectByHost.get(normalizeHost(host)) ?? null;
					if (projectId) this.functions.noteActivity(projectId);
					return projectId;
				},
				onAccessEntry: this.edgeRequestLogs?.consume ?? null,
			});
		}

		// Function hosts POST Analytics Engine datapoints and tail events here over an `external`
		// service. The sink is independent of the access-log tail (a binding writes even with no
		// Caddy log configured) and a bind failure is logged, not fatal: telemetry must never keep
		// the agent from booting.
		try {
			this.analyticsSink = startAnalyticsSink({
				port: this.config.functionAnalyticsPort,
				record: (event) => this.telemetry?.recordAnalytics(event),
				recordTail: (event) => this.telemetry?.recordTail(event),
				...(this.otlpLogs ? { otlp: this.otlpLogs.handle } : {}),
				log,
			});
		} catch (error) {
			log(
				'warn',
				`Analytics Engine sink unavailable on 127.0.0.1:${this.config.functionAnalyticsPort}: ${errorText(error)}`,
			);
		}

		// Bun's process typings only augment `memoryPressure`; the Node signal overloads still work
		// at runtime, so go through a narrow structural type here.
		const signals = process as unknown as {
			once(event: 'SIGTERM' | 'SIGINT', listener: () => void): void;
		};
		signals.once('SIGTERM', () => this.beginShutdown());
		signals.once('SIGINT', () => this.beginShutdown());

		this.loops = [
			this.reconcileLoop(),
			this.heartbeatLoop(),
			this.offlineDrillLoop(),
			this.certificateLoop(),
			this.identityLoop(),
			this.telemetryLoop(),
			this.logRecordsLoop(),
			this.databaseStatsLoop(),
			this.databaseBackupLoop(),
			this.appVolumeLoop(),
			this.shareMountLoop(),
			this.volumeProfileLoop(),
			this.linkTestLoop(),
			this.runLeaseLoop(),
			this.ingressHealthLoop(),
			this.databasePitrLoop(),
			this.databaseRotationLoop(),
			this.databaseCredentialLoop(),
			this.databasePoolerRestartLoop(),
			this.databaseReplicationLoop(),
			this.databaseDurabilityLoop(),
			this.nodeUpdateLoop(),
			this.storageAdminLoop(),
			this.storageStatsLoop(),
			this.storageReplicator.run(this.shutdownController.signal),
			this.brokerStatsLoop(),
			this.kubernetesLoop(),
			this.functions.run(() => this.desired, this.shutdownController.signal),
			this.functionQueues.run(() => this.desired, this.shutdownController.signal),
			this.eventPublisher.run(() => this.desired, this.shutdownController.signal),
			this.nodeTasks.run(() => this.desired, this.shutdownController.signal),
			this.jobs.run(() => this.desired, this.shutdownController.signal),
			this.releaseCommands.run(() => this.desired, this.shutdownController.signal),
		];
		if (this.config.logDrain)
			this.loops.push(this.logDrain.run(() => this.desired, this.shutdownController.signal));
		log(
			'info',
			`Agent ${this.config.agentVersion} for ${this.config.nodeId} running (control ${this.config.controlUrl})`,
		);
	}

	private async shutdown(): Promise<void> {
		log('info', 'Shutting down');
		this.shutdownController.abort();
		await Promise.allSettled(this.loops);
		this.brokerStats.close();
		// Stop the sink before the telemetry client so its last flush carries any buffered events.
		this.analyticsSink?.stop();
		this.analyticsSink = null;
		await this.telemetry?.stop().catch(() => undefined);
		// The tail's last lines and any OTLP records still buffered; best effort on the way out.
		await this.logRecords.flush().catch(() => undefined);
		await this.studioUpdates;
		if (this.studioFront) (await this.studioFront.catch(() => null))?.stop();
		this.consoleFront?.stop();
		this.identity.stop();
		await this.mail.close();
		await this.poolIdentity.close();
		this.serviceForwarder.close();
		this.publicDb.close();
		this.certificateDelivery.close();
		await this.replicaLinks.close();
		this.server?.stop(true);
		this.server = null;
		await fs.rm(this.config.agentSocket, { force: true }).catch(() => undefined);
		log('info', 'Stopped');
	}

	private async startServer(): Promise<void> {
		await fs.mkdir(dirname(this.config.agentSocket), { recursive: true, mode: 0o755 });
		await fs.rm(this.config.agentSocket, { force: true }).catch(() => undefined);

		this.server = Bun.serve({
			unix: this.config.agentSocket,
			fetch: (request) => this.handleRequest(request),
		});
		await fs.chmod(this.config.agentSocket, 0o660).catch(() => undefined);
		log('info', `Listening on unix/${this.config.agentSocket}`);
	}

	private handleRequest(request: Request): Response {
		const path = requestPath(request.url);
		if (path === '/metrics') return new Response(this.metricsText(), { headers: metricsHeaders() });
		if (path === '/healthz') {
			const reports = this.workloads.currentReports();
			return Response.json({
				ok: true,
				nodeId: this.config.nodeId,
				caddyOk: this.caddyOk,
				desiredStateVersion: this.desired?.version ?? 0,
				actualStateVersion: this.actualStateVersion,
				workloads: {
					total: reports.length,
					running: reports.filter((report) => report.status === 'running').length,
				},
				lastReconcileSuccessAt: this.lastReconcileSuccessAt,
			});
		}
		return handleSiteRequest(request, {
			state: this.desired,
			cookieName: this.config.cookieName,
			insecureHttp: this.config.insecureHttp,
			usedTokens: this.usedTokens,
			accessCookieName: this.config.accessCookieName,
			accessJwtSecret: this.ingressSecrets?.accessJwtSecret ?? this.config.accessJwtSecret,
			accessCache: this.accessCache,
		});
	}

	// --- desired state -------------------------------------------------------

	private async reconcileLoop(): Promise<void> {
		while (this.running) {
			if (
				this.desired &&
				(this.convergedVersion !== this.desired.version || this.workloads.needsRetry()) &&
				!this.pullBeforeConverge
			) {
				try {
					await this.converge(this.desired);
					this.reconcileBackoff.reset();
				} catch (error) {
					if (!this.running) break;
					this.reconcileFailures += 1;
					log('error', `Reconcile v${this.desired.version} failed: ${errorText(error)}`);
					// Do not get stuck retrying a stale state forever: pull once before trying
					// again, so a newer desired state can supersede a broken release URL.
					this.pullBeforeConverge = true;
					await sleep(this.reconcileBackoff.next(), this.shutdownController.signal);
				}
				continue;
			}

			try {
				// After a failed converge, pull unconditionally: the version may not have changed, but
				// a fresh copy carries freshly presigned release URLs (the old ones expire after 1 h).
				const force = this.pullBeforeConverge;
				const started = Date.now();
				const changed = await this.pullDesiredState(force);
				this.pullBeforeConverge = false;
				this.reconcileBackoff.reset();
				if (!changed) {
					// A control plane that supports long-poll holds the request. If it answered instantly
					// (304 without holding), fall back to the documented 10 s poll interval.
					const elapsed = Date.now() - started;
					// The activation is refreshed on a timer even when desired state does not change
					// (H20: on start, on a generation change and every six hours); the guard inside
					// makes this a no-op until the interval elapses.
					if (this.desired?.ingress) await this.syncIngressSecrets(this.desired);
					await sleep(elapsed < 2_000 ? 10_000 : 250, this.shutdownController.signal);
				}
			} catch (error) {
				if (!this.running) break;
				this.reconcileFailures += 1;
				log('warn', `Desired-state pull failed: ${errorText(error)}`);
				await sleep(this.reconcileBackoff.next(), this.shutdownController.signal);
			}
		}
	}

	/**
	 * The 6-hour refresh of the shared-certificate activation (CLUSTERING §7.3). Converge also
	 * checks after a desired-state change, which is what a renewal causes; this covers a change that
	 * somehow did not bump the version.
	 */
	private async certificateLoop(): Promise<void> {
		while (this.running) {
			await sleep(CERTIFICATE_REFRESH_MS, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			await this.certificateDelivery.refresh().catch((error: unknown) => {
				log('warn', `Shared certificate refresh failed: ${errorText(error)}`);
			});
		}
	}

	private async pullDesiredState(force = false): Promise<boolean> {
		// Dark for a drill: keep serving the state in hand, as a partitioned node would. Two seconds
		// so the reconcile loop takes the short sleep and pulls promptly once the drill ends.
		if (this.offlineDrill.active(Date.now())) {
			await sleep(2_000, this.shutdownController.signal).catch(() => undefined);
			return false;
		}
		const headers: Record<string, string> = {
			authorization: `Bearer ${this.config.nodeToken}`,
			accept: 'application/json',
		};
		const request = desiredStateRequest({
			etag: this.desiredEtag ?? (this.desired ? desiredStateEtag(this.desired) : null),
			force,
			pulledThisRun: this.desiredPulledThisRun,
			longPollSeconds: LONG_POLL_SECONDS,
		});
		if (request.ifNoneMatch) headers['if-none-match'] = request.ifNoneMatch;

		const timeout = AbortSignal.timeout(LONG_POLL_TIMEOUT_MS);
		const signal = AbortSignal.any([this.shutdownController.signal, timeout]);

		let response: Response;
		try {
			response = await this.control.request(
				`/api/agent/desired-state?wait=${request.waitSeconds}`,
				{ headers, signal },
			);
		} catch (error) {
			// A long-poll that outlived our client timeout is harmless: just ask again.
			if (error instanceof Error && error.name === 'TimeoutError') return false;
			throw error;
		}

		if (response.status === 304) return false;
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`desired-state -> ${response.status}${text ? `: ${text}` : ''}`);
		}

		const value: unknown = await response.json();
		const parsed = desiredStateSchema.safeParse(value);
		if (!parsed.success) {
			throw new Error(`desired-state failed validation: ${parsed.error.message}`);
		}
		const state = parsed.data;
		if (state.nodeId !== this.config.nodeId) {
			throw new Error(`desired-state is for node ${state.nodeId}, not ${this.config.nodeId}`);
		}
		// W9: persist the epoch before applying anything at it, and refuse a lower one outright.
		if (state.control) {
			const control = await this.control.apply(state.control);
			if (!control.ok) {
				this.control.refuseCurrent();
				throw new Error(control.reason);
			}
		}

		const etagHeader = response.headers.get('etag') ?? desiredStateEtag(state);
		// Same version as the cache but different content: the cache lost fields this build applies.
		const content = (value: DesiredState) => JSON.stringify({ ...value, generatedAt: '' });
		if (!this.desiredPulledThisRun && this.desired && content(this.desired) !== content(state))
			this.convergedVersion = null;
		this.desired = state;
		this.desiredEtag = etagHeader;
		this.desiredPulledThisRun = true;
		// Armed only from a fresh pull, never the cache, so restarting the agent ends a drill.
		if (this.offlineDrill.arm(state.offlineDrill, Date.now()))
			log(
				'warn',
				`Offline drill ${state.offlineDrill!.id}: going dark to the control plane for ${Math.round(this.offlineDrill.remainingMs(Date.now()) / 1000)} s (no heartbeats, no pulls, ingress probe unready). Restart the agent to end it here.`,
			);
		this.applyStudio(state.studio);
		this.applyConsole(state.containerConsole);
		this.mail.apply(state.mail);
		this.poolIdentity.apply(state.identity);
		await this.syncIngressSecrets(state);
		try {
			await this.store.write(state, etagHeader);
		} catch (error) {
			// Serving from the in-memory copy still works; the next pull will retry the cache write.
			log('warn', `Could not cache desired state: ${errorText(error)}`);
		}
		log('info', `Pulled desired state v${state.version} (${state.routes.length} routes)`);
		return true;
	}

	/**
	 * Point the studio front at the desired port and live sessions. Updates are serialised and
	 * never block convergence; the front module is imported only once a studio is enabled.
	 */
	private applyStudio(desired: NodeStudioDesired | null): void {
		if (!desired && !this.studioFront) return;
		this.studioFront ??= import('./studio/front.ts').then(
			({ StudioFront, controlPlaneActivationFetcher }) =>
				new StudioFront({
					fetchActivation: controlPlaneActivationFetcher({
						controlUrl: this.config.controlUrl,
						nodeToken: this.config.nodeToken,
						signal: this.shutdownController.signal,
					}),
					helper: this.helper,
					log,
				}),
		);
		const front = this.studioFront;
		this.studioUpdates = this.studioUpdates
			.then(async () => (await front).update(desired))
			.catch((error: unknown) => log('error', `Studio front update failed: ${errorText(error)}`));
	}

	/** Open, move or close the container console front (D127). Never blocks convergence. */
	private applyConsole(desired: NodeContainerConsoleDesired | null): void {
		if (!desired && !this.consoleFront) return;
		this.consoleFront ??= new ConsoleFront({
			fetchActivation: controlPlaneConsoleActivationFetcher({
				controlUrl: this.config.controlUrl,
				nodeToken: this.config.nodeToken,
				signal: this.shutdownController.signal,
			}),
			helper: this.helper,
			log,
		});
		try {
			this.consoleFront.update(desired);
		} catch (error) {
			log('error', `Container console front update failed: ${errorText(error)}`);
		}
	}

	/**
	 * Secret values are fetched only when a workload is (re)applied, straight from the control
	 * plane, and handed to the helper. They never touch desired-state.json (D18, D23).
	 */
	private async fetchWorkloadActivation(
		id: string,
		signal: AbortSignal,
	): Promise<WorkloadActivation> {
		const response = await fetch(
			`${this.config.controlUrl}/api/agent/workloads/${encodeURIComponent(id)}/activation`,
			{
				headers: {
					authorization: `Bearer ${this.config.nodeToken}`,
					accept: 'application/json',
				},
				signal,
			},
		);
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`workload activation -> ${response.status}${text ? `: ${text}` : ''}`);
		}
		const parsed = workloadActivationSchema.safeParse(await response.json());
		if (!parsed.success)
			throw new Error(`workload activation failed validation: ${parsed.error.message}`);
		return parsed.data;
	}

	/**
	 * Fetch the ingress activation when this node has the public payload and the cached copy is
	 * old or missing (HA-PLAN H20, G8). A failure keeps the cached or env value and retries in a
	 * minute; it must never stop a site serving. The secrets never enter desired state or logs.
	 */
	private async syncIngressSecrets(state: DesiredState): Promise<void> {
		if (!state.ingress) return;
		const now = Date.now();
		const refresh = now - this.ingressSecretsAt;
		if (this.ingressSecrets && refresh < INGRESS_SECRETS_REFRESH_MS) return;
		if (!this.ingressSecrets && refresh < INGRESS_SECRETS_RETRY_MS && this.ingressSecretsAt > 0) return;
		try {
			const response = await fetch(`${this.config.controlUrl}/api/agent/ingress/activation`, {
				headers: {
					authorization: `Bearer ${this.config.nodeToken}`,
					accept: 'application/json',
				},
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				throw new Error(`ingress activation -> ${response.status}${text ? `: ${text}` : ''}`);
			}
			this.ingressSecrets = ingressActivationSchema.parse(await response.json());
			this.ingressSecretsAt = now;
			try {
				this.ingressSecretsStore.save(this.ingressSecrets);
			} catch (error) {
				log('warn', `Could not cache ingress secrets: ${errorText(error)}`);
			}
			this.ingressSecretsWarned = false;
		} catch (error) {
			this.ingressSecretsAt = now;
			if (!this.ingressSecretsWarned) log('warn', `Ingress activation failed: ${errorText(error)}`);
			this.ingressSecretsWarned = true;
		}
	}

	/** A fresh workload token from the control plane, for the file or the metadata endpoint. */
	private async fetchWorkloadIdentity(
		id: string,
		audience: string,
		signal?: AbortSignal,
	): Promise<ReturnType<typeof parseIdentityResponse>> {
		const query = new URLSearchParams({ audience });
		const response = await fetch(
			`${this.config.controlUrl}/api/agent/workloads/${encodeURIComponent(id)}/identity?${query}`,
			{
				headers: {
					authorization: `Bearer ${this.config.nodeToken}`,
					accept: 'application/json',
				},
				...(signal ? { signal } : {}),
			},
		);
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`workload identity -> ${response.status}${text ? `: ${text}` : ''}`);
		}
		return parseIdentityResponse(await response.json());
	}

	private async converge(state: DesiredState): Promise<void> {
		const started = Date.now();
		this.lastReconcileAttemptAt = started;

		// HA-PLAN H19: a node losing the ingress role says goodbye before it stops serving, while
		// the old config (routes, TLS, health) is still in place. A failed converge keeps that old
		// config live and the drain continues, so the node is never offered traffic it cannot serve.
		if (this.ingress && !state.ingress) {
			log('info', `Ingress role removed: draining for ${this.ingress.drainSeconds}s before dropping the edge config`);
			await this.lameDuck.begin('role-removal');
		}

		const specs = new Map(state.releases.map((release) => [release.sha256, release]));
		// Worker-placed routes are proxied over WireGuard; their releases live on the worker. A
		// function on this node has an upstream (its socket) but serves its assets from here.
		const localRoutes = state.routes.filter(servesReleaseLocally);
		for (const release of state.releases) {
			try {
				const downloaded = await this.releases.ensureRelease(release, this.shutdownController.signal);
				if (downloaded) log('info', `Cached release ${release.sha256.slice(0, 12)}`);
			} catch (error) {
				throw new Error(`release ${release.sha256.slice(0, 12)}: ${errorText(error)}`);
			}
		}

		for (const route of localRoutes) {
			if (!(await this.releases.hasRelease(route.release))) {
				const spec = specs.get(route.release);
				if (!spec)
					throw new Error(`route ${route.host} references unknown release ${route.release.slice(0, 12)}`);
				await this.releases.ensureRelease(spec, this.shutdownController.signal);
			}
			// Previews are rooted at their own release; only production goes through the
			// per-project symlink, so promote/rollback is an atomic swap.
			if (isProductionRoute(route, state.contentDomain))
				await this.releases.activate(route.projectId, route.release);
		}

		// Shares and partitions first: a volume on one must be mounted before a workload on it starts.
		await this.convergeShareMounts(state);
		await this.convergeDiskMounts(state);

		// The helper needs the disk registry before it can resolve a disk-backed data dir (D169). A
		// failure is logged; affected workloads then fail closed at start (D76).
		try {
			await this.helper.syncVolumes(state.volumes, this.shutdownController.signal);
		} catch (error) {
			log('error', `Volume registry sync failed: ${errorText(error)}`);
		}

		// Consumer loopback endpoints and provider overlay listeners (C2). Harmless when empty.
		try {
			// HA-PLAN H24 fields reach only an `endpoints-gateway` node with the flag on; without them
			// this is the C2 call as before (no gateway binds, no CA material, no read endpoints).
			const wantsGatewayListeners =
				wantsGateway(state.serviceEndpoints, state.readEndpoints ?? []);
			if (wantsGatewayListeners && !this.endpointGuardReady) {
				try {
					await this.helper.endpointGuard();
					this.endpointGuardReady = true;
				} catch (error) {
					log('warn', `Endpoint guard not applied, gateway listeners stay off: ${errorText(error)}`);
				}
			}
			this.serviceForwarder.converge(state.serviceEndpoints, state.serviceProviders, {
				...(state.readEndpoints ? { readEndpoints: state.readEndpoints } : {}),
				trust: this.nodeCa.material(state.nodeTrust),
				gatewayAllowed: this.endpointGuardReady,
			});
		} catch (error) {
			log('error', `Service endpoint converge failed: ${errorText(error)}`);
		}
		// Public database listeners after the endpoints they may dial (D241).
		await this.syncPublicDatabases(state.publicDatabases ?? []);
		// Replica link sockets before the replica workloads, whose units mount their directories (C7).
		try {
			await this.replicaLinks.converge(state.databaseReplicaLinks ?? []);
		} catch (error) {
			log('error', `Replica link converge failed: ${errorText(error)}`);
		}

		// The overlay must be up before a workload tries a cross-node service endpoint (C1).
		if (state.wireguard) {
			try {
				await this.helper.wireguardApply(state.wireguard);
			} catch (error) {
				log('error', `WireGuard apply failed: ${errorText(error)}`);
			}
		}

		// Tier 2/3 workloads converge before Caddy loads their upstreams. A helper outage or a
		// broken workload must never take static serving down, so failures are logged inside the
		// runtime and this call is defensive as well.
		try {
			await this.workloads.converge(state, this.shutdownController.signal);
		} catch (error) {
			log('error', `Workload converge failed: ${errorText(error)}`);
		}

		// Shared certificates (H20): pick up a new generation before rendering the manager policy. A
		// failure keeps the last delivery (and the last fingerprint) rather than dropping TLS.
		await this.certificateDelivery.ensureFresh().catch((error: unknown) => {
			log('warn', `Shared certificate activation failed; keeping the last delivery: ${errorText(error)}`);
		});
		const tls = this.config.tls || state.ingress?.tls ? this.tlsOptions(state) : undefined;
		const listen = splitIngressListen(this.config.caddyListen, Boolean(tls));
		const caddyConfig = buildCaddyConfig({
			// An unhealthy identity unit falls back to the control plane's hosted/OIDC routes, so a
			// restart loop cannot take every assigned pool offline (§11.2).
			state:
				state.identity && !this.poolIdentity.isHealthy
					? { ...state, identity: null }
					: state,
			// With TLS enabled Caddy owns :443 and site-config adds the :80 redirect server. An
			// ingress-set node keeps its private listener (a worker's overlay address) and adds the
			// public one, so the routes other ingresses proxy to it still answer (HA-PLAN G5).
			// With TLS on, YOAL_CADDY_LISTEN's secure entries are honoured and its :80 entries become the
			// redirect server (H19 "Listen addresses", W8 lane C).
			listen: state.ingress?.listeners?.length
				? ingressListeners(listen.content, state.ingress.listeners, Boolean(tls))
				: listen.content,
			// An empty list is meaningful with TLS: the operator asked for no :80 listener.
			...(tls ? { httpListen: listen.http } : {}),
			dataDir: this.config.dataDir,
			agentSocket: this.config.agentSocket,
			caddyAdminSocket: this.config.caddyAdminSocket,
			accessLog: this.config.caddyAccessLog,
			// docs/LOGS.md LP6: X-Request-Id on site routes (flag EDGE_REQUEST_LOGS).
			...(this.config.edgeRequestLogs ? { requestIds: true } : {}),
			...(tls ? { tls } : {}),
			// With the flag off the manager is null and the relay list empty: today's per-node ACME.
			...(this.certificateDelivery.manager() ? { certificateManager: this.certificateDelivery.manager() } : {}),
			...(this.certificateDelivery.relays().length > 0 ? { acmeRelays: this.certificateDelivery.relays() } : {}),
			// H19 (W8): health routes, lame duck, PROXY and trusted proxies. `state.ingress` exists only
			// on an INGRESS_SET member, so a single-node install renders none of it.
			...(state.ingress
				? { ingress: state.ingress, ingressHealthDir: this.config.ingressHealthDir }
				: {}),
			...(() => {
				const upstreams = state.ingress?.platformUpstreams?.map((entry) => ({
					dial: entry.upstream,
					priority: entry.priority,
				}));
				const platform = state.ingress?.platform ?? (this.config.platformHost ? {
					host: this.config.platformHost,
					upstream: this.config.platformUpstream,
				} : null);
				if (!platform) return {};
				return {
					platform: {
						...platform,
						...(upstreams && upstreams.length > 0 ? { upstreams, healthUri: '/readyz' } : {}),
					},
				};
			})(),
		});
		const caddyJson = JSON.stringify(caddyConfig);
		if (caddyJson !== this.appliedCaddyJson) {
			try {
				await this.caddy.applyFullConfig(caddyConfig, this.shutdownController.signal);
				this.appliedCaddyJson = caddyJson;
			} catch (error) {
				// The previous config may still be serving, but this agent cannot prove it is current.
				this.caddyOk = false;
				await this.refreshIngressHealth().catch(() => undefined);
				throw error;
			}
		}

		this.caddyOk = true;
		this.appliedState = state;
		this.ingress = state.ingress ?? null;
		this.projectByHost = new Map(
			state.routes.map((route) => [normalizeHost(route.host), route.projectId]),
		);
		this.accessLogHosts = accessLogHosts(state);
		this.convergedVersion = state.version;
		this.actualStateVersion = state.version;
		this.lastReconcileSuccessAt = Date.now();
		log(
			'info',
			`Converged v${state.version}: ${state.routes.length} routes, ${state.releases.length} releases in ${Date.now() - started}ms`,
		);
		await this.refreshIngressHealth().catch((error) => log('warn', `Ingress health update failed: ${errorText(error)}`));
		// The drain finished and the edge config is gone: this node is a worker again.
		if (!this.ingress && this.lameDuck.draining) await this.lameDuck.reset();

		try {
			await this.releases.gc(state);
		} catch (error) {
			log('warn', `Release GC failed: ${errorText(error)}`);
		}
		void this.maybePruneImages();
		void this.applyRegistryMirror(state);

		// Bucket and key changes are desired state too (S4): converge them now instead of waiting
		// for the minute loop. The reconciler never throws and coalesces overlapping rounds.
		void this.storageAdmin.reconcile();
	}

	/**
	 * The platform registry's pull-through cache (G4): Podman mirrors for docker.io/ghcr.io/quay.io
	 * point at the registry, and root logs in there with this node's token. Re-applied when the
	 * desired mirror changes and once after every agent start (the auth file lives in /run).
	 */
	private async applyRegistryMirror(state: DesiredState): Promise<void> {
		const mirror = state.registryMirror ?? null;
		const key = JSON.stringify(mirror);
		if (key === this.appliedMirror) return;
		try {
			await this.helper.applyRegistryMirror({
				// Removing uses the host last applied, so its login leaves root's auth file too.
				host: mirror?.host ?? this.appliedMirrorHost ?? 'registry.invalid',
				upstreams: mirror?.upstreams ?? [],
				username: `node.${this.config.nodeId}`,
				password: this.config.nodeToken,
			});
			this.appliedMirror = key;
			this.appliedMirrorHost = mirror?.host;
			if (mirror) log('info', `Registry mirror for ${mirror.upstreams.join(', ')} → ${mirror.host}`);
		} catch (error) {
			// Older helpers lack the verb: nothing to undo, pulls go straight upstream.
			log('warn', `Registry mirror not applied: ${errorText(error)}`);
			this.appliedMirror = key;
		}
	}

	/**
	 * Ask the helper to drop images no unit or container references (R3). Every deploy of a new
	 * digest otherwise leaves the old image on disk. Failures are logged once and retried next hour.
	 */
	private async maybePruneImages(): Promise<void> {
		if (this.imagePruneRunning || Date.now() - this.lastImagePruneAt < IMAGE_PRUNE_INTERVAL_MS) return;
		this.imagePruneRunning = true;
		this.lastImagePruneAt = Date.now();
		try {
			const result = await this.helper.pruneImages();
			this.imagePruneWarned = false;
			if (result.removed > 0)
				log('info', `Image prune removed ${result.removed} image(s), ${Math.round(result.reclaimedBytes / 1048576)} MiB; kept ${result.kept}`);
		} catch (error) {
			if (!this.imagePruneWarned) log('warn', `Image prune failed: ${errorText(error)}`);
			this.imagePruneWarned = true;
		} finally {
			this.imagePruneRunning = false;
		}
	}

	/** Best-effort content domain for the cert probe; never throws. */
	private contentDomain(state: DesiredState): string | null {
		try {
			return this.config.contentDomain ?? (state.contentDomain || deriveContentDomain(state));
		} catch {
			return null;
		}
	}

	private tlsOptions(state: DesiredState): TlsOptions {
		const domain =
			this.config.contentDomain ?? (state.contentDomain || deriveContentDomain(state));
		// Desired state wins when the ingress set renders it: a worker that gained the role did not
		// get an ACME email in its env file (HA-PLAN G5). The token is a secret and comes from the
		// activation cache, never from here.
		const desired = state.ingress?.tls;
		const email = desired?.email ?? this.config.acmeEmail ?? '';
		const ca = desired?.ca ?? this.config.acmeCa;
		const cloudflareApiToken = this.ingressSecrets?.cloudflareApiToken ?? this.config.cloudflareApiToken;
		const platformHost = state.ingress?.platform?.host ?? this.config.platformHost;
		return {
			email,
			subjects: tlsSubjects(domain, platformHost ? [platformHost] : []),
			httpRedirect: true,
			...(ca ? { ca } : {}),
			...(cloudflareApiToken ? { cloudflareApiToken } : {}),
		};
	}

	/** Dump/restore tasks run beside the normal reconcile loop; they never block static serving. */
	private async databaseBackupLoop(): Promise<void> {
		while (this.running) {
			await sleep(5_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state) continue;
			try {
				const running = new Set(
					this.workloads
						.currentReports()
						.filter((report) => report.status === 'running')
						.map((report) => report.id),
				);
				await this.databaseBackups.runOnce(state, (id) => running.has(id), this.shutdownController.signal);
			} catch (error) {
				log('warn', `Database backup task failed: ${errorText(error)}`);
			}
		}
	}

	/** Mount missing shares and unmount removed ones; a change refreshes the volume inventory. */
	private async convergeShareMounts(state: DesiredState): Promise<void> {
		try {
			// Share linking keys off the inventory, so re-read it on the next heartbeat.
			if (await this.shareMounts.runOnce(state, this.shutdownController.signal)) this.volumeInventoryAt = 0;
		} catch (error) {
			log('error', `Share mount converge failed: ${errorText(error)}`);
		}
	}

	/** Mount missing partitions and unmount removed ones; a change refreshes the volume inventory. */
	private async convergeDiskMounts(state: DesiredState): Promise<void> {
		try {
			// Adoption keys off the inventory, so re-read it on the next heartbeat.
			if (await this.diskMounts.runOnce(state, this.shutdownController.signal)) this.volumeInventoryAt = 0;
		} catch (error) {
			log('error', `Partition mount converge failed: ${errorText(error)}`);
		}
	}

	/** Re-check share and disk mounts between reconciles: retries failures, notices drops. */
	private async shareMountLoop(): Promise<void> {
		while (this.running) {
			await sleep(15_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state) continue;
			if (state.shareMounts.length > 0 || state.shareUnmounts.length > 0) await this.convergeShareMounts(state);
			if (state.diskMounts.length > 0 || state.diskUnmounts.length > 0) await this.convergeDiskMounts(state);
		}
	}

	/** Starts the next storage benchmark; it runs in the background and reports in the heartbeat. */
	private async volumeProfileLoop(): Promise<void> {
		while (this.running) {
			await sleep(5_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state || state.volumeProfileTasks.length === 0) continue;
			void this.volumeProfiles.runOnce(state, this.shutdownController.signal)?.catch((error) => {
				log('warn', `Volume profile round failed: ${errorText(error)}`);
			});
		}
	}

	/**
	 * Self-fencing (docs/CLUSTERING.md §8.4). Whenever the set of leased workloads this node must
	 * hold back changes (a lease ran out, or contact came back), converge once from the desired
	 * state already in hand: the runtime removes the fenced units, or starts them again.
	 */
	private async runLeaseLoop(): Promise<void> {
		await this.runLease.load();
		while (this.running) {
			const state = this.desired;
			if (state) {
				const { fenced } = leaseState(state, this.runLease);
				const key = fenced.join(',');
				if (key !== this.fencedKey) {
					this.fencedKey = key;
					if (fenced.length > 0)
						log('warn', `No contact with the control plane for ${this.runLease.silentSeconds() ?? '?'} s: stopping ${fenced.length} leased workload(s) so they cannot run twice`);
					else log('info', 'Contact with the control plane is back: leased workloads may run again');
					await this.workloads.converge(state, this.shutdownController.signal).catch((error) => {
						log('warn', `Applying the run-lease change failed: ${errorText(error)}`);
						// Try again on the next pass rather than believing it was applied.
						this.fencedKey = '\u0000';
					});
				}
			}
			await sleep(3_000, this.shutdownController.signal).catch(() => undefined);
		}
	}

	/**
	 * The health endpoint's state file (HA-PLAN H19). Recomputed every few seconds so the drift
	 * window expires on its own even if nothing is reconciling, and written only when the word
	 * changes so Caddy never reloads for it.
	 */
	private async ingressHealthLoop(): Promise<void> {
		while (this.running) {
			await this.refreshIngressHealth().catch((error) => log('warn', `Ingress health update failed: ${errorText(error)}`));
			await sleep(5_000, this.shutdownController.signal).catch(() => undefined);
		}
	}

	/** Compute this node's health and publish the word Caddy reads. No-op on a non-ingress. */
	private async refreshIngressHealth(): Promise<void> {
		if (!this.ingress) {
			this.latestIngressHealth = null;
			if (this.healthWord !== null) await this.writeIngressHealthWord(null);
			return;
		}
		this.latestIngressHealth = await this.computeIngressHealth();
		await this.writeIngressHealthWord(ingressHealthWord(this.latestIngressHealth));
	}

	private async computeIngressHealth(): Promise<IngressHealth> {
		const applied = this.appliedState;
		// Dark for a drill: fail the probe so steering withdraws this ingress like a lost one. A node
		// cut off from the control plane cannot vouch for its routes, hence `desired-state`.
		if (this.offlineDrill.active(Date.now()))
			return {
				status: 'unready',
				reason: 'desired-state',
				desiredStateVersion: this.desired?.version ?? null,
				appliedStateVersion: applied?.version ?? null,
				certificateFingerprint: null,
			};
		const missingReleases: string[] = [];
		if (applied) {
			for (const release of applied.releases) {
				if (!(await this.releases.hasRelease(release.sha256))) missingReleases.push(release.sha256);
			}
		}
		return ingressHealth({
			draining: this.lameDuck.draining,
			caddyOk: this.caddyOk,
			desiredStateVersion: this.desired?.version ?? null,
			appliedStateVersion: applied?.version ?? null,
			lastConvergedAt: this.lastReconcileSuccessAt > 0 ? this.lastReconcileSuccessAt : null,
			now: Date.now(),
			missingReleases,
			expectedCertificateFingerprint: this.ingress?.certificateFingerprint ?? null,
			loadedCertificateFingerprint: await this.servedCertificateFingerprint(),
		});
	}

	/** The certificate this node's Caddy serves, cached for a minute. Null when TLS is off. */
	private async servedCertificateFingerprint(): Promise<string | null> {
		if (!this.config.certProbe || !this.config.tls) return null;
		const now = Date.now();
		if (this.fingerprintRead && now - this.fingerprintRead.at < 60_000) return this.fingerprintRead.value;
		const servername = this.desired ? this.contentDomain(this.desired) : this.config.contentDomain;
		const value = servername ? await tlsCertFingerprint(this.config.certProbe, servername) : null;
		this.fingerprintRead = { value, at: now };
		return value;
	}

	/**
	 * Atomically replace the one state file Caddy stats: write the new word first, then remove the
	 * others, so a probe never lands in an empty directory and sees an invented reason.
	 */
	private healthWriteChain: Promise<void> = Promise.resolve();

	/** Serialise word writes and never let a stale `ok` land while the node is draining. */
	private writeIngressHealthWord(word: string | null): Promise<void> {
		const effective = word === ingressHealthWords.ok && this.lameDuck.draining ? ingressHealthWords.draining : word;
		const next = this.healthWriteChain.then(() => this.writeIngressHealthWordNow(effective));
		this.healthWriteChain = next.catch(() => undefined);
		return next;
	}

	private async writeIngressHealthWordNow(word: string | null): Promise<void> {
		const dir = this.config.ingressHealthDir;
		await fs.mkdir(dir, { recursive: true, mode: 0o755 }).catch(() => undefined);
		if (word !== null && word !== this.healthWord) {
			const path = join(dir, word);
			await atomicWriteFile(path, '');
			// Caddy runs as another user; the matcher only stats the path, but 0644 keeps it legible.
			await fs.chmod(path, 0o644).catch(() => undefined);
		}
		for (const other of Object.values(ingressHealthWords)) {
			if (other !== word) await fs.rm(join(dir, other), { force: true }).catch(() => undefined);
		}
		this.healthWord = word;
	}

	/**
	 * Links to the other nodes (docs/CLUSTERING.md §4.6): pick up link tests quickly, and sample a
	 * round trip to every peer about twice a minute. Both run beside the reconcile loop.
	 */
	private async linkTestLoop(): Promise<void> {
		let lastSampleAt = 0;
		while (this.running) {
			await sleep(2_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state) continue;
			this.linkTests.runOnce(state);
			if (Date.now() - lastSampleAt < 30_000) continue;
			lastSampleAt = Date.now();
			void this.linkTests.sample(state).catch((error) => {
				log('warn', `Link sampling failed: ${errorText(error)}`);
			});
		}
		this.linkTests.stop();
	}

	/** App-volume work beside the reconcile loop; snapshots and restores run in the background. */
	private async appVolumeLoop(): Promise<void> {
		while (this.running) {
			await sleep(5_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state) continue;
			try {
				await this.appVolumes.runOnce(state, this.shutdownController.signal);
			} catch (error) {
				log('warn', `App volume round failed: ${errorText(error)}`);
			}
		}
	}

	/** PITR tasks are additive to the logical backup loop and only exist when the flag is on. */
	private async databasePitrLoop(): Promise<void> {
		while (this.running) {
			await sleep(5_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state || state.databasePitrTasks.length === 0) continue;
			try {
				// Ready = desired activation applied and the last report is running. A replica has no
				// held monitor, so the stats sampler's `databaseTargets()` must not be the source.
				const ready = this.workloads.readyWorkloadIds();
				await this.databasePitr.runOnce(
					state,
					(id) => ready.has(id),
					this.shutdownController.signal,
				);
			} catch (error) {
				log('warn', `Database PITR task failed: ${errorText(error)}`);
			}
		}
	}

	/** Dashboard node updates (D99); its own loop because a download can take minutes. */
	private async nodeUpdateLoop(): Promise<void> {
		while (this.running) {
			await sleep(10_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state) continue;
			try {
				await this.nodeUpdate.runOnce(state, this.shutdownController.signal);
			} catch (error) {
				log('warn', `Node update failed: ${errorText(error)}`);
			}
		}
	}

	private async databasePoolerRestartLoop(): Promise<void> {
		while (this.running) {
			await sleep(5_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state) continue;
			try {
				await this.databasePoolerRestarts.runOnce(state, this.shutdownController.signal);
			} catch (error) {
				log('warn', `Database pooler restart failed: ${errorText(error)}`);
			}
		}
	}

	private async databaseReplicationLoop(): Promise<void> {
		while (this.running) {
			await sleep(5_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state) continue;
			try {
				await this.databaseReplication.runOnce(state, this.shutdownController.signal);
			} catch (error) {
				log('warn', `Database replication task failed: ${errorText(error)}`);
			}
		}
	}

	private async databaseDurabilityLoop(): Promise<void> {
		while (this.running) {
			await sleep(2_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state) continue;
			try {
				await this.databaseDurability.runOnce(state, this.shutdownController.signal);
				await this.databaseMember.runOnce(state, this.shutdownController.signal);
			} catch (error) {
				log('warn', `Database durability task failed: ${errorText(error)}`);
			}
		}
	}

	private async databaseRotationLoop(): Promise<void> {
		while (this.running) {
			await sleep(5_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state) continue;
			try {
				await this.databaseRotations.runOnce(state, this.shutdownController.signal);
			} catch (error) {
				log('warn', `Database rotation task failed: ${errorText(error)}`);
			}
		}
	}

	private async databaseCredentialLoop(): Promise<void> {
		while (this.running) {
			await sleep(5_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state) continue;
			try {
				await this.databaseCredentials.runOnce(state, this.shutdownController.signal);
			} catch (error) {
				log('warn', `Database credential task failed: ${errorText(error)}`);
			}
			// Read-only studio principals (plan 22 track G) ride the same loop.
			try {
				await this.studioPrincipals.runOnce(state, this.shutdownController.signal);
			} catch (error) {
				log('warn', `Studio principal task failed: ${errorText(error)}`);
			}
		}
	}

	// --- heartbeat -----------------------------------------------------------

	/**
	 * Workload identity (IAM.md I18). The runtime recovers a token during converge; this loop
	 * rotates delivered tokens at 50% of their lifetime without touching desired state or restarting
	 * a unit. `retain` drops workloads that left this node.
	 */
	private async identityLoop(): Promise<void> {
		while (this.running) {
			await sleep(30_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running || !this.desired) continue;
			this.identity.retain(new Set(this.desired.workloads.map((workload) => workload.id)));
			try {
				await this.identity.refresh(this.workloads.identityWorkloads(), this.shutdownController.signal);
			} catch (error) {
				if (!this.running) break;
				log('warn', `Workload identity refresh failed: ${errorText(error)}`);
			}
		}
	}

	/**
	 * Offline drills (D235): while dark, ask the control plane every few seconds whether the drill
	 * was cancelled. That request is not a heartbeat, so it does not bring the node back online.
	 */
	private async offlineDrillLoop(): Promise<void> {
		let wasActive = false;
		let lastPoll = 0;
		while (this.running) {
			const now = Date.now();
			let active = this.offlineDrill.active(now);
			if (active && now - lastPoll >= nodeDrillLimits.pollMs) {
				lastPoll = now;
				try {
					const response = await this.control.request('/api/agent/drill', {
						headers: { authorization: `Bearer ${this.config.nodeToken}`, accept: 'application/json' },
						signal: this.shutdownController.signal,
					});
					if (response.ok) {
						const parsed = nodeDrillPollSchema.safeParse(await response.json());
						if (parsed.success && this.offlineDrill.poll(parsed.data.drill, Date.now())) active = false;
					} else await response.body?.cancel();
				} catch {
					// Unreachable is fine: the drill still ends on its own at `endsAt`.
				}
			}
			if (wasActive && !active) {
				log('info', 'Offline drill over: heartbeats and desired-state pulls resume');
				void this.refreshIngressHealth().catch(() => undefined);
			}
			if (!wasActive && active) void this.refreshIngressHealth().catch(() => undefined);
			wasActive = active;
			await sleep(1_000, this.shutdownController.signal).catch(() => undefined);
		}
	}

	private async heartbeatLoop(): Promise<void> {
		while (this.running) {
			if (this.offlineDrill.active(Date.now())) {
				await sleep(1_000, this.shutdownController.signal).catch(() => undefined);
				continue;
			}
			let ok = false;
			try {
				ok = await this.sendHeartbeat('online');
			} catch (error) {
				if (!this.running) break;
				this.heartbeatFailures += 1;
				this.heartbeatWasFailing = true;
				log('warn', `Heartbeat failed: ${errorText(error)}`);
			}
			if (!this.running) break;

			if (ok) {
				if (this.heartbeatWasFailing) log('info', 'Heartbeat restored');
				this.heartbeatWasFailing = false;
				this.heartbeatBackoff.reset();
				await sleep(HEARTBEAT_INTERVAL_MS, this.shutdownController.signal);
			} else {
				await sleep(this.heartbeatBackoff.next(), this.shutdownController.signal);
			}
		}
	}

	/**
	 * Public database access (docs/DATABASES.md §19.4, D241): apply the helper's per-port firewall
	 * when the rule set changed (listeners bind only while it is current), keep the `*.db`
	 * certificates copied out of Caddy's storage, then converge the proxy. Never throws.
	 */
	private async syncPublicDatabases(listeners: PublicDatabaseListener[]): Promise<void> {
		try {
			if (listeners.length > 0) this.publicDbReported = true;
			const rules = listeners.map((listener) => ({ port: listener.port, allow: [...listener.allow].sort() })).sort((a, b) => a.port - b.port);
			const key = JSON.stringify(rules);
			// A node that never served a listener leaves the helper alone (and older helpers quiet).
			if (key !== this.publicDbFirewallKey && (listeners.length > 0 || this.publicDbReported)) {
				try {
					const applied = await this.helper.publicDbFirewall(rules);
					this.publicDbHelperOutdated = applied === null;
					this.publicDbFirewallKey = applied === null ? null : key;
				} catch (error) {
					this.publicDbFirewallKey = null;
					log('warn', `Public database firewall not applied, listeners stay closed: ${errorText(error)}`);
				}
			}
			const names = [...new Set(listeners.flatMap((listener) => listener.certificateNames))].sort();
			const namesKey = names.join(',');
			const missing = listeners.some((listener) => !listener.certificateNames.some((name) => this.publicDbCertificates.has(name)));
			const age = Date.now() - this.publicDbCertsAt;
			if (names.length === 0) {
				this.publicDbCertificates = new Map();
				this.publicDbCertNames = '';
			} else if (!this.publicDbHelperOutdated && (namesKey !== this.publicDbCertNames || age > 10 * 60_000 || (missing && age > 60_000))) {
				this.publicDbCertsAt = Date.now();
				this.publicDbCertNames = namesKey;
				try {
					const results = (await this.helper.publicDbTls(names)) ?? [];
					const next = new Map<string, PublicDbCertificate>();
					for (const result of results) {
						if (!result.found || !result.certPath || !result.keyPath) continue;
						const [certPem, keyPem] = await Promise.all([fs.readFile(result.certPath, 'utf8'), fs.readFile(result.keyPath, 'utf8')]);
						next.set(result.name, { certPem, keyPem });
					}
					this.publicDbCertificates = next;
				} catch (error) {
					log('warn', `Copying public database certificates failed: ${errorText(error)}`);
				}
			}
			this.publicDb.converge(listeners, {
				firewallReady: this.publicDbFirewallKey === key,
				helperOutdated: this.publicDbHelperOutdated,
				certificates: this.publicDbCertificates,
			});
		} catch (error) {
			log('error', `Public database converge failed: ${errorText(error)}`);
		}
	}

	private async sendHeartbeat(requestedStatus: NodeStatus): Promise<boolean> {
		await this.checkCaddy();
		// Retries a firewall apply that failed and refreshes certificates; cheap when nothing is due.
		if (this.desired) await this.syncPublicDatabases(this.desired.publicDatabases ?? []);
		const publicDatabases = this.publicDb.size > 0 || this.publicDbReported ? this.publicDb.status() : null;
		const publicDatabaseEvents = this.publicDb.drainEvents();
		const stats = await this.stats.collect();
		const hardware = await this.hardware.collect();
		const nodeCertificate = this.nodeCertificate.ensure();
		// Only while desired state carries `nodeTrust` (flag on, capability advertised).
		const nodeCsr = this.nodeCa.request(this.desired?.nodeTrust);
		if (this.desired?.wireguard && Date.now() - this.wireguardStatusAt > 30_000) {
			try {
				this.wireguardStatus = await this.helper.wireguardStatus();
				this.wireguardStatusAt = Date.now();
			} catch {
				// A helper that predates the overlay simply reports no peer health.
			}
		}
		if (this.desired?.wireguard && this.desired.wireguard.mode !== 'external' && !this.wireguardPublicKey) {
			try {
				// Idempotent: returns the existing key's public half, or creates the pair.
				this.wireguardPublicKey = (await this.helper.wireguardKeygen()).publicKey;
			} catch (error) {
				log('warn', `Could not read the WireGuard public key: ${errorText(error)}`);
			}
		}
		// Cached; refreshed in the background at most every ~6 h (cert-expiry alert, DESIGN §8), and
		// sooner for a custom domain that just arrived (its report moves the domain to `active`).
		const certs = this.certs?.current() ?? [];
		if (certs.length > 0) stats.certs = certs;
		// Actual unit state, so restart loops and OOM kills show up in the fleet view.
		const reports = await this.workloads.refreshReports();
		const storage = await this.storage.status();
		// Purged data dirs (D59, S8); cleared only once the control plane accepts this heartbeat.
		const purgedDatabases = this.workloads.pendingPurgedDatabases();
		const purgedStorage = this.workloads.pendingPurgedStorage();
		const purgedBrokers = this.workloads.pendingPurgedBrokers();
		const purgedKubernetes = this.workloads.pendingPurgedKubernetes();
		const purgedCloudShells = this.workloads.pendingPurgedCloudShells();
		const kubernetesComponent = readKubernetesComponent();
		const kubernetesStatus = this.kubernetes.pending();
		const kubernetesComponentResult = this.kubernetes.pendingComponentResult();
		const kubernetesBackupResults = this.kubernetes.pendingBackupResults();
		const appVolumeReport = this.appVolumes.pending();
		const shareMountReport = this.shareMounts.report();
		const diskMountReport = this.diskMounts.report();
		const volumeProfileResults = this.volumeProfiles.results();
		const linkSamples = this.linkTests.links();
		const linkTestResults = this.linkTests.results();
		const volumeInventory = await this.volumeInventoryForHeartbeat();
		const backupResults = this.databaseBackups.pendingResults();
		const pitrResults = this.databasePitr.pendingResults();
		const rotationResults = this.databaseRotations.pendingResults();
		const credentialResults = this.databaseCredentials.pendingResults();
		const studioPrincipalResults = this.studioPrincipals.pendingResults();
		const poolerRestarted = this.databasePoolerRestarts.pending();
		const databaseReplication = this.databaseReplication.reports();
		const promotionResults = this.databaseReplication.pendingPromotionResults();
		const durabilityReports = this.desired ? await this.databaseDurability.memberReports(this.desired) : [];
		// The W11 member machine is the authority for role/generation once it has run; the W10
		// durability probes fill the first heartbeat before its first pass.
		const memberReports = [
			...new Map([...durabilityReports, ...this.databaseMember.reports()].map((report) => [report.databaseId, report])).values(),
		];
		const memberEvents = this.databaseMember.pendingEvents();
		const syncResults = this.databaseDurability.pendingSyncResults();
		const switchoverResults = this.databaseDurability.pendingSwitchoverResults();
		const rewindResults = this.databaseReplication.pendingRewindResults();
		const nodeUpdateResult = this.nodeUpdate.pendingResult();
		const databaseTls = databaseTlsHeartbeat(reports);
		// Release commands this node ran or refused; re-sent until the control plane drops the task.
		const releaseCommandResults = this.releaseCommands.pendingResults(this.desired);
		// Bucket deletions and config convergence are reported once, capped by the heartbeat schema.
		const storageBucketDeletions = this.storageAdmin.pendingBucketDeletions().slice(0, 500);
		const storageBucketConfigs = this.storageAdmin.pendingBucketConfigs().slice(0, 500);
		// Root keys proved or refused (staged rotation, §5) and replication progress (§12).
		const storageRootKeys = this.storageAdmin.pendingRootKeyReports().slice(0, 200);
		const storageReplication = this.storageReplicator.pendingReports();
		// A storage move happens outside the agent's sandbox (D48); ask for it while it is due.
		await this.storage
			.reconcile(this.desired?.storage, storage)
			.then((requested) => {
				if (requested) log('info', 'Requested a storage move from yoal-storage.service');
			})
			.catch((error: unknown) => log('warn', `Could not request a storage move: ${errorText(error)}`));
		// The endpoint is Caddy's answer from the state file; refresh it so the fleet view matches.
		await this.refreshIngressHealth().catch((error) => log('warn', `Ingress health update failed: ${errorText(error)}`));
		const controlReport = this.controlReadyzUrl ? await readControlReport(this.controlReadyzUrl) : null;
		const body: Heartbeat = {
			nodeId: this.config.nodeId,
			agentVersion: this.config.agentVersion,
			actualStateVersion: this.actualStateVersion,
			status: requestedStatus === 'draining' ? 'draining' : this.caddyOk ? 'online' : 'offline',
			caddyOk: this.caddyOk,
			capabilities: advertisedCapabilities(undefined, undefined, this.nodeCa.available(), this.databaseMember.selfFencing),
			// The same value on every ingress when distribution is healthy (HA-PLAN H20, W7). Null
			// with the flag off, where Caddy issues per node.
			certificateFingerprint: this.certificateDelivery.fingerprint(),
			stats,
			...(this.latestIngressHealth ? { ingressHealth: this.latestIngressHealth } : {}),
			// A control node reports its own lease view so `/api/v1/ha/status` can show standbys
			// instead of only the primary's row (W9-SPEC §4.6).
			...(controlReport ? { control: controlReport } : {}),
			...(hardware ? { hardware } : {}),
			...(nodeCertificate ? { nodeCertificate } : {}),
			...(nodeCsr ? { nodeCsr } : {}),
			...(this.desired?.wireguard && this.wireguardStatus ? { wireguard: this.wireguardStatus } : {}),
			...(this.desired?.wireguard && this.wireguardPublicKey ? { wireguardPublicKey: this.wireguardPublicKey } : {}),
			releases: this.releases.listReleases(),
			...(storage ? { storage } : {}),
			...(reports.length > 0 ? { workloads: workloadHeartbeat(reports) } : {}),
			...(backupResults.length > 0 ? { databaseBackupResults: backupResults } : {}),
			...(pitrResults.length > 0 ? { databasePitrResults: pitrResults } : {}),
			...(rotationResults.length > 0 ? { databaseRotationResults: rotationResults } : {}),
			...(credentialResults.length > 0 ? { databaseCredentialResults: credentialResults } : {}),
			...(studioPrincipalResults.length > 0 ? { databaseStudioPrincipalResults: studioPrincipalResults } : {}),
			...(poolerRestarted.length > 0 ? { databasePoolerRestarted: poolerRestarted } : {}),
			...(databaseReplication.length > 0 ? { databaseReplication } : {}),
			...(promotionResults.length > 0 ? { databaseReplicaPromotionResults: promotionResults } : {}),
			...(memberReports.length > 0 ? { databaseMembers: memberReports } : {}),
			...(memberEvents.length > 0 ? { databaseMemberEvents: memberEvents } : {}),
			...(syncResults.length > 0 ? { databaseSyncResults: syncResults } : {}),
			...(switchoverResults.length > 0 ? { databaseSwitchoverResults: switchoverResults } : {}),
			...(rewindResults.length > 0 ? { databaseReplicaRewindResults: rewindResults } : {}),
			...(nodeUpdateResult ? { nodeUpdateResult } : {}),
			...(releaseCommandResults.length > 0 ? { releaseCommandResults } : {}),
			...(databaseTls.length > 0 ? { databaseTls } : {}),
			...(purgedDatabases.length > 0 ? { purgedDatabases } : {}),
			...(purgedStorage.length > 0 ? { purgedStorage } : {}),
			...(purgedBrokers.length > 0 ? { purgedBrokers } : {}),
			...(purgedKubernetes.length > 0 ? { purgedKubernetes } : {}),
			...(purgedCloudShells.length > 0 ? { purgedCloudShells } : {}),
			...(kubernetesComponent ? { kubernetes: kubernetesComponent } : {}),
			...(kubernetesStatus.length > 0 ? { kubernetesStatus } : {}),
			...(kubernetesComponentResult ? { kubernetesComponentResult } : {}),
			...(kubernetesBackupResults.length > 0 ? { kubernetesBackupResults } : {}),
			...(appVolumeReport.purged.length > 0 ? { purgedAppVolumes: appVolumeReport.purged } : {}),
			...(appVolumeReport.usage.length > 0 ? { appVolumeUsage: appVolumeReport.usage } : {}),
			...(appVolumeReport.results.length > 0 ? { appVolumeTaskResults: appVolumeReport.results } : {}),
			...(storageBucketDeletions.length > 0 ? { storageBucketDeletions } : {}),
			...(storageBucketConfigs.length > 0 ? { storageBucketConfigs } : {}),
			...(storageRootKeys.length > 0 ? { storageRootKeys } : {}),
			...(storageReplication.length > 0 ? { storageReplication } : {}),
			...(volumeInventory ? { volumes: volumeInventory } : {}),
			...(shareMountReport.shareMounts.length > 0 ? { shareMounts: shareMountReport.shareMounts } : {}),
			...(shareMountReport.unmountedShares.length > 0 ? { unmountedShares: shareMountReport.unmountedShares } : {}),
			...(diskMountReport.diskMounts.length > 0 ? { diskMounts: diskMountReport.diskMounts } : {}),
			...(diskMountReport.unmountedDisks.length > 0 ? { unmountedDisks: diskMountReport.unmountedDisks } : {}),
			...(volumeProfileResults.length > 0 ? { volumeProfileResults } : {}),
			...(linkSamples.length > 0 ? { links: linkSamples } : {}),
			...(linkTestResults.length > 0 ? { linkTestResults } : {}),
			...(this.poolIdentity.isActive ? { identityStatus: this.poolIdentity.status() } : {}),
			...(publicDatabases ? { publicDatabases } : {}),
			...(publicDatabaseEvents.length > 0 ? { publicDatabaseEvents } : {}),
		};

		const parsed = heartbeatSchema.safeParse(body);
		if (!parsed.success) throw new Error(`heartbeat failed validation: ${parsed.error.message}`);

		const response = await this.control.request('/api/agent/heartbeat', {
			method: 'POST',
			signal: AbortSignal.any([
				this.shutdownController.signal,
				AbortSignal.timeout(HEARTBEAT_INTERVAL_MS * 2),
			]),
			headers: {
				authorization: `Bearer ${this.config.nodeToken}`,
				'content-type': 'application/json',
				// This host's clock at send time, for the control plane's `clocks` check (HA Wave 5).
				'x-yoal-agent-time': String(Date.now()),
			},
			body: JSON.stringify(parsed.data),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`heartbeat -> ${response.status}${text ? `: ${text}` : ''}`);
		}
		// The control plane answered: every run lease on this node is good for another TTL.
		await this.runLease.touch(leaseState(this.desired, this.runLease).leased.length > 0);
		this.databaseBackups.acknowledge(backupResults.map((result) => result.taskId));
		this.databasePitr.acknowledge(pitrResults.map((result) => result.taskId));
		this.databaseRotations.acknowledge(rotationResults.map((result) => result.taskId));
		this.databaseCredentials.acknowledge(credentialResults.map((result) => result.taskId));
		this.studioPrincipals.acknowledge(studioPrincipalResults);
		this.databasePoolerRestarts.acknowledge(poolerRestarted);
		this.databaseReplication.acknowledgePromotions(promotionResults);
		this.databaseReplication.acknowledgeRewinds(rewindResults.map((result) => result.replicaId));
		this.databaseMember.acknowledgeEvents(memberEvents.length);
		await this.nodeUpdate.acknowledge(nodeUpdateResult);
		// The control plane accepted a heartbeat from this binary: stand the rollback guard down.
		await this.nodeUpdate.confirmHealthy(this.shutdownController.signal);
		this.workloads.acknowledgePurgedDatabases(purgedDatabases);
		this.workloads.acknowledgePurgedStorage(purgedStorage);
		this.workloads.acknowledgePurgedBrokers(purgedBrokers);
		this.workloads.acknowledgePurgedKubernetes(purgedKubernetes);
		this.workloads.acknowledgePurgedCloudShells(purgedCloudShells);
		this.kubernetes.acknowledge(kubernetesStatus);
		this.kubernetes.acknowledgeComponentResult(kubernetesComponentResult);
		this.kubernetes.acknowledgeBackupResults(kubernetesBackupResults);
		this.appVolumes.acknowledge(appVolumeReport);
		this.shareMounts.acknowledgeUnmounted(shareMountReport.unmountedShares);
		this.diskMounts.acknowledgeUnmounted(diskMountReport.unmountedDisks);
		this.volumeProfiles.acknowledge(volumeProfileResults);
		this.linkTests.acknowledge(linkTestResults);
		this.storageAdmin.acknowledgeBucketDeletions(storageBucketDeletions);
		this.storageAdmin.acknowledgeBucketConfigs(storageBucketConfigs);
		this.storageAdmin.acknowledgeRootKeyReports(storageRootKeys);
		this.storageReplicator.acknowledgeReports(storageReplication);
		return true;
	}

	/** Cached mount/device inventory (D72, D80); a failure keeps the last report and retries later. */
	private async volumeInventoryForHeartbeat(): Promise<VolumeInventory | null> {
		if (this.volumeInventory && Date.now() - this.volumeInventoryAt < VOLUME_INVENTORY_INTERVAL_MS)
			return this.volumeInventory;
		try {
			this.volumeInventory = await this.helper.volumes(this.shutdownController.signal);
		} catch (error) {
			log('warn', `Volume inventory failed: ${errorText(error)}`);
		} finally {
			// Throttle retries too: the helper may be down, and the next heartbeat is 10 s away.
			this.volumeInventoryAt = Date.now();
		}
		return this.volumeInventory;
	}

	private async checkCaddy(): Promise<void> {
		try {
			await this.caddy.health(this.shutdownController.signal);
			this.caddyOk = true;
		} catch {
			this.caddyOk = false;
			return;
		}
		// A restarted Caddy comes back with the bootstrap Caddyfile and none of our routes. Our
		// config always carries the `catch-all` id, so its absence means we must re-apply.
		if (this.convergedVersion === null) return;
		try {
			if (!(await this.caddy.hasId(CONVERGED_SENTINEL_ID, this.shutdownController.signal))) {
				log('warn', 'Caddy lost the Yoal config (restart?); re-applying routes');
				this.convergedVersion = null;
			}
		} catch {
			// A transient admin error is not proof of a restart; the next check will tell.
		}
	}

	// --- log records (docs/LOGS.md LP6, LP7) ---------------------------------

	/** The node-local logs secret, created on first use. Null (and logged once) when the data dir refuses it. */
	private logsSecret(): Buffer | null {
		if (this.logsSecretValue !== undefined) return this.logsSecretValue;
		try {
			this.logsSecretValue = loadLogsSecret(this.config.dataDir);
		} catch (error) {
			log('warn', `Log records disabled: cannot create ${join(this.config.dataDir, 'logs.key')}: ${errorText(error)}`);
			this.logsSecretValue = null;
		}
		return this.logsSecretValue;
	}

	/** Ship buffered access and OTLP records every 2 s, the live-tail floor (docs/LOGS.md §2). */
	private async logRecordsLoop(): Promise<void> {
		if (!this.edgeRequestLogs && !this.otlpLogs) return;
		let warned = false;
		while (this.running) {
			try {
				await this.logRecords.flush();
				warned = false;
			} catch (error) {
				if (!warned) log('warn', `Log records flush failed: ${errorText(error)}`);
				warned = true;
			}
			await sleep(LOG_RECORDS_INTERVAL_MS, this.shutdownController.signal);
		}
	}

	// --- telemetry -----------------------------------------------------------

	private async telemetryLoop(): Promise<void> {
		const client = this.telemetry;
		if (!client) return;
		let lastFlush = Date.now();
		let lastStartAttempt = 0;

		while (this.running) {
			try {
				if (!client.ready) {
					if (Date.now() - lastStartAttempt >= 10_000) {
						lastStartAttempt = Date.now();
						try {
							await client.start();
							this.telemetryStartWarned = false;
							log('info', `Aggregating access log ${this.config.caddyAccessLog}`);
						} catch (error) {
							if (!this.telemetryStartWarned) {
								this.telemetryStartWarned = true;
								log('warn', `Waiting for access log: ${errorText(error)}`);
							}
						}
					}
					await sleep(TELEMETRY_POLL_MS, this.shutdownController.signal);
					continue;
				}

				await client.poll();
				if (Date.now() - lastFlush >= TELEMETRY_INTERVAL_MS) {
					lastFlush = Date.now();
					try {
						await client.flush();
					} catch (error) {
						log('warn', `Telemetry flush failed: ${errorText(error)}`);
					}
				}
			} catch (error) {
				if (!this.running) break;
				log('warn', `Telemetry tail failed: ${errorText(error)}`);
			}
			await sleep(TELEMETRY_POLL_MS, this.shutdownController.signal);
		}
	}

	/**
	 * Managed database samples (D57). Independent of the access-log tail, so a node without Caddy
	 * access logging still reports its databases. Credentials stay in the runtime's memory.
	 */
	private async databaseStatsLoop(): Promise<void> {
		while (this.running) {
			await sleep(DATABASE_STATS_INTERVAL_MS, this.shutdownController.signal);
			if (!this.running) break;
			try {
				await this.databaseStats.sample();
			} catch (error) {
				log('warn', `Database sampling failed: ${errorText(error)}`);
			}
			try {
				await this.databaseStats.flush((payload) =>
					postTelemetryBatch(
						{
							controlUrl: this.config.controlUrl,
							nodeToken: this.config.nodeToken,
							nodeId: this.config.nodeId,
						},
						payload,
					),
				);
			} catch (error) {
				log('warn', `Database telemetry flush failed: ${errorText(error)}`);
			}
		}
	}

	/**
	 * Bucket and scoped-key convergence (S4, S8). Desired-state changes also trigger a round at
	 * the end of `converge`, so this loop is the repair/retry path.
	 */
	private async storageAdminLoop(): Promise<void> {
		while (this.running) {
			try {
				await this.storageAdmin.reconcile();
			} catch (error) {
				log('warn', `Storage reconcile failed: ${errorText(error)}`);
			}
			if (!this.running) break;
			await sleep(STORAGE_RECONCILE_INTERVAL_MS, this.shutdownController.signal);
		}
	}

	/** Object storage usage and per-bucket snapshots (S7), riding the telemetry batch. */
	private async storageStatsLoop(): Promise<void> {
		while (this.running) {
			await sleep(STORAGE_STATS_INTERVAL_MS, this.shutdownController.signal);
			if (!this.running) break;
			try {
				await this.storageStats.sample();
			} catch (error) {
				log('warn', `Storage sampling failed: ${errorText(error)}`);
			}
			try {
				await this.storageStats.flush((payload) =>
					postTelemetryBatch(
						{
							controlUrl: this.config.controlUrl,
							nodeToken: this.config.nodeToken,
							nodeId: this.config.nodeId,
						},
						payload,
					),
				);
			} catch (error) {
				log('warn', `Storage telemetry flush failed: ${errorText(error)}`);
			}
		}
	}

	/** Managed broker samples and stream listings (D123), riding the telemetry batch. */
	/** Kubernetes manifests (on change) and status samples (once a minute). Idle without machines. */
	private async kubernetesLoop(): Promise<void> {
		while (this.running) {
			await sleep(15_000, this.shutdownController.signal);
			if (!this.running) break;
			const state = this.desired;
			await this.kubernetes.componentTick(state, this.shutdownController.signal);
			if (!state || !state.workloads.some((workload) => workload.kubernetes)) continue;
			// Snapshots run in the background so a long upload never delays status or manifests.
			void this.kubernetes.backupTick(state, this.shutdownController.signal);
			await this.kubernetes.tick(state, this.shutdownController.signal);
		}
	}

	/** A server machine's manifests (they can carry attachment passwords; never cached on disk). */
	private async fetchKubernetesManifests(
		machineId: string,
		signal: AbortSignal,
	): Promise<{ generation: string; files: Record<string, string> }> {
		const response = await fetch(
			`${this.config.controlUrl}/api/agent/kubernetes/manifests/${encodeURIComponent(machineId)}`,
			{ headers: { authorization: `Bearer ${this.config.nodeToken}`, accept: 'application/json' }, signal },
		);
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`kubernetes manifests -> ${response.status}${text ? `: ${text}` : ''}`);
		}
		const body = (await response.json()) as { generation?: unknown; files?: unknown };
		if (typeof body.generation !== 'string' || typeof body.files !== 'object' || body.files === null)
			throw new Error('kubernetes manifests: malformed response');
		const files: Record<string, string> = {};
		for (const [name, content] of Object.entries(body.files as Record<string, unknown>))
			if (typeof content === 'string') files[name] = content;
		return { generation: body.generation, files };
	}

	private async brokerStatsLoop(): Promise<void> {
		while (this.running) {
			await sleep(BROKER_STATS_INTERVAL_MS, this.shutdownController.signal);
			if (!this.running) break;
			try {
				await this.brokerStats.sample(this.shutdownController.signal);
			} catch (error) {
				log('warn', `Broker sampling failed: ${errorText(error)}`);
			}
			try {
				await this.brokerStats.flush((payload) =>
					postTelemetryBatch(
						{
							controlUrl: this.config.controlUrl,
							nodeToken: this.config.nodeToken,
							nodeId: this.config.nodeId,
						},
						payload,
					),
				);
			} catch (error) {
				log('warn', `Broker telemetry flush failed: ${errorText(error)}`);
			}
		}
	}

	// --- metrics -------------------------------------------------------------

	private metricsText(): string {
		const telemetry = this.telemetry?.stats;
		const workloadReports = this.workloads.currentReports();
		const measurements: Array<[string, string, 'counter' | 'gauge', number]> = [
			['yoal_agent_caddy_up', 'Whether the Caddy admin API is reachable.', 'gauge', this.caddyOk ? 1 : 0],
			['yoal_agent_routes', 'Routes in the current desired state.', 'gauge', this.desired?.routes.length ?? 0],
			['yoal_agent_releases', 'Verified releases on disk.', 'gauge', this.releases.listReleases().length],
			[
				'yoal_agent_workloads_total',
				'Workloads reported by this node.',
				'gauge',
				workloadReports.length,
			],
			[
				'yoal_agent_workloads_running',
				'Workloads currently running.',
				'gauge',
				workloadReports.filter((report) => report.status === 'running').length,
			],
			[
				'yoal_agent_desired_state_version',
				'Version of the last pulled desired state.',
				'gauge',
				this.desired?.version ?? 0,
			],
			['yoal_agent_actual_state_version', 'Version this agent has converged to.', 'gauge', this.actualStateVersion],
			[
				'yoal_agent_reconcile_last_attempt_timestamp_seconds',
				'Unix time of the last reconcile attempt.',
				'gauge',
				this.lastReconcileAttemptAt / 1000,
			],
			[
				'yoal_agent_reconcile_last_success_timestamp_seconds',
				'Unix time of the last successful reconcile.',
				'gauge',
				this.lastReconcileSuccessAt / 1000,
			],
			[
				'yoal_agent_reconcile_failures_total',
				'Desired-state pulls or converges that failed.',
				'counter',
				this.reconcileFailures,
			],
			[
				'yoal_agent_heartbeat_failures_total',
				'Heartbeats that could not be delivered.',
				'counter',
				this.heartbeatFailures,
			],
			[
				'yoal_agent_telemetry_flush_failures_total',
				'Telemetry batches that could not be delivered.',
				'counter',
				telemetry?.flushFailures ?? 0,
			],
			[
				'yoal_agent_telemetry_batches_sent_total',
				'Telemetry batches delivered to the control plane.',
				'counter',
				telemetry?.batchesSent ?? 0,
			],
			[
				'yoal_agent_telemetry_buckets_dropped_total',
				'Telemetry buckets dropped to keep memory bounded.',
				'counter',
				telemetry?.dropped ?? 0,
			],
			[
				'yoal_agent_telemetry_spool_queued',
				'Buckets waiting in the bounded on-disk telemetry spool.',
				'gauge',
				telemetry?.spoolQueued ?? 0,
			],
			[
				'yoal_agent_telemetry_spool_bytes',
				'Bytes used by the bounded on-disk telemetry spool.',
				'gauge',
				telemetry?.spoolBytes ?? 0,
			],
			[
				'yoal_agent_telemetry_spool_dropped_total',
				'Buckets dropped when the telemetry spool reached its bound.',
				'counter',
				telemetry?.spoolDropped ?? 0,
			],
			[
				'yoal_agent_database_samples_dropped_total',
				'Database samples and snapshots dropped to keep memory bounded.',
				'counter',
				this.databaseStats.dropped,
			],
			[
				'yoal_agent_storage_samples_dropped_total',
				'Storage samples and snapshots dropped to keep memory bounded.',
				'counter',
				this.storageStats.dropped,
			],
			[
				'yoal_agent_broker_samples_dropped_total',
				'Broker samples and stream listings dropped to keep memory bounded.',
				'counter',
				this.brokerStats.dropped,
			],
		];

		const lines: string[] = [];
		for (const [name, help, type, value] of measurements) {
			lines.push(`# HELP ${name} ${help}`);
			lines.push(`# TYPE ${name} ${type}`);
			lines.push(`${name} ${formatMetric(value)}`);
		}
		lines.push('# HELP yoal_agent_build_info Agent build metadata.');
		lines.push('# TYPE yoal_agent_build_info gauge');
		lines.push(`yoal_agent_build_info{version="${escapeLabel(this.config.agentVersion)}"} 1`);
		return `${lines.join('\n')}\n`;
	}
}

function metricsHeaders(): Record<string, string> {
	return { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' };
}

function formatMetric(value: number): string {
	return Number.isFinite(value) ? String(value) : '0';
}

function escapeLabel(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Fall back to stripping the site label from any route host when desired state omits it. */
function deriveContentDomain(state: DesiredState): string {
	const host = state.routes[0] ? normalizeHost(state.routes[0].host) : '';
	const labels = host.split('.');
	if (labels.length < 3) throw new Error('Cannot determine the content domain for TLS');
	return labels.slice(1).join('.');
}

function requestPath(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		return '/';
	}
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.name === 'AbortError' ? 'aborted' : error.message;
	return String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = (): void => {
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			resolve();
		};
		const onAbort = (): void => finish();
		const timer = setTimeout(finish, ms);
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
	const line = `[yoal-agent ${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
	if (level === 'error') console.error(line);
	else if (level === 'warn') console.warn(line);
	else console.log(line);
}

async function runJoinCli(args: string[]): Promise<void> {
	if (args.includes('--help') || args.includes('-h')) {
		console.log(JOIN_USAGE);
		return;
	}
	const options = parseJoinArgs(args);
	if (options.networkMode === 'yoal' && !options.wireguardPublicKey) {
		// The private key stays on the node: the helper generates it and returns only the public key.
		const helper = new HelperClient(process.env.YOAL_HELPER_SOCKET?.trim() || '/run/yoal-helper/helper.sock');
		options.wireguardPublicKey = (await helper.wireguardKeygen()).publicKey;
	}
	const joined = await joinNode(options);
	process.stdout.write(formatEnv(joined));
	// Keep stdout machine-readable for `> /etc/yoal/agent.env`.
	console.error(`Wrote ${nodeFilePath(options.dataDir)}`);
}

async function main(): Promise<void> {
	const config = loadConfig();
	// Edge node: reach the control plane on its socket, never through our own Caddy (D105).
	if (config.controlSocket) globalThis.fetch = controlSocketFetch(globalThis.fetch, config.controlUrl, config.controlSocket);
	const runtime = new AgentRuntime(config);
	await runtime.run();
}

if (import.meta.main) {
	// `bun src/main.ts join …` has the script at argv[1]; a compiled binary may not.
	const subcommand = (name: string) => (process.argv[2] === name ? 2 : process.argv[1] === name ? 1 : -1);
	const joinIndex = subcommand('join');
	const storageIndex = subcommand('storage');
	if (subcommand('mail') >= 0) {
		// Email's MTA (docs/EMAIL.md), run by yoal-mail.service in its own cgroup. It reads no agent
		// config and never sees the node token: the agent feeds it over /run/yoal/mail.sock.
		const { runMailProcess } = await import('@yoal/mail/process');
		await runMailProcess().catch((error: unknown) => {
			console.error(`[yoal-agent mail] fatal: ${errorText(error)}`);
			process.exit(1);
		});
	} else if (subcommand('identity') >= 0) {
		// The separate user-pool identity process (docs/IAM.md §11.2), run by yoal-identity.service
		// in its own cgroup. Same signed binary as yoal-mail; no agent config or node token.
		const { runIdentityProcess } = await import('@yoal/identity/process');
		await runIdentityProcess().catch((error: unknown) => {
			console.error(`[yoal-agent identity] fatal: ${errorText(error)}`);
			process.exit(1);
		});
	} else if (subcommand('studio') >= 0) {
		// The native database studio process (plan 22), run by yoal-studio.service in its own
		// cgroup. It reads no agent config and never sees the node token.
		const { runStudioProcess } = await import('./studio/process.ts');
		await runStudioProcess().catch((error: unknown) => {
			console.error(`[yoal-agent studio] fatal: ${errorText(error)}`);
			process.exit(1);
		});
	} else if (storageIndex >= 0) {
		// Root-only node storage moves (D48), run by yoal-storage.service.
		const { runStorageCli } = await import('./storage-apply.ts');
		process.exitCode = await runStorageCli(process.argv.slice(storageIndex + 1));
	} else if (subcommand('pipeline-step') >= 0) {
		// The in-job Pipelines step runner (docs/PIPELINES.md W5), started by the Builder inside a job
		// container or sandbox unit. It reads no agent config: only job.json and the job token.
		const { runPipelineStep } = await import('@yoal/builder');
		const code = await runPipelineStep(process.argv[subcommand('pipeline-step') + 1]).catch((error: unknown) => {
			console.error(`[yoal-agent pipeline-step] fatal: ${errorText(error)}`);
			return 1;
		});
		process.exit(code);
	} else if (subcommand('builder') >= 0) {
		// The git Builder ships inside the agent binary so every node can build (D47). It runs as its
		// own unit (`yoal-builder.service`), never inside the agent's sandbox or memory budget.
		const { runBuilder } = await import('@yoal/builder');
		await runBuilder().catch((error: unknown) => {
			console.error(`[yoal-agent builder] fatal: ${errorText(error)}`);
			process.exitCode = 1;
		});
	} else if (joinIndex >= 0) {
		await runJoinCli(process.argv.slice(joinIndex + 1)).catch((error: unknown) => {
			console.error(`yoal-agent join: ${errorText(error)}`);
			process.exitCode = 1;
		});
	} else {
		main().catch((error: unknown) => {
			console.error(`[yoal-agent] fatal: ${errorText(error)}`);
			process.exitCode = 1;
		});
	}
}

/**
 * The static capabilities plus `functions-python` when the warmed Pyodide cache for the pinned
 * workerd is on disk (D121), and `process-node` when the node has Node.js (D125). Checked on every heartbeat, so installing the cache later takes effect
 * without restarting the agent.
 */
export function advertisedCapabilities(
	pyodideDir: string = process.env.YOAL_PYODIDE_CACHE_DIR ?? `${WORKERD_INSTALL_DIR}/${WORKERD_PINNED_VERSION}/pyodide`,
	nodeBinary: string = process.env.YOAL_NODE_PATH ?? '/usr/local/bin/node',
	nodeCaAvailable: boolean = Bun.which('openssl') !== null,
	selfFencing: boolean = false,
): string[] {
	let python = false;
	try {
		python = existsSync(pyodideDir) && readdirSync(pyodideDir).some((name) => name.endsWith('.capnp.bin'));
	} catch {
		python = false;
	}
	const capabilities: string[] = [...nodeCapabilities];
	// This build runs release commands, honours readiness/drain/stop timeouts and reports results.
	capabilities.push(RELEASE_PHASE_CAPABILITY);
	if (python) capabilities.push(FUNCTIONS_PYTHON_CAPABILITY);
	// Node.js process apps (D125) need the pinned node the installer links onto every unit's PATH.
	if (existsSync(nodeBinary)) capabilities.push(PROCESS_NODE_CAPABILITY);
	// The optional Kubernetes component (docs/KUBERNETES.md K2): only while its marker says it works.
	capabilities.push(...kubernetesCapabilities(readKubernetesComponent()));
	// HA-PLAN H24: gateway listeners, AddHost, read endpoints and install-CA trust. The forwarder
	// and helper verbs ship in this build; the CSR needs openssl, as the C2 identity already does.
	if (nodeCaAvailable) capabilities.push(ENDPOINTS_GATEWAY_CAPABILITY);
	// This build serves the full edge payload and the health endpoint (W6/W8).
	capabilities.push(INGRESS_SET_CAPABILITY);
	// W9: holds the control address list in `control`, persists the epoch and refuses a lower one.
	capabilities.push(HA_EPOCH_CAPABILITY);
	// W11: advertise self-fencing only when this process really has an arbiter transport and a peer
	// channel. Report-only builds must not claim it, or the control plane would arm `auto` (F1).
	if (selfFencing) capabilities.push(DB_MEMBER_SELF_FENCING_CAPABILITY);
	return capabilities;
}

/** The kernel's id for this boot, or null off Linux (the workload diff cache then never expires). */
function readBootId(): string | null {
	try {
		const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
		return /^[0-9a-f-]{36}$/.test(id) ? id : null;
	} catch {
		return null;
	}
}
