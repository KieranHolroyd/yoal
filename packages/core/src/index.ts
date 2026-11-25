import type { Database } from 'bun:sqlite';
import type { YoalDb } from '@yoal/db';
import type { CoreConfig } from './config.ts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import type { ConditionalStore } from './object-store.ts';
import { AuditService } from './audit.ts';
import { QuotaService } from './quota.ts';
import { UsageService } from './usage.ts';
import { ProjectService } from './projects.ts';
import { ReleaseService } from './releases.ts';
import { DeploymentService } from './deployments.ts';
import { UploadService } from './uploads.ts';
import { NodeService } from './nodes.ts';
import { AccessService } from './access.ts';
import { DeployService } from './deploy.ts';
import { MaintenanceService } from './maintenance.ts';
import { SecretService } from './secrets.ts';
import { MetricsService } from './metrics.ts';
import { MetricsExporter } from './metrics-export.ts';
import { ServerErrorService } from './server-errors.ts';
import { AppErrorService } from './app-errors.ts';
import { SentryService } from './sentry.ts';
import { UsageAnalyticsService } from './usage-analytics.ts';
import { WhatsNewService } from './whats-new.ts';
import { PlatformPolicyService } from './platform-policies.ts';
import { ObservabilityService } from './observability.ts';
import { AlertService } from './alerts.ts';
import { TopologyService } from './topology.ts';
import { ServiceEndpointService } from './service-endpoints.ts';
import { DatabasePublicAccessService } from './database-public-access.ts';
import { NodeCaService } from './node-ca.ts';
import { ShareService } from './shares.ts';
import { RegistryCredentialService } from './registry-credentials.ts';
import { RegistryService } from './registry.ts';
import { DatabaseReplicaService } from './database-replica-service.ts';
import { StorageReplicationService } from './storage-replication-service.ts';
import { IngressHaService } from './ingress-ha.ts';
import { FailoverService } from './failover-service.ts';
import { NodeDrillService } from './node-drills.ts';
import { SchedulingService } from './scheduling-service.ts';
import { NodeRolloutService } from './node-rollouts.ts';
import { NodeLinkService } from './link-service.ts';
import { OverlayMeshService } from './overlay-mesh-service.ts';
import { ScalingService } from './scaling-service.ts';
import { ReleaseCommandScheduler } from './release-commands.ts';
import { RelocationService } from './relocation-service.ts';
import { ClusterConfigService } from './cluster-config-service.ts';
import { HaService } from './ha-service.ts';
import { RegionService } from './region-service.ts';
import { HaInitService } from './ha-init-service.ts';
import { HaDoctorService } from './ha-doctor.ts';
import { HaDrillRunner } from './ha-drill-runner.ts';
import { TelemetrySpoolGapService } from './telemetry-spool-gaps.ts';
import { CertificateService, IngressSetService, SteeringService } from './ingress-service.ts';
import { ControlPlaneService } from './control-plane-service.ts';
import { DatabaseMemberService } from './database-member-service.ts';
import { DatabaseFailoverPolicyService } from './database-failover-policy-service.ts';
import { SloService } from './slo-service.ts';
import { ExternalProberService } from './external-prober-service.ts';
import { createDnsFailoverDriver } from './steering/dns-failover/core.ts';
import { createVipDriverFromCore } from './steering/vip/core.ts';
import { createWebhookDriverFromCore } from './steering/webhook/core.ts';
import { STEERING_DRIVER_FACTORIES } from './steering/registry.ts';
import { WorkloadService } from './workloads.ts';
import { DatabaseService } from './databases.ts';
import { DatabaseStudioService } from './database-studio.ts';
import { ContainerConsoleService } from './container-console.ts';
import { CloudShellService } from './cloud-shells.ts';
import { StorageService } from './storage-instances.ts';
import { BrokerService } from './brokers.ts';
import { KubernetesService } from './kubernetes.ts';
import { EmailService, type EmailServiceOptions } from './email.ts';
import { cloudflareConfigFromEnv, HttpCloudflareClient } from './domains.ts';
import { EventService } from './events.ts';
import { NodeTaskService } from './node-tasks.ts';
import { JobService } from './jobs.ts';
import { ConnectedAppService } from './connected-apps.ts';
import { DiskService } from './disks.ts';
import { AppVolumeService } from './app-volumes.ts';
import { ServiceMoveService } from './service-moves.ts';
import { StorageObjectsService } from './storage-objects.ts';
import { DomainService } from './domains.ts';
import { BuildService } from './builds.ts';
import { PipelineService } from './pipelines.ts';
import { LogService } from './logs.ts';
import { LogExplorerService } from './log-explorer.ts';
import { LogDrainService } from './log-drains.ts';
import { ConfigExportService } from './config-export.ts';
import { ConfigImportService } from './config-import/service.ts';
import { EnvironmentService } from './environments.ts';
import { SourceService } from './source.ts';
import { createOperationService, type OperationService } from './operations/index.ts';
import { SchedulerService } from './scheduler.ts';
import { FlowService } from './flows/service.ts';
import { ServiceActionsService } from './service-actions.ts';
import { BackupTargetService } from './backup-targets.ts';
import { UpgradeService } from './upgrades.ts';
import { GithubRunnerService } from './github-runners.ts';
import { GithubAppService } from './github-app.ts';
import { GithubImportService } from './github-import.ts';
import { ForgeService, GitProviders } from './forges/index.ts';
import { FunctionService } from './functions.ts';
import { TemplateService } from './templates.ts';
import { BlueprintService } from './blueprints.ts';
import { IamService } from './iam/service.ts';
import { GovernanceService } from './iam/governance.ts';
import { AuthPolicyService } from './iam/auth-policy.ts';
import { PlatformIamService } from './platform-iam.ts';
import { configurePrunePlatformIam } from './operations/prune.ts';
import { ServiceAccountService } from './service-accounts.ts';
import { AccessKeyService } from './access-keys.ts';
import { FederationTrustService } from './iam/federation.ts';
import { SigningKeyService } from './iam/keys.ts';
import { WorkloadIdentityService } from './iam/workload-identity.ts';
import { TokenService } from './iam/sts.ts';
import { AccessPolicyService } from './iam/access-policies.ts';
import { ScimTokenService } from './iam/scim.ts';
import { UserPoolService } from './user-pools.ts';
import { UserPoolEngineService, createUserPoolMailer } from './user-pool-engine.ts';

