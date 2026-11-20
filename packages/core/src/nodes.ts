import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { featureFlagsForGate, gateDesiredState, nodeHasCapability } from './capability-gate';
import { featureEnabled } from './config.ts';
import { ingressNodeIds, isIngressNode, nodeRoles } from './ingress.ts';
import {
	appVolumes,
	databaseStudioSessions,
	databases,
	nodeJoinTokens,
	shareMounts,
	nodes,
	projects,
	storageInstances,
	nodeCertificates,
	serviceEndpoints,
	workloads,
	type nodes as nodesTable,
} from '@yoal/db';
import {
	compareSemver,
	parseSemver,
	nodeHardwareSchema,
	nodeLabelsSchema,
	nodeRoleSchema,
	nodeStorageStatusSchema,
	nodeUpdateSchema,
	nodeZoneSchema,
	type DesiredState,
	type NodeHardware,
	type NodeNetworkMode,
	type ServiceProvider,
	type NodeIdentityCertificate,
	type NodeRole,
	type WireguardState,
	DEFAULT_OVERLAY_CIDR,
	DEFAULT_WG_MTU,
	DEFAULT_WG_PORT,
	wireguardPublicKeySchema,
	wireguardStatusSchema,
	type WireguardStatus,
	type NodeStorage,
	type NodeStorageStatus,
	type Heartbeat,
	type NodeUpdate,
	type NodeUpdateTask,
	type Principal,
	type PlatformPermission,
	IDENTITY_CAPABILITY,
	ENDPOINTS_GATEWAY_CAPABILITY,
	selectIdentityNode,
	KUBERNETES_CAPABILITY,
	RELEASE_PHASE_CAPABILITY,
	WG_SUBNETS_CAPABILITY,
	machineSubnetFor,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, UnauthorizedError, ValidationError } from './errors.ts';
import { allocateOverlayAddress, buildWireguardState, type OverlayNode } from './overlay.ts';
import { newId, randomToken, sha256Hex, parseJson } from './util.ts';
import { assertJoinKeyFree, assertJoinTokenUnused } from './node-join.ts';
import { IDENTITY_NODE_SETTING, identityDesiredForNode } from './identity-desired.ts';
import { DesiredStateContext } from './desired-state/context.ts';
import { RouteState } from './desired-state/routes.ts';
import { EnvironmentRouteState } from './desired-state/environment-routes.ts';
import { ReleaseState } from './desired-state/releases.ts';
import { EndpointState } from './desired-state/endpoints.ts';
import { DatabaseState } from './desired-state/databases.ts';
import { IngressState } from './desired-state/ingress.ts';

const JOIN_TTL_MS = 60 * 60 * 1000;

/**
 * An agent is offline after 30 s without a heartbeat (DESIGN §9). The alert delay is a platform
 * policy (`nodeAlertMinutes`, Settings → Policies).
 */
export const OFFLINE_AFTER_MS = 30_000;

export interface UnhealthyNode {
	nodeId: string;
	name: string;
	reason: 'no_heartbeat' | 'caddy_down';
	/** Known for `no_heartbeat`; `caddy_down` nodes still heartbeat, so the caller tracks it. */
	offlineForMs: number | null;
}

export interface NodeView {
	id: string;
	name: string;
	mode: string;
	status: string;
	publicAddress: string | null;
	version: string | null;
	agentVersion: string | null;
	lastHeartbeatAt: string | null;
	stats: unknown;
	/** True when this node's Builder may claim git-build jobs (D45, D47). */
	canBuild: boolean;
	/** `yoal-workloads.slice` memory budget, in MB (D42). */
	sliceMemoryMb: number;
	/** `yoal-workloads.slice` CPUWeight. */
	sliceCpuWeight: number;
	/** Requested storage locations (`null` = install default) and what the node last reported (D48). */
	storage: NodeStorage & { status: NodeStorageStatus | null };
	/** Failure domain (CLUSTERING §3.2). */
	zone: string;
	/** What the node may run; derived from mode/can_build when roles_json is null. */
	roles: NodeRole[];
	/** Operator labels. */
	labels: Record<string, string>;
	/** Operator labels plus derived `yoal.io/*` facts. */
	derivedLabels: Record<string, string>;
	/** Hardware facts plus the labels derived from them. */
	hardware: NodeHardware | null;
	hardwareAt: string | null;
	hardwareError: string | null;
	/** LAN address for direct peering inside one zone (C1). */
	lanEndpoint: string | null;
	/** The private network this node shares with others, for direct peering across zones and roles (D215). */
	privateNetwork: string | null;
	/** CPU reservation budget in millis; null means no explicit cap. */
	cpuBudgetMillis: number | null;
	/** Managed overlay address (C1); null on external nodes. */
	privateAddress: string | null;
	networkMode: NodeNetworkMode;
	/** Public key only; the private key never leaves the node. */
	wgPublicKey: string | null;
	wgEndpoint: string | null;
	wgListenPort: number | null;
	wireguardStatus: WireguardStatus | null;
	wireguardStatusAt: string | null;
	certificateFingerprint: string | null;
	certificateExpiresAt: string | null;
	/** Capabilities from the last heartbeat (`nodeCapabilities`); empty for older agents. */
	capabilities: string[];
	/** Outstanding or failed dashboard update (D99); null when none. */
	update: NodeUpdateView | null;
	createdAt: string;
}

export interface NodeUpdateView {
	version: string;
	requestedAt: string | null;
	/** `pending` until the agent reports `version`; `failed` once the node reported an error. */
	status: 'pending' | 'failed';
	error: string | null;
}

/** A requested node update counts as stale (shown as "no response") after this long. */
export const NODE_UPDATE_STALE_MS = 15 * 60 * 1000;

/** Desired-state reconciliation for nodes (DESIGN §3.3, D23). Agents pull; the control plane never pushes. */
export class NodeService {
	constructor(private readonly ctx: CoreContext) {}

	view(row: typeof nodesTable.$inferSelect): NodeView {
		const hardware = hardwareFor(row.hardwareJson);
		const labels = labelsFor(row.labelsJson);
		const certificate = this.ctx.db.select().from(nodeCertificates).where(eq(nodeCertificates.nodeId, row.id)).get();
		return {
			id: row.id,
			name: row.name,
			mode: row.mode,
			status: row.status,
			publicAddress: row.publicAddress,
			version: row.version,
			agentVersion: row.agentVersion,
			lastHeartbeatAt: row.lastHeartbeatAt ? new Date(row.lastHeartbeatAt).toISOString() : null,
			stats: parseJson(row.statsJson, null),
			canBuild: row.canBuild,
			sliceMemoryMb: row.sliceMemoryMb,
			sliceCpuWeight: row.sliceCpuWeight,
			storage: {
				dataDir: row.storageDataDir,
				buildDir: row.storageBuildDir,
				status: storageStatus(row.storageStatusJson),
			},
			zone: row.zone,
			roles: rolesFor(row),
			labels,
			derivedLabels: { ...labels, ...derivedLabelsFor(hardware) },
			hardware,
			hardwareAt: row.hardwareAt ? new Date(row.hardwareAt).toISOString() : null,
			hardwareError: row.hardwareError,
			lanEndpoint: row.lanEndpoint,
			privateNetwork: row.privateNetwork,
			cpuBudgetMillis: row.cpuBudgetMillis,
			privateAddress: row.privateAddress,
			networkMode: row.networkMode,
			wgPublicKey: row.wgPublicKey,
			wgEndpoint: row.wgEndpoint,
			wgListenPort: row.wgListenPort,
			wireguardStatus: wireguardStatusFor(row.wgStatusJson),
			wireguardStatusAt: row.wgStatusAt ? new Date(row.wgStatusAt).toISOString() : null,
			certificateFingerprint: certificate?.serial ?? null,
			certificateExpiresAt: certificate ? new Date(certificate.expiresAt).toISOString() : null,
			capabilities: capabilities(row.capabilitiesJson),
			update: row.updateVersion
				? {
						version: row.updateVersion,
						requestedAt: row.updateRequestedAt ? new Date(row.updateRequestedAt).toISOString() : null,
						status: row.updateFailedGeneration >= row.updateGeneration ? 'failed' : 'pending',
						error: row.updateError,
					}
				: null,
			createdAt: new Date(row.createdAt).toISOString(),
		};
	}

