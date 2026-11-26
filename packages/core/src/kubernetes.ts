import { and, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import {
	brokers,
	databases,
	k8sAccessKeys,
	k8sAttachments,
	k8sBackups,
	k8sClusters,
	k8sPodLogs,
	k8sLogEvents,
	k8sMachines,
	k8sRoutes,
	k8sTrustedOrgs,
	nodes,
} from '@yoal/db';
import {
	DEFAULT_KUBERNETES_MINOR,
	KUBERNETES_DEFAULT_CPUS,
	KUBERNETES_DEFAULT_MEMORY_MB,
	WG_SUBNETS_CAPABILITY,
	kubernetesImageForRelease,
	kubernetesLogIngestSchema,
	kubernetesMinorOf,
	kubernetesRestoreSchema,
	machineSubnetFor,
	type KubernetesBackupResult,
	type KubernetesBackupTask,
	type KubernetesBackupView,
	type KubernetesApplyResult,
	type KubernetesPodLogLine,
	type KubernetesRestore,
	KUBERNETES_API_PORT_MAX,
	KUBERNETES_API_PORT_MIN,
	KUBERNETES_CAPABILITY,
	KUBERNETES_CLUSTER_ID_PREFIX,
	KUBERNETES_DEDICATED_LABEL,
	KUBERNETES_GROUP_ROLES,
	KUBERNETES_GROUPS,
	KUBERNETES_GROUPS_CLAIM,
	KUBERNETES_INGRESS_PORT_MAX,
	KUBERNETES_INGRESS_PORT_MIN,
	KUBERNETES_MACHINE_ID_PREFIX,
	KUBERNETES_TOKEN_ENV,
	KUBERNETES_TRAEFIK_MANIFEST,
	KUBERNETES_TOKEN_TTL_SECONDS,
	KUBERNETES_TRUSTED_CAPABILITY,
	KUBERNETES_USERNS_CAPABILITY,
	canAdministerPlatform,
	kubernetesAccessKeyCreateSchema,
	kubernetesApiHost,
	kubernetesAttachSchema,
	kubernetesAudience,
	kubernetesCreateSchema,
	kubernetesDisplayVersion,
	kubernetesGroupsFor,
	kubernetesMachineAlias,
	kubernetesRouteCreateSchema,
	kubernetesUpdateSchema,
	kubernetesVersion,
	kubernetesVersions,
	nextKubernetesMinor,
	orgNetworkName,
	parseKubernetesDedication,
	renderExecKubeconfig,
	renderTokenKubeconfig,
	type KubernetesAccessKeyCreate,
	type KubernetesAccessKeySecret,
	type KubernetesAccessKeyView,
	type KubernetesAccessRole,
	type KubernetesAttach,
	type KubernetesAttachmentView,
	type KubernetesClusterView,
	type KubernetesComponentReport,
	type KubernetesComponentRequest,
	type KubernetesComponentResult,
	type KubernetesComponentView,
	type KubernetesCreate,
	type KubernetesKubeconfig,
	type KubernetesMachineView,
	type KubernetesRoute,
	type KubernetesRouteCreate,
	type KubernetesRouteView,
	type KubernetesStatus,
	type KubernetesStatusSample,
	type KubernetesTier,
	type KubernetesToken,
	type KubernetesUpdate,
	type Permission,
	type Principal,
	type ResourceRef,
	type WorkloadActivation,
	type WorkloadDesired,
	type WorkloadStatus,
} from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import { messageRowAccess } from './log-ingest-guard.ts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { resolvePlacement, type PlacementCandidate } from './placement.ts';
import type { DiskRow } from './disks.ts';
import { newId, parseJson, randomBytes, safeEqual, sha256Hex } from './util.ts';
import { lintManifests, type Manifest, type ManifestContext } from './kubernetes-manifests.ts';
import { KubernetesApiClient, type KubernetesFetch } from './kubernetes-api.ts';

export type KubernetesClusterRow = typeof k8sClusters.$inferSelect;
export type KubernetesMachineRow = typeof k8sMachines.$inferSelect;

const ACTIVE: KubernetesStatus[] = ['pending', 'starting', 'running', 'degraded'];
/** Presigned snapshot URLs live this long; a stuck snapshot fails after six hours. */
const BACKUP_TASK_TTL_SECONDS = 6 * 60 * 60;
const BACKUP_STUCK_MS = 6 * 60 * 60_000;
/** A moved machine must be running again within this, or the rollout rolls back (K15). */
const ROLLOUT_MACHINE_TIMEOUT_MS = 15 * 60_000;
/** A cluster unhealthy this long raises an alert. */
const ALERT_AFTER_MS = 10 * 60_000;
/** Names the REST surface uses beside `/kubernetes/<name>`. */
const RESERVED_NAMES = new Set(['nodes', 'components', 'trusted-orgs', 'tokens']);
/** Signing-key purpose for 15-minute cluster tokens (K8); rotated by the monthly sweep. */
export const KUBERNETES_SIGNING_PURPOSE = 'kubernetes';
/**
 * Access keys (K19) are long-lived, so they get their own purpose that is never rotated
 * automatically: a rotation retires the key after a day and every access key signed by it with it.
 */
export const KUBERNETES_KEYS_SIGNING_PURPOSE = 'kubernetes-keys';
/** Access keys are long-lived; their RBAC binding (not the token) is what revocation removes. */
const ACCESS_KEY_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;
/** Restarts before a machine counts as failed (as brokers). */
const RESTART_LIMIT = 5;
/** The node component status sample is stale after this long. */
const STATUS_STALE_MS = 5 * 60_000;

/**
 * Managed Kubernetes clusters (docs/KUBERNETES.md). A cluster is an org resource whose k3s
 * machines run as helper-profiled containers on nodes that have the optional component. Placement
 * and admission happen once at create time (D41); the join token is sealed (D18) and reaches the
 * machines only through activation; access is Yoal-issued tokens mapped to in-cluster groups (K8,
 * K9); public paths are Caddy routes to loopback listeners (K7, K11, D56).
 */
export class KubernetesService {
	constructor(private readonly ctx: CoreContext) {}

	// ---------------------------------------------------------------- reads

	list(principal: Principal, options: { includeDeleted?: boolean } = {}): KubernetesClusterView[] {
		const filters = [eq(k8sClusters.orgId, principal.orgId)];
		if (!options.includeDeleted) filters.push(isNull(k8sClusters.deletedAt));
		const orgWide = this.ctx.iam.can(principal, 'kubernetes:read', { type: 'org' });
		return this.ctx.db
			.select()
			.from(k8sClusters)
			.where(and(...filters))
			.all()
			.filter((row) => orgWide || this.can(principal, 'kubernetes:read', row))
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((row) => this.toView(row));
	}

	get(principal: Principal, name: string, options: { includeDeleted?: boolean } = {}): KubernetesClusterView {
		const row = this.requireRow(principal, name, options);
		this.require(principal, 'kubernetes:read', row);
		return this.toView(row);
	}

	requireRow(principal: Principal, name: string, options: { includeDeleted?: boolean } = {}): KubernetesClusterRow {
		const row = this.ctx.db
			.select()
			.from(k8sClusters)
			.where(and(eq(k8sClusters.orgId, principal.orgId), eq(k8sClusters.name, name)))
			.get();
		if (!row || (row.deletedAt && !options.includeDeleted)) throw new NotFoundError(`Kubernetes cluster "${name}"`);
		return row;
	}

	/** Nodes that can run clusters, with the tiers each offers (for the create form). */
	capableNodes(principal: Principal): Array<{ id: string; name: string; tiers: KubernetesTier[]; dedicatedTo: string | null }> {
		this.ctx.iam.require(principal, 'kubernetes:read', { type: 'org' });
		return this.ctx.db
			.select()
			.from(nodes)
			.all()
			.filter((node) => parseJson<string[]>(node.capabilitiesJson, []).includes(KUBERNETES_CAPABILITY))
			.map((node) => {
				const caps = parseJson<string[]>(node.capabilitiesJson, []);
				const labels = parseJson<Record<string, string>>(node.labelsJson, {});
				const dedication = parseKubernetesDedication(labels[KUBERNETES_DEDICATED_LABEL]);
				return {
					id: node.id,
					name: node.name,
					tiers: tiersOf(caps),
					dedicatedTo: dedication ? (dedication.orgId ?? 'platform') : null,
				};
			})
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	// ---------------------------------------------------------------- node component (K2)

	/** The component on every node, for Nodes → Components and the Kubernetes settings page. */
	components(principal: Principal): KubernetesComponentView[] {
		if (!canAdministerPlatform(principal) && principal.platformAdmin !== true)
			throw new CoreError('forbidden', 'Platform admins only.', 403);
		const machineCounts = new Map<string, number>();
		for (const machine of this.ctx.db.select().from(k8sMachines).where(isNull(k8sMachines.removedAt)).all())
			machineCounts.set(machine.nodeId, (machineCounts.get(machine.nodeId) ?? 0) + 1);
		return this.ctx.db
			.select()
			.from(nodes)
			.all()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((node) => {
				const report = this.setting<KubernetesComponentReport>(`kubernetes.component.report.${node.id}`);
				const request = this.setting<KubernetesComponentRequest & { requestedAt: number }>(`kubernetes.component.request.${node.id}`);
				const result = this.setting<KubernetesComponentResult & { action: 'install' | 'remove'; at: number }>(
					`kubernetes.component.result.${node.id}`,
				);
				const labels = parseJson<Record<string, string>>(node.labelsJson, {});
				const dedication = parseKubernetesDedication(labels[KUBERNETES_DEDICATED_LABEL]);
				return {
					nodeId: node.id,
					nodeName: node.name,
					installed: Boolean(report && !report.error && report.minors.length > 0),
					minors: report?.minors ?? [],
					tiers: report?.tiers ?? [],
					error: report?.error ?? null,
					pending: request ? { action: request.action, requestedAt: iso(request.requestedAt) } : null,
					lastResult: result ? { action: result.action, ok: result.ok, message: result.message, at: iso(result.at) } : null,
					dedicatedTo: dedication ? (dedication.orgId ?? 'platform') : null,
					machines: machineCounts.get(node.id) ?? 0,
				};
			});
	}

	/** Ask a node to install or remove the component. Platform admins, interactive sessions only. */
	requestComponent(principal: Principal, nodeId: string, action: 'install' | 'remove', purge = false): KubernetesComponentView {
		if (!canAdministerPlatform(principal)) throw new CoreError('forbidden', 'Platform admins only (dashboard session).', 403);
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node) throw new NotFoundError('Node');
		if (action === 'remove') {
			const machines = this.ctx.db
				.select({ id: k8sMachines.id })
				.from(k8sMachines)
				.where(and(eq(k8sMachines.nodeId, nodeId), isNull(k8sMachines.removedAt)))
				.all();
			if (machines.length > 0)
				throw new ConflictError(`Node "${node.name}" still runs ${machines.length} Kubernetes machine(s). Delete their clusters first.`);
		}
		const request = { id: newId('kcr_'), action, purge, requestedAt: this.ctx.now() };
		this.putSetting(`kubernetes.component.request.${nodeId}`, request);
		this.ctx.audit.record({
			principal,
			action: `kubernetes.component.${action}`,
			resource: 'node',
			resourceId: nodeId,
			args: { node: node.name, purge },
			result: 'ok',
		});
		this.ctx.projects.bump();
		return this.components(principal).find((item) => item.nodeId === nodeId)!;
	}

	componentRequestForNode(nodeId: string): KubernetesComponentRequest | null {
		const request = this.setting<KubernetesComponentRequest & { requestedAt: number }>(`kubernetes.component.request.${nodeId}`);
		return request ? { id: request.id, action: request.action, purge: request.purge } : null;
	}

	/** The component report from a heartbeat (absent = not installed). */
	applyComponentReport(nodeId: string, report: KubernetesComponentReport | undefined): void {
		const key = `kubernetes.component.report.${nodeId}`;
		const current = this.setting<KubernetesComponentReport>(key);
		if (!report) {
			if (current) this.deleteSetting(key);
			return;
		}
		if (JSON.stringify(current) !== JSON.stringify(report)) this.putSetting(key, report);
	}

	applyComponentResult(nodeId: string, result: KubernetesComponentResult): void {
		const key = `kubernetes.component.request.${nodeId}`;
		const request = this.setting<KubernetesComponentRequest & { requestedAt: number }>(key);
		if (!request || request.id !== result.id) return;
		this.deleteSetting(key);
		this.putSetting(`kubernetes.component.result.${nodeId}`, { ...result, action: request.action, at: this.ctx.now() });
		this.ctx.projects.bump();
	}

	private setting<T>(key: string): T | null {
		const row = this.ctx.sqlite.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(key);
		return row ? parseJson<T | null>(row.value, null) : null;
	}

	private putSetting(key: string, value: unknown): void {
		this.ctx.sqlite
			.query('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
			.run(key, JSON.stringify(value), this.ctx.now());
	}

	private deleteSetting(key: string): void {
		this.ctx.sqlite.query('DELETE FROM settings WHERE key = ?').run(key);
	}

	// ---------------------------------------------------------------- trusted tier grants (K4)

	trustedOrgs(principal: Principal): Array<{ orgId: string; grantedBy: string; grantedAt: string }> {
		if (!canAdministerPlatform(principal)) throw new CoreError('forbidden', 'Platform admins only.', 403);
		return this.ctx.db
			.select()
			.from(k8sTrustedOrgs)
			.all()
			.map((row) => ({ orgId: row.orgId, grantedBy: row.grantedBy, grantedAt: iso(row.grantedAt) }));
	}

	/** Let an org's clusters use the `trusted` tier, where a cluster admin can become root on its dedicated node. */
	grantTrusted(principal: Principal, orgId: string): void {
		if (!canAdministerPlatform(principal)) throw new CoreError('forbidden', 'Platform admins only.', 403);
		this.ctx.db
			.insert(k8sTrustedOrgs)
			.values({ orgId, grantedBy: principal.userId, grantedAt: this.ctx.now() })
			.onConflictDoNothing()
			.run();
		this.ctx.audit.record({
			principal,
			action: 'kubernetes.trusted.grant',
			resource: 'org',
			resourceId: orgId,
			args: { orgId },
			result: 'ok',
		});
	}

	revokeTrusted(principal: Principal, orgId: string): void {
		if (!canAdministerPlatform(principal)) throw new CoreError('forbidden', 'Platform admins only.', 403);
		const inUse = this.ctx.db
			.select({ name: k8sClusters.name })
			.from(k8sClusters)
			.where(and(eq(k8sClusters.orgId, orgId), eq(k8sClusters.tier, 'trusted'), isNull(k8sClusters.deletedAt)))
			.all();
		if (inUse.length > 0)
			throw new ConflictError(
				`The org still has trusted clusters (${inUse.map((row) => row.name).join(', ')}). Delete them first.`,
			);
		this.ctx.db.delete(k8sTrustedOrgs).where(eq(k8sTrustedOrgs.orgId, orgId)).run();
		this.ctx.audit.record({
			principal,
			action: 'kubernetes.trusted.revoke',
			resource: 'org',
			resourceId: orgId,
			args: { orgId },
			result: 'ok',
		});
	}

	// ---------------------------------------------------------------- lifecycle

	create(principal: Principal, raw: KubernetesCreate): KubernetesClusterView {
		this.ctx.iam.require(principal, 'kubernetes:create', { type: 'org' });
		this.requireFeature();
		const input = kubernetesCreateSchema.parse(raw);
		if (RESERVED_NAMES.has(input.name))
			throw new ValidationError(`"${input.name}" is reserved; pick another cluster name.`);
		const minor = input.version ?? DEFAULT_KUBERNETES_MINOR;
		const version = kubernetesVersion(minor);
		if (!version)
			throw new ValidationError(`Kubernetes versions: ${kubernetesVersions.map((item) => item.minor).join(', ')}.`);
		this.assertNameFree(principal.orgId, input.name);
		const layout = this.layout(principal, {
			placement: input.placement,
			nodes: input.nodes ?? null,
			servers: input.servers,
			agents: input.agents,
			memoryMb: input.memoryMb,
			tier: input.tier ?? null,
			storage: input.storage,
		});
		const production = input.purpose === 'production';
		const id = this.insertCluster(principal, {
			name: input.name,
			minor,
			release: version.release,
			purpose: input.purpose,
			layout,
			memoryMb: input.memoryMb,
			cpus: input.cpus,
			apiAccess: input.apiAccess,
			allowCidrs: input.allowCidrs,
			window: input.window ?? { hour: 3, hours: 2 },
			autoPatch: input.autoPatch,
			traefik: input.traefik,
			backupHours: input.backupHours ?? (production ? 1 : 24),
			backupRetentionDays: input.backupRetentionDays,
			shipper: input.shipper ?? production,
			tokenSecret: this.ctx.secrets.seal(principal.orgId, randomBytes(32).toString('base64url')),
			restoreBackupId: null,
		});
		this.ctx.audit.record({
			principal,
			action: 'kubernetes.create',
			resource: 'kubernetes',
			resourceId: id,
			args: {
				name: input.name,
				minor,
				tier: layout.tier,
				purpose: input.purpose,
				servers: input.servers,
				agents: input.agents,
				nodes: [...new Set(layout.machines.map((machine) => machine.nodeId))],
				memoryMb: input.memoryMb,
				apiAccess: input.apiAccess,
			},
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, input.name));
	}

	update(principal: Principal, name: string, raw: KubernetesUpdate): KubernetesClusterView {
		const row = this.requireRow(principal, name);
		this.require(principal, 'kubernetes:update', row);
		const patch = kubernetesUpdateSchema.parse(raw);
		const set: Partial<typeof k8sClusters.$inferInsert> = {};
		const notes: string[] = [];
		if (row.restoreBackupId) throw new ConflictError(`"${name}" is still being restored.`);

		if (patch.version !== undefined && patch.version !== row.minor) {
			const next = nextKubernetesMinor(row.minor);
			if (!kubernetesVersion(patch.version))
				throw new ValidationError(`Kubernetes versions: ${kubernetesVersions.map((item) => item.minor).join(', ')}.`);
			if (patch.version !== next)
				throw new ConflictError(
					next
						? `Kubernetes moves one minor at a time: ${row.minor} → ${next}. Downgrades are not possible.`
						: `Kubernetes ${row.minor} is the newest supported minor.`,
				);
			if (row.upgradeStartedAt) throw new ConflictError(`"${name}" is already rolling out ${row.release}; wait for it to finish.`);
			set.minor = patch.version;
			set.release = kubernetesVersion(patch.version)!.release;
			notes.push(`Upgrade ${row.minor} → ${patch.version} requested; a snapshot is taken first, then machines move one at a time.`);
		}
		const memoryMb = patch.memoryMb ?? row.memoryMb;
		const agents = patch.agents ?? row.agents;
		const machines = this.liveMachines(row.id);
		const multiNode = new Set(machines.map((machine) => machine.nodeId)).size > 1 || row.datastore === 'etcd';
		if (memoryMb > row.memoryMb || agents > row.agents) {
			// Growth is admitted per node: every machine on a node grows, new agents land on the server's node.
			const perNode = new Map<string, number>();
			for (const machine of machines) perNode.set(machine.nodeId, (perNode.get(machine.nodeId) ?? 0) + 1);
			if (agents > row.agents) perNode.set(row.nodeId, (perNode.get(row.nodeId) ?? 0) + (agents - row.agents));
			for (const [nodeId, count] of perNode) {
				const current = machines.filter((machine) => machine.nodeId === nodeId).length * row.memoryMb;
				this.admitOn(nodeId, count * memoryMb - current);
			}
			this.ctx.quota.assertCanAdmitMemory(row.orgId, null, memoryMb * (row.servers + agents) - row.memoryMb * (row.servers + row.agents));
		}
		if (patch.memoryMb !== undefined) set.memoryMb = patch.memoryMb;
		if (patch.cpus !== undefined) set.cpus = patch.cpus;
		if (patch.purpose !== undefined && patch.purpose !== row.purpose) {
			set.purpose = patch.purpose;
			// Production defaults (K22): hourly snapshots and log history, unless set explicitly.
			if (patch.purpose === 'production') {
				if (patch.backupHours === undefined && row.backupHours > 1) set.backupHours = 1;
				if (patch.shipper === undefined && !row.shipper) patch.shipper = true;
			}
		}
		if (patch.apiAccess !== undefined) set.apiAccess = patch.apiAccess;
		if (patch.allowCidrs !== undefined) set.allowCidrs = JSON.stringify(patch.allowCidrs);
		if (patch.window !== undefined) {
			set.windowHour = patch.window.hour;
			set.windowHours = patch.window.hours;
		}
		if (patch.autoPatch !== undefined) set.autoPatch = patch.autoPatch;
		if (patch.traefik !== undefined) set.traefik = patch.traefik;
		if (patch.backupHours !== undefined) set.backupHours = patch.backupHours;
		if (patch.backupRetentionDays !== undefined) set.backupRetentionDays = patch.backupRetentionDays;
		if (patch.logRetentionDays !== undefined) set.logRetentionDays = patch.logRetentionDays;
		if (patch.shipper !== undefined && patch.shipper !== row.shipper) {
			set.shipper = patch.shipper;
			if (patch.shipper && !row.shipperTokenSecret) {
				const token = randomBytes(32).toString('base64url');
				set.shipperTokenSecret = this.ctx.secrets.seal(row.orgId, token);
				set.shipperTokenHash = sha256Hex(token);
			}
			set.manifestsGeneration = row.manifestsGeneration + 1;
			notes.push(patch.shipper ? 'Log shipping turned on.' : 'Log shipping turned off.');
		}
		let convert = false;
		if (patch.servers === 3 && row.servers !== 3) {
			if ((patch.purpose ?? row.purpose) !== 'production')
				throw new ConflictError('Only production clusters can be made highly available. Set purpose to production first.');
			if (row.upgradeStartedAt) throw new ConflictError(`"${name}" is rolling out a release; wait for it to finish.`);
			convert = true;
		}

		const now = this.ctx.now();
		this.ctx.sqlite.transaction(() => {
			if (Object.keys(set).length > 0)
				this.ctx.db
					.update(k8sClusters)
					.set({ ...set, updatedAt: now })
					.where(eq(k8sClusters.id, row.id))
					.run();
			if (patch.agents !== undefined && patch.agents !== row.agents) {
				this.ctx.db.update(k8sClusters).set({ agents, updatedAt: now }).where(eq(k8sClusters.id, row.id)).run();
				const live = machines.filter((machine) => machine.role === 'agent');
				for (let ordinal = row.agents + 1; ordinal <= agents; ordinal++)
					this.insertMachine(row.orgId, row.id, 'agent', ordinal, row.nodeId, multiNode ? this.allocateOverlayIp(row.nodeId) : null, row.release);
				// Highest ordinals go first; their node objects are pruned by the next status sample.
				for (const machine of live.filter((item) => item.ordinal > agents))
					this.ctx.db
						.update(k8sMachines)
						.set({ removedAt: now, purgeRequestedAt: now, updatedAt: now })
						.where(eq(k8sMachines.id, machine.id))
						.run();
				notes.push(`Agents ${row.agents} → ${agents}.`);
			}
		})();
		if (convert) this.beginHaConversion(row);
		for (const note of notes) this.systemLog(row.id, row.orgId, row.nodeId, note);
		this.ctx.audit.record({
			principal,
			action: 'kubernetes.update',
			resource: 'kubernetes',
			resourceId: row.id,
			args: { name, ...patch },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, name));
	}

	private assertNameFree(orgId: string, name: string): void {
		const existing = this.ctx.db
			.select({ id: k8sClusters.id, deletedAt: k8sClusters.deletedAt })
			.from(k8sClusters)
			.where(and(eq(k8sClusters.orgId, orgId), eq(k8sClusters.name, name)))
			.get();
		if (existing)
			throw new ConflictError(
				existing.deletedAt
					? `Kubernetes cluster "${name}" is in the trash. Restore it or pick another name.`
					: `Kubernetes cluster "${name}" already exists.`,
			);
	}

	/** Insert a cluster and its machines from a resolved layout. */
	private insertCluster(
		principal: Principal,
		input: {
			name: string;
			minor: string;
			release: string;
			purpose: 'lab' | 'production';
			layout: ClusterLayout;
			memoryMb: number;
			cpus: number;
			apiAccess: 'public' | 'private';
			allowCidrs: string[];
			window: { hour: number; hours: number };
			autoPatch: boolean;
			traefik: boolean;
			backupHours: number;
			backupRetentionDays: number;
			shipper: boolean;
			tokenSecret: string;
			restoreBackupId: string | null;
			datastore?: 'sqlite' | 'etcd';
		},
	): string {
		const { layout } = input;
		const id = newId(KUBERNETES_CLUSTER_ID_PREFIX);
		const now = this.ctx.now();
		const shipperToken = input.shipper ? randomBytes(32).toString('base64url') : null;
		const servers = layout.machines.filter((machine) => machine.role === 'server');
		const agents = layout.machines.length - servers.length;
		this.ctx.sqlite.transaction(() => {
			this.ctx.db
				.insert(k8sClusters)
				.values({
					id,
					orgId: principal.orgId,
					name: input.name,
					minor: input.minor,
					release: input.release,
					tier: layout.tier,
					purpose: input.purpose,
					nodeId: servers[0]!.nodeId,
					diskId: layout.diskId,
					memoryMb: input.memoryMb,
					cpus: input.cpus,
					agents,
					servers: servers.length,
					datastore: input.datastore ?? (servers.length > 1 ? 'etcd' : 'sqlite'),
					apiPort: layout.apiPort,
					ingressPort: layout.ingressPort,
					apiAccess: input.apiAccess,
					allowCidrs: JSON.stringify(input.allowCidrs),
					windowHour: input.window.hour,
					windowHours: input.window.hours,
					autoPatch: input.autoPatch,
					traefik: input.traefik,
					backupHours: input.backupHours,
					backupRetentionDays: input.backupRetentionDays,
					nextBackupAt: now + input.backupHours * HOUR_MS,
					shipper: input.shipper,
					shipperTokenSecret: shipperToken ? this.ctx.secrets.seal(principal.orgId, shipperToken) : null,
					shipperTokenHash: shipperToken ? sha256Hex(shipperToken) : null,
					restoreBackupId: input.restoreBackupId,
					status: 'pending',
					tokenSecret: input.tokenSecret,
					createdBy: principal.userId,
					createdAt: now,
					updatedAt: now,
				})
				.run();
			for (const machine of layout.machines)
				this.insertMachine(principal.orgId, id, machine.role, machine.ordinal, machine.nodeId, machine.overlayIp, input.release);
		})();
		const nodesUsed = [...new Set(layout.machines.map((machine) => machine.nodeId))].length;
		this.systemLog(
			id,
			principal.orgId,
			servers[0]!.nodeId,
			`Cluster created on Kubernetes ${kubernetesDisplayVersion(input.release)} (${layout.tier} tier, ${servers.length} server${servers.length > 1 ? 's' : ''}, ${agents} agent${agents === 1 ? '' : 's'}, ${nodesUsed} node${nodesUsed > 1 ? 's' : ''}).`,
		);
		return id;
	}

	/**
	 * Where every machine goes (K5, K6). One node unless three servers or several nodes are asked
	 * for: then servers land on distinct nodes (different zones first), agents spread round-robin,
	 * and every machine gets a routed address from its node's machine subnet.
	 */
	private layout(
		principal: Principal,
		input: {
			placement: string;
			nodes: string[] | null;
			servers: number;
			agents: number;
			memoryMb: number;
			tier: KubernetesTier | null;
			storage?: string;
		},
	): ClusterLayout {
		const total = input.memoryMb * (input.servers + input.agents);
		const storageMb = 10_240 * (input.servers + input.agents);
		const multi = input.servers > 1 || (input.nodes !== null && new Set(input.nodes).size > 1);
		this.ctx.quota.assertCanAdmitMemory(principal.orgId, null, total);
		if (!multi) {
			const requested = input.nodes?.[0] ?? input.placement;
			const storage = this.ctx.disks.prepare({
				kind: 'kubernetes',
				storage: input.storage,
				requested,
				storageMb,
				edgeNodeId: this.ctx.workloads.edgeNode(),
				candidates: this.ctx.workloads.placementCandidates(),
			});
			const { nodeId, tier } = this.place(principal, storage.requested, total, input.tier, storage.candidates);
			const disk: DiskRow | null = this.ctx.disks.pick(storage.plan, nodeId, storageMb);
			const machines: LayoutMachine[] = [{ role: 'server', ordinal: 0, nodeId, overlayIp: null }];
			for (let ordinal = 1; ordinal <= input.agents; ordinal++) machines.push({ role: 'agent', ordinal, nodeId, overlayIp: null });
			return {
				tier,
				diskId: disk?.id ?? null,
				machines,
				apiPort: this.allocatePort([nodeId], 'api'),
				ingressPort: this.allocatePort([nodeId], 'ingress'),
			};
		}

		// Multi-node: every node needs the component, the same tier, an overlay address and a helper
		// that routes machine subnets.
		if (input.storage) throw new ValidationError('Multi-node clusters use each node\'s system disk for now; omit storage.');
		const eligible = this.eligibleNodes(principal, input.tier);
		let chosen: EligibleNode[];
		if (input.nodes && input.nodes.length > 0) {
			chosen = [...new Set(input.nodes)].map((nodeId) => {
				const node = eligible.all.find((item) => item.id === nodeId || item.name === nodeId);
				if (!node) throw new ValidationError(`Node "${nodeId}" cannot take new workloads.`);
				if (node.problem) throw new ValidationError(node.problem);
				return node;
			});
		} else {
			chosen = eligible.ok;
		}
		if (chosen.length < input.servers)
			throw new ValidationError(
				`Three servers need three nodes with the Kubernetes component; ${chosen.length} qualif${chosen.length === 1 ? 'ies' : 'y'}.${eligible.reasons[0] ? ` ${eligible.reasons[0]}` : ''}`,
			);
		const tier = commonTier(chosen, input.tier);
		if (!tier) throw new ValidationError('The chosen nodes have no isolation tier in common.');
		for (const node of chosen)
			if (!node.machineSubnet)
				throw new ValidationError(
					`Node "${node.name}" cannot run multi-node machines: it needs an overlay address and an agent that routes machine subnets (update it).`,
				);
		// Servers on distinct nodes, spreading zones first, then the most free memory.
		const free = new Map(this.ctx.workloads.capacityInternal().map((item) => [item.nodeId, item.freeMemoryMb]));
		const ordered = [...chosen].sort((a, b) => (free.get(b.id) ?? 0) - (free.get(a.id) ?? 0));
		const serverNodes: EligibleNode[] = [];
		const zones = new Set<string>();
		for (const node of ordered) if (serverNodes.length < input.servers && !zones.has(node.zone)) (serverNodes.push(node), zones.add(node.zone));
		for (const node of ordered) if (serverNodes.length < input.servers && !serverNodes.includes(node)) serverNodes.push(node);
		const machines: LayoutMachine[] = [];
		const reserved = new Map<string, Set<string>>();
		const ipOn = (node: EligibleNode) => {
			const taken = reserved.get(node.id) ?? new Set<string>();
			const ip = this.allocateOverlayIp(node.id, taken);
			taken.add(ip);
			reserved.set(node.id, taken);
			return ip;
		};
		serverNodes.forEach((node, ordinal) => machines.push({ role: 'server', ordinal, nodeId: node.id, overlayIp: ipOn(node) }));
		for (let ordinal = 1; ordinal <= input.agents; ordinal++) {
			const node = ordered[(ordinal - 1) % ordered.length]!;
			machines.push({ role: 'agent', ordinal, nodeId: node.id, overlayIp: ipOn(node) });
		}
		const perNode = new Map<string, number>();
		for (const machine of machines) perNode.set(machine.nodeId, (perNode.get(machine.nodeId) ?? 0) + input.memoryMb);
		for (const [nodeId, memoryMb] of perNode) this.admitOn(nodeId, memoryMb);
		const serverNodeIds = serverNodes.map((node) => node.id);
		return {
			tier,
			diskId: null,
			machines,
			apiPort: this.allocatePort(serverNodeIds, 'api'),
			ingressPort: this.allocatePort(serverNodeIds, 'ingress'),
		};
	}

	/** Soft delete (D59): machines stop, data dirs stay on the node for the trash window. */
	delete(principal: Principal, name: string): KubernetesClusterView {
		const row = this.requireRow(principal, name);
		this.require(principal, 'kubernetes:delete', row);
		const now = this.ctx.now();
		this.ctx.db
			.update(k8sClusters)
			.set({ deletedAt: now, purgeAt: now + this.ctx.policies.trashMs(), status: 'stopped', updatedAt: now })
			.where(eq(k8sClusters.id, row.id))
			.run();
		this.systemLog(row.id, row.orgId, row.nodeId, 'Cluster deleted; machines stop. Restore it before the trash window ends to keep its data.');
		this.ctx.audit.record({
			principal,
			action: 'kubernetes.delete',
			resource: 'kubernetes',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, name, { includeDeleted: true }));
	}

	restore(principal: Principal, name: string): KubernetesClusterView {
		const row = this.requireRow(principal, name, { includeDeleted: true });
		this.require(principal, 'kubernetes:delete', row);
		if (!row.deletedAt) return this.toView(row);
		if (row.purgeRequestedAt)
			throw new ConflictError(`Kubernetes cluster "${name}" is being purged and can no longer be restored.`);
		this.requireFeature();
		const total = row.memoryMb * (row.servers + row.agents);
		this.ctx.quota.assertCanAdmitMemory(principal.orgId, null, total);
		this.admit(row);
		this.ctx.db
			.update(k8sClusters)
			.set({ deletedAt: null, purgeAt: null, status: 'pending', message: null, updatedAt: this.ctx.now() })
			.where(eq(k8sClusters.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'kubernetes.restore',
			resource: 'kubernetes',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, name));
	}

	purgeNow(principal: Principal, name: string): void {
		const row = this.requireRow(principal, name, { includeDeleted: true });
		this.require(principal, 'kubernetes:delete', row);
		if (!row.deletedAt) throw new ConflictError(`Kubernetes cluster "${name}" must be deleted before it can be purged.`);
		const now = this.ctx.now();
		this.ctx.db
			.update(k8sClusters)
			.set({ purgeAt: now, purgeRequestedAt: now, updatedAt: now })
			.where(eq(k8sClusters.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'kubernetes.purge',
			resource: 'kubernetes',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
	}

	/** Maintenance sweep: hand expired trash to its node. */
	requestExpiredPurges(): number {
		const now = this.ctx.now();
		const due = this.ctx.db
			.select({ id: k8sClusters.id })
			.from(k8sClusters)
			.where(
				and(
					isNotNull(k8sClusters.deletedAt),
					isNotNull(k8sClusters.purgeAt),
					lte(k8sClusters.purgeAt, now),
					isNull(k8sClusters.purgeRequestedAt),
				),
			)
			.all();
		if (due.length === 0) return 0;
		this.ctx.db
			.update(k8sClusters)
			.set({ purgeRequestedAt: now })
			.where(inArray(k8sClusters.id, due.map((row) => row.id)))
			.run();
		this.ctx.projects.bump();
		return due.length;
	}

	/** Restart every machine (folded into the activation version). Pods restart with them. */
	restart(principal: Principal, name: string): KubernetesClusterView {
		const row = this.requireRow(principal, name);
		this.require(principal, 'kubernetes:update', row);
		this.ctx.db
			.update(k8sClusters)
			.set({ restartGeneration: row.restartGeneration + 1, message: 'Restart requested.', updatedAt: this.ctx.now() })
			.where(eq(k8sClusters.id, row.id))
			.run();
		this.systemLog(row.id, row.orgId, row.nodeId, 'Restart requested; every machine restarts, and its pods with it.');
		this.ctx.audit.record({
			principal,
			action: 'kubernetes.restart',
			resource: 'kubernetes',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, name));
	}

	// ---------------------------------------------------------------- access (K8, K9, K19)

	/** A 15-minute token for the caller, carrying the in-cluster group their permissions grant. */
	async token(principal: Principal, name: string): Promise<KubernetesToken> {
		const row = this.requireRow(principal, name);
		this.require(principal, 'kubernetes:read', row);
		const groups = this.groupsFor(principal, row);
		if (groups.length === 0)
			throw new CoreError(
				'forbidden',
				`You can see "${name}" but have no access inside it. Ask for kubernetes:view, kubernetes:edit or kubernetes:admin.`,
				403,
			);
		const audience = kubernetesAudience(row.id);
		const token = await this.ctx.signingKeys.sign(
			KUBERNETES_SIGNING_PURPOSE,
			{ sub: principal.userId, aud: audience, org_id: row.orgId, [KUBERNETES_GROUPS_CLAIM]: groups },
			KUBERNETES_TOKEN_TTL_SECONDS,
		);
		const expiresAt = new Date(this.ctx.now() + KUBERNETES_TOKEN_TTL_SECONDS * 1000).toISOString();
		return { token, expiresAt, audience, groups };
	}

	/** A kubeconfig whose user runs `yoal k8s token`; it holds no credential. */
	kubeconfig(principal: Principal, name: string): KubernetesKubeconfig {
		const row = this.requireRow(principal, name);
		this.require(principal, 'kubernetes:read', row);
		const server = this.apiUrl(row);
		if (!server)
			throw new ConflictError(
				`"${name}" has a private API; it is reachable only from Yoal nodes over the overlay. Switch its API access to public to use kubectl from elsewhere.`,
			);
		return { cluster: row.name, server, kubeconfig: renderExecKubeconfig({ cluster: row.name, server }) };
	}

	accessKeys(principal: Principal, name: string): KubernetesAccessKeyView[] {
		const row = this.requireRow(principal, name);
		this.require(principal, 'kubernetes:read', row);
		return this.ctx.db
			.select()
			.from(k8sAccessKeys)
			.where(eq(k8sAccessKeys.clusterId, row.id))
			.all()
			.sort((a, b) => b.createdAt - a.createdAt)
			.map(accessKeyView);
	}

	/**
	 * A static kubeconfig for tools that cannot run an exec plugin (K19). The token authenticates as
	 * `yoal-key:<id>`; its only permission is the ClusterRoleBinding Yoal writes into the cluster, so
	 * revoking the key (which removes the binding) takes its access away at once.
	 */
	async createAccessKey(principal: Principal, name: string, raw: KubernetesAccessKeyCreate): Promise<KubernetesAccessKeySecret> {
		const row = this.requireRow(principal, name);
		const input = kubernetesAccessKeyCreateSchema.parse(raw);
		this.require(principal, `kubernetes:${input.role}` as Permission, row);
		this.require(principal, 'kubernetes:update', row);
		const server = this.apiUrl(row);
		if (!server) throw new ConflictError(`"${name}" has a private API; access keys need the public endpoint.`);
		const clash = this.ctx.db
			.select({ id: k8sAccessKeys.id })
			.from(k8sAccessKeys)
			.where(and(eq(k8sAccessKeys.clusterId, row.id), eq(k8sAccessKeys.name, input.name), isNull(k8sAccessKeys.revokedAt)))
			.get();
		if (clash) throw new ConflictError(`An access key named "${input.name}" already exists.`);
		const id = newId('kk_');
		const now = this.ctx.now();
		const expiresAt = input.expiresAt ? Date.parse(input.expiresAt) : null;
		if (expiresAt !== null && expiresAt <= now) throw new ValidationError('expiresAt must be in the future.');
		const ttl = expiresAt ? Math.ceil((expiresAt - now) / 1000) : ACCESS_KEY_TTL_SECONDS;
		const token = await this.ctx.signingKeys.sign(
			KUBERNETES_KEYS_SIGNING_PURPOSE,
			{ sub: `key:${id}`, aud: kubernetesAudience(row.id), org_id: row.orgId, [KUBERNETES_GROUPS_CLAIM]: [] },
			ttl,
		);
		this.ctx.sqlite.transaction(() => {
			this.ctx.db
				.insert(k8sAccessKeys)
				.values({
					id,
					orgId: row.orgId,
					clusterId: row.id,
					name: input.name,
					role: input.role,
					createdBy: principal.userId,
					createdAt: now,
					expiresAt,
				})
				.run();
			this.bumpManifests(row.id);
		})();
		this.ctx.audit.record({
			principal,
			action: 'kubernetes.access-key.create',
			resource: 'kubernetes',
			resourceId: row.id,
			args: { name, key: input.name, role: input.role, expiresAt: input.expiresAt ?? null },
			result: 'ok',
		});
		const view = accessKeyView(this.ctx.db.select().from(k8sAccessKeys).where(eq(k8sAccessKeys.id, id)).get()!);
		return {
			...view,
			kubeconfig: renderTokenKubeconfig({ cluster: row.name, server, user: `yoal-key-${input.name}`, token }),
		};
	}

	revokeAccessKey(principal: Principal, name: string, keyName: string): void {
		const row = this.requireRow(principal, name);
		this.require(principal, 'kubernetes:update', row);
		const key = this.ctx.db
			.select()
			.from(k8sAccessKeys)
			.where(and(eq(k8sAccessKeys.clusterId, row.id), eq(k8sAccessKeys.name, keyName), isNull(k8sAccessKeys.revokedAt)))
			.get();
		if (!key) throw new NotFoundError(`Access key "${keyName}"`);
		this.ctx.sqlite.transaction(() => {
			this.ctx.db.update(k8sAccessKeys).set({ revokedAt: this.ctx.now() }).where(eq(k8sAccessKeys.id, key.id)).run();
			this.bumpManifests(row.id);
		})();
		this.ctx.audit.record({
			principal,
			action: 'kubernetes.access-key.revoke',
			resource: 'kubernetes',
			resourceId: row.id,
			args: { name, key: keyName },
			result: 'ok',
		});
		this.ctx.projects.bump(row.orgId);
	}

	// ---------------------------------------------------------------- routes (K11)

	addRoute(principal: Principal, name: string, raw: KubernetesRouteCreate): KubernetesRouteView {
		const row = this.requireRow(principal, name);
		this.require(principal, 'kubernetes:update', row);
		if (!row.traefik)
			throw new ConflictError(`"${name}" has its ingress controller turned off; routes need it.`);
		const input = kubernetesRouteCreateSchema.parse(raw);
		const host = `${input.name}.${this.ctx.config.contentDomain}`;
		const projectTaken = this.ctx.sqlite
			.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM projects WHERE slug = ?')
			.get(input.name)!.n;
		const routeTaken = this.ctx.db.select({ id: k8sRoutes.id }).from(k8sRoutes).where(eq(k8sRoutes.host, host)).get();
		if (projectTaken > 0 || routeTaken) throw new ConflictError(`"${input.name}" is already taken.`);
		const id = newId('kr_');
		this.ctx.db
			.insert(k8sRoutes)
			.values({ id, orgId: row.orgId, clusterId: row.id, host, createdBy: principal.userId, createdAt: this.ctx.now() })
			.run();
		this.ctx.audit.record({
			principal,
			action: 'kubernetes.route.add',
			resource: 'kubernetes',
			resourceId: row.id,
			args: { name, host },
			result: 'ok',
		});
		this.ctx.projects.bump(row.orgId);
		return { id, host, createdAt: iso(this.ctx.now()) };
	}

	removeRoute(principal: Principal, name: string, host: string): void {
		const row = this.requireRow(principal, name);
		this.require(principal, 'kubernetes:update', row);
		const full = host.includes('.') ? host : `${host}.${this.ctx.config.contentDomain}`;
		const route = this.ctx.db
			.select()
			.from(k8sRoutes)
			.where(and(eq(k8sRoutes.clusterId, row.id), eq(k8sRoutes.host, full)))
			.get();
		if (!route) throw new NotFoundError(`Route "${host}"`);
		this.ctx.db.delete(k8sRoutes).where(eq(k8sRoutes.id, route.id)).run();
		this.ctx.audit.record({
			principal,
			action: 'kubernetes.route.remove',
			resource: 'kubernetes',
			resourceId: row.id,
			args: { name, host: full },
			result: 'ok',
		});
		this.ctx.projects.bump(row.orgId);
	}

	// ---------------------------------------------------------------- attachments (K12)

	attach(principal: Principal, name: string, raw: KubernetesAttach): KubernetesAttachmentView {
		const row = this.requireRow(principal, name);
		this.require(principal, 'kubernetes:update', row);
		const input = kubernetesAttachSchema.parse(raw);
		const target =
			input.kind === 'database'
				? this.ctx.databases.requireRow(principal, input.name)
				: this.ctx.brokers.requireRow(principal, input.name);
		this.ctx.iam.require(principal, input.kind === 'database' ? 'database:read' : 'broker:read', {
			type: input.kind,
			id: target.id,
		});
		// D56: a managed service listens on its own node only, until cross-node endpoints exist.
		if (target.nodeId !== row.nodeId)
			throw new ConflictError(
				`${input.kind === 'database' ? 'Database' : 'Broker'} "${input.name}" runs on another node; attachments need the cluster on the same node for now.`,
			);
		const secret = input.secret ?? `yoal-${input.name}`;
		const clash = this.ctx.db
			.select({ id: k8sAttachments.id })
			.from(k8sAttachments)
			.where(
				and(
					eq(k8sAttachments.clusterId, row.id),
					eq(k8sAttachments.namespace, input.namespace),
					eq(k8sAttachments.secret, secret),
				),
			)
			.get();
		if (clash) throw new ConflictError(`Secret ${input.namespace}/${secret} is already written by another attachment.`);
		const id = newId('ka_');
		const now = this.ctx.now();
		this.ctx.sqlite.transaction(() => {
			this.ctx.db
				.insert(k8sAttachments)
				.values({
					id,
					orgId: row.orgId,
					clusterId: row.id,
					kind: input.kind,
					targetId: target.id,
					namespace: input.namespace,
					secret,
					createdBy: principal.userId,
					createdAt: now,
				})
				.run();
			this.bumpManifests(row.id);
		})();
		this.ctx.audit.record({
			principal,
			action: 'kubernetes.attach',
			resource: 'kubernetes',
			resourceId: row.id,
			args: { name, kind: input.kind, target: input.name, namespace: input.namespace, secret },
			result: 'ok',
		});
		this.ctx.projects.bump(row.orgId);
		return { id, kind: input.kind, name: input.name, namespace: input.namespace, secret, createdAt: iso(now) };
	}

	detach(principal: Principal, name: string, attachmentId: string): void {
		const row = this.requireRow(principal, name);
		this.require(principal, 'kubernetes:update', row);
		const attachment = this.ctx.db
			.select()
			.from(k8sAttachments)
			.where(and(eq(k8sAttachments.clusterId, row.id), eq(k8sAttachments.id, attachmentId)))
			.get();
		if (!attachment) throw new NotFoundError('Attachment');
		this.ctx.sqlite.transaction(() => {
			this.ctx.db.delete(k8sAttachments).where(eq(k8sAttachments.id, attachment.id)).run();
			this.bumpManifests(row.id);
		})();
		this.ctx.audit.record({
			principal,
			action: 'kubernetes.detach',
			resource: 'kubernetes',
			resourceId: row.id,
			args: { name, namespace: attachment.namespace, secret: attachment.secret },
			result: 'ok',
		});
		this.ctx.projects.bump(row.orgId);
	}

	// ---------------------------------------------------------------- node protocol

	isMachineId(id: string): boolean {
		return id.startsWith(KUBERNETES_MACHINE_ID_PREFIX);
	}

	/** Live machines of live clusters on this node, as container workloads with the kubernetes profile. */
	desiredForNode(nodeId: string): WorkloadDesired[] {
		const isolated = featureEnabled(this.ctx.config, 'ORG_NETWORKS');
		const issuer = this.ctx.config.platformOrigin;
		const nodeRow = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		const mySubnet = nodeRow ? machineSubnetFor(nodeRow.privateAddress) : null;
		const out: WorkloadDesired[] = [];
		const machinesHere = this.ctx.db
			.select()
			.from(k8sMachines)
			.where(and(eq(k8sMachines.nodeId, nodeId), isNull(k8sMachines.removedAt)))
			.all();
		const clusterIds = [...new Set(machinesHere.map((machine) => machine.clusterId))];
		for (const clusterId of clusterIds) {
			const cluster = this.clusterById(clusterId);
			// A restoring cluster's machines wait until the snapshot is unpacked (K14).
			if (!cluster || cluster.deletedAt || cluster.restoreBackupId) continue;
			const all = this.liveMachines(cluster.id);
			const first = all.find((machine) => machine.role === 'server' && machine.ordinal === 0) ?? all.find((machine) => machine.role === 'server');
			if (!first) continue;
			const multiNode = all.some((machine) => machine.overlayIp !== null);
			const serverAddress = multiNode && first.overlayIp ? first.overlayIp : kubernetesMachineAlias(first.id);
			for (const machine of all.filter((item) => item.nodeId === nodeId)) {
				const release = machine.release ?? cluster.release;
				const image = kubernetesImageForRelease(release);
				if (!image) continue;
				const server = machine.role === 'server';
				out.push({
					id: machine.id,
					projectId: cluster.id,
					projectSlug: cluster.name,
					deploymentId: cluster.id,
					...(isolated ? { orgId: cluster.orgId, networkName: orgNetworkName(cluster.orgId) } : { orgId: cluster.orgId }),
					runtime: 'container' as const,
					status: 'running' as const,
					release: null,
					image,
					upstream: server ? `127.0.0.1:${cluster.apiPort}` : '',
					memoryMb: cluster.memoryMb,
					cpus: cluster.cpus,
					port: cluster.apiPort,
					healthPath: '/',
					socketActivation: false,
					activationVersion: this.activationVersion(cluster, machine),
					env: {},
					secrets: [],
					dataSizeMb: null,
					...(cluster.diskId && !multiNode ? { volumeId: cluster.diskId } : {}),
					kubernetes: {
						clusterId: cluster.id,
						role: machine.role,
						ordinal: machine.ordinal,
						release,
						serverId: first.id,
						minor: kubernetesMinorOf(release),
						tier: cluster.tier,
						// Servers carry pods only when there are no agents.
						schedulable: !server || cluster.agents === 0,
						ingressPort: server && cluster.traefik ? cluster.ingressPort : 0,
						traefik: cluster.traefik,
						apiHost: cluster.apiAccess === 'public' ? this.apiHost(cluster) : null,
						issuer,
						datastore: cluster.datastore,
						clusterInit: server && cluster.datastore === 'etcd' && machine.id === first.id,
						serverAddress: machine.id === first.id && cluster.datastore === 'etcd' ? kubernetesMachineAlias(first.id) : serverAddress,
						overlayIp: machine.overlayIp,
						machineSubnet: machine.overlayIp ? mySubnet : null,
					},
				});
			}
		}
		return out;
	}

	/** Machines whose data dir this node must delete: removed agents, and every machine of a purged cluster. */
	purgesForNode(nodeId: string): string[] {
		const purgedClusters = new Set(
			this.ctx.db
				.select({ id: k8sClusters.id })
				.from(k8sClusters)
				.where(and(isNotNull(k8sClusters.deletedAt), isNotNull(k8sClusters.purgeRequestedAt)))
				.all()
				.map((row) => row.id),
		);
		return this.ctx.db
			.select()
			.from(k8sMachines)
			.where(eq(k8sMachines.nodeId, nodeId))
			.all()
			.filter((machine) => machine.purgeRequestedAt !== null || purgedClusters.has(machine.clusterId))
			.map((machine) => machine.id)
			.sort();
	}

	/**
	 * Manifest generation per first server here, and the node names the cluster should have, so the
	 * status sample can prune nodes of removed machines and of the cluster a restore came from.
	 */
	manifestsForNode(nodeId: string): Array<{ machineId: string; generation: string; nodes: string[] }> {
		return this.ctx.db
			.select()
			.from(k8sMachines)
			.where(and(eq(k8sMachines.nodeId, nodeId), eq(k8sMachines.role, 'server'), eq(k8sMachines.ordinal, 0), isNull(k8sMachines.removedAt)))
			.all()
			.flatMap((machine) => {
				const cluster = this.clusterById(machine.clusterId);
				if (!cluster || cluster.deletedAt || cluster.restoreBackupId) return [];
				return [
					{
						machineId: machine.id,
						generation: sha256Hex(JSON.stringify(this.manifestFiles(cluster))).slice(0, 32),
						nodes: this.liveMachines(cluster.id).map((item) => kubernetesNodeName(item.id)),
					},
				];
			});
	}

	/** The join token for a machine. Node-authenticated only. */
	activation(nodeId: string, id: string): WorkloadActivation {
		const machine = this.machineById(id);
		if (!machine || machine.removedAt) throw new NotFoundError('Kubernetes machine');
		if (machine.nodeId !== nodeId) throw new CoreError('forbidden', 'This machine is placed on another node.', 403);
		const cluster = this.clusterById(machine.clusterId);
		if (!cluster || cluster.deletedAt) throw new NotFoundError('Kubernetes cluster');
		return {
			workloadId: machine.id,
			activationVersion: this.activationVersion(cluster, machine),
			env: { [KUBERNETES_TOKEN_ENV]: this.ctx.secrets.open(cluster.orgId, cluster.tokenSecret) },
			files: {},
		};
	}

	/**
	 * The manifests the helper writes into the server's auto-deploy directory: RBAC for the token
	 * groups and access keys, and attachment Secrets. Node-authenticated only; they can hold
	 * attachment passwords, so they never enter desired state (D43).
	 */
	manifests(nodeId: string, machineId: string): { generation: string; files: Record<string, string> } {
		const machine = this.machineById(machineId);
		if (!machine || machine.removedAt || machine.role !== 'server') throw new NotFoundError('Kubernetes machine');
		if (machine.nodeId !== nodeId) throw new CoreError('forbidden', 'This machine is placed on another node.', 403);
		const cluster = this.clusterById(machine.clusterId);
		if (!cluster || cluster.deletedAt) throw new NotFoundError('Kubernetes cluster');
		const files = this.manifestFiles(cluster);
		return { generation: sha256Hex(JSON.stringify(files)).slice(0, 32), files };
	}

	applyHeartbeat(nodeId: string, reports: Array<{ id: string; status: WorkloadStatus; restarts: number }>): void {
		const touched = new Set<string>();
		for (const report of reports) {
			if (!this.isMachineId(report.id)) continue;
			const machine = this.machineById(report.id);
			if (!machine || machine.nodeId !== nodeId || machine.removedAt) continue;
			const status: KubernetesStatus = report.status === 'running' && report.restarts >= RESTART_LIMIT ? 'failed' : report.status;
			if (status !== machine.status || report.restarts !== machine.restarts) {
				this.ctx.db
					.update(k8sMachines)
					.set({ status, restarts: report.restarts, updatedAt: this.ctx.now() })
					.where(eq(k8sMachines.id, machine.id))
					.run();
				touched.add(machine.clusterId);
			}
		}
		for (const clusterId of touched) this.refreshClusterStatus(clusterId);
	}

	/** Status samples from the server machine's node (nodes Ready, API ready, deprecated APIs). */
	ingestStatus(nodeId: string, samples: KubernetesStatusSample[]): void {
		for (const sample of samples) {
			const cluster = this.clusterById(sample.clusterId);
			if (!cluster || cluster.nodeId !== nodeId || cluster.deletedAt) continue;
			this.ctx.db
				.update(k8sClusters)
				.set({
					nodesReady: sample.nodesReady,
					nodesTotal: sample.nodesTotal,
					deprecatedApis: JSON.stringify(sample.deprecatedApis),
					statsAt: Date.parse(sample.at) || this.ctx.now(),
				})
				.where(eq(k8sClusters.id, cluster.id))
				.run();
			this.refreshClusterStatus(cluster.id, sample);
		}
	}

	applyPurged(nodeId: string, ids: string[]): void {
		let changed = false;
		for (const id of ids) {
			const machine = this.machineById(id);
			if (!machine || machine.nodeId !== nodeId) continue;
			const cluster = this.clusterById(machine.clusterId);
			const clusterPurged = cluster?.deletedAt && cluster.purgeRequestedAt;
			if (!machine.purgeRequestedAt && !clusterPurged) continue;
			this.ctx.db.delete(k8sMachines).where(eq(k8sMachines.id, id)).run();
			changed = true;
			if (cluster && clusterPurged) {
				const left = this.ctx.db
					.select({ id: k8sMachines.id })
					.from(k8sMachines)
					.where(eq(k8sMachines.clusterId, cluster.id))
					.all();
				if (left.length === 0) {
					this.ctx.sqlite.transaction(() => {
						for (const table of [k8sRoutes, k8sAttachments, k8sAccessKeys])
							this.ctx.db.delete(table).where(eq(table.clusterId, cluster.id)).run();
						this.ctx.db.delete(k8sLogEvents).where(eq(k8sLogEvents.clusterId, cluster.id)).run();
						this.ctx.db.delete(k8sClusters).where(eq(k8sClusters.id, cluster.id)).run();
					})();
					this.ctx.audit.record({
						orgId: cluster.orgId,
						action: 'kubernetes.purged',
						resource: 'kubernetes',
						resourceId: cluster.id,
						args: { name: cluster.name, nodeId },
						result: 'ok',
					});
				}
			}
		}
		if (changed) this.ctx.projects.bump();
	}

	/**
	 * Public routes this node serves (K7, K11). A server's node proxies to its loopback ports; the
	 * edge forwards to every server node (an HA API has three upstreams, Caddy picks a healthy one).
	 */
	routesForNode(nodeId: string, isEdge: boolean, publicAddressOf: (nodeId: string) => string | null): KubernetesRoute[] {
		const out: KubernetesRoute[] = [];
		const live = this.ctx.db.select().from(k8sClusters).where(isNull(k8sClusters.deletedAt)).all();
		const routesByCluster = new Map<string, string[]>();
		for (const route of this.ctx.db.select().from(k8sRoutes).all()) {
			const list = routesByCluster.get(route.clusterId) ?? [];
			list.push(route.host);
			routesByCluster.set(route.clusterId, list);
		}
		for (const cluster of live) {
			if (cluster.restoreBackupId) continue;
			const serverNodes = [
				...new Set(this.liveMachines(cluster.id).filter((machine) => machine.role === 'server').map((machine) => machine.nodeId)),
			];
			const local = serverNodes.includes(nodeId);
			if (!local && !isEdge) continue;
			const remotes = serverNodes.filter((id) => id !== nodeId).map((id) => `http://${publicAddressOf(id) ?? '127.0.0.1:1'}`);
			const allowCidrs = isEdge ? parseJson<string[]>(cluster.allowCidrs, []) : [];
			const route = (kind: 'api' | 'ingress', host: string, port: number): KubernetesRoute => {
				const upstreams = local ? [`127.0.0.1:${port}`] : remotes;
				return {
					clusterId: cluster.id,
					kind,
					host,
					upstream: upstreams[0] ?? 'http://127.0.0.1:1',
					// The edge reaching every server node spreads an HA API; a server node uses its own.
					upstreams: local ? [] : upstreams.length > 1 ? upstreams : [],
					upstreamTls: local && kind === 'api',
					bearerOnly: kind === 'api',
					allowCidrs: kind === 'api' ? allowCidrs : [],
				};
			};
			if (cluster.apiAccess === 'public') out.push(route('api', this.apiHost(cluster), cluster.apiPort));
			if (cluster.traefik)
				for (const host of routesByCluster.get(cluster.id) ?? []) out.push(route('ingress', host, cluster.ingressPort));
		}
		return out;
	}

	/** Memory reserved by live machines per node (D42 admission). */
	reservedByNode(): Map<string, number> {
		const totals = new Map<string, number>();
		const clusters = new Map(
			this.ctx.db
				.select()
				.from(k8sClusters)
				.where(isNull(k8sClusters.deletedAt))
				.all()
				.map((row) => [row.id, row]),
		);
		for (const machine of this.ctx.db.select().from(k8sMachines).where(isNull(k8sMachines.removedAt)).all()) {
			const cluster = clusters.get(machine.clusterId);
			if (!cluster || !ACTIVE.includes(cluster.status)) continue;
			totals.set(machine.nodeId, (totals.get(machine.nodeId) ?? 0) + cluster.memoryMb);
		}
		return totals;
	}

	/** Memory reserved by an org's live clusters (quota accounting). */
	reservedMemoryForOrg(orgId: string): number {
		return this.ctx.db
			.select({ memoryMb: k8sClusters.memoryMb, agents: k8sClusters.agents, servers: k8sClusters.servers })
			.from(k8sClusters)
			.where(and(eq(k8sClusters.orgId, orgId), isNull(k8sClusters.deletedAt)))
			.all()
			.reduce((total, row) => total + row.memoryMb * (row.servers + row.agents), 0);
	}

	appendRuntimeLogs(
		nodeId: string,
		machineId: string,
		rows: Array<{ stream: 'stdout' | 'stderr' | 'system'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; ts: number }>,
	): number {
		const machine = this.machineById(machineId);
		if (!machine) return 0;
		if (machine.nodeId !== nodeId) throw new CoreError('forbidden', 'This machine is placed on another node.', 403);
		if (rows.length === 0) return 0;
		// Inserts publish to the Logs Explorer live tail (docs/LOGS.md §4.4).
		this.ctx.logs.tracked('kle', () =>
			this.ctx.db
				.insert(k8sLogEvents)
				.values(
					rows.map((line) => ({
						orgId: machine.orgId,
						clusterId: machine.clusterId,
						machineId: machine.id,
						nodeId,
						source: 'runtime' as const,
						...line,
					})),
				)
				.run(),
		);
		return rows.length;
	}

	logs(principal: Principal, name: string, options: { after?: number; limit?: number } = {}) {
		const row = this.requireRow(principal, name, { includeDeleted: true });
		this.require(principal, 'kubernetes:read', row);
		const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
		type Line = { seq: number; machine_id: string | null; source: string; stream: string; level: string; message: string; ts: number };
		// With a cursor, the next lines after it (oldest first) so a tail never skips any; without
		// one, the newest page.
		const lines =
			options.after !== undefined
				? this.ctx.sqlite
						.query<Line, [string, number, number]>(
							`SELECT seq, machine_id, source, stream, level, message, ts FROM k8s_log_events
							 WHERE cluster_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
						)
						.all(row.id, options.after, limit)
				: this.ctx.sqlite
						.query<Line, [string, number]>(
							`SELECT seq, machine_id, source, stream, level, message, ts FROM k8s_log_events
							 WHERE cluster_id = ? ORDER BY seq DESC LIMIT ?`,
						)
						.all(row.id, limit)
						.reverse();
		return lines
			.map((line) => ({
				seq: line.seq,
				machineId: line.machine_id,
				source: line.source,
				stream: line.stream,
				level: line.level,
				message: line.message,
				at: iso(line.ts),
			}));
	}

	// ---------------------------------------------------------------- backups and restore (K14)

	backups(principal: Principal, name: string): KubernetesBackupView[] {
		const row = this.requireRow(principal, name, { includeDeleted: true });
		this.require(principal, 'kubernetes:read', row);
		return this.ctx.db
			.select()
			.from(k8sBackups)
			.where(eq(k8sBackups.clusterId, row.id))
			.all()
			.sort((a, b) => b.createdAt - a.createdAt)
			.map((backup) => this.backupView(backup));
	}

	/** Queue a datastore snapshot now. */
	backupNow(principal: Principal, name: string): KubernetesBackupView {
		const row = this.requireRow(principal, name);
		this.require(principal, 'kubernetes:update', row);
		const backup = this.queueBackup(row, 'manual', principal.userId);
		this.ctx.audit.record({
			principal,
			action: 'kubernetes.backup',
			resource: 'kubernetes',
			resourceId: row.id,
			args: { name, backup: backup.id },
			result: 'ok',
		});
		return this.backupView(backup);
	}

	/**
	 * A new cluster from a snapshot, on any capable node (K14). Its server unpacks the snapshot before
	 * the first start; it keeps the source's join token, without which the datastore will not open.
	 */
	restoreBackup(principal: Principal, raw: KubernetesRestore): KubernetesClusterView {
		this.ctx.iam.require(principal, 'kubernetes:create', { type: 'org' });
		this.requireFeature();
		const input = kubernetesRestoreSchema.parse(raw);
		const backup = this.ctx.db
			.select()
			.from(k8sBackups)
			.where(and(eq(k8sBackups.id, input.backup), eq(k8sBackups.orgId, principal.orgId)))
			.get();
		if (!backup) throw new NotFoundError(`Backup "${input.backup}"`);
		if (backup.status !== 'ok') throw new ConflictError(`Backup "${input.backup}" did not finish; pick another.`);
		this.ctx.backupTargets.requireRecorded(backup);
		const source = this.clusterById(backup.clusterId);
		if (source && !source.deletedAt) this.require(principal, 'kubernetes:read', source);
		if (RESERVED_NAMES.has(input.name)) throw new ValidationError(`"${input.name}" is reserved; pick another cluster name.`);
		this.assertNameFree(principal.orgId, input.name);
		const release = kubernetesImageForRelease(backup.release) ? backup.release : kubernetesVersion(backup.minor)?.release;
		if (!release) throw new ConflictError(`Kubernetes ${backup.minor} is no longer supported; this backup cannot be restored.`);
		const memoryMb = source?.memoryMb ?? KUBERNETES_DEFAULT_MEMORY_MB;
		const layout = this.layout(principal, {
			placement: input.placement,
			nodes: null,
			servers: 1,
			agents: 0,
			memoryMb,
			tier: null,
		});
		const id = this.insertCluster(principal, {
			name: input.name,
			minor: backup.minor,
			release,
			purpose: source?.purpose ?? 'lab',
			layout,
			memoryMb,
			cpus: source?.cpus ?? KUBERNETES_DEFAULT_CPUS,
			apiAccess: source?.apiAccess ?? 'public',
			allowCidrs: parseJson<string[]>(source?.allowCidrs, []),
			window: { hour: source?.windowHour ?? 3, hours: source?.windowHours ?? 2 },
			autoPatch: source?.autoPatch ?? true,
			traefik: source?.traefik ?? true,
			backupHours: source?.backupHours ?? 24,
			backupRetentionDays: source?.backupRetentionDays ?? 7,
			shipper: source?.shipper ?? false,
			tokenSecret: this.ctx.secrets.seal(principal.orgId, this.ctx.secrets.open(backup.orgId, backup.tokenSecret)),
			restoreBackupId: backup.id,
			datastore: backup.datastore,
		});
		this.systemLog(id, principal.orgId, layout.machines[0]!.nodeId, `Restoring from ${backup.id} (${backup.clusterName}, ${backup.release}).`);
		this.ctx.audit.record({
			principal,
			action: 'kubernetes.restore-backup',
			resource: 'kubernetes',
			resourceId: id,
			args: { name: input.name, backup: backup.id, from: backup.clusterName },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, input.name));
	}

	/** Snapshots and restores the first server's node must run now. */
	async backupTasksForNode(nodeId: string): Promise<KubernetesBackupTask[]> {
		const tasks: KubernetesBackupTask[] = [];
		for (const machine of this.ctx.db
			.select()
			.from(k8sMachines)
			.where(and(eq(k8sMachines.nodeId, nodeId), eq(k8sMachines.role, 'server'), eq(k8sMachines.ordinal, 0), isNull(k8sMachines.removedAt)))
			.all()) {
			const cluster = this.clusterById(machine.clusterId);
			if (!cluster || cluster.deletedAt) continue;
			if (cluster.restoreBackupId) {
				const backup = this.ctx.db.select().from(k8sBackups).where(eq(k8sBackups.id, cluster.restoreBackupId)).get();
				const recorded = backup ? this.ctx.backupTargets.openRecorded(backup) : null;
				if (!backup || !recorded?.available) {
					this.failRestore(cluster, backup ? (recorded && !recorded.available ? recorded.reason : 'unreachable') : 'the backup is gone');
					continue;
				}
				tasks.push({
					id: `restore:${cluster.id}`,
					action: 'restore',
					machineId: machine.id,
					datastore: backup.datastore,
					url: await recorded.store.presignGet(backup.objectKey, BACKUP_TASK_TTL_SECONDS),
				});
				continue;
			}
			if (machine.status !== 'running') continue;
			for (const backup of this.ctx.db
				.select()
				.from(k8sBackups)
				.where(and(eq(k8sBackups.clusterId, cluster.id), eq(k8sBackups.status, 'pending')))
				.all()) {
				const recorded = this.ctx.backupTargets.openRecorded(backup);
				if (!recorded.available) {
					this.finishBackup(backup.id, { status: 'failed', error: recorded.reason });
					continue;
				}
				tasks.push({
					id: backup.id,
					action: 'backup',
					machineId: machine.id,
					datastore: cluster.datastore,
					url: await recorded.store.presignPut(backup.objectKey, BACKUP_TASK_TTL_SECONDS, 'application/gzip'),
				});
			}
		}
		return tasks;
	}

	applyBackupResults(nodeId: string, results: KubernetesBackupResult[]): void {
		for (const result of results) {
			if (result.action === 'restore') {
				const clusterId = result.taskId.replace(/^restore:/, '');
				const cluster = this.clusterById(clusterId);
				const server = cluster ? this.liveMachines(cluster.id).find((machine) => machine.role === 'server') : null;
				if (!cluster || !cluster.restoreBackupId || server?.nodeId !== nodeId) continue;
				if (result.status === 'ok') {
					this.ctx.db
						.update(k8sClusters)
						.set({ restoreBackupId: null, message: null, updatedAt: this.ctx.now() })
						.where(eq(k8sClusters.id, cluster.id))
						.run();
					this.systemLog(cluster.id, cluster.orgId, nodeId, 'Snapshot unpacked; the server starts from it now.');
					this.ctx.projects.bump(cluster.orgId);
				} else this.failRestore(cluster, result.error ?? 'the node could not unpack it');
				continue;
			}
			const backup = this.ctx.db.select().from(k8sBackups).where(eq(k8sBackups.id, result.taskId)).get();
			if (!backup || backup.status === 'ok' || backup.status === 'failed') continue;
			const cluster = this.clusterById(backup.clusterId);
			if (cluster?.nodeId !== nodeId) continue;
			this.finishBackup(backup.id, {
				status: result.status,
				error: result.error ?? null,
				sizeBytes: result.sizeBytes ?? null,
				sha256: result.sha256 ?? null,
			});
		}
	}

	/** Maintenance: queue due snapshots, prune expired ones, fail stuck ones. */
	async backupTick(): Promise<void> {
		const now = this.ctx.now();
		for (const cluster of this.ctx.db.select().from(k8sClusters).where(isNull(k8sClusters.deletedAt)).all()) {
			if (cluster.restoreBackupId || cluster.status !== 'running' && cluster.status !== 'degraded') continue;
			if (cluster.nextBackupAt !== null && cluster.nextBackupAt > now) continue;
			const pending = this.ctx.db
				.select({ id: k8sBackups.id })
				.from(k8sBackups)
				.where(and(eq(k8sBackups.clusterId, cluster.id), inArray(k8sBackups.status, ['pending', 'running'])))
				.get();
			if (!pending) this.queueBackup(cluster, 'scheduled', 'system');
			this.ctx.db
				.update(k8sClusters)
				.set({ nextBackupAt: now + cluster.backupHours * HOUR_MS })
				.where(eq(k8sClusters.id, cluster.id))
				.run();
		}
		for (const backup of this.ctx.db.select().from(k8sBackups).where(eq(k8sBackups.status, 'pending')).all())
			if (now - backup.createdAt > BACKUP_STUCK_MS) this.finishBackup(backup.id, { status: 'failed', error: 'The node did not take the snapshot within six hours.' });
		for (const backup of this.ctx.db.select().from(k8sBackups).where(lte(k8sBackups.expiresAt, now)).all()) {
			// A cluster's newest good snapshot is kept whatever its age.
			const newest = this.ctx.db
				.select()
				.from(k8sBackups)
				.where(and(eq(k8sBackups.clusterId, backup.clusterId), eq(k8sBackups.status, 'ok')))
				.all()
				.sort((a, b) => b.createdAt - a.createdAt)[0];
			if (newest?.id === backup.id) continue;
			const recorded = this.ctx.backupTargets.openRecorded(backup);
			if (recorded.available && !recorded.writeOnly) await recorded.store.delete(backup.objectKey).catch(() => undefined);
			this.ctx.db.delete(k8sBackups).where(eq(k8sBackups.id, backup.id)).run();
		}
	}

	private queueBackup(cluster: KubernetesClusterRow, kind: 'scheduled' | 'manual' | 'pre-upgrade', by: string) {
		const id = newId('kb_');
		const now = this.ctx.now();
		this.ctx.db
			.insert(k8sBackups)
			.values({
				id,
				orgId: cluster.orgId,
				clusterId: cluster.id,
				clusterName: cluster.name,
				kind,
				datastore: cluster.datastore,
				status: 'pending',
				objectKey: `k8s/${cluster.orgId}/${cluster.id}/${id}.tar.gz`,
				...this.ctx.backupTargets.placementFor(cluster.orgId),
				minor: cluster.minor,
				release: this.liveMachines(cluster.id).find((machine) => machine.role === 'server')?.release ?? cluster.release,
				tokenSecret: cluster.tokenSecret,
				createdBy: by,
				createdAt: now,
				expiresAt: now + cluster.backupRetentionDays * DAY_MS,
			})
			.run();
		this.ctx.projects.bump(cluster.orgId);
		return this.ctx.db.select().from(k8sBackups).where(eq(k8sBackups.id, id)).get()!;
	}

	private finishBackup(
		id: string,
		result: { status: 'ok' | 'failed'; error?: string | null; sizeBytes?: number | null; sha256?: string | null },
	): void {
		const backup = this.ctx.db.select().from(k8sBackups).where(eq(k8sBackups.id, id)).get();
		if (!backup) return;
		const now = this.ctx.now();
		this.ctx.db
			.update(k8sBackups)
			.set({
				status: result.status,
				error: result.error ?? null,
				sizeBytes: result.sizeBytes ?? null,
				sha256: result.sha256 ?? null,
				finishedAt: now,
			})
			.where(eq(k8sBackups.id, id))
			.run();
		this.ctx.db
			.update(k8sClusters)
			.set({ lastBackupAt: now, lastBackupStatus: result.status === 'ok' ? 'ok' : `failed: ${result.error ?? 'unknown'}`.slice(0, 300) })
			.where(eq(k8sClusters.id, backup.clusterId))
			.run();
		const cluster = this.clusterById(backup.clusterId);
		if (cluster)
			this.systemLog(
				cluster.id,
				cluster.orgId,
				cluster.nodeId,
				result.status === 'ok' ? `Snapshot ${id} stored (${result.sizeBytes ?? 0} bytes).` : `Snapshot ${id} failed: ${result.error ?? 'unknown error'}`,
			);
	}

	private failRestore(cluster: KubernetesClusterRow, reason: string): void {
		this.ctx.db
			.update(k8sClusters)
			.set({ status: 'failed', message: `Restore failed: ${reason}`.slice(0, 500), updatedAt: this.ctx.now() })
			.where(eq(k8sClusters.id, cluster.id))
			.run();
		this.systemLog(cluster.id, cluster.orgId, cluster.nodeId, `Restore failed: ${reason}`);
	}

	private backupView(backup: typeof k8sBackups.$inferSelect): KubernetesBackupView {
		const location = this.ctx.backupTargets.describeRecorded(backup);
		return {
			id: backup.id,
			clusterName: backup.clusterName,
			kind: backup.kind,
			datastore: backup.datastore,
			status: backup.status,
			error: backup.error,
			sizeBytes: backup.sizeBytes,
			minor: backup.minor,
			release: backup.release,
			location: (location as { label?: string; name?: string }).label ?? backup.targetName ?? 'platform object store',
			createdAt: iso(backup.createdAt),
			finishedAt: backup.finishedAt ? iso(backup.finishedAt) : null,
			expiresAt: iso(backup.expiresAt),
		};
	}

	// ---------------------------------------------------------------- rollouts, patches, HA (K15, K17)

	/**
	 * One maintenance pass over every cluster (every minute or so):
	 *
	 * - Patches: in the cluster's window, a newer pin of its minor becomes its target (unless
	 *   `autoPatch` is off). At end of support the next minor becomes the target, in the window.
	 * - Warnings 60 and 30 days before end of support, listing deprecated APIs still in use.
	 * - Rollout: when machines lag the target, a snapshot is taken first (minor changes), then one
	 *   machine at a time moves (servers first). A machine that is not running 15 minutes after its
	 *   move puts the previous release back on it and stops the rollout.
	 * - HA: once the first server runs on etcd, the missing servers are added one by one.
	 */
	rolloutTick(): void {
		const now = this.ctx.now();
		for (const cluster of this.ctx.db.select().from(k8sClusters).where(isNull(k8sClusters.deletedAt)).all()) {
			if (cluster.restoreBackupId) continue;
			try {
				this.patchAndSupport(cluster, now);
				this.advanceRollout(this.clusterById(cluster.id)!, now);
				this.advanceHa(this.clusterById(cluster.id)!);
			} catch (error) {
				console.error(`[kubernetes] maintenance for ${cluster.id} failed:`, error);
			}
		}
	}

	private inWindow(cluster: KubernetesClusterRow, now: number): boolean {
		const hour = new Date(now).getUTCHours();
		const end = (cluster.windowHour + cluster.windowHours) % 24;
		return cluster.windowHour < end ? hour >= cluster.windowHour && hour < end : hour >= cluster.windowHour || hour < end;
	}

	private patchAndSupport(cluster: KubernetesClusterRow, now: number): void {
		const version = kubernetesVersion(cluster.minor);
		const eos = version ? Date.parse(version.endOfSupport) : Number.NaN;
		const warned = new Set((cluster.eosWarned ?? '').split(',').filter(Boolean));
		for (const days of [60, 30]) {
			if (!Number.isFinite(eos) || warned.has(String(days)) || eos - now > days * DAY_MS) continue;
			warned.add(String(days));
			const deprecated = parseJson<string[]>(cluster.deprecatedApis, []);
			this.notifyCluster(
				cluster,
				`Kubernetes ${cluster.minor} on "${cluster.name}" leaves support on ${version!.endOfSupport}`,
				`It moves to ${nextKubernetesMinor(cluster.minor) ?? 'the next minor'} automatically in its maintenance window after that date.${
					deprecated.length > 0 ? ` APIs still in use that the next minor may remove: ${deprecated.slice(0, 10).join(', ')}.` : ''
				}`,
			);
			this.ctx.db.update(k8sClusters).set({ eosWarned: [...warned].join(',') }).where(eq(k8sClusters.id, cluster.id)).run();
		}
		if (cluster.upgradeStartedAt || !this.inWindow(cluster, now)) return;
		// End of support (or the minor dropped from the registry): one minor forward, in the window.
		if (!version || (Number.isFinite(eos) && now >= eos)) {
			const next = nextKubernetesMinor(cluster.minor) ?? kubernetesVersions[kubernetesVersions.length - 1]!.minor;
			const target = kubernetesVersion(next);
			if (target && target.minor !== cluster.minor) {
				this.ctx.db.update(k8sClusters).set({ minor: target.minor, release: target.release, updatedAt: now }).where(eq(k8sClusters.id, cluster.id)).run();
				this.systemLog(cluster.id, cluster.orgId, cluster.nodeId, `Kubernetes ${cluster.minor} is out of support; moving to ${target.minor}.`);
			}
			return;
		}
		if (cluster.autoPatch && version.release !== cluster.release) {
			this.ctx.db.update(k8sClusters).set({ release: version.release, updatedAt: now }).where(eq(k8sClusters.id, cluster.id)).run();
			this.systemLog(cluster.id, cluster.orgId, cluster.nodeId, `Patch ${kubernetesDisplayVersion(version.release)} is available; rolling it out in the maintenance window.`);
		}
	}

	private advanceRollout(cluster: KubernetesClusterRow, now: number): void {
		const machines = this.liveMachines(cluster.id);
		const lagging = machines.filter((machine) => (machine.release ?? cluster.release) !== cluster.release);
		// During a rollout, every machine already moved must be running before anything else happens.
		if (cluster.upgradeStartedAt) {
			const waiting = machines.find(
				(machine) => (machine.release ?? cluster.release) === cluster.release && machine.status !== 'running' && machine.updatedAt >= cluster.upgradeStartedAt!,
			);
			if (waiting) {
				if (now - waiting.updatedAt > ROLLOUT_MACHINE_TIMEOUT_MS && waiting.status !== 'starting')
					this.rollBack(cluster, `${kubernetesNodeName(waiting.id)} did not come back within 15 minutes`);
				else if (now - waiting.updatedAt > 2 * ROLLOUT_MACHINE_TIMEOUT_MS)
					this.rollBack(cluster, `${kubernetesNodeName(waiting.id)} did not come back within 30 minutes`);
				return;
			}
		}
		if (lagging.length === 0) {
			if (cluster.upgradeStartedAt) {
				this.ctx.db
					.update(k8sClusters)
					.set({ upgradeStartedAt: null, upgradeMessage: null, previousRelease: null, updatedAt: now })
					.where(eq(k8sClusters.id, cluster.id))
					.run();
				this.systemLog(cluster.id, cluster.orgId, cluster.nodeId, `Rollout of ${cluster.release} finished.`);
				this.ctx.projects.bump(cluster.orgId);
			}
			return;
		}
		const from = lagging[0]!.release ?? cluster.previousRelease ?? cluster.release;
		if (!cluster.upgradeStartedAt) {
			const minorChange = kubernetesMinorOf(from) !== cluster.minor;
			this.ctx.db
				.update(k8sClusters)
				.set({ upgradeStartedAt: now, previousRelease: from, upgradeMessage: minorChange ? 'Taking a snapshot first.' : null, updatedAt: now })
				.where(eq(k8sClusters.id, cluster.id))
				.run();
			if (minorChange) this.queueBackup(cluster, 'pre-upgrade', 'system');
			return;
		}
		// A minor change waits for its pre-upgrade snapshot (and gives up if it failed).
		const snapshot = this.ctx.db
			.select()
			.from(k8sBackups)
			.where(and(eq(k8sBackups.clusterId, cluster.id), eq(k8sBackups.kind, 'pre-upgrade')))
			.all()
			.filter((backup) => backup.createdAt >= cluster.upgradeStartedAt!)
			.sort((a, b) => b.createdAt - a.createdAt)[0];
		if (snapshot && (snapshot.status === 'pending' || snapshot.status === 'running')) return;
		if (snapshot?.status === 'failed') {
			this.rollBack(cluster, `the pre-upgrade snapshot failed (${snapshot.error ?? 'unknown'})`);
			return;
		}
		const next = [...lagging].sort((a, b) => (a.role === b.role ? a.ordinal - b.ordinal : a.role === 'server' ? -1 : 1))[0]!;
		this.ctx.db.update(k8sMachines).set({ release: cluster.release, status: 'starting', updatedAt: now }).where(eq(k8sMachines.id, next.id)).run();
		this.ctx.db
			.update(k8sClusters)
			.set({ upgradeMessage: `Moving ${kubernetesNodeName(next.id)} to ${kubernetesDisplayVersion(cluster.release)}.`, updatedAt: now })
			.where(eq(k8sClusters.id, cluster.id))
			.run();
		this.systemLog(cluster.id, cluster.orgId, next.nodeId, `Moving ${next.role} ${kubernetesNodeName(next.id)} to ${cluster.release}.`);
		this.ctx.projects.bump(cluster.orgId);
	}

	/** Put the previous release back on every machine and stop the rollout. */
	private rollBack(cluster: KubernetesClusterRow, reason: string): void {
		const previous = cluster.previousRelease;
		if (!previous) return;
		const now = this.ctx.now();
		this.ctx.sqlite.transaction(() => {
			this.ctx.db
				.update(k8sClusters)
				.set({
					release: previous,
					minor: kubernetesMinorOf(previous),
					upgradeStartedAt: null,
					previousRelease: null,
					upgradeMessage: null,
					// Stop automatic patching until someone looks.
					autoPatch: false,
					message: `Rollout stopped and rolled back: ${reason}.`.slice(0, 500),
					updatedAt: now,
				})
				.where(eq(k8sClusters.id, cluster.id))
				.run();
			for (const machine of this.liveMachines(cluster.id))
				if (machine.release !== previous)
					this.ctx.db.update(k8sMachines).set({ release: previous, updatedAt: now }).where(eq(k8sMachines.id, machine.id)).run();
		})();
		this.systemLog(cluster.id, cluster.orgId, cluster.nodeId, `Rollout stopped and rolled back to ${previous}: ${reason}. Automatic patching is off until it is turned back on.`);
		this.notifyCluster(cluster, `Kubernetes rollout on "${cluster.name}" was rolled back`, `${reason}. It runs ${previous} again; automatic patching is paused.`);
		this.ctx.projects.bump(cluster.orgId);
	}

	/**
	 * Making a cluster HA (K17): take a snapshot, then move the server onto etcd (`--cluster-init`
	 * converts SQLite in place) and onto its node's routed network; servers 2 and 3 follow once it runs.
	 */
	private beginHaConversion(row: KubernetesClusterRow): void {
		const server = this.liveMachines(row.id).find((machine) => machine.role === 'server' && machine.ordinal === 0);
		if (!server) throw new ConflictError('The cluster has no server.');
		const eligible = this.eligibleNodes(
			{ ...this.systemPrincipal(row.orgId), platformAdmin: this.trustedAllowedForOrg(row.orgId) },
			row.tier,
		);
		const others = eligible.ok.filter((node) => node.id !== server.nodeId && node.machineSubnet);
		if (others.length < 2) throw new ConflictError('Three servers need two more nodes with the Kubernetes component and an updated agent.');
		const now = this.ctx.now();
		const overlayIp = server.overlayIp ?? this.allocateOverlayIp(server.nodeId);
		this.queueBackup(row, 'pre-upgrade', 'system');
		this.ctx.sqlite.transaction(() => {
			this.ctx.db
				.update(k8sClusters)
				.set({ servers: 3, datastore: 'etcd', upgradeMessage: 'Converting to etcd; two more servers follow.', updatedAt: now })
				.where(eq(k8sClusters.id, row.id))
				.run();
			this.ctx.db.update(k8sMachines).set({ overlayIp, status: 'starting', updatedAt: now }).where(eq(k8sMachines.id, server.id)).run();
			// Agents move to the routed network too, so pods can reach the new servers' nodes.
			for (const agent of this.liveMachines(row.id).filter((machine) => machine.role === 'agent' && !machine.overlayIp))
				this.ctx.db.update(k8sMachines).set({ overlayIp: this.allocateOverlayIp(agent.nodeId), updatedAt: now }).where(eq(k8sMachines.id, agent.id)).run();
		})();
		this.systemLog(row.id, row.orgId, row.nodeId, 'Making the cluster highly available: converting its datastore to etcd, then adding two servers.');
	}

	/** Add the next missing etcd server once every existing server runs (K17). */
	private advanceHa(cluster: KubernetesClusterRow): void {
		if (cluster.datastore !== 'etcd') return;
		const servers = this.liveMachines(cluster.id).filter((machine) => machine.role === 'server');
		if (servers.length >= cluster.servers) {
			if (cluster.upgradeMessage?.startsWith('Converting to etcd'))
				this.ctx.db.update(k8sClusters).set({ upgradeMessage: null }).where(eq(k8sClusters.id, cluster.id)).run();
			return;
		}
		if (servers.some((machine) => machine.status !== 'running')) return;
		const used = new Set(servers.map((machine) => machine.nodeId));
		const usedZones = new Set(
			this.ctx.workloads
				.placementCandidates()
				.filter((node) => used.has(node.id))
				.map((node) => node.zone ?? 'default'),
		);
		const eligible = this.eligibleNodes(
			{ ...this.systemPrincipal(cluster.orgId), platformAdmin: this.trustedAllowedForOrg(cluster.orgId) },
			cluster.tier,
		).ok.filter((node) => !used.has(node.id) && node.machineSubnet);
		const free = new Map(this.ctx.workloads.capacityInternal().map((item) => [item.nodeId, item.freeMemoryMb]));
		const pick = [...eligible]
			.filter((node) => (free.get(node.id) ?? 0) >= cluster.memoryMb)
			.sort((a, b) => Number(usedZones.has(a.zone)) - Number(usedZones.has(b.zone)) || (free.get(b.id) ?? 0) - (free.get(a.id) ?? 0))[0];
		if (!pick) {
			this.ctx.db
				.update(k8sClusters)
				.set({ upgradeMessage: 'Waiting for a node with room for the next server.' })
				.where(eq(k8sClusters.id, cluster.id))
				.run();
			return;
		}
		const ordinal = Math.max(...servers.map((machine) => machine.ordinal)) + 1;
		this.insertMachine(cluster.orgId, cluster.id, 'server', ordinal, pick.id, this.allocateOverlayIp(pick.id), cluster.release);
		this.systemLog(cluster.id, cluster.orgId, pick.id, `Adding server ${ordinal + 1} of ${cluster.servers} on ${pick.name}.`);
		this.ctx.projects.bump(cluster.orgId);
	}

	private systemPrincipal(orgId: string): Principal {
		return { kind: 'system', userId: 'system', orgId, role: 'owner', permissions: new Set() } as unknown as Principal;
	}

	private trustedAllowedForOrg(orgId: string): boolean {
		return Boolean(this.ctx.db.select().from(k8sTrustedOrgs).where(eq(k8sTrustedOrgs.orgId, orgId)).get());
	}

	// ---------------------------------------------------------------- alerts

	/** Maintenance: remember since when each cluster has been unhealthy (alerts fire after 10 minutes). */
	alertTick(): void {
		const now = this.ctx.now();
		for (const cluster of this.ctx.db.select().from(k8sClusters).where(isNull(k8sClusters.deletedAt)).all()) {
			const state = parseJson<{ unhealthySince?: number }>(cluster.alertState, {});
			const unhealthy = cluster.status === 'failed' || cluster.status === 'degraded';
			const next = unhealthy ? { unhealthySince: state.unhealthySince ?? now } : {};
			const json = JSON.stringify(next);
			if (json !== (cluster.alertState ?? '{}'))
				this.ctx.db.update(k8sClusters).set({ alertState: json }).where(eq(k8sClusters.id, cluster.id)).run();
		}
	}

	/** Alerts maintenance routes like every other platform alert (keyed, so each fires once while true). */
	alertCandidates(): Array<{ key: string; title: string; detail: string; severity: 'warning' | 'critical' }> {
		const now = this.ctx.now();
		const out: Array<{ key: string; title: string; detail: string; severity: 'warning' | 'critical' }> = [];
		for (const cluster of this.ctx.db.select().from(k8sClusters).where(isNull(k8sClusters.deletedAt)).all()) {
			const since = parseJson<{ unhealthySince?: number }>(cluster.alertState, {}).unhealthySince;
			if (since !== undefined && now - since > ALERT_AFTER_MS)
				out.push({
					key: `k8s_unhealthy:${cluster.id}`,
					title: `Kubernetes cluster ${cluster.name} is ${cluster.status}`,
					detail: cluster.message ?? 'Check the cluster page for its machines and nodes.',
					severity: cluster.status === 'failed' ? 'critical' : 'warning',
				});
			if (cluster.lastBackupStatus?.startsWith('failed'))
				out.push({
					key: `k8s_backup:${cluster.id}`,
					title: `Snapshots of Kubernetes cluster ${cluster.name} are failing`,
					detail: cluster.lastBackupStatus,
					severity: cluster.purpose === 'production' ? 'critical' : 'warning',
				});
			if (cluster.message?.startsWith('Rollout stopped'))
				out.push({ key: `k8s_rollback:${cluster.id}`, title: `Kubernetes rollout on ${cluster.name} was rolled back`, detail: cluster.message, severity: 'warning' });
			const version = kubernetesVersion(cluster.minor);
			const eos = version ? Date.parse(version.endOfSupport) : Number.NaN;
			if (Number.isFinite(eos) && eos - now <= 60 * DAY_MS) {
				const deprecated = parseJson<string[]>(cluster.deprecatedApis, []);
				out.push({
					key: `k8s_eos:${cluster.id}:${cluster.minor}`,
					title: `Kubernetes ${cluster.minor} on ${cluster.name} leaves support on ${version!.endOfSupport}`,
					detail: `It moves to the next minor in its maintenance window after that date.${
						deprecated.length > 0 ? ` APIs still in use that the next minor may remove: ${deprecated.slice(0, 10).join(', ')}.` : ''
					}`,
					severity: eos - now <= 30 * DAY_MS ? 'critical' : 'warning',
				});
			}
		}
		return out;
	}

	private notifyCluster(cluster: KubernetesClusterRow, title: string, body: string): void {
		// Notifications go out through `alertCandidates`; the cluster's log keeps the story.
		this.systemLog(cluster.id, cluster.orgId, cluster.nodeId, `${title}. ${body}`);
	}

	// ---------------------------------------------------------------- the log shipper (K23)

	/** The URL and token a cluster's shipper posts to. */
	private shipperManifest(cluster: KubernetesClusterRow): string | null {
		if (!cluster.shipper || !cluster.shipperTokenSecret) return null;
		const token = this.ctx.secrets.open(cluster.orgId, cluster.shipperTokenSecret);
		return renderShipperManifest({
			endpoint: `${this.ctx.config.platformOrigin.replace(/\/+$/, '')}/api/v1/kubernetes-ingest/${cluster.id}`,
			token,
		});
	}

	/** A batch from a cluster's shipper. The bearer is the cluster's ingest token, nothing else. */
	ingestLogs(clusterId: string, bearer: string, raw: unknown): number {
		const cluster = this.clusterById(clusterId);
		if (!cluster || cluster.deletedAt || !cluster.shipper || !cluster.shipperTokenHash)
			throw new CoreError('unauthorized', 'Unknown cluster or shipping is off.', 401);
		if (!safeEqual(sha256Hex(bearer), cluster.shipperTokenHash)) throw new CoreError('unauthorized', 'Bad ingest token.', 401);
		const lines = kubernetesLogIngestSchema.parse(raw);
		if (lines.length === 0) return 0;
		const now = this.ctx.now();
		// Rules, quota and redaction before storage (docs/LOGS.md §10.2–§10.4).
		const rows = this.ctx.logGuard.admit(
			{ orgId: cluster.orgId, scopeKind: 'k8s', scopeId: cluster.id, projectId: null },
			lines.map((line) => {
				const ts = typeof line.ts === 'number' ? line.ts : typeof line.ts === 'string' ? Date.parse(line.ts) : now;
				return {
					orgId: cluster.orgId,
					clusterId: cluster.id,
					namespace: line.namespace,
					pod: line.pod,
					container: line.container,
					stream: line.stream,
					message: line.message,
					ts: Number.isFinite(ts) ? ts : now,
				};
			}),
			messageRowAccess('kpl', (row) => ({ stream: `pod:${row.namespace}/${row.pod}/${row.container}`, channel: row.stream ?? null })),
		);
		if (rows.length === 0) return 0;
		// Pod lines publish to the Logs Explorer live tail as they land (docs/LOGS.md §4.4).
		this.ctx.logs.tracked('kpl', () => this.ctx.db.insert(k8sPodLogs).values(rows).run());
		return rows.length;
	}

	podLogs(
		principal: Principal,
		name: string,
		options: { after?: number; limit?: number; namespace?: string; pod?: string; search?: string } = {},
	): KubernetesPodLogLine[] {
		const row = this.requireRow(principal, name, { includeDeleted: true });
		this.require(principal, 'kubernetes:view', row);
		const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
		const where = ['cluster_id = ?'];
		const params: Array<string | number> = [row.id];
		if (options.namespace) (where.push('namespace = ?'), params.push(options.namespace));
		if (options.pod) (where.push('pod = ?'), params.push(options.pod));
		if (options.search) (where.push('message LIKE ?'), params.push(`%${options.search.replace(/[%_]/g, '')}%`));
		if (options.after !== undefined) (where.push('seq > ?'), params.push(options.after));
		const order = options.after !== undefined ? 'ASC' : 'DESC';
		const lines = this.ctx.sqlite
			.query<{ seq: number; namespace: string; pod: string; container: string; stream: string; message: string; ts: number }, Array<string | number>>(
				`SELECT seq, namespace, pod, container, stream, message, ts FROM k8s_pod_logs WHERE ${where.join(' AND ')} ORDER BY seq ${order} LIMIT ${limit}`,
			)
			.all(...params);
		if (order === 'DESC') lines.reverse();
		return lines.map((line) => ({
			seq: line.seq,
			namespace: line.namespace,
			pod: line.pod,
			container: line.container,
			stream: line.stream,
			message: line.message,
			at: iso(line.ts),
		}));
	}

	/** Maintenance: drop pod logs past each cluster's retention, and logs of purged clusters. */
	pruneLogs(): number {
		let removed = 0;
		const now = this.ctx.now();
		for (const cluster of this.ctx.db.select().from(k8sClusters).all())
			removed += this.ctx.sqlite
				.query('DELETE FROM k8s_pod_logs WHERE cluster_id = ? AND ts < ?')
				.run(cluster.id, now - cluster.logRetentionDays * DAY_MS).changes;
		removed += this.ctx.sqlite.query('DELETE FROM k8s_pod_logs WHERE cluster_id NOT IN (SELECT id FROM k8s_clusters)').run().changes;
		removed += this.ctx.sqlite.query('DELETE FROM k8s_log_events WHERE ts < ?').run(now - 30 * DAY_MS).changes;
		return removed;
	}

	// ---------------------------------------------------------------- configs from natural language (§18)

	/** What the manifest linter and the model need to know about a cluster. */
	manifestContext(principal: Principal, name: string, namespace = 'default'): ManifestContext {
		const row = this.requireRow(principal, name);
		this.require(principal, 'kubernetes:read', row);
		const machines = this.liveMachines(row.id);
		// Pods land on agents when there are any, else on the server (K16: allocatable = limit − reserve).
		const schedulable = machines.filter((machine) => (row.agents > 0 ? machine.role === 'agent' : true)).length || 1;
		const reserve = Math.min(1536, Math.max(768, Math.round(row.memoryMb * 0.3)));
		const secrets = this.ctx.db
			.select()
			.from(k8sAttachments)
			.where(eq(k8sAttachments.clusterId, row.id))
			.all()
			.map((attachment) => ({
				namespace: attachment.namespace,
				name: attachment.secret,
				kind: attachment.kind,
				keys:
					attachment.kind === 'database'
						? Object.keys(this.ctx.databases.connectionValuesForCluster(attachment.targetId) ?? { URL: '', HOST: '', PORT: '', USER: '', PASSWORD: '', NAME: '' })
						: ['URL', 'HOST', 'PORT', 'USER', 'PASSWORD'],
			}));
		return {
			cluster: row.name,
			minor: row.minor,
			namespace,
			ingressClass: row.traefik ? 'traefik' : null,
			routeHosts: this.ctx.db
				.select({ host: k8sRoutes.host })
				.from(k8sRoutes)
				.where(eq(k8sRoutes.clusterId, row.id))
				.all()
				.map((route) => route.host),
			contentDomain: this.ctx.config.contentDomain,
			secrets,
			storageClasses: ['local-path'],
			defaultStorageClass: 'local-path',
			allocatableMemoryMi: Math.max(0, (row.memoryMb - reserve) * schedulable),
			registryHost: this.ctx.registry.enabled() ? this.ctx.registry.host() : null,
		};
	}

	/**
	 * Server-side apply (or a dry run) of manifests, as the caller: Yoal mints the caller's own
	 * 15-minute token and talks to the cluster's public API, so the cluster's RBAC decides (K9).
	 * Yoal checks `kubernetes:edit` first for a real apply, and lints the objects either way.
	 */
	async applyManifests(
		principal: Principal,
		name: string,
		input: { manifests: Manifest[]; dryRun: boolean; namespace?: string },
	): Promise<KubernetesApplyResult> {
		const row = this.requireRow(principal, name);
		this.require(principal, input.dryRun ? 'kubernetes:view' : 'kubernetes:edit', row);
		const api = this.apiUrl(row);
		if (!api) throw new ConflictError(`"${name}" has a private API; applying from Yoal needs public API access.`);
		if (row.restoreBackupId || (row.status !== 'running' && row.status !== 'degraded'))
			throw new ConflictError(`"${name}" is ${row.restoreBackupId ? 'restoring' : row.status}; wait until it is running.`);
		const lint = lintManifests(input.manifests, this.manifestContext(principal, name, input.namespace ?? 'default'), { annotate: false });
		if (!lint.ok)
			return { dryRun: input.dryRun, ok: false, outcomes: [], findings: lint.findings };
		const { token } = await this.token(principal, name);
		const client = new KubernetesApiClient(api, token, this.apiFetch);
		const outcomes = await client.applyAll(lint.manifests, { dryRun: input.dryRun });
		const ok = outcomes.every((outcome) => outcome.ok);
		if (!input.dryRun)
			this.ctx.audit.record({
				principal,
				action: 'kubernetes.apply',
				resource: 'kubernetes',
				resourceId: row.id,
				args: { name, objects: outcomes.map((outcome) => `${outcome.kind}/${outcome.namespace ?? ''}/${outcome.name}:${outcome.result}`).slice(0, 50) },
				result: ok ? 'ok' : 'error',
			});
		return { dryRun: input.dryRun, ok, outcomes, findings: lint.findings };
	}

	/** Swappable for tests. */
	apiFetch: KubernetesFetch = (url, init) => fetch(url, init);

	// ---------------------------------------------------------------- internals

	private requireFeature(): void {
		if (!featureEnabled(this.ctx.config, 'KUBERNETES'))
			throw new ValidationError('Kubernetes is not enabled on this platform (YOAL_FEATURE_KUBERNETES).');
	}

	/** `production` unlocks once restore and automatic patching ship (K22). */
	private productionAllowed(): boolean {
		// K5 shipped: snapshots and restore, automatic patching, log history and alerts.
		return true;
	}

	private apiHost(row: KubernetesClusterRow): string {
		return kubernetesApiHost(row.name, row.orgId, this.ctx.config.contentDomain);
	}

	private apiUrl(row: KubernetesClusterRow): string | null {
		return row.apiAccess === 'public' ? `https://${this.apiHost(row)}` : null;
	}

	private groupsFor(principal: Principal, row: KubernetesClusterRow): string[] {
		return kubernetesGroupsFor({
			admin: this.can(principal, 'kubernetes:admin', row),
			edit: this.can(principal, 'kubernetes:edit', row),
			view: this.can(principal, 'kubernetes:view', row),
		});
	}

	/**
	 * Pick the node and tier. Only nodes with the component and the tier's capability qualify;
	 * ingress and control nodes only when named (K25); a dedicated node only for its org (K24); the
	 * `trusted` tier only for granted orgs, and only on a node dedicated to that org (K4).
	 */
	/**
	 * Every node with the component, judged for this principal: the tiers it may use there, and why
	 * not when it cannot (no component, dedicated to another org, tier not granted). `ok` skips
	 * ingress and control nodes (K25) unless the install has one node.
	 */
	private eligibleNodes(
		principal: Principal,
		wantedTier: KubernetesTier | null,
	): { all: EligibleNode[]; ok: EligibleNode[]; reasons: string[] } {
		const candidates = this.ctx.workloads.placementCandidates();
		const rows = new Map(this.ctx.db.select().from(nodes).all().map((node) => [node.id, node]));
		const trustedAllowed = this.trustedAllowed(principal);
		const singleNode = rows.size === 1;
		const all: EligibleNode[] = candidates.map((candidate) => {
			const row = rows.get(candidate.id);
			const caps = parseJson<string[]>(row?.capabilitiesJson, []);
			const labels = parseJson<Record<string, string>>(row?.labelsJson, {});
			const dedication = parseKubernetesDedication(labels[KUBERNETES_DEDICATED_LABEL]);
			const base = {
				id: candidate.id,
				name: candidate.name,
				zone: candidate.zone ?? 'default',
				edgeOrControl: candidate.mode === 'edge' || (candidate.roles ?? []).some((role) => role === 'ingress' || role === 'control'),
				machineSubnet: caps.includes(WG_SUBNETS_CAPABILITY) ? machineSubnetFor(row?.privateAddress ?? null) : null,
			};
			if (!caps.includes(KUBERNETES_CAPABILITY))
				return { ...base, tiers: [], problem: `Node "${candidate.name}" does not have the Kubernetes component. Install it from Settings → Kubernetes.` };
			const dedicatedTo = dedication ? (dedication.orgId ?? null) : undefined;
			if (dedicatedTo !== undefined) {
				const mine = dedicatedTo === null ? principal.platformAdmin === true : dedicatedTo === principal.orgId;
				if (!mine) return { ...base, tiers: [], problem: `Node "${candidate.name}" is dedicated to another organisation's clusters.` };
			}
			const offered = tiersOf(caps);
			const tiers = offered.filter((tier) => tier !== 'trusted' || (trustedAllowed && dedicatedTo !== undefined));
			const usable = wantedTier ? tiers.filter((tier) => tier === wantedTier) : tiers;
			if (usable.length > 0) return { ...base, tiers: usable, problem: null };
			let problem = `Node "${candidate.name}" does not offer the ${wantedTier ?? 'userns'} tier.`;
			if (wantedTier === 'trusted' && !trustedAllowed) problem = 'Your organisation is not allowed the trusted tier. A platform admin can grant it.';
			else if (wantedTier === 'trusted' || (!offered.includes('userns') && offered.includes('trusted')))
				problem = `Node "${candidate.name}" offers only the trusted tier, which needs the node labelled ${KUBERNETES_DEDICATED_LABEL}=dedicated:<org>.`;
			return { ...base, tiers: [], problem };
		});
		const reasons = all.filter((node) => node.problem && !node.problem.includes('does not have the Kubernetes component')).map((node) => node.problem!);
		const ok = all.filter((node) => !node.problem && (singleNode || !node.edgeOrControl));
		return { all, ok, reasons };
	}

	/** One node for a single-node cluster: the named one, or the best eligible worker. */
	private place(
		principal: Principal,
		requested: string,
		memoryMb: number,
		wantedTier: KubernetesTier | null,
		narrowed: PlacementCandidate[] | null,
	): { nodeId: string; tier: KubernetesTier } {
		const all = narrowed ?? this.ctx.workloads.placementCandidates();
		const eligible = this.eligibleNodes(principal, wantedTier);
		const explicit = requested === 'auto' ? null : requested === 'edge' ? this.ctx.workloads.edgeNode() : requested;
		if (explicit) {
			const node = eligible.all.find((item) => item.id === explicit || item.name === explicit);
			if (!node || !all.some((candidate) => candidate.id === node.id)) throw new ValidationError(`Node "${requested}" cannot take new workloads.`);
			if (node.problem) throw new ValidationError(node.problem);
			const decision = resolvePlacement({
				runtime: 'container',
				requested: node.id,
				memoryMb,
				edgeNodeId: this.ctx.workloads.edgeNode(),
				candidates: all.filter((candidate) => candidate.id === node.id),
			});
			if (!decision.ok) throw new ValidationError(decision.message.replace('this app reserves', 'this cluster reserves'), decision.freeByNode);
			return { nodeId: decision.nodeId, tier: node.tiers[0]! };
		}
		const okIds = new Set(eligible.ok.map((node) => node.id));
		const candidates = all.filter((candidate) => okIds.has(candidate.id));
		if (candidates.length === 0)
			throw new ValidationError(
				eligible.reasons[0] ??
					'No node can run Kubernetes yet. Install the Kubernetes component on a worker node (Settings → Kubernetes), or pick a node explicitly.',
			);
		const singleNode = this.ctx.db.select({ id: nodes.id }).from(nodes).all().length === 1;
		const decision = resolvePlacement({
			runtime: 'container',
			requested: 'auto',
			memoryMb,
			edgeNodeId: singleNode ? this.ctx.workloads.edgeNode() : null,
			candidates,
		});
		if (!decision.ok) throw new ValidationError(decision.message.replace('this app reserves', 'this cluster reserves'), decision.freeByNode);
		return { nodeId: decision.nodeId, tier: eligible.ok.find((node) => node.id === decision.nodeId)!.tiers[0]! };
	}

	private trustedAllowed(principal: Principal): boolean {
		if (principal.platformAdmin === true) return true;
		return Boolean(this.ctx.db.select().from(k8sTrustedOrgs).where(eq(k8sTrustedOrgs.orgId, principal.orgId)).get());
	}

	/** Admission on one node for `memoryMb` more of workload budget (D42). */
	private admitOn(nodeId: string, memoryMb: number): void {
		if (memoryMb <= 0) return;
		const capacity = this.ctx.workloads.capacityInternal().find((item) => item.nodeId === nodeId);
		if (!capacity) throw new ValidationError('A node of this cluster is no longer registered.');
		if (capacity.freeMemoryMb < memoryMb)
			throw new ValidationError(
				`Node "${capacity.name}" only has ${capacity.freeMemoryMb} MB of workload budget free, but this cluster needs ${memoryMb} MB there.`,
			);
	}

	/** Admission for a whole cluster coming back from the trash. */
	private admit(row: KubernetesClusterRow): void {
		const perNode = new Map<string, number>();
		for (const machine of this.liveMachines(row.id)) perNode.set(machine.nodeId, (perNode.get(machine.nodeId) ?? 0) + row.memoryMb);
		for (const [nodeId, memoryMb] of perNode) this.admitOn(nodeId, memoryMb);
	}

	/**
	 * A loopback port free on every one of these nodes (HA servers share the cluster's API and
	 * ingress ports). Trashed clusters keep theirs, so a restore gets them back.
	 */
	allocatePort(nodeIds: string[], kind: 'api' | 'ingress'): number {
		const onNodes = new Set(nodeIds);
		const clusterIds = new Set(
			this.ctx.db
				.select({ clusterId: k8sMachines.clusterId, nodeId: k8sMachines.nodeId, role: k8sMachines.role })
				.from(k8sMachines)
				.all()
				.filter((machine) => machine.role === 'server' && onNodes.has(machine.nodeId))
				.map((machine) => machine.clusterId),
		);
		const used = new Set(
			this.ctx.db
				.select()
				.from(k8sClusters)
				.all()
				.filter((row) => onNodes.has(row.nodeId) || clusterIds.has(row.id))
				.map((row) => (kind === 'api' ? row.apiPort : row.ingressPort)),
		);
		const [min, max] =
			kind === 'api' ? [KUBERNETES_API_PORT_MIN, KUBERNETES_API_PORT_MAX] : [KUBERNETES_INGRESS_PORT_MIN, KUBERNETES_INGRESS_PORT_MAX];
		for (let port = min; port <= max; port++) if (!used.has(port)) return port;
		throw new ValidationError('These nodes have no free Kubernetes ports left.');
	}

	/** The next free routed address in a node's machine subnet (.10–.250). */
	private allocateOverlayIp(nodeId: string, extraTaken: ReadonlySet<string> = new Set()): string {
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		const subnet = node && parseJson<string[]>(node.capabilitiesJson, []).includes(WG_SUBNETS_CAPABILITY) ? machineSubnetFor(node.privateAddress) : null;
		if (!subnet) throw new ValidationError(`Node "${node?.name ?? nodeId}" has no machine subnet (it needs an overlay address and an updated agent).`);
		const prefix = subnet.slice(0, subnet.lastIndexOf('.') + 1);
		const taken = new Set(
			this.ctx.db
				.select({ ip: k8sMachines.overlayIp })
				.from(k8sMachines)
				.where(and(isNull(k8sMachines.removedAt), isNotNull(k8sMachines.overlayIp)))
				.all()
				.map((row) => row.ip!),
		);
		for (let host = 10; host <= 250; host++) {
			const ip = `${prefix}${host}`;
			if (!taken.has(ip) && !extraTaken.has(ip)) return ip;
		}
		throw new ValidationError(`Node "${node?.name ?? nodeId}" has no free machine addresses left.`);
	}

	private insertMachine(
		orgId: string,
		clusterId: string,
		role: 'server' | 'agent',
		ordinal: number,
		nodeId: string,
		overlayIp: string | null,
		release: string,
	): string {
		const now = this.ctx.now();
		const id = newId(KUBERNETES_MACHINE_ID_PREFIX);
		this.ctx.db
			.insert(k8sMachines)
			.values({ id, orgId, clusterId, role, ordinal, nodeId, overlayIp, release, createdAt: now, updatedAt: now })
			.run();
		return id;
	}

	private liveMachines(clusterId: string): KubernetesMachineRow[] {
		return this.ctx.db
			.select()
			.from(k8sMachines)
			.where(and(eq(k8sMachines.clusterId, clusterId), isNull(k8sMachines.removedAt)))
			.all()
			.sort((a, b) => (a.role === b.role ? a.ordinal - b.ordinal : a.role === 'server' ? -1 : 1));
	}

	private machineById(id: string): KubernetesMachineRow | undefined {
		return this.ctx.db.select().from(k8sMachines).where(eq(k8sMachines.id, id)).get();
	}

	private clusterById(id: string): KubernetesClusterRow | undefined {
		return this.ctx.db.select().from(k8sClusters).where(eq(k8sClusters.id, id)).get();
	}

	private bumpManifests(clusterId: string): void {
		const row = this.clusterById(clusterId);
		if (!row) return;
		this.ctx.db
			.update(k8sClusters)
			.set({ manifestsGeneration: row.manifestsGeneration + 1, updatedAt: this.ctx.now() })
			.where(eq(k8sClusters.id, clusterId))
			.run();
		this.ctx.projects.bump(row.orgId);
	}

	/**
	 * Hash of everything a machine's unit and activation depend on. Manifests are not in it: they
	 * reach the server through their own verb, so attaching a database never restarts the cluster.
	 */
	private activationVersion(cluster: KubernetesClusterRow, machine: KubernetesMachineRow): string {
		return sha256Hex(
			JSON.stringify({
				machine: machine.id,
				// The machine's own release: a rollout restarts one machine at a time (K15).
				release: machine.release ?? cluster.release,
				datastore: cluster.datastore,
				overlayIp: machine.overlayIp,
				token: sha256Hex(cluster.tokenSecret),
				restart: cluster.restartGeneration,
				memoryMb: cluster.memoryMb,
				cpus: cluster.cpus,
				agents: cluster.agents,
				traefik: cluster.traefik,
				apiHost: cluster.apiAccess === 'public' ? this.apiHost(cluster) : null,
			}),
		);
	}

	private manifestFiles(cluster: KubernetesClusterRow): Record<string, string> {
		const files: Record<string, string> = { 'yoal-rbac.yaml': renderRbacManifest() };
		if (cluster.traefik) files['yoal-traefik.yaml'] = KUBERNETES_TRAEFIK_MANIFEST;
		const shipper = this.shipperManifest(cluster);
		if (shipper) files['yoal-shipper.yaml'] = shipper;
		const now = this.ctx.now();
		const keys = this.ctx.db
			.select()
			.from(k8sAccessKeys)
			.where(and(eq(k8sAccessKeys.clusterId, cluster.id), isNull(k8sAccessKeys.revokedAt)))
			.all()
			.filter((key) => key.expiresAt === null || key.expiresAt > now);
		if (keys.length > 0) files['yoal-access-keys.yaml'] = renderAccessKeyManifest(keys);
		const attachments = this.ctx.db.select().from(k8sAttachments).where(eq(k8sAttachments.clusterId, cluster.id)).all();
		for (const attachment of attachments) {
			const values = this.attachmentValues(attachment);
			if (!values) continue;
			files[`yoal-attach-${attachment.id.replace(/^ka_/, '').slice(0, 24).toLowerCase()}.yaml`] = renderSecretManifest({
				namespace: attachment.namespace,
				name: attachment.secret,
				data: values,
			});
		}
		return files;
	}

	/** Connection values for an attachment Secret, reached on the machine's org network (D56). */
	private attachmentValues(attachment: typeof k8sAttachments.$inferSelect): Record<string, string> | null {
		if (attachment.kind === 'database') {
			const db = this.ctx.db.select().from(databases).where(eq(databases.id, attachment.targetId)).get();
			if (!db || db.deletedAt) return null;
			return this.ctx.databases.connectionValuesForCluster(db.id);
		}
		const broker = this.ctx.db.select().from(brokers).where(eq(brokers.id, attachment.targetId)).get();
		if (!broker || broker.deletedAt) return null;
		return this.ctx.brokers.connectionValuesForCluster(broker.id);
	}

	private refreshClusterStatus(clusterId: string, sample?: KubernetesStatusSample): void {
		const cluster = this.clusterById(clusterId);
		if (!cluster || cluster.deletedAt) return;
		const machines = this.liveMachines(clusterId);
		const server = machines.find((machine) => machine.role === 'server');
		let status: KubernetesStatus = server?.status ?? 'pending';
		let message: string | null = cluster.message === 'Restart requested.' && status !== 'running' ? cluster.message : null;
		if (server && server.restarts >= RESTART_LIMIT && status === 'failed') message = `Restart loop (${server.restarts} restarts)`;
		if (status === 'running') {
			const ready = sample?.nodesReady ?? cluster.nodesReady;
			const total = sample?.nodesTotal ?? cluster.nodesTotal;
			const fresh = sample || (cluster.statsAt !== null && this.ctx.now() - cluster.statsAt < STATUS_STALE_MS);
			if (sample && !sample.apiReady) {
				status = 'starting';
				message = 'The API server is not ready yet.';
			} else if (fresh && ready !== null && total !== null && ready < total) {
				status = 'degraded';
				message = `${total - ready} of ${total} nodes are not Ready.`;
			} else if (machines.some((machine) => machine.status === 'failed')) {
				status = 'degraded';
				message = 'An agent machine is failing.';
			}
		}
		if (status === cluster.status && message === cluster.message) return;
		this.ctx.db
			.update(k8sClusters)
			.set({ status, message, updatedAt: this.ctx.now() })
			.where(eq(k8sClusters.id, clusterId))
			.run();
	}

	private systemLog(clusterId: string, orgId: string, nodeId: string, message: string): void {
		this.ctx.logs.tracked('kle', () =>
			this.ctx.db
				.insert(k8sLogEvents)
				.values({ orgId, clusterId, nodeId, source: 'system', stream: 'system', level: 'info', message, ts: this.ctx.now() })
				.run(),
		);
	}

	private resource(row: KubernetesClusterRow): ResourceRef {
		return { type: 'kubernetesCluster', id: row.id };
	}

	private can(principal: Principal, permission: Permission, row: KubernetesClusterRow): boolean {
		return this.ctx.iam.can(principal, permission, this.resource(row));
	}

	private require(principal: Principal, permission: Permission, row: KubernetesClusterRow): void {
		this.ctx.iam.require(principal, permission, this.resource(row));
	}

	private toView(row: KubernetesClusterRow): KubernetesClusterView {
		const nodeNames = new Map(this.ctx.db.select({ id: nodes.id, name: nodes.name }).from(nodes).all().map((node) => [node.id, node.name]));
		const version = kubernetesVersion(row.minor);
		const machines: KubernetesMachineView[] = this.liveMachines(row.id).map((machine) => ({
			id: machine.id,
			role: machine.role,
			ordinal: machine.ordinal,
			nodeId: machine.nodeId,
			nodeName: nodeNames.get(machine.nodeId) ?? null,
			status: machine.status,
			restarts: machine.restarts,
			memoryMb: row.memoryMb,
			cpus: row.cpus,
			release: machine.release ?? row.release,
			overlayIp: machine.overlayIp,
		}));
		const routes: KubernetesRouteView[] = this.ctx.db
			.select()
			.from(k8sRoutes)
			.where(eq(k8sRoutes.clusterId, row.id))
			.all()
			.map((route) => ({ id: route.id, host: route.host, createdAt: iso(route.createdAt) }));
		const attachments: KubernetesAttachmentView[] = this.ctx.db
			.select()
			.from(k8sAttachments)
			.where(eq(k8sAttachments.clusterId, row.id))
			.all()
			.map((attachment) => ({
				id: attachment.id,
				kind: attachment.kind,
				name: this.targetName(attachment) ?? '(deleted)',
				namespace: attachment.namespace,
				secret: attachment.secret,
				createdAt: iso(attachment.createdAt),
			}));
		return {
			id: row.id,
			name: row.name,
			minor: row.minor,
			release: row.release,
			displayVersion: kubernetesDisplayVersion(row.release),
			upgradeTo: nextKubernetesMinor(row.minor),
			endOfSupport: version?.endOfSupport ?? null,
			tier: row.tier,
			purpose: row.purpose,
			status: row.status,
			message: row.message,
			nodeId: row.nodeId,
			nodeName: nodeNames.get(row.nodeId) ?? null,
			memoryMb: row.memoryMb,
			cpus: row.cpus,
			agents: row.agents,
			apiAccess: row.apiAccess,
			allowCidrs: parseJson<string[]>(row.allowCidrs, []),
			apiUrl: this.apiUrl(row),
			window: { hour: row.windowHour, hours: row.windowHours },
			autoPatch: row.autoPatch,
			traefik: row.traefik,
			servers: row.servers,
			datastore: row.datastore,
			multiNode: new Set(machines.map((machine) => machine.nodeId)).size > 1 || machines.some((machine) => machine.overlayIp !== null),
			backup: {
				hours: row.backupHours,
				retentionDays: row.backupRetentionDays,
				nextAt: row.nextBackupAt ? iso(row.nextBackupAt) : null,
				lastAt: row.lastBackupAt ? iso(row.lastBackupAt) : null,
				lastStatus: row.lastBackupStatus,
			},
			upgrade:
				row.upgradeStartedAt && row.previousRelease
					? { from: row.previousRelease, to: row.release, startedAt: iso(row.upgradeStartedAt), message: row.upgradeMessage }
					: row.upgradeMessage
						? { from: row.release, to: row.release, startedAt: iso(row.updatedAt), message: row.upgradeMessage }
						: null,
			deprecatedApis: parseJson<string[]>(row.deprecatedApis, []),
			shipper: row.shipper,
			logRetentionDays: row.logRetentionDays,
			restoring: row.restoreBackupId !== null,
			machines,
			routes,
			attachments,
			nodesReady: row.nodesReady,
			nodesTotal: row.nodesTotal,
			statsAt: row.statsAt ? iso(row.statsAt) : null,
			createdAt: iso(row.createdAt),
			updatedAt: iso(row.updatedAt),
			deletedAt: row.deletedAt ? iso(row.deletedAt) : null,
			purgeAt: row.purgeAt ? iso(row.purgeAt) : null,
		};
	}

	private targetName(attachment: typeof k8sAttachments.$inferSelect): string | null {
		const table = attachment.kind === 'database' ? databases : brokers;
		return this.ctx.db.select({ name: table.name }).from(table).where(eq(table.id, attachment.targetId)).get()?.name ?? null;
	}
}

// ---------------------------------------------------------------- manifests

const MANAGED_LABELS = 'app.kubernetes.io/managed-by: yoal';

/** ClusterRoleBindings for the three token groups (K9). Re-applied by k3s on every start. */
export function renderRbacManifest(): string {
	const docs = (Object.keys(KUBERNETES_GROUPS) as KubernetesAccessRole[]).map((role) =>
		[
			'apiVersion: rbac.authorization.k8s.io/v1',
			'kind: ClusterRoleBinding',
			'metadata:',
			`  name: yoal-${role}`,
			'  labels:',
			`    ${MANAGED_LABELS}`,
			'roleRef:',
			'  apiGroup: rbac.authorization.k8s.io',
			'  kind: ClusterRole',
			`  name: ${KUBERNETES_GROUP_ROLES[role]}`,
			'subjects:',
			'- apiGroup: rbac.authorization.k8s.io',
			'  kind: Group',
			`  name: "${KUBERNETES_GROUPS[role]}"`,
		].join('\n'),
	);
	return `${docs.join('\n---\n')}\n`;
}

/** One ClusterRoleBinding per live access key, bound to the key's user `yoal:key:<id>` (K19). */
export function renderAccessKeyManifest(keys: Array<{ id: string; name: string; role: KubernetesAccessRole }>): string {
	const docs = keys.map((key) =>
		[
			'apiVersion: rbac.authorization.k8s.io/v1',
			'kind: ClusterRoleBinding',
			'metadata:',
			`  name: yoal-key-${key.id.replace(/^kk_/, '').slice(0, 24).toLowerCase()}`,
			'  labels:',
			`    ${MANAGED_LABELS}`,
			'    yoal.io/access-key: "true"',
			'  annotations:',
			`    yoal.io/key-name: ${JSON.stringify(key.name)}`,
			'roleRef:',
			'  apiGroup: rbac.authorization.k8s.io',
			'  kind: ClusterRole',
			`  name: ${KUBERNETES_GROUP_ROLES[key.role]}`,
			'subjects:',
			'- apiGroup: rbac.authorization.k8s.io',
			'  kind: User',
			`  name: "yoal:key:${key.id}"`,
		].join('\n'),
	);
	return `${docs.join('\n---\n')}\n`;
}

/** An Opaque Secret (and its namespace) with base64 values (K12). */
export function renderSecretManifest(input: { namespace: string; name: string; data: Record<string, string> }): string {
	const data = Object.entries(input.data)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `  ${key}: ${Buffer.from(value).toString('base64')}`);
	return [
		'apiVersion: v1',
		'kind: Namespace',
		'metadata:',
		`  name: ${input.namespace}`,
		'---',
		'apiVersion: v1',
		'kind: Secret',
		'metadata:',
		`  name: ${input.name}`,
		`  namespace: ${input.namespace}`,
		'  labels:',
		`    ${MANAGED_LABELS}`,
		'type: Opaque',
		'data:',
		...data,
		'',
	].join('\n');
}

// ---------------------------------------------------------------- helpers

function tiersOf(caps: readonly string[]): KubernetesTier[] {
	const tiers: KubernetesTier[] = [];
	if (caps.includes(KUBERNETES_USERNS_CAPABILITY)) tiers.push('userns');
	if (caps.includes(KUBERNETES_TRUSTED_CAPABILITY)) tiers.push('trusted');
	return tiers;
}

function isTier(value: string): value is KubernetesTier {
	return value === 'userns' || value === 'trusted';
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function accessKeyView(row: typeof k8sAccessKeys.$inferSelect): KubernetesAccessKeyView {
	return {
		id: row.id,
		name: row.name,
		role: row.role,
		createdBy: row.createdBy,
		createdAt: iso(row.createdAt),
		expiresAt: row.expiresAt ? iso(row.expiresAt) : null,
		revokedAt: row.revokedAt ? iso(row.revokedAt) : null,
	};
}

/** The machine's server alias, for agents joining over the org network. */
export function kubernetesServerAlias(serverMachineId: string): string {
	return kubernetesMachineAlias(serverMachineId);
}

interface LayoutMachine {
	role: 'server' | 'agent';
	ordinal: number;
	nodeId: string;
	overlayIp: string | null;
}

interface ClusterLayout {
	tier: KubernetesTier;
	diskId: string | null;
	machines: LayoutMachine[];
	apiPort: number;
	ingressPort: number;
}

interface EligibleNode {
	id: string;
	name: string;
	zone: string;
	edgeOrControl: boolean;
	machineSubnet: string | null;
	tiers: KubernetesTier[];
	problem: string | null;
}

/** The tier every node offers: the wanted one, else `userns`, else `trusted`. */
function commonTier(chosen: EligibleNode[], wanted: KubernetesTier | null): KubernetesTier | null {
	const order: KubernetesTier[] = wanted ? [wanted] : ['userns', 'trusted'];
	return order.find((tier) => chosen.every((node) => node.tiers.includes(tier))) ?? null;
}

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** k3s node name of a machine (the helper passes the same `--node-name`). */
export function kubernetesNodeName(machineId: string): string {
	return machineId.replace(/_/g, '-').toLowerCase();
}

/** Pinned Vector for the log shipper (K23). */
export const KUBERNETES_SHIPPER_IMAGE =
	'docker.io/timberio/vector:0.61.0-distroless-libc@sha256:1a3451978644d5cd4b99a0b28c990791e2f7e1efbea4184122f1c59a56448143';

/**
 * The opt-in log shipper (K23): Vector as a DaemonSet in `yoal-system`, reading container logs and
 * posting batches to the control plane with the cluster's ingest token.
 */
export function renderShipperManifest(input: { endpoint: string; token: string }): string {
	const vector = [
		'data_dir: /vector-data-dir',
		'sources:',
		'  pods:',
		'    type: kubernetes_logs',
		'transforms:',
		'  shape:',
		'    type: remap',
		'    inputs: [pods]',
		'    source: |',
		'      . = {',
		'        "namespace": .kubernetes.pod_namespace,',
		'        "pod": .kubernetes.pod_name,',
		'        "container": .kubernetes.container_name,',
		'        "stream": .stream,',
		'        "message": .message,',
		'        "ts": to_unix_timestamp!(.timestamp, unit: "milliseconds")',
		'      }',
		'sinks:',
		'  yoal:',
		'    type: http',
		'    inputs: [shape]',
		`    uri: ${JSON.stringify(input.endpoint)}`,
		'    method: post',
		'    encoding:',
		'      codec: json',
		'    framing:',
		'      method: newline_delimited',
		'    batch:',
		'      max_events: 1000',
		'      timeout_secs: 5',
		'    request:',
		'      headers:',
		'        Authorization: "Bearer ${YOAL_INGEST_TOKEN}"',
		'        Content-Type: application/x-ndjson',
	].join('\n');
	return [
		'apiVersion: v1',
		'kind: Namespace',
		'metadata:',
		'  name: yoal-system',
		'---',
		'apiVersion: v1',
		'kind: Secret',
		'metadata:',
		'  name: yoal-shipper',
		'  namespace: yoal-system',
		'  labels:',
		`    ${MANAGED_LABELS}`,
		'type: Opaque',
		'data:',
		`  token: ${Buffer.from(input.token).toString('base64')}`,
		'---',
		'apiVersion: v1',
		'kind: ConfigMap',
		'metadata:',
		'  name: yoal-shipper',
		'  namespace: yoal-system',
		'data:',
		'  vector.yaml: |',
		...vector.split('\n').map((line) => `    ${line}`),
		'---',
		'apiVersion: v1',
		'kind: ServiceAccount',
		'metadata:',
		'  name: yoal-shipper',
		'  namespace: yoal-system',
		'---',
		'apiVersion: rbac.authorization.k8s.io/v1',
		'kind: ClusterRole',
		'metadata:',
		'  name: yoal-shipper',
		'rules:',
		'- apiGroups: [""]',
		'  resources: [pods, namespaces, nodes]',
		'  verbs: [get, list, watch]',
		'---',
		'apiVersion: rbac.authorization.k8s.io/v1',
		'kind: ClusterRoleBinding',
		'metadata:',
		'  name: yoal-shipper',
		'roleRef:',
		'  apiGroup: rbac.authorization.k8s.io',
		'  kind: ClusterRole',
		'  name: yoal-shipper',
		'subjects:',
		'- kind: ServiceAccount',
		'  name: yoal-shipper',
		'  namespace: yoal-system',
		'---',
		'apiVersion: apps/v1',
		'kind: DaemonSet',
		'metadata:',
		'  name: yoal-shipper',
		'  namespace: yoal-system',
		'spec:',
		'  selector:',
		'    matchLabels: { app: yoal-shipper }',
		'  template:',
		'    metadata:',
		'      labels: { app: yoal-shipper }',
		'    spec:',
		'      serviceAccountName: yoal-shipper',
		'      tolerations:',
		'      - operator: Exists',
		'      containers:',
		'      - name: vector',
		`        image: ${KUBERNETES_SHIPPER_IMAGE}`,
		'        args: [--config, /etc/vector/vector.yaml]',
		'        env:',
		'        - name: VECTOR_SELF_NODE_NAME',
		'          valueFrom: { fieldRef: { fieldPath: spec.nodeName } }',
		'        - name: YOAL_INGEST_TOKEN',
		'          valueFrom: { secretKeyRef: { name: yoal-shipper, key: token } }',
		'        resources:',
		'          requests: { cpu: 20m, memory: 48Mi }',
		'          limits: { memory: 128Mi }',
		'        volumeMounts:',
		'        - { name: config, mountPath: /etc/vector, readOnly: true }',
		'        - { name: data, mountPath: /vector-data-dir }',
		'        - { name: var-log, mountPath: /var/log, readOnly: true }',
		'      volumes:',
		'      - { name: config, configMap: { name: yoal-shipper } }',
		'      - { name: data, hostPath: { path: /var/lib/yoal-shipper } }',
		'      - { name: var-log, hostPath: { path: /var/log } }',
		'',
	].join('\n');
}