export * from './config.ts';
export * from './context.ts';
export * from './errors.ts';
export * from './util.ts';
export * from './cron.ts';
export * from './artifact.ts';
export * from './object-store.ts';
export * from './object-store-factory.ts';
export * from './object-store/azure.ts';
export * from './object-store/gcs.ts';
export * from './ha-lease.ts';
export * from './ha-control-arbiter.ts';
export * from './control-standby.ts';
export * from './control-enrolment.ts';
export * from './control-plane-service.ts';
export * from './orgs.ts';
export * from './iam/service.ts';
export * from './iam/governance.ts';
export * from './iam/auth-policy.ts';
export * from './iam/sso.ts';
export * from './iam/federation.ts';
export * from './iam/keys.ts';
export * from './iam/workload-identity.ts';
export * from './iam/sts.ts';
export * from './iam/token-consumers.ts';
export * from './iam/access-policies.ts';
export * from './iam/scim.ts';
export * from './user-pools.ts';
export * from './user-pool-engine.ts';
export * from './identity-desired.ts';
export * from './platform-iam.ts';
export * from './service-accounts.ts';
export * from './access-keys.ts';
export * from './projects.ts';
export * from './releases.ts';
export * from './deployments.ts';
export * from './uploads.ts';
export * from './nodes.ts';
export * from './access.ts';
export * from './deploy.ts';
export * from './maintenance.ts';
export * from './failover-service.ts';
export * from './node-drills.ts';
export * from './scheduling-service.ts';
export * from './node-rollouts.ts';
export * from './node-rollout-plan.ts';
export * from './link-service.ts';
export * from './scaling-service.ts';
export * from './relocation-service.ts';
export * from './ha-service.ts';
export * from './ha-preflight.ts';
export * from './telemetry-spool-gaps.ts';
export * from './rebalance.ts';
export * from './secrets.ts';
export * from './metrics.ts';
export * from './metrics-export.ts';
export * from './server-errors.ts';
export * from './app-errors.ts';
export * from './sentry.ts';
export * from './usage-analytics.ts';
export * from './whats-new.ts';
export * from './platform-policies.ts';
export * from './observability.ts';
export * from './observability-query.ts';
export * from './alerts.ts';
export * from './clickhouse.ts';
export * from './placement.ts';
export * from './workloads.ts';
export * from './functions.ts';
export * from './runtime-tier.ts';
export * from './github-runners.ts';
export * from './github-app.ts';
export * from './github-import.ts';
export * from './forges/index.ts';
export * from './templates.ts';
export * from './databases.ts';
export * from './database-studio.ts';
export * from './container-console.ts';
export * from './cloud-shells.ts';
export * from './storage-instances.ts';
export * from './brokers.ts';
export * from './kubernetes.ts';
export * from './kubernetes-manifests.ts';
export * from './kubernetes-api.ts';
export * from './email.ts';
export * from './events.ts';
export * from './node-tasks.ts';
export * from './jobs.ts';
export * from './connected-apps.ts';
export * from './domain-reconcile.ts';
export * from './disks.ts';
export * from './app-volumes.ts';
export * from './app-volume-lifecycle.ts';
export * from './service-moves.ts';
export * from './storage-objects.ts';
export * from './storage-s3.ts';
export * from './domains.ts';
export * from './builds.ts';
export * from './pipelines.ts';
export * from './pipeline-engine.ts';
export * from './registry-credentials.ts';
export * from './registry.ts';
export * from './registry-token.ts';
export * from './oci-client.ts';
export * from './logs.ts';
export * from './log-explorer.ts';
export * from './log-tail-bus.ts';
export * from './log-saved-queries.ts';
export * from './log-store/types.ts';
export * from './log-store/sqlite-sources.ts';
export * from './log-store/sqlite-compiler.ts';
export * from './log-store/sqlite-store.ts';
export * from './environments.ts';
export * from './source.ts';
export * from './notify.ts';
export * from './web-push.ts';
export * from './notify-chat.ts';
export * from './telemetry.ts';
export * from './operations/index.ts';
export * from './scheduler.ts';
export * from './flows/index.ts';
export * from './usage.ts';
export * from './service-actions.ts';
export * from './backup-targets.ts';
export * from './audit.ts';
export * from './log-drains.ts';
export * from './webhook-signature.ts';
export * from './upgrades.ts';
export * from './blueprints.ts';
export * from './config-export.ts';
export { ConfigImportService, parseDocument as parseConfigExportDocument } from './config-import/service.ts';