	/**
	 * Ask a node to install the control plane's own signed release (D99). This only records desired
	 * state: the agent picks it up on its next pull and hands the version to the helper's fixed
	 * `node/update` verb, which verifies the release signature before it replaces anything. Asking
	 * again after a failure is a retry (a new generation).
	 */
	requestUpdate(principal: Principal, nodeId: string): NodeView {
		this.assertPlatformAdmin(principal, 'platform:updates');
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node) throw new NotFoundError('Node');
		const target = parseSemver(this.ctx.config.desiredAgentVersion)?.version;
		if (!target)
			throw new ConflictError(
				`The control plane's version (${this.ctx.config.desiredAgentVersion ?? 'unknown'}) is not a release version, so there is no signed release to install.`,
			);
		const running = parseSemver(node.agentVersion);
		if (running && compareSemver(running, target) >= 0)
			throw new ConflictError(`"${node.name}" already runs ${running.version}.`);
		if (!capabilities(node.capabilitiesJson).includes('node-update'))
			throw new ConflictError(
				`"${node.name}" runs an agent (${node.agentVersion ?? 'unknown version'}) that cannot update itself yet. Update it by hand once (docs/OPS.md "Updating worker nodes"); later updates work from here.`,
			);
		// An operator's request is always a fresh attempt (a retry after "no answer" must re-run).
		this.scheduleUpdate(node.id, target, { principal, fresh: true });
		const after = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		return this.view(after ?? node);
	}

	/**
	 * Record that a node should install `target` (D99), for `requestUpdate` and fleet rollouts
	 * (CLUSTERING §3.11). An update already outstanding for the same version keeps its generation, so
	 * a rollout adopting a node an operator already asked to update does not restart the attempt.
	 * Returns the generation the agent will run. `fresh` always starts a new generation.
	 */
	scheduleUpdate(
		nodeId: string,
		target: string,
		actor: { principal?: Principal; rolloutId?: string; fresh?: boolean } = {},
	): number {
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node) throw new NotFoundError('Node');
		if (!actor.fresh && node.updateVersion === target && node.updateFailedGeneration < node.updateGeneration) return node.updateGeneration;
		const now = this.ctx.now();
		const generation = node.updateGeneration + 1;
		this.ctx.db
			.update(nodes)
			.set({
				updateVersion: target,
				updateGeneration: generation,
				updateRequestedAt: now,
				updateError: null,
				updatedAt: now,
			})
			.where(eq(nodes.id, nodeId))
			.run();
		this.ctx.audit.record({
			...(actor.principal ? { principal: actor.principal } : {}),
			action: 'node.update_agent',
			resource: 'node',
			resourceId: nodeId,
			args: {
				from: node.agentVersion,
				to: target,
				generation,
				...(actor.rolloutId ? { rolloutId: actor.rolloutId } : {}),
			},
			result: 'ok',
		});
		this.bump();
		return generation;
	}

	/** The update this node should run now, or null (none requested, done, or already failed). */
	private updateTaskFor(node: typeof nodesTable.$inferSelect): NodeUpdateTask | null {
		if (!node.updateVersion || node.updateFailedGeneration >= node.updateGeneration) return null;
		return {
			generation: node.updateGeneration,
			version: node.updateVersion,
			repo: this.ctx.config.releaseRepo ?? 'KieranHolroyd/yoal',
		};
	}

	/**
	 * Settle an outstanding update from a heartbeat: the reported version proves success; a failure
	 * report for the current generation stops the task until an operator retries.
	 */
	private settleUpdate(
		node: typeof nodesTable.$inferSelect,
		agentVersion: string,
		result: Heartbeat['nodeUpdateResult'],
	): Partial<typeof nodesTable.$inferInsert> {
		if (!node.updateVersion) return {};
		const running = parseSemver(agentVersion);
		if (running && compareSemver(running, node.updateVersion) >= 0) {
			this.ctx.audit.record({
				action: 'node.update_agent.done',
				resource: 'node',
				resourceId: node.id,
				args: { version: running.version, generation: node.updateGeneration },
				result: 'ok',
			});
			return { updateVersion: null, updateError: null, updateRequestedAt: null };
		}
		if (
			result &&
			result.generation === node.updateGeneration &&
			node.updateFailedGeneration < node.updateGeneration
		) {
			this.ctx.audit.record({
				action: 'node.update_agent.done',
				resource: 'node',
				resourceId: node.id,
				args: { version: node.updateVersion, generation: result.generation },
				result: 'error',
				error: result.error,
			});
			return { updateFailedGeneration: result.generation, updateError: result.error };
		}
		return {};
	}

	/**
	 * Platform-only: nodes and Caddy are global (DESIGN §6.2). Platform IAM decides the
	 * `platform:*` permission (IAM.md I24); the service keeps the pre-I8 admin flag as the fallback
	 * until bindings are seeded, and D129's session-only rule for `platform-admin`.
	 */
	private assertPlatformAdmin(
		principal: Principal,
		permission: PlatformPermission = 'platform:nodes',
	): void {
		if (this.ctx.platformIam.allows(principal, permission)) return;
		throw new CoreError(
			'forbidden',
			principal.platformAdmin
				? 'Fleet changes need a platform admin role signed in to the dashboard (not an API key or MCP token).'
				: 'Platform admin permission required.',
			403,
		);
	}

	list(principal: Principal): NodeView[] {
		this.assertPlatformAdmin(principal, 'platform:read');
		return this.ctx.db
			.select()
			.from(nodes)
			.orderBy(desc(nodes.createdAt))
			.all()
			.map((row) => this.view(row));
	}

	get(nodeId: string): NodeView {
		const row = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!row) throw new NotFoundError('Node');
		return this.view(row);
	}

	/** Single-use join token, valid for one hour. Returned in clear exactly once. */
	createJoinToken(principal: Principal, nodeName?: string): { token: string; expiresAt: string } {
		this.assertPlatformAdmin(principal);
		const token = randomToken(32);
		const now = this.ctx.now();
		const expiresAt = now + JOIN_TTL_MS;
		this.ctx.db
			.insert(nodeJoinTokens)
			.values({
				id: newId('njt_'),
				tokenHash: sha256Hex(token),
				nodeName: nodeName ?? null,
				createdBy: principal.userId,
				expiresAt,
				createdAt: now,
			})
			.run();
		this.ctx.audit.record({
			principal,
			action: 'node.join_token',
			resource: 'node',
			args: { nodeName },
			result: 'ok',
		});
		return { token, expiresAt: new Date(expiresAt).toISOString() };
	}

	/**
	 * `yoal agent join` consumes a one-time token and receives the node's long-lived token.
	 * The first node becomes the edge; later nodes are workers.
	 */
	join(input: {
		token: string;
		name: string;
		publicAddress?: string;
		version?: string;
		networkMode?: 'yoal' | 'external';
		wireguardPublicKey?: string;
	}): {
		nodeId: string;
		token: string;
		controlUrl: string;
		mode: 'edge' | 'worker';
		wireguard?: WireguardState;
	} {
		// A used token or a key another node holds is a 409 that says why, not a 500 (F11).
		assertJoinTokenUnused(this.ctx, input);
		const tokenHash = sha256Hex(input.token);
		const join = this.ctx.sqlite
			.query<{ id: string; expiresAt: number; usedAt: number | null }, [string]>(
				'SELECT id, expires_at AS expiresAt, used_at AS usedAt FROM node_join_tokens WHERE token_hash = ?',
			)
			.get(tokenHash);
		if (!join || join.usedAt || join.expiresAt < this.ctx.now())
			throw new UnauthorizedError('Invalid or expired join token.');
		const edgeCount = this.ctx.sqlite.query<{ n: number }, []>("SELECT count(*) AS n FROM nodes WHERE mode = 'edge'").get();
		const mode: 'edge' | 'worker' = (edgeCount?.n ?? 0) === 0 ? 'edge' : 'worker';
		const nodeId = newId('nod_');
		const nodeToken = randomToken(32);
		const now = this.ctx.now();
		const managed = input.networkMode === 'yoal';
		if (managed) {
			const key = input.wireguardPublicKey;
			if (!key || !wireguardPublicKeySchema.safeParse(key).success)
				throw new ValidationError('A managed overlay join needs the node\'s WireGuard public key.');
			assertJoinKeyFree(this.ctx, input);
		}
		const used = new Set(
			this.ctx.sqlite
				.query<{ address: string }, []>('SELECT private_address AS address FROM nodes WHERE private_address IS NOT NULL')
				.all()
				.map((row) => row.address),
		);
		const privateAddress = managed ? allocateOverlayAddress(this.ctx.cluster.get().overlay.cidr, used) : null;
		if (managed && !privateAddress)
			throw new ConflictError('The overlay CIDR has no free address. Widen it before adding another node.');
		// On the overlay the edge proxies to the overlay address, and `--public-address` is the
		// underlay endpoint other nodes dial for WireGuard: two different addresses.
		const listenPort = this.ctx.cluster.get().overlay.listenPort;
		const publicAddress = managed && privateAddress ? `${privateAddress}:8080` : (input.publicAddress ?? null);
		const wgEndpoint = managed && input.publicAddress ? withPort(input.publicAddress, listenPort) : null;
		this.ctx.sqlite.transaction(() => {
			this.ctx.sqlite.run(
				`INSERT INTO nodes (
					id, name, mode, status, public_address, version, token_hash, created_at, updated_at,
					private_address, private_cidr, wg_public_key, network_mode, wg_endpoint, wg_listen_port
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					nodeId,
					input.name,
					mode,
					'online',
					publicAddress,
					input.version ?? null,
					sha256Hex(nodeToken),
					now,
					now,
					privateAddress,
					managed ? this.ctx.cluster.get().overlay.cidr : null,
					managed ? input.wireguardPublicKey ?? null : null,
					managed ? 'yoal' : 'external',
					wgEndpoint,
					managed ? listenPort : null,
				],
			);
			this.ctx.sqlite.run('UPDATE node_join_tokens SET used_at = ?, used_by_node_id = ? WHERE id = ?', [now, nodeId, join.id]);
		})();
		this.ctx.audit.record({
			action: 'node.join',
			resource: 'node',
			resourceId: nodeId,
			args: { name: input.name, mode },
			result: 'ok',
		});
		this.bump();
		return {
			nodeId,
			token: nodeToken,
			controlUrl: this.ctx.config.platformOrigin,
			mode,
			...(managed
				? {
						wireguard: (() => {
							const cfg = this.ctx.cluster.get().overlay;
							return buildWireguardState(nodeId, this.overlayNodes(), cfg.cidr, cfg);
						})(),
					}
				: {}),
		};
	}

	authenticate(token: string): typeof nodesTable.$inferSelect {
		const row = this.ctx.db.select().from(nodes).where(eq(nodes.tokenHash, sha256Hex(token))).get();
		if (!row) throw new UnauthorizedError('Unknown node token');
		return row;
	}

	heartbeat(token: string, input: Heartbeat): { ok: true; desiredStateVersion: number } {
		const node = this.authenticate(token);
		if (node.id !== input.nodeId) throw new UnauthorizedError('Node id does not match token');
		const now = this.ctx.now();
		this.storeCertificate(node.id, input.nodeCertificate, now);
		// A node that advertises `endpoints-gateway` sends its CSR here; only the public request
		// travels and the install CA signs it (HA-PLAN H24 "Trust").
		if (input.nodeCsr && featureEnabled(this.ctx.config, 'ENDPOINTS_GATEWAY') && (input.capabilities ?? []).includes(ENDPOINTS_GATEWAY_CAPABILITY)) {
			try {
				this.ctx.nodeCa.signCsr(node.id, input.nodeCsr);
			} catch (cause) {
				console.error(`[nodes] refused the certificate request from ${node.name}:`, (cause as Error).message);
			}
		}
		// A node moved onto the overlay after it joined (`adoptOverlay`) has an address but no key
		// until its helper reports one. Only the first key is taken: a different key later is a
		// re-key the operator must do by re-adopting, not something a heartbeat may change.
		const adoptedKey =
			node.networkMode !== 'external' && !node.wgPublicKey && input.wireguardPublicKey ? input.wireguardPublicKey : null;
		const settled = this.settleUpdate(node, input.agentVersion, input.nodeUpdateResult);
		this.ctx.db
			.update(nodes)
			.set({
				// Draining is an operator decision; the agent's liveness report must not undo it.
				status: node.status === 'draining' ? 'draining' : input.status,
				agentVersion: input.agentVersion,
				// An agent that predates capabilities declares none, so work it would ignore is refused.
				capabilitiesJson: JSON.stringify(input.capabilities ?? []),
				// Ingress drift (HA-PLAN W6): the applied version, and when it last changed rather than
				// every heartbeat, so "behind for two minutes" survives a control-plane restart.
				actualStateVersion: input.actualStateVersion,
				actualStateAt:
					node.actualStateVersion === input.actualStateVersion ? node.actualStateAt : now,
				...hardwarePatch(input.hardware, now),
				...wireguardStatusPatch(input.wireguard, now),
				...(adoptedKey ? { wgPublicKey: adoptedKey } : {}),
				...settled,
				lastHeartbeatAt: now,
				statsJson: input.stats ? JSON.stringify(input.stats) : node.statsJson,
				storageStatusJson: input.storage ? JSON.stringify(input.storage) : node.storageStatusJson,
				updatedAt: now,
			})
			.where(eq(nodes.id, node.id))
			.run();
		// The fleet certificate fingerprint this ingress serves (HA-PLAN H20, W7). Ignored while
		// `SHARED_CERTIFICATES` is off, so the single-node install reports nothing new.
		if (input.certificateFingerprint !== undefined)
			this.ctx.certificates.report(node.id, input.certificateFingerprint);
		// Every peer's desired state now carries this node's key.
		if (adoptedKey) this.bump();
		if (input.workloads?.length) {
			this.ctx.workloads.applyHeartbeat(node.id, input.workloads, input.actualStateVersion);
			this.ctx.scaling.applyUsage(node.id, input.workloads);
			this.ctx.databases.applyHeartbeat(node.id, input.workloads);
			this.ctx.storage.applyHeartbeat(node.id, input.workloads);
			this.ctx.brokers.applyHeartbeat(node.id, input.workloads);
			this.ctx.kubernetes.applyHeartbeat(node.id, input.workloads);
			this.ctx.registry.applyHeartbeat(node.id, input.workloads);
			this.ctx.databaseReplicas.applyWorkloadReports(node.id, input.workloads);
		}
		// Release-phase reports (H25): an outcome closes a run's lease; the edge's own counters are
		// what the canary judge reads, never ClickHouse (H28).
		if (input.releaseCommandResults?.length)
			this.ctx.releaseCommands.recordResults(node.id, input.releaseCommandResults);
		if (input.upstreamCounters?.length)
			this.ctx.workloads.recordUpstreamCounters(node.id, input.upstreamCounters);
		if (input.databaseReplication?.length)
			this.ctx.databaseReplicas.applyReplicationReports(node.id, input.databaseReplication);
		if (input.databaseReplicaPromotionResults?.length)
			this.ctx.databaseReplicas.applyPromotionResults(node.id, input.databaseReplicaPromotionResults);
		// W10: member roles, sync steps, switchover drain/resume and rewind outcomes.
		if (input.databaseMembers?.length) this.ctx.databaseMembers.applyMemberReports(node.id, input.databaseMembers);
		if (input.databaseSyncResults?.length)
			void this.ctx.databaseMembers
				.applySyncResults(node.id, input.databaseSyncResults)
				.catch((error: unknown) => console.error(`[database-members] sync result: ${(error as Error).message}`));
		if (input.databaseSwitchoverResults?.length)
			this.ctx.databaseMembers.applySwitchoverResults(node.id, input.databaseSwitchoverResults);
		if (input.databaseRewindResults?.length)
			this.ctx.databaseMembers.applyRewindResults(node.id, input.databaseRewindResults);
		if (input.databaseBackupResults?.length)
			this.ctx.databases.applyBackupResults(node.id, input.databaseBackupResults);
		if (input.databasePitrResults?.length)
			this.ctx.databases.applyPitrResults(node.id, input.databasePitrResults);
		if (input.databaseRotationResults?.length)
			this.ctx.databases.applyRotationResults(node.id, input.databaseRotationResults);
		if (input.databaseCredentialResults?.length)
			this.ctx.databases.applyCredentialResults(node.id, input.databaseCredentialResults);
		if (input.databaseStudioPrincipalResults?.length)
			this.ctx.databaseStudio.principals.applyResults(node.id, input.databaseStudioPrincipalResults);
		if (input.databasePoolerRestarted?.length)
			this.ctx.databases.applyPoolerRestarted(node.id, input.databasePoolerRestarted);
		if (input.databaseTls?.length) this.ctx.databases.applyTlsReport(node.id, input.databaseTls);
		if (input.purgedDatabases?.length) {
			this.ctx.databases.applyPurged(node.id, input.purgedDatabases);
			this.ctx.moves.onPurged(node.id, input.purgedDatabases);
			this.ctx.databaseReplicas.applyPurged(node.id, input.purgedDatabases);
		}
		if (input.purgedStorage?.length) this.ctx.storage.applyPurged(node.id, input.purgedStorage);
		if (input.purgedBrokers?.length) this.ctx.brokers.applyPurged(node.id, input.purgedBrokers);
		if (input.purgedKubernetes?.length) this.ctx.kubernetes.applyPurged(node.id, input.purgedKubernetes);
		if (input.kubernetesStatus?.length) this.ctx.kubernetes.ingestStatus(node.id, input.kubernetesStatus);
		this.ctx.kubernetes.applyComponentReport(node.id, input.kubernetes);
		if (input.kubernetesBackupResults?.length) this.ctx.kubernetes.applyBackupResults(node.id, input.kubernetesBackupResults);
		if (input.kubernetesComponentResult) this.ctx.kubernetes.applyComponentResult(node.id, input.kubernetesComponentResult);
		if (input.appVolumeUsage?.length) this.ctx.appVolumes.lifecycle.applyUsage(node.id, input.appVolumeUsage);
		if (input.appVolumeTaskResults?.length)
			this.ctx.appVolumes.lifecycle.applyTaskResults(node.id, input.appVolumeTaskResults);
		if (input.purgedAppVolumes?.length) this.ctx.appVolumes.lifecycle.applyPurged(node.id, input.purgedAppVolumes);
		if (input.storageBucketDeletions?.length)
			this.ctx.storage.applyBucketDeletions(node.id, input.storageBucketDeletions);
		if (input.storageBucketConfigs?.length)
			this.ctx.storage.applyBucketConfigReports(node.id, input.storageBucketConfigs);
		if (input.storageRootKeys?.length) this.ctx.storage.applyRootKeyReports(node.id, input.storageRootKeys);
		if (input.storageReplication?.length)
			this.ctx.storageReplication.applyReports(node.id, input.storageReplication);
		// Disks first (capacity, missing mounts, Yoal mounts turning ready), then share mounts, which
		// register a mounted share as a disk once the inventory shows it (docs/STORAGE.md §3).
		if (input.volumes) this.ctx.disks.applyInventory(node.id, input.volumes);
		this.ctx.disks.applyMountReport(node.id, input.diskMounts, input.unmountedDisks);
		this.ctx.shares.applyNodeReport(node.id, input.shareMounts, input.unmountedShares);
		if (input.volumeProfileResults?.length) this.ctx.disks.applyProfileResults(node.id, input.volumeProfileResults);
		if (input.links?.length) this.ctx.links.applySamples(node.id, input.links);
		if (input.linkTestResults?.length) this.ctx.links.applyTestResults(node.id, input.linkTestResults);
		// Custom domains go `active` once an edge reports serving their certificate.
		if (input.stats?.certs?.length) {
			try {
				this.ctx.domains.applyServedCertificates(input.stats.certs);
			} catch (cause) {
				console.error('[nodes] could not apply certificate report:', cause);
			}
		}
		// A database move waits for its source to stop the attached apps before dumping (D97).
		this.ctx.moves.onHeartbeat(node.id, input.actualStateVersion, (input.workloads ?? []).map((item) => item.id));
		this.ctx.relocations.onHeartbeat(node.id, input.actualStateVersion, (input.workloads ?? []).map((item) => item.id));
		// A replica promotion waits for the old primary's node to stop it (C7, §9.3).
		this.ctx.databaseReplicas.onHeartbeat(node.id, input.actualStateVersion, (input.workloads ?? []).map((item) => item.id));
		// A fleet rollout waiting on this node's update hears about it now rather than on its next
		// poll; last, so its checks see the workload statuses this heartbeat carried (CLUSTERING §3.11).
		if (Object.keys(settled).length > 0) this.ctx.nodeRollouts?.nodeSettled(node.id);
		return { ok: true, desiredStateVersion: this.stateVersion() };
	}

	/** Called by the maintenance sweep; returns nodes that just went offline. */
	markStale(): Array<{ nodeId: string; offlineForMs: number }> {
		const now = this.ctx.now();
		const stale = this.ctx.db
			.select()
			.from(nodes)
			.where(and(eq(nodes.status, 'online'), sql`coalesce(${nodes.lastHeartbeatAt}, ${nodes.createdAt}) < ${now - OFFLINE_AFTER_MS}`))
			.all();
		for (const node of stale)
			this.ctx.db.update(nodes).set({ status: 'offline', updatedAt: now }).where(eq(nodes.id, node.id)).run();
		return stale.map((node) => ({ nodeId: node.id, offlineForMs: now - (node.lastHeartbeatAt ?? node.createdAt) }));
	}

	/**
	 * Every node that is currently unhealthy, for alerting (DESIGN §8: node offline > 2 min).
	 * `no_heartbeat` nodes carry how long they have been silent; `caddy_down` nodes still
	 * heartbeat but report that their proxy is not serving, so the caller tracks the duration.
	 */
	unhealthy(): UnhealthyNode[] {
		const now = this.ctx.now();
		return this.ctx.db
			.select()
			.from(nodes)
			.all()
			.flatMap((node): UnhealthyNode[] => {
				const last = node.lastHeartbeatAt ?? node.createdAt;
				if (last < now - OFFLINE_AFTER_MS)
					return [{ nodeId: node.id, name: node.name, reason: 'no_heartbeat' as const, offlineForMs: now - last }];
				if (node.status === 'offline')
					return [{ nodeId: node.id, name: node.name, reason: 'caddy_down' as const, offlineForMs: null }];
				return [];
			});
	}

	setDraining(principal: Principal, nodeId: string, draining: boolean): NodeView {
		this.assertPlatformAdmin(principal, 'platform:drain');
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node) throw new NotFoundError('Node');
		this.ctx.db
			.update(nodes)
			.set({ status: draining ? 'draining' : 'online', updatedAt: this.ctx.now() })
			.where(eq(nodes.id, nodeId))
			.run();
		this.bump();
		return this.view({ ...node, status: draining ? 'draining' : 'online' });
	}

	/** Mark a node as a git Builder (D3). Only a platform admin may change fleet-wide roles. */
	setBuilder(principal: Principal, nodeId: string, builder: boolean): NodeView {
		this.assertPlatformAdmin(principal);
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node) throw new NotFoundError('Node');
		this.ctx.db
			.update(nodes)
			.set({ canBuild: builder, updatedAt: this.ctx.now() })
			.where(eq(nodes.id, nodeId))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'node.set_builder',
			resource: 'node',
			resourceId: nodeId,
			args: { builder },
			result: 'ok',
		});
		return this.view({ ...node, canBuild: builder });
	}

	/**
	 * Hand the edge role to another node (D98). The roles swap: the target terminates ingress and
	 * serves every static site, the old edge becomes a worker that keeps what was admitted to it.
	 * Everything follows from desired state, so both agents converge on their next pull. Outside
	 * Yoal the operator still points DNS at the new edge and gives it TLS settings; that is why the
	 * dashboard asks for a typed confirmation.
	 */
	setEdge(principal: Principal, nodeId: string): NodeView {
		this.assertPlatformAdmin(principal);
		if (this.ctx.config.edgeNodeId)
			throw new ConflictError(
				'YOAL_EDGE_NODE_ID pins the edge in the control plane environment. Change it there and restart the control plane.',
			);
		const target = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!target) throw new NotFoundError('Node');
		if (target.mode === 'edge') throw new ConflictError(`"${target.name}" is already the edge node.`);
		if (target.status !== 'online')
			throw new ConflictError(`"${target.name}" is ${target.status}; only an online node can take over ingress.`);
		const previous = this.ctx.db.select().from(nodes).where(eq(nodes.mode, 'edge')).get();
		// The new edge proxies to whatever stays on the old one, so it needs an address to reach it.
		if (previous && !previous.publicAddress) {
			const blockers = this.removalBlockers(previous.id);
			if (blockers.length)
				throw new ConflictError(
					`"${previous.name}" still hosts ${blockers.join('; ')}, and has no address the new edge could proxy to. Give it one (Edit node) or move them first.`,
				);
		}

		const now = this.ctx.now();
		this.ctx.db.transaction(() => {
			if (previous)
				this.ctx.db.update(nodes).set({ mode: 'worker', updatedAt: now }).where(eq(nodes.id, previous.id)).run();
			this.ctx.db.update(nodes).set({ mode: 'edge', updatedAt: now }).where(eq(nodes.id, nodeId)).run();
		});
		this.ctx.audit.record({
			principal,
			action: 'node.set_edge',
			resource: 'node',
			resourceId: nodeId,
			args: { name: target.name, previous: previous ? { id: previous.id, name: previous.name } : null },
			result: 'ok',
		});
		this.bump();
		// The old edge leaves the ingress set, and its copy of the wildcard key must be replaced.
		if (previous) this.ctx.certificates.onIngressRemoved(previous.id);
		return this.view({ ...target, mode: 'edge', updatedAt: now });
	}

	/**
	 * Edit operator settings: name, the address the edge proxies to, the workload-slice budget and
	 * the Builder role. The slice budget cannot drop below what admitted workloads already reserve
	 * (D42), because the kernel limit would then OOM-kill workloads the control plane accepted.
	 * Every change is in desired state, so agents converge on their next pull.
	 */
	/**
	 * Move a node that joined with host-provided networking onto the managed overlay (C1): give it
	 * an overlay address and record the underlay endpoint other nodes dial. Its helper creates the
	 * key pair when it first applies the overlay, and the heartbeat stores the public key.
	 * Workloads keep running; upstreams move to the overlay address once the key arrives.
	 */
	adoptOverlay(principal: Principal, nodeId: string, input: { endpoint?: string | null }): NodeView {
		this.assertPlatformAdmin(principal);
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node) throw new NotFoundError('Node');
		if (node.networkMode !== 'external') throw new ConflictError(`"${node.name}" is already on the managed overlay.`);
		const { cidr, listenPort } = this.ctx.cluster.get().overlay;
		const endpoint = input.endpoint?.trim() ? withPort(input.endpoint.trim(), listenPort) : null;
		if (endpoint && !/^[A-Za-z0-9.\-[\]:]+$/.test(endpoint))
			throw new ValidationError('The endpoint is host or host:port, without a scheme or path.');
		const used = new Set(
			this.ctx.sqlite
				.query<{ address: string }, []>('SELECT private_address AS address FROM nodes WHERE private_address IS NOT NULL')
				.all()
				.map((row) => row.address),
		);
		const privateAddress = allocateOverlayAddress(cidr, used);
		if (!privateAddress) throw new ConflictError('The overlay CIDR has no free address. Widen it before adding another node.');
		const now = this.ctx.now();
		const changes = {
			networkMode: 'yoal' as const,
			privateAddress,
			privateCidr: cidr,
			wgEndpoint: endpoint,
			wgListenPort: listenPort,
			wgPublicKey: null,
			// The edge keeps serving its own routes on loopback; a worker is proxied on the overlay.
			...(node.mode === 'edge' ? {} : { publicAddress: `${privateAddress}:8080` }),
			updatedAt: now,
		};
		this.ctx.db.update(nodes).set(changes).where(eq(nodes.id, nodeId)).run();
		this.ctx.audit.record({
			principal,
			action: 'node.overlay_adopt',
			resource: 'node',
			resourceId: nodeId,
			args: { privateAddress, endpoint },
			result: 'ok',
		});
		this.bump();
		return this.view({ ...node, ...changes });
	}

	update(principal: Principal, nodeId: string, input: NodeUpdate): NodeView {
		this.assertPlatformAdmin(principal);
		const reservedLabel = Object.keys(input.labels ?? {}).find((key) => key.startsWith('yoal.io/'));
		if (reservedLabel)
			throw new ValidationError(
				`Label "${reservedLabel}" uses yoal.io/, which is reserved for derived hardware facts.`,
			);
		const parsed = nodeUpdateSchema.safeParse(input);
		if (!parsed.success)
			throw new ValidationError(parsed.error.issues.map((issue) => issue.message).join('; '));
		const patch = parsed.data;
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node) throw new NotFoundError('Node');

		if (patch.sliceMemoryMb !== undefined && patch.sliceMemoryMb < node.sliceMemoryMb) {
			const reserved =
				this.ctx.workloads.capacityInternal().find((item) => item.nodeId === nodeId)?.reservedMemoryMb ?? 0;
			if (patch.sliceMemoryMb < reserved)
				throw new ValidationError(
					`Workloads on ${node.name} already reserve ${reserved} MB; the slice budget cannot be lower than that. Move or shrink workloads first.`,
				);
		}

		const changes: Partial<typeof nodesTable.$inferInsert> = {};
		let removedRoles: NodeRole[] = [];
		if (patch.name !== undefined && patch.name !== node.name) changes.name = patch.name;
		if (patch.publicAddress !== undefined) {
			const address = patch.publicAddress || null;
			if (address !== node.publicAddress) changes.publicAddress = address;
		}
		if (patch.sliceMemoryMb !== undefined && patch.sliceMemoryMb !== node.sliceMemoryMb)
			changes.sliceMemoryMb = patch.sliceMemoryMb;
		if (patch.sliceCpuWeight !== undefined && patch.sliceCpuWeight !== node.sliceCpuWeight)
			changes.sliceCpuWeight = patch.sliceCpuWeight;
		if (patch.canBuild !== undefined && patch.canBuild !== node.canBuild) changes.canBuild = patch.canBuild;
		if (patch.zone !== undefined && patch.zone !== node.zone) changes.zone = patch.zone;
		if (patch.roles !== undefined) {
			const next = [...new Set(patch.roles)] as NodeRole[];
			const removed = rolesFor(node).filter((role) => !next.includes(role));
			if (removed.length) this.assertRolesRemovable(node, removed);
			removedRoles = removed;
			if (JSON.stringify(next) !== node.rolesJson) changes.rolesJson = JSON.stringify(next);
		}
		if (patch.labels !== undefined) {
			const next = patch.labels;
			if (JSON.stringify(next) !== JSON.stringify(labelsFor(node.labelsJson)))
				changes.labelsJson = JSON.stringify(next);
		}
		if (patch.lanEndpoint !== undefined) {
			const next = patch.lanEndpoint || null;
			if (next !== node.lanEndpoint) changes.lanEndpoint = next;
		}
		if (patch.privateNetwork !== undefined) {
			const next = patch.privateNetwork || null;
			if (next !== node.privateNetwork) changes.privateNetwork = next;
		}
		if (patch.cpuBudgetMillis !== undefined) {
			const next = patch.cpuBudgetMillis ?? null;
			if (next !== node.cpuBudgetMillis) changes.cpuBudgetMillis = next;
		}
		const dataDir = patch.dataDir === undefined ? node.storageDataDir : patch.dataDir || null;
		const buildDir = patch.buildDir === undefined ? node.storageBuildDir : patch.buildDir || null;
		if (dataDir && buildDir && (dataDir === buildDir || dataDir.startsWith(`${buildDir}/`) || buildDir.startsWith(`${dataDir}/`)))
			throw new ValidationError('The data and build directories must be separate; neither may contain the other.');
		if (dataDir !== node.storageDataDir) changes.storageDataDir = dataDir;
		if (buildDir !== node.storageBuildDir) changes.storageBuildDir = buildDir;
		if (Object.keys(changes).length === 0) return this.view(node);

		const now = this.ctx.now();
		this.ctx.db
			.update(nodes)
			.set({ ...changes, updatedAt: now })
			.where(eq(nodes.id, nodeId))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'node.update',
			resource: 'node',
			resourceId: nodeId,
			args: changes,
			result: 'ok',
		});
		// Address, slice and storage changes all reach agents through desired state.
		this.bump();
		// Removing the ingress role takes the key away with the payload, but not from the machine:
		// every ACME certificate is reissued (HA-PLAN H20, CLUSTERING §7.3 "Key security").
		if (removedRoles.includes('ingress')) this.ctx.certificates.onIngressRemoved(nodeId);
		return this.view({ ...node, ...changes, updatedAt: now });
	}

	/** Refuse dropping a role while resources placed under it still run on the node. */
	private assertRolesRemovable(node: typeof nodesTable.$inferSelect, removed: NodeRole[]): void {
		const blockers: string[] = [];
		if ((removed.includes('ingress') || removed.includes('control')) && node.mode === 'edge')
			blockers.push('it is the edge and terminates ingress');
		if (removed.includes('compute')) {
			const running = this.ctx.db
				.select({ id: workloads.id })
				.from(workloads)
				.where(eq(workloads.nodeId, node.id))
				.all();
			if (running.length) blockers.push(`${running.length} app workload(s)`);
		}
		if (removed.includes('data')) {
			const dbs = this.ctx.db
				.select({ id: databases.id })
				.from(databases)
				.where(and(eq(databases.nodeId, node.id), isNull(databases.deletedAt)))
				.all();
			const stores = this.ctx.db
				.select({ id: storageInstances.id })
				.from(storageInstances)
				.where(and(eq(storageInstances.nodeId, node.id), isNull(storageInstances.deletedAt)))
				.all();
			if (dbs.length) blockers.push(`${dbs.length} database(s)`);
			if (stores.length) blockers.push(`${stores.length} storage instance(s)`);
		}
		if (blockers.length)
			throw new ConflictError(
				`"${node.name}" still runs ${blockers.join(' and ')}. Move or delete them before removing a role.`,
			);
	}

	/**
	 * Storage paths for the node's root `yoal-storage.service`. It asks the control plane rather
	 * than trusting the request file the agent drops, so only a platform admin picks paths (D48).
	 */
	storageFor(token: string): NodeStorage {
		return this.effectiveStorage(this.authenticate(token));
	}

	/**
	 * D48 directories the node should use: its explicit setting, else the most-free local ready disk
	 * of the `site-data` / `builds` default tier on this node (docs/STORAGE.md §2.2), else the
	 * install default.
	 */
	effectiveStorage(node: { id: string; storageDataDir: string | null; storageBuildDir: string | null }): NodeStorage {
		return {
			dataDir: node.storageDataDir ?? this.ctx.disks.nodeDirectory('site-data', node.id),
			buildDir: node.storageBuildDir ?? this.ctx.disks.nodeDirectory('builds', node.id),
		};
	}

	rotateToken(principal: Principal, nodeId: string): { token: string } {
		this.assertPlatformAdmin(principal);
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node) throw new NotFoundError('Node');
		const token = randomToken(32);
		this.ctx.db.update(nodes).set({ tokenHash: sha256Hex(token), updatedAt: this.ctx.now() }).where(eq(nodes.id, nodeId)).run();
		this.ctx.audit.record({ principal, action: 'node.rotate_token', resource: 'node', resourceId: nodeId, result: 'ok' });
		return { token };
	}

	/**
	 * What still lives on a node and so blocks removing it. Removal never moves or deletes data:
	 * the operator relocates or deletes these first, exactly as removing a disk works (D169).
	 * Soft-deleted rows do not count; their purge simply never runs once the node is gone.
	 */
	removalBlockers(nodeId: string): string[] {
		const names = (rows: Array<{ name: string }>) => rows.map((row) => `"${row.name}"`);
		const blockers: string[] = [];
		const placed = this.ctx.db
			.select({ name: projects.name })
			.from(projects)
			.where(and(eq(projects.placement, nodeId), isNull(projects.deletedAt)))
			.all();
		if (placed.length) blockers.push(`projects placed on it (${names(placed).join(', ')})`);
		const running = this.ctx.db
			.select({ name: projects.name })
			.from(workloads)
			.innerJoin(projects, eq(projects.id, workloads.projectId))
			.where(and(eq(workloads.nodeId, nodeId), isNull(projects.deletedAt)))
			.all();
		if (running.length) blockers.push(`app workloads (${names(running).join(', ')})`);
		const dbs = this.ctx.db
			.select({ name: databases.name })
			.from(databases)
			.where(and(eq(databases.nodeId, nodeId), isNull(databases.deletedAt)))
			.all();
		if (dbs.length) blockers.push(`databases (${names(dbs).join(', ')})`);
		const stores = this.ctx.db
			.select({ name: storageInstances.name })
			.from(storageInstances)
			.where(and(eq(storageInstances.nodeId, nodeId), isNull(storageInstances.deletedAt)))
			.all();
		if (stores.length) blockers.push(`storage instances (${names(stores).join(', ')})`);
		const volumes = this.ctx.db
			.select({ name: appVolumes.name })
			.from(appVolumes)
			.where(and(eq(appVolumes.nodeId, nodeId), isNull(appVolumes.deletedAt)))
			.all();
		if (volumes.length) blockers.push(`app volumes (${names(volumes).join(', ')})`);
		const moving = this.ctx.moves.nodeBlockers(nodeId);
		if (moving.length) blockers.push(`database moves in progress (${moving.join(', ')})`);
		// A live read replica must be removed first; one already being removed is forgotten (C7).
		const replicaCount = this.ctx.databaseReplicas.liveCountOnNode(nodeId);
		if (replicaCount) blockers.push(`database replicas (${replicaCount}; remove them first)`);
		return blockers;
	}

	/**
	 * Forget a worker node: its token stops working at once, its disk registrations and studio
	 * sessions go, and builds it had claimed return to the queue. History (deployments, builds,
	 * logs, audit) keeps the node id. The edge cannot be removed — it terminates ingress — and a
	 * node that still hosts anything is refused with the list of what to move first. Nothing on
	 * the machine itself changes; the operator uninstalls the agent there.
	 */
	remove(principal: Principal, nodeId: string): { ok: true; requeuedBuilds: number } {
		this.assertPlatformAdmin(principal);
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node) throw new NotFoundError('Node');
		if (this.ctx.ingressSet.isIngress(nodeId))
			throw new ConflictError(
				`"${node.name}" is an ingress node (an edge node). It terminates ingress for every site, so it cannot be removed.`,
			);
		const blockers = this.removalBlockers(nodeId);
		if (blockers.length)
			throw new ConflictError(
				`"${node.name}" still hosts ${blockers.join('; ')}. Move or delete them first.`,
			);

		// Before the row goes: if it terminated ingress, certificates it held are reissued. The call
		// is a no-op while `SHARED_CERTIFICATES` is off or no certificate exists.
		const allNodes = this.ctx.db.select({ id: nodes.id, mode: nodes.mode, rolesJson: nodes.rolesJson }).from(nodes).all();
		const terminatedIngress =
			isIngressNode(nodeId, ingressNodeIds(allNodes, this.ctx.config.edgeNodeId ?? null)) ||
			nodeRoles(node).includes('ingress');
		if (terminatedIngress) this.ctx.certificates.onIngressRemoved(nodeId);
		let requeuedBuilds = 0;
		this.ctx.db.transaction(() => {
			requeuedBuilds = this.ctx.builds.releaseNodeClaims(nodeId);
			this.ctx.pipelines.engine.releaseNode(nodeId);
			this.ctx.db.delete(databaseStudioSessions).where(eq(databaseStudioSessions.nodeId, nodeId)).run();
			this.ctx.disks.forgetNode(nodeId);
			// Share mounts on it are forgotten with it; the share definitions stay.
			this.ctx.db.delete(shareMounts).where(eq(shareMounts.nodeId, nodeId)).run();
			// Its certificates stay trusted by every peer until revoked; do it with the removal.
			this.ctx.nodeCa.revoke(nodeId, 'node removed');
			this.ctx.db.delete(serviceEndpoints).where(eq(serviceEndpoints.consumerNodeId, nodeId)).run();
			this.ctx.db.delete(serviceEndpoints).where(eq(serviceEndpoints.upstreamNodeId, nodeId)).run();
			this.ctx.db.delete(nodes).where(eq(nodes.id, nodeId)).run();
			// A removed node can never confirm a purge an earlier move left for it.
			this.ctx.moves.forgetNode(nodeId);
			this.ctx.databaseReplicas.forgetNode(nodeId);
		});
		this.ctx.audit.record({
			principal,
			action: 'node.remove',
			resource: 'node',
			resourceId: nodeId,
			args: { name: node.name, mode: node.mode, publicAddress: node.publicAddress, requeuedBuilds },
			result: 'ok',
		});
		// The edge drops any proxy routes that pointed at this node on its next pull.
		this.bump();
		return { ok: true, requeuedBuilds };
	}

	stateVersion(): number {
		return this.ctx.projects.stateVersion();
	}

	bump(): void {
		this.ctx.projects.bump();
	}

	/** Provider-side overlay listeners for services this node hosts (C2, C7); see `desired-state/endpoints.ts`. */
	serviceProvidersForNode(nodeId: string): ServiceProvider[] {
		return new EndpointState(this.ctx).serviceProvidersForNode(nodeId);
	}

	/** Upsert the public node certificate; the private key never reaches this process. */
	private storeCertificate(nodeId: string, certificate: NodeIdentityCertificate | undefined, now: number): void {
		if (!certificate) return;
		const expiresAt = Date.parse(certificate.expiresAt);
		if (!Number.isFinite(expiresAt)) return;
		const existing = this.ctx.db
			.select({ nodeId: nodeCertificates.nodeId })
			.from(nodeCertificates)
			.where(eq(nodeCertificates.nodeId, nodeId))
			.get();
		if (existing) {
			this.ctx.db
				.update(nodeCertificates)
				.set({
					serial: certificate.fingerprint,
					certPem: certificate.certPem,
					issuedAt: now,
					expiresAt,
					revokedAt: null,
				})
				.where(eq(nodeCertificates.nodeId, nodeId))
				.run();
		} else {
			this.ctx.db
				.insert(nodeCertificates)
				.values({
					nodeId,
					serial: certificate.fingerprint,
					certPem: certificate.certPem,
					caSerial: null,
					issuedAt: now,
					expiresAt,
					revokedAt: null,
				})
				.run();
		}
	}

	/** Full rows as the pure peer-graph builder needs them. */
	private overlayNodes(): OverlayNode[] {
		return this.ctx.db
			.select()
			.from(nodes)
			.all()
			.map((row) => ({
				id: row.id,
				name: row.name,
				zone: row.zone,
				roles: rolesFor(row),
				networkMode: row.networkMode,
				privateAddress: row.privateAddress,
				wgPublicKey: row.wgPublicKey,
				publicAddress: row.publicAddress,
				wgEndpoint: row.wgEndpoint,
				lanEndpoint: row.lanEndpoint,
				privateNetwork: row.privateNetwork,
				// Only nodes with the Kubernetes component carry a machine subnet (docs/KUBERNETES.md §10).
				machineSubnet: capabilities(row.capabilitiesJson).includes(KUBERNETES_CAPABILITY)
					? machineSubnetFor(row.privateAddress)
					: null,
				acceptsSubnets: capabilities(row.capabilitiesJson).includes(WG_SUBNETS_CAPABILITY),
			}));
	}

	/**
	 * Everything this node must converge to: releases, production and preview routes, redirects,
	 * revocations. Built fresh on every pull and cached by the agent.
	 *
	 * Each concern is built by its own part in `./desired-state/` (routes and site config, releases
	 * and workloads, endpoints, databases, ingress) over one shared `DesiredStateContext`. This
	 * composes them, in the order the fields have always been built and emitted, and
	 * `desired-state/golden.test.ts` pins the result.
	 */
	async desiredState(token: string): Promise<DesiredState> {
		const node = this.authenticate(token);
		const state = new DesiredStateContext(this.ctx, node);
		const { now, allNodes, ingressId, isIngress } = state;
		const routeState = new RouteState(state);
		const ingress = new IngressState(state);
		const releaseState = new ReleaseState(state);
		const endpoints = new EndpointState(this.ctx);

		const deploymentRoutes = routeState.deploymentRoutes();
		const { routes } = deploymentRoutes;
		const environmentRoutes = new EnvironmentRouteState(state).environmentRoutes(deploymentRoutes);
		const placeholders = ingress.placeholders(deploymentRoutes, environmentRoutes);
		// A node leased a release command needs that release (process apps) before it can run it.
		const releasePhase = nodeHasCapability(node, RELEASE_PHASE_CAPABILITY);
		if (releasePhase)
			for (const sha of this.ctx.releaseCommands.releaseShasForNode(node.id)) deploymentRoutes.releaseShas.add(sha);
		const releaseSpecs = await releaseState.releaseSpecs(deploymentRoutes.releaseShas);
		const hostRedirects = routeState.hostRedirects();
		const workloadRows = releaseState.workloads();
		// Custom domains always clone the production route (stream B), so only projects with a
		// production pointer are candidates; staging-only projects must not serve them.
		const servedProjectIds = environmentRoutes.productionProjectIds;
		const databaseGateway = ingress.databaseGateway();

		// The separate user-pool identity process (IAM.md §11.2): one node per install. An operator
		// pins it with the `identity.node_id` setting; otherwise the edge or the first online capable
		// node wins. Scale-out later places pools individually; this scaffold sends every enabled
		// pool to that one node.
		const identityCapable = allNodes.filter((row) => capabilities(row.capabilitiesJson).includes(IDENTITY_CAPABILITY));
		const identityOnline = identityCapable.filter((row) => row.status === 'online');
		const configuredIdentityNode = this.ctx.sqlite
			.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
			.get(IDENTITY_NODE_SETTING)?.value ?? null;
		const identityNodeId = selectIdentityNode(
			(identityOnline.length > 0 ? identityOnline : identityCapable).map((row) => row.id),
			configuredIdentityNode,
			ingressId,
		);

		// Every HA Wave 1 field passes the capability gate last (HA-PLAN §9 "Mixed versions").
		return gateDesiredState({
			version: this.stateVersion(),
			nodeId: node.id,
			agentVersion: this.ctx.config.desiredAgentVersion ?? '0.1.0',
			nodeUpdate: this.updateTaskFor(node),
			generatedAt: new Date(now).toISOString(),
			contentDomain: this.ctx.config.contentDomain,
			platformOrigin: this.ctx.config.platformOrigin,
			sliceMemoryMb: node.sliceMemoryMb,
			sliceCpuWeight: node.sliceCpuWeight,
			storage: this.effectiveStorage(node),
			releases: releaseSpecs,
			routes,
			// Kept until every session a revocation affects has expired (share sessions last up to
			// 30 days), not for a fixed window.
			revocations: this.ctx.access.revocations(),
			hostRedirects,
			placeholders,
			workloads: workloadRows,
			...releaseState.volumes(),
			linkProbes: this.ctx.links.probesForNode(node.id),
			linkTests: this.ctx.links.testsForNode(node.id),
			...(await releaseState.appVolumes()),
			...(await new DatabaseState(state).tasks()),
			storageGateway: this.ctx.storage.gatewayForNode(node.id, isIngress, state.proxyAddress),
			studio: this.ctx.databaseStudio.desiredForNode(node.id),
			databaseGateway,
			containerConsole: this.ctx.containerConsole.desiredForNode(node),
			storageRoutes: [
				...this.ctx.storage.routesForNode(node.id, isIngress, state.proxyAddress),
				// The registry host streams like public S3: no body limit, no buffering (G1).
				...this.ctx.registry.routesForNode(node.id, isIngress, state.proxyAddress),
			],
			// The registry's pull-through cache (G4): Podman mirrors docker.io/ghcr.io/quay.io through it.
			registryMirror: this.ctx.registry.mirrorForNodes(),
			storagePurges: this.ctx.storage.purgesForNode(node.id),
			brokerPurges: this.ctx.brokers.purgesForNode(node.id),
			kubernetesPurges: this.ctx.kubernetes.purgesForNode(node.id),
			kubernetesRoutes: this.ctx.kubernetes.routesForNode(node.id, isIngress, state.proxyAddress),
			kubernetesManifests: this.ctx.kubernetes.manifestsForNode(node.id),
			kubernetesComponentRequest: this.ctx.kubernetes.componentRequestForNode(node.id),
			kubernetesBackupTasks: await this.ctx.kubernetes.backupTasksForNode(node.id),
			mail: this.ctx.email.desiredForNode(node.id),
			identity: node.id === identityNodeId ? identityDesiredForNode(this.ctx, node.id) : null,
			domains: this.ctx.domains.desiredForProjects(servedProjectIds),
			// Ingress-set payload (H17/G5): listeners, TLS and the platform route on every member,
			// only while the flag is on and the agent declares `ingress-set` (gate strips it).
			...(ingress.ingress() ? { ingress: ingress.ingress() } : {}),
			serviceEndpoints: endpoints.serviceEndpointsForNode(node.id),
			readEndpoints: endpoints.readEndpointsForNode(node.id),
			nodeTrust: endpoints.nodeTrustForNode(node.id),
			serviceProviders: endpoints.serviceProvidersForNode(node.id),
			// Release phase (H25), only to an agent that declares it: the commands it must run once
			// and the images to pull before a rollout reaches it. The capability gate strips them
			// from older agents anyway; not computing them keeps their payload byte-identical.
			...(releasePhase
				? {
						releaseCommands: this.ctx.releaseCommands.tasksForNode(node.id),
						imagePrePulls: this.ctx.workloads.imagePrePullsForNode(node.id),
					}
				: {}),
			...(node.networkMode === 'external'
				? {}
				: { wireguard: buildWireguardState(node.id, this.overlayNodes(), this.ctx.cluster.get().overlay.cidr, this.ctx.cluster.get().overlay) }),
		}, capabilities(node.capabilitiesJson), featureFlagsForGate(this.ctx.config));
	}
}

function storageStatus(json: string | null): NodeStorageStatus | null {
	const parsed = nodeStorageStatusSchema.safeParse(parseJson(json, null));
	return parsed.success ? parsed.data : null;
}

function capabilities(json: string | null): string[] {
	const parsed = parseJson<unknown>(json, []);
	return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
}

const RESERVED_LABEL_PREFIX = 'yoal.io/';

/** Operator-set roles, or the mode/can_build derivation older rows rely on. */
function rolesFor(row: typeof nodesTable.$inferSelect): NodeRole[] {
	const stored = parseJson<unknown>(row.rolesJson, null);
	if (Array.isArray(stored)) {
		const roles = [...new Set(stored.filter((value): value is NodeRole => nodeRoleSchema.safeParse(value).success))];
		if (roles.length > 0) return roles;
	}
	const base: NodeRole[] = row.mode === 'edge' ? ['ingress', 'control', 'compute', 'data'] : ['compute', 'data'];
	if (row.canBuild) base.push('build');
	return base;
}

function labelsFor(raw: string | null): Record<string, string> {
	const stored = parseJson<unknown>(raw, null);
	if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
	const labels: Record<string, string> = {};
	for (const [key, value] of Object.entries(stored)) {
		if (key.startsWith(RESERVED_LABEL_PREFIX) || typeof value !== 'string') continue;
		labels[key] = value;
	}
	return labels;
}

function hardwareFor(raw: string | null): NodeHardware | null {
	const parsed = nodeHardwareSchema.safeParse(parseJson<unknown>(raw, null));
	return parsed.success ? parsed.data : null;
}

/** `yoal.io/*` labels derived from the hardware report; never operator-written. */
export function derivedLabelsFor(hardware: NodeHardware | null): Record<string, string> {
	if (!hardware) return {};
	const labels: Record<string, string> = {};
	if (hardware.arch) labels['yoal.io/arch'] = hardware.arch;
	if (hardware.virtualization) labels['yoal.io/virt'] = hardware.virtualization;
	if (hardware.gpus?.length) {
		labels['yoal.io/gpu'] = hardware.gpus.some((gpu) => /nvidia/i.test(gpu.name ?? '') || /10de/i.test(gpu.pciId ?? ''))
			? 'nvidia'
			: 'other';
		labels['yoal.io/gpu-count'] = String(hardware.gpus.length);
	}
	if (hardware.memoryBytes !== undefined)
		labels['yoal.io/memory-gb'] = String(Math.max(1, Math.round(hardware.memoryBytes / 1024 ** 3)));
	if (hardware.cpuModel) labels['yoal.io/cpu-model'] = hardware.cpuModel.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 63);
	return labels;
}

/** Validate and store a heartbeat's hardware block; a bad report never clears the last good one. */
function hardwarePatch(hardware: NodeHardware | undefined, now: number): Partial<typeof nodesTable.$inferInsert> {
	if (!hardware) return {};
	const parsed = nodeHardwareSchema.safeParse(hardware);
	if (!parsed.success)
		return { hardwareError: parsed.error.issues[0]?.message ?? 'Invalid hardware report', hardwareAt: now };
	return { hardwareJson: JSON.stringify(parsed.data), hardwareAt: now, hardwareError: null };
}

function wireguardStatusFor(raw: string | null): WireguardStatus | null {
	const parsed = wireguardStatusSchema.safeParse(parseJson<unknown>(raw, null));
	return parsed.success ? parsed.data : null;
}

/** `host` → `host:port`; an explicit port or a bracketed IPv6 with a port is kept. */
export function withPort(address: string, port: number): string {
	if (/^\[.*\]:\d+$/.test(address) || /^[^:\[\]]+:\d+$/.test(address)) return address;
	if (address.includes(':') && !address.startsWith('[')) return `[${address}]:${port}`;
	return `${address}:${port}`;
}

function wireguardStatusPatch(status: WireguardStatus | undefined, now: number): Partial<typeof nodesTable.$inferInsert> {
	if (!status) return {};
	const parsed = wireguardStatusSchema.safeParse(status);
	if (!parsed.success) return {};
	return { wgStatusJson: JSON.stringify(parsed.data), wgStatusAt: now };
}