export interface CoreOptions {
	db: YoalDb;
	sqlite: Database;
	config: CoreConfig;
	/**
	 * The arbiter with conditional writes (HA-PLAN H21). Defaults to the object store when it
	 * implements `ConditionalStore`; tests inject `MemoryConditionalStore`. Without one, `sync`
	 * fails closed and no database lease is written.
	 */
	arbiter?: ConditionalStore | null;
	version?: string;
	/** Email DNS/Cloudflare seams (docs/EMAIL.md); defaults read `YOAL_CLOUDFLARE_*` and `YOAL_MAIL_DOMAIN`. */
	email?: EmailServiceOptions;
}

export interface Core {
	ctx: CoreContext;
	projects: ProjectService;
	releases: ReleaseService;
	deployments: DeploymentService;
	uploads: UploadService;
	nodes: NodeService;
	access: AccessService;
	deploy: DeployService;
	maintenance: MaintenanceService;
	serverErrors: ServerErrorService;
	/** The app-facing error tracker (docs/APP-ERRORS.md). */
	appErrors: AppErrorService;
	/** Optional Sentry forwarding for the errors above (docs/SERVER-ERRORS.md §6). */
	sentry: SentryService;
	/** Opt-in anonymous usage pings (docs/USAGE-ANALYTICS.md, D211). */
	usageAnalytics: UsageAnalyticsService;
	/** Post-update onboarding for platform admins (docs/WHATS-NEW.md, D212). */
	whatsNew: WhatsNewService;
	secrets: SecretService;
	metrics: MetricsService;
	metricsExport: MetricsExporter;
	policies: PlatformPolicyService;
	observability: ObservabilityService;
	alerts: AlertService;
	workloads: WorkloadService;
	databases: DatabaseService;
	databaseStudio: DatabaseStudioService;
	containerConsole: ContainerConsoleService;
	cloudShells: CloudShellService;
	storage: StorageService;
	brokers: BrokerService;
	kubernetes: KubernetesService;
	events: EventService;
	nodeTasks: NodeTaskService;
	/** App cron jobs and one-off commands (plan 09). */
	jobs: JobService;
	/** MCP/OAuth clients users have approved (Settings → Connected apps). */
	connectedApps: ConnectedAppService;
	/** Disks and default storage (docs/STORAGE.md, D169). */
	disks: DiskService;
	appVolumes: AppVolumeService;
	moves: ServiceMoveService;
	storageObjects: StorageObjectsService;
	domains: DomainService;
	builds: BuildService;
	pipelines: PipelineService;
	logs: LogService;
	/** The Logs Explorer (docs/LOGS.md): `/api/v1/logs/*`, live tail and saved queries. */
	logExplorer: LogExplorerService;
	environments: EnvironmentService;
	source: SourceService;
	audit: AuditService;
	operations: OperationService;
	blueprints: BlueprintService;
	scheduler: SchedulerService;
	flows: FlowService;
	serviceActions: ServiceActionsService;
	backupTargets: BackupTargetService;
	usage: UsageService;
	upgrades: UpgradeService;
	githubRunners: GithubRunnerService;
	/** Yoal's GitHub App (docs/GITHUB.md). */
	githubApp: GithubAppService;
	/** Deploy from Git (docs/GITHUB.md §9, docs/FORGES.md §7). */
	githubImport: GithubImportService;
	/** GitLab, Gitea and Forgejo connections (docs/FORGES.md). */
	forges: ForgeService;
	/** One door to every git provider (docs/FORGES.md §5). */
	git: GitProviders;
	templates: TemplateService;
	/** Functions: Workers-compatible workloads on workerd (D110). */
	functions: FunctionService;
	/** Fleet topology and blast radius (CLUSTERING §3.6, C0). */
	topology: TopologyService;
	/** Cross-node service endpoints (CLUSTERING §4.3, C2). */
	endpoints: ServiceEndpointService;
	/** The per-install CA for endpoint mTLS (HA-PLAN H24). */
	nodeCa: NodeCaService;
	/** Cluster shares (CLUSTERING §5.2, C3). */
	shares: ShareService;
	/** Credentials for external container registries (docs/REGISTRY.md R2). */
	registryCredentials: RegistryCredentialService;
	/** The platform container registry (docs/REGISTRY.md G1). */
	registry: RegistryService;
	/** Managed database replicas (CLUSTERING §9.2, C7). */
	databaseReplicas: DatabaseReplicaService;
	/** Public database access from outside Yoal (docs/DATABASES.md §19, D241). */
	databasePublicAccess: DatabasePublicAccessService;
	/** Bucket replication (CLUSTERING §10.2, C9). */
	storageReplication: StorageReplicationService;
	/** Ingress HA status (CLUSTERING §7, C5). */
	ingress: IngressHaService;
	/** The failover controller (CLUSTERING §8.3, §9.3, C8). */
	failover: FailoverService;
	/** Node offline drills (D235). */
	nodeDrills: NodeDrillService;
	/** Fleet scheduling: utilisation, rebalance and workload moves (CLUSTERING §3.10). */
	scheduling: SchedulingService;
	/** Fleet node updates in waves (CLUSTERING §3.11, D217). */
	nodeRollouts: NodeRolloutService;
	/** Measured links between nodes (CLUSTERING §4.6). */
	links: NodeLinkService;
	/** Mesh mode's direct node pairs (CLUSTERING §4.7). */
	overlayMesh: OverlayMeshService;
	/** Horizontal scaling per app (SCALING.md). */
	scaling: ScalingService;
	/** Release commands: the run lease on a release id (HA-PLAN H25, I16). */
	releaseCommands: ReleaseCommandScheduler;
	/** Moving an app together with its app volumes (SCALING §7). */
	relocations: RelocationService;
	/** Cluster tunables (CLUSTERING). */
	cluster: ClusterConfigService;
	/** The HA profile and movable platform dependencies (HA-PLAN H27/H28, W12). */
	ha: HaService;
	regions: RegionService;
	haInit: HaInitService;
	haDoctor: HaDoctorService;
	haDrills: HaDrillRunner;
	/** Telemetry spool gaps agents report (HA-PLAN H28, W12). */
	telemetrySpool: TelemetrySpoolGapService;
	ingressSet: IngressSetService;
	steering: SteeringService;
	certificates: CertificateService;
	controlPlane: ControlPlaneService;
	databaseMembers: DatabaseMemberService;
	/** Per-database automatic failover policy and drills (HA-PLAN W11, Wave 4). */
	failoverPolicies: DatabaseFailoverPolicyService;
	/** SLO objects, error budgets and burn alerts (HA-PLAN W15, Wave 4). */
	slos: SloService;
	/** The external prober's report sink (HA-PLAN W15, Wave 4). */
	externalProber: ExternalProberService;
	/** Identity and access management (IAM.md I1). */
	iam: IamService;
	/** Guardrails and just-in-time access (IAM.md I11/I22, §9.2–§9.4). */
	governance: GovernanceService;
	/** Per-organisation sign-in policy (IAM.md I21, §8.5). */
	authPolicy: AuthPolicyService;
	/** Platform roles and bindings at `{ type: 'platform' }` (IAM.md I24, D129). */
	platformIam: PlatformIamService;
	/** Service accounts: org-owned machine principals (`sa_…`, IAM.md I13). */
	serviceAccounts: ServiceAccountService;
	/** Org-bound access keys and their verification (IAM.md I14). */
	accessKeys: AccessKeyService;
	/** Federation trusts that map an OIDC issuer to a service account (IAM.md I17). */
	federation: FederationTrustService;
	/** The platform signing-key ring: one issuer and one JWKS for every token (IAM.md I15). */
	signingKeys: SigningKeyService;
	/** Per-workload service accounts and tokens (IAM.md I18, §7.4). */
	workloadIdentity: WorkloadIdentityService;
	/** RFC 8693 token exchange against federation trusts (IAM.md I16–I17). */
	sts: TokenService;
	/** Yoal Access policies (IAM.md I25). */
	accessPolicies: AccessPolicyService;
	/** Managed user pools: OIDC clients and discovery for tenant apps (IAM.md I26–I29). */
	userPools: UserPoolService;
	/** Native user-pool engine: pool users, sessions and OIDC code flow (I27). */
	userPoolEngine: UserPoolEngineService;
	/** SCIM bearer tokens and directory reconciliation (IAM.md I20). */
	scim: ScimTokenService;
	/** Email: Yoal's self-hosted SES (docs/EMAIL.md). */
	email: EmailService;
	/** Log drains: forward stored log lines to webhooks and OTLP receivers (DESIGN §8). */
	logDrains: LogDrainService;
	/** Read-only snapshot of an org's configuration, secrets by name only (OPERATIONS.md §13). */
	configExport: ConfigExportService;
	/** Recreate a config export on this instance; create-only (OPERATIONS.md §14). */
	configImport: ConfigImportService;
}

function defaultEmailOptions(): EmailServiceOptions {
	const cloudflare = cloudflareConfigFromEnv();
	return {
		cloudflare: cloudflare ? new HttpCloudflareClient(cloudflare) : null,
		cloudflareZoneName: cloudflare?.zoneName ?? null,
		mailDomain: process.env.YOAL_MAIL_DOMAIN?.trim() || null
	};
}

/**
 * The one service layer every surface calls (DESIGN §3.2): dashboard, REST, MCP and CLI get
 * identical permission checks and behaviour.
 */
export function createCore(options: CoreOptions): Core {
	const ctx = {
		db: options.db,
		sqlite: options.sqlite,
		config: options.config,
		objectStore: options.config.objectStore,
		arbiter:
			options.arbiter ??
			('readVersioned' in options.config.objectStore && 'writeConditional' in options.config.objectStore
				? (options.config.objectStore as unknown as ConditionalStore)
				: null),
		notifiers: options.config.notifiers ?? [],
		now: options.config.now ?? (() => Date.now())
	} as unknown as CoreContext;

	ctx.policies = new PlatformPolicyService(ctx);
	ctx.audit = new AuditService(ctx);
	ctx.iam = new IamService(ctx);
	ctx.governance = new GovernanceService(ctx);
	ctx.authPolicy = new AuthPolicyService(ctx);
	ctx.serverErrors = new ServerErrorService(ctx, options.version ?? null);
	ctx.appErrors = new AppErrorService(ctx, options.version ?? null);
	ctx.sentry = new SentryService(ctx);
	ctx.usageAnalytics = new UsageAnalyticsService(ctx, { version: options.version ?? '0.0.0' });
	ctx.whatsNew = new WhatsNewService(ctx, { version: options.version ?? '0.0.0' });
	ctx.platformIam = new PlatformIamService(ctx);
	// Seed `platform-admin` from the Better Auth admin flag once, best effort. A boot before Better
	// Auth's tables exist is covered by `sync(userId)` on demand; this is not a schema migration.
	ctx.platformIam.syncAll();
	// The prune action authorises before a RunContext exists, so it reads the platform service the
	// core was built with. (Action definitions in this codebase are module-level singletons.)
	configurePrunePlatformIam(ctx.platformIam);
	ctx.serviceAccounts = new ServiceAccountService(ctx);
	ctx.accessKeys = new AccessKeyService(ctx);
	ctx.federation = new FederationTrustService(ctx);
	ctx.signingKeys = new SigningKeyService(ctx);
	ctx.workloadIdentity = new WorkloadIdentityService(ctx);
	ctx.sts = new TokenService(ctx);
	ctx.accessPolicies = new AccessPolicyService(ctx);
	ctx.userPools = new UserPoolService(ctx);
	ctx.userPoolEngine = new UserPoolEngineService(ctx);
	ctx.scim = new ScimTokenService(ctx);
	ctx.quota = new QuotaService(ctx);
	ctx.projects = new ProjectService(ctx);
	ctx.releases = new ReleaseService(ctx);
	ctx.deployments = new DeploymentService(ctx);
	ctx.uploads = new UploadService(ctx);
	ctx.nodes = new NodeService(ctx);
	ctx.access = new AccessService(ctx);
	ctx.environments = new EnvironmentService(ctx);
	ctx.secrets = new SecretService(ctx);
	ctx.workloads = new WorkloadService(ctx);
	ctx.databases = new DatabaseService(ctx);
	ctx.databaseStudio = new DatabaseStudioService(ctx);
	ctx.containerConsole = new ContainerConsoleService(ctx);
	ctx.cloudShells = new CloudShellService(ctx);
	ctx.storage = new StorageService(ctx);
	ctx.brokers = new BrokerService(ctx);
	ctx.kubernetes = new KubernetesService(ctx);
	ctx.email = new EmailService(ctx, options.email ?? defaultEmailOptions());
	// Pool mail (verification, magic link, reset and invite) uses the platform's sender or the
	// mail node; tests replace this hook with a capture.
	ctx.userPoolMail = createUserPoolMailer(ctx);
	ctx.events = new EventService(ctx);
	ctx.nodeTasks = new NodeTaskService(ctx);
	ctx.jobs = new JobService(ctx);
	ctx.disks = new DiskService(ctx);
	ctx.appVolumes = new AppVolumeService(ctx);
	ctx.moves = new ServiceMoveService(ctx);
	ctx.storageObjects = new StorageObjectsService(ctx);
	ctx.domains = new DomainService(ctx);
	ctx.logs = new LogService(ctx);
	ctx.logExplorer = new LogExplorerService(ctx);
	ctx.builds = new BuildService(ctx);
	ctx.pipelines = new PipelineService(ctx);
	ctx.operations = createOperationService(ctx);
	ctx.blueprints = new BlueprintService(ctx);
	ctx.scheduler = new SchedulerService(ctx);
	ctx.flows = new FlowService(ctx);
	ctx.serviceActions = new ServiceActionsService(ctx);
	ctx.backupTargets = new BackupTargetService(ctx);
	ctx.usage = new UsageService(ctx);
	ctx.upgrades = new UpgradeService(ctx, {
		platformVersion: options.version ?? '0.0.0',
		agentVersion: options.config.desiredAgentVersion ?? null
	});
	ctx.githubRunners = new GithubRunnerService(ctx);
	ctx.githubApp = new GithubAppService(ctx);
	ctx.githubImport = new GithubImportService(ctx);
	ctx.forges = new ForgeService(ctx);
	ctx.git = new GitProviders(ctx);
	ctx.templates = new TemplateService(ctx);
	ctx.functions = new FunctionService(ctx);
	ctx.topology = new TopologyService(ctx);
	ctx.endpoints = new ServiceEndpointService(ctx);
	ctx.databasePublicAccess = new DatabasePublicAccessService(ctx);
	ctx.nodeCa = new NodeCaService(ctx);
	ctx.shares = new ShareService(ctx);
	ctx.registryCredentials = new RegistryCredentialService(ctx);
	ctx.registry = new RegistryService(ctx);
	ctx.databaseReplicas = new DatabaseReplicaService(ctx);
	ctx.storageReplication = new StorageReplicationService(ctx);
	ctx.ingress = new IngressHaService(ctx);
	ctx.failover = new FailoverService(ctx);
	ctx.nodeDrills = new NodeDrillService(ctx);
	ctx.scheduling = new SchedulingService(ctx);
	ctx.nodeRollouts = new NodeRolloutService(ctx);
	ctx.links = new NodeLinkService(ctx);
	ctx.overlayMesh = new OverlayMeshService(ctx);
	ctx.scaling = new ScalingService(ctx);
	ctx.releaseCommands = new ReleaseCommandScheduler(ctx);
	ctx.relocations = new RelocationService(ctx);
	ctx.cluster = new ClusterConfigService(ctx);
	ctx.telemetrySpool = new TelemetrySpoolGapService(ctx);
	ctx.ha = new HaService(ctx);
	ctx.regions = new RegionService(ctx);
	ctx.haInit = new HaInitService(ctx);
	ctx.haDoctor = new HaDoctorService(ctx);
	ctx.haDrills = new HaDrillRunner(ctx);
	ctx.ingressSet = new IngressSetService(ctx);
	// Lane E's driver needs the core context (provider, probes, persisted streaks), so it is
	// registered here rather than in the context-free registry.
	ctx.steering = new SteeringService(ctx, {
		...STEERING_DRIVER_FACTORIES,
		'dns-failover': () => createDnsFailoverDriver(ctx),
		// W8 lane E: both need the core context (a sealed secret, the ingress snapshot, a helper
		// transport), so the adapters live beside the driver and are registered here.
		vip: () => createVipDriverFromCore(ctx),
		webhook: () => createWebhookDriverFromCore(ctx),
	});
	ctx.certificates = new CertificateService(ctx);
	ctx.controlPlane = new ControlPlaneService(ctx);
	ctx.databaseMembers = new DatabaseMemberService(ctx);
	ctx.failoverPolicies = new DatabaseFailoverPolicyService(ctx);
	ctx.slos = new SloService(ctx);
	ctx.externalProber = new ExternalProberService(ctx);
	// Flow definitions register once every service exists, so their steps can call any of them.
	ctx.flows.register(ctx.moves.databaseMoveFlow());
	ctx.flows.register(ctx.nodeRollouts.rolloutFlow());
	const source = new SourceService(ctx);

	const deploy = new DeployService(ctx);
	const maintenance = new MaintenanceService(ctx);
	const secrets = ctx.secrets;
	const metrics = new MetricsService(ctx, options.version);
	ctx.metricsExport = new MetricsExporter(ctx, () => metrics.platformLines());
	const observability = new ObservabilityService(ctx);
	ctx.alerts = new AlertService(ctx, observability);

	const core: Omit<Core, 'configExport' | 'configImport'> = {
		ctx,
		projects: ctx.projects,
		releases: ctx.releases,
		deployments: ctx.deployments,
		uploads: ctx.uploads,
		nodes: ctx.nodes,
		access: ctx.access,
		deploy,
		maintenance,
		secrets,
		metrics,
		metricsExport: ctx.metricsExport,
		policies: ctx.policies,
		observability,
		alerts: ctx.alerts,
		workloads: ctx.workloads,
		databases: ctx.databases,
		databaseStudio: ctx.databaseStudio,
		containerConsole: ctx.containerConsole,
		cloudShells: ctx.cloudShells,
		storage: ctx.storage,
		brokers: ctx.brokers,
		kubernetes: ctx.kubernetes,
		email: ctx.email,
		events: ctx.events,
		nodeTasks: ctx.nodeTasks,
		jobs: ctx.jobs,
		connectedApps: new ConnectedAppService(ctx),
		disks: ctx.disks,
		appVolumes: ctx.appVolumes,
		moves: ctx.moves,
		storageObjects: ctx.storageObjects,
		domains: ctx.domains,
		builds: ctx.builds,
		pipelines: ctx.pipelines,
		logs: ctx.logs,
		logExplorer: ctx.logExplorer,
		environments: ctx.environments,
		source,
		audit: ctx.audit,
		operations: ctx.operations,
		blueprints: ctx.blueprints,
		scheduler: ctx.scheduler,
		flows: ctx.flows,
		serviceActions: ctx.serviceActions,
		backupTargets: ctx.backupTargets,
		usage: ctx.usage,
		upgrades: ctx.upgrades,
		githubRunners: ctx.githubRunners,
		githubApp: ctx.githubApp,
		githubImport: ctx.githubImport,
		forges: ctx.forges,
		git: ctx.git,
		templates: ctx.templates,
		functions: ctx.functions,
		topology: ctx.topology,
		endpoints: ctx.endpoints,
		nodeCa: ctx.nodeCa,
		shares: ctx.shares,
		registryCredentials: ctx.registryCredentials,
		registry: ctx.registry,
		databaseReplicas: ctx.databaseReplicas,
		databasePublicAccess: ctx.databasePublicAccess,
		storageReplication: ctx.storageReplication,
		ingress: ctx.ingress,
		failover: ctx.failover,
		nodeDrills: ctx.nodeDrills,
		scheduling: ctx.scheduling,
		nodeRollouts: ctx.nodeRollouts,
		links: ctx.links,
		overlayMesh: ctx.overlayMesh,
		scaling: ctx.scaling,
		releaseCommands: ctx.releaseCommands,
		relocations: ctx.relocations,
		cluster: ctx.cluster,
		ha: ctx.ha,
		regions: ctx.regions,
		haInit: ctx.haInit,
		haDoctor: ctx.haDoctor,
		haDrills: ctx.haDrills,
		telemetrySpool: ctx.telemetrySpool,
		ingressSet: ctx.ingressSet,
		steering: ctx.steering,
		certificates: ctx.certificates,
		controlPlane: ctx.controlPlane,
		databaseMembers: ctx.databaseMembers,
		failoverPolicies: ctx.failoverPolicies,
		slos: ctx.slos,
		externalProber: ctx.externalProber,
		iam: ctx.iam,
		governance: ctx.governance,
		authPolicy: ctx.authPolicy,
		serverErrors: ctx.serverErrors,
		appErrors: ctx.appErrors,
		sentry: ctx.sentry,
		usageAnalytics: ctx.usageAnalytics,
		whatsNew: ctx.whatsNew,
		platformIam: ctx.platformIam,
		serviceAccounts: ctx.serviceAccounts,
		accessKeys: ctx.accessKeys,
		federation: ctx.federation,
		signingKeys: ctx.signingKeys,
		workloadIdentity: ctx.workloadIdentity,
		sts: ctx.sts,
		accessPolicies: ctx.accessPolicies,
		userPools: ctx.userPools,
		userPoolEngine: ctx.userPoolEngine,
		scim: ctx.scim,
		logDrains: new LogDrainService(ctx, options.version)
	};
	return {
		...core,
		configExport: new ConfigExportService(core, options.version ?? '0.0.0'),
		configImport: new ConfigImportService(core)
	};
}
