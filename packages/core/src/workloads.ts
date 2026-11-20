import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { deployments, nodes, projects, releases, workloadReplicas, workloads } from '@yoal/db';
import {
	RUN_LEASES_CAPABILITY,
	type ScalingMode,
	githubRunnerSecretNames,
	githubRunnerTarget,
	orgNetworkName,
	parseWorkloadReplicaId,
	pinnedImageReference,
	processIdleStopIssue,
	functionIsPython,
	FUNCTIONS_PYTHON_CAPABILITY,
	BUN_DEFAULT_COMMAND,
	PROCESS_NODE_CAPABILITY,
	STORAGE_STS_CAPABILITY,
	WORKLOAD_IDENTITY_AUDIENCE,
	WORKLOAD_IDENTITY_CAPABILITY,
	WORKLOAD_IDENTITY_MOUNT_PATH,
	WORKLOAD_IDENTITY_TOKEN_ENV,
	WORKLOAD_IDENTITY_URL_ENV,
	workloadEnvIssues,
	workloadIdentityUrl,
	composeSpecSchema,
	type ComposeRoute,
	type ComposeSpec,
	type GithubRunnerPoolView,
	workloadReplicaId,
	workloadSpecSchema,
	placementSpecSchema,
	workloadVariablesSchema,
	type NodeCapacityView,
	type Principal,
	type WorkloadActivation,
	type WorkloadDesired,
	type WorkloadIdentityResponse,
	type WorkloadRuntime,
	type WorkloadSpec,
	type WorkloadSpecInput,
	type WorkloadStatus,
	type WorkloadVariables,
	type WorkloadView,
	type WorkloadReplica,
} from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import { assertReleasePhaseSpec } from './release-phase-gate.ts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { matchingPlacementSpec, resolvePlacement, type PlacementCandidate } from './placement.ts';
import { appSpecPortProblem, laterPortProblem, nodeAppPortClaims, nodePortConflict } from './host-ports.ts';
import { planReplicas } from './replicas.ts';
import type { BalanceNode, BalanceUnit } from './rebalance.ts';
import { effectiveRuntime, storedRuntime, workloadRuntimeOf } from './runtime-tier.ts';
import { workloadGetsIdentity } from './iam/workload-identity.ts';
import { parseJson, newId, sha256Hex } from './util.ts';
import { nodeDiskFreeBytes } from './app-volumes.ts';
import type { ProjectRow } from './projects.ts';

export type WorkloadRow = typeof workloads.$inferSelect;
export type ReplicaRow = typeof workloadReplicas.$inferSelect;

/** One spread replica copy as the failover controller sees it (CLUSTERING §8.3). */
export interface ReplicaCopy {
	id: string;
	workloadId: string;
	projectId: string;
	orgId: string;
	projectSlug: string;
	nodeId: string;
	replicaIndex: number;
	status: string;
	/** HTTP copies move before workers (§8.3 step 3). */
	ingress: 'http' | 'none';
	updatedAt: number;
	/** A single-copy workload (the id is the workload's own) rather than one copy of a spread set. */
	single?: boolean;
	/**
	 * False when the copy must not be re-placed off a node that only went silent: a single worker
	 * could still be running there, and a second copy would do its work twice (§8.4). A drain
	 * moves it all the same, because the draining node is told to stop it first.
	 */
	autoFailover?: boolean;
}

/** Why a copy is where it is; recorded on the row and in the audit log. */
export type MoveReason = 'failover' | 'drain' | 'rebalance' | 'manual';

const ACTIVE_STATUSES: WorkloadStatus[] = ['pending', 'starting', 'running'];

/** Seconds between a lease running out on a node and the fleet starting the worker elsewhere, at least. */
export const RUN_LEASE_MARGIN_SECONDS = 30;

/**
 * Loopback ports Yoal assigns to compose services (Caddy dials one per exposed service). The
 * range is deliberately above the managed-service ranges so a stack never steals a database,
 * broker or storage port. Ports are stable for a service until the stack changes.
 */
const COMPOSE_PORT_MIN = 30_000;
const COMPOSE_PORT_MAX = 39_999;

export interface ResolvedWorkload {
	spec: WorkloadSpec;
	nodeId: string;
	upstream: string;
	activationVersion: string;
	/** Multi-node replica assignments when the feature flag is on (C4). */
	replicas?: WorkloadReplica[];
}

/**
 * Tier 2/3 runtime state (DESIGN §3.4). Placement is resolved once per deploy, admission is
 * checked against the target node's `yoal-workloads.slice` budget, and the agent receives only
 * public spec fields plus secret *references*. Values are fetched at activation time.
 */
export class WorkloadService {
	constructor(private readonly ctx: CoreContext) {}

	/** Load the project's configured spec; `runtime` projects must have one. */
	projectSpec(project: ProjectRow): WorkloadSpec | null {
		const raw = parseJson<unknown>(project.workloadJson, null);
		if (raw) return workloadSpecSchema.parse(raw);
		return null;
	}

	defaultSpec(project: ProjectRow): WorkloadSpec {
		const runtime = effectiveRuntime(project);
		if (runtime === 'static') throw new ValidationError('Static projects have no workload spec.');
		// A function has no sensible default: the manifest is the program (D110).
		if (runtime === 'function')
			throw new ValidationError(
				`Project "${project.slug}" needs a yoal-function.json bundle before it can deploy.`,
			);
		if (runtime === 'compose')
			throw new ValidationError(
				`Project "${project.slug}" needs a docker-compose file before it can deploy.`,
			);
		if (runtime === 'container')
			throw new ValidationError(
				`Project "${project.slug}" needs a workload spec with an image before it can deploy.`,
			);
		return workloadSpecSchema.parse({ runtime, command: ['bun', 'run', 'start'] });
	}

	/** The spec a deployed workload runs now (as opposed to `projectSpec`, which the next deploy uses). */
	liveSpec(project: ProjectRow, row: WorkloadRow): WorkloadSpec {
		return this.specOf(project, row);
	}

	private specOf(project: ProjectRow, row: WorkloadRow): WorkloadSpec {
		const parsed = workloadSpecSchema.safeParse(parseJson<unknown>(row.specJson, null));
		if (!parsed.success) throw new ValidationError(`Workload spec for "${project.slug}" is invalid.`);
		return parsed.data;
	}

	plan(principal: Principal, project: ProjectRow, input?: Partial<WorkloadSpec>): ResolvedWorkload {
		this.ctx.iam.require(principal, 'deployment:create', { type: 'project', id: project.id });
		const runtime = effectiveRuntime(project);
		let spec = withEngineCommand(
			workloadSpecSchema.parse({
				...(this.projectSpec(project) ?? this.defaultSpec(project)),
				...input,
				runtime: runtime === 'static' ? (input?.runtime ?? 'process') : runtime,
			}),
		);
		if (runtime === 'static')
			throw new ValidationError(
				`Project "${project.slug}" is static. Create it with runtime "process", "container", "function" or "compose" to run a workload.`,
			);
		if (runtime === 'function' && !featureEnabled(this.ctx.config, 'FUNCTIONS'))
			throw new ValidationError('Functions are not enabled on this platform (YOAL_FEATURE_FUNCTIONS).');
		if (input) assertReleasePhaseSpec(this.ctx.config, input, this.projectSpec(project));
		if (runtime === 'compose') {
			if (!featureEnabled(this.ctx.config, 'COMPOSE'))
				throw new ValidationError('Compose stacks are not enabled on this platform (YOAL_FEATURE_COMPOSE).');
			if (!spec.compose) throw new ValidationError('A compose project needs a parsed compose spec.');
			// Admission is the whole stack: every service reserves its own memory and CPU share.
			spec = {
				...spec,
				memoryMb: composeMemoryMb(spec.compose),
				cpus: composeCpus(spec.compose),
				// Set after placement assigns the loopback ports; a stale stored value is replaced.
				port: spec.port,
				healthPath: primaryComposeRoute(spec.compose)?.healthPath ?? '/',
				// Services are containers; the helper rejects socket activation for a stack.
				socketActivation: false,
				// A stack with no exposed port is a worker: no route and no health probe.
				ingress: spec.compose.routes.length === 0 ? ('none' as const) : ('http' as const),
			};
		}
		// An app never takes a port the platform holds on every node (D225), nor newly one it has
		// reserved for later (HA-PLAN F2).
		const reservedPort = appSpecPortProblem(this.ctx, spec) ?? laterPortProblem(this.ctx, project.id, spec);
		if (reservedPort) throw new ValidationError(reservedPort);
		if (this.ctx.relocations.isRelocating(project.id))
			throw new ConflictError(`"${project.slug}" is stopped while it moves to another node with its data. Deploy again once the move finishes.`);
		if (this.ctx.moves.quiescedProjectIds().has(project.id))
			throw new ConflictError(
				`"${project.slug}" is stopped while a database it uses moves to another node. Deploy again once the move finishes.`,
			);
		// A project with attached databases or private storage normally runs next to them (D56, S5).
		// With C2 endpoints enabled, a process app may run elsewhere: the consumer gets a loopback
		// endpoint and the provider listens on the overlay. Private storage still pins for now.
		const crossNode = featureEnabled(this.ctx.config, 'SERVICE_ENDPOINTS') && runtime === 'process';
		// Brokers have no cross-node endpoint yet (D111), so an attached broker pins even then.
		const pinned = crossNode ? this.ctx.brokers.requiredNode(project.id) : this.attachmentNode(project.id);
		if (pinned) {
			const conflict = crossNode
				? this.ctx.brokers.placementConflict(project, pinned)
				: (this.ctx.databases.placementConflict(project, pinned) ??
					this.ctx.storage.placementConflict(project, pinned) ??
					this.ctx.brokers.placementConflict(project, pinned));
			if (conflict) throw new ValidationError(conflict);
		}
		const placementSpec = placementSpecFor(project);
		const clusterConfig = this.ctx.cluster.get().replicas;
		const scheduling = this.ctx.cluster.get().scheduling;
		if (featureEnabled(this.ctx.config, 'MULTI_NODE_REPLICAS') && spec.replicas > clusterConfig.max)
			throw new ValidationError(`This install allows at most ${clusterConfig.max} replicas per workload.`);
		// A redeploy must not be refused for the room its own running copies already hold.
		const existing = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get() ?? null;
		const { mode, blocker } = this.scalingMode(project, spec, existing);
		if (spec.replicas > 1 && mode === 'single')
			throw new ValidationError(`"${project.slug}" cannot run ${spec.replicas} copies: ${blocker}.`);
		let replicas: WorkloadReplica[] | undefined;
		let decision: ReturnType<typeof resolvePlacement>;
		if (spec.replicas > 1 && (mode === 'spread' || mode === 'stack')) {
			// Copies that already run keep their node, so a deploy updates a set in place instead of
			// reshuffling it; only missing copies are placed (SCALING §3).
			const planned = planReplicas({
				count: spec.replicas,
				memoryMb: spec.memoryMb,
				spread: clusterConfig.spread,
				cpuMillis: Math.round((spec.cpus ?? 1) * 1000),
				strategy: scheduling.strategy,
				stack: mode === 'stack',
				reason: 'deploy',
				existing: existing ? this.copyPlacements(existing) : [],
				candidates: this.copyCandidates(project, spec, existing?.id),
			});
			if (!planned.ok) throw new ValidationError(planned.message, planned.refusals);
			replicas = planned.plan.assignments;
			decision = { ok: true, nodeId: replicas[0]!.nodeId, mode: 'worker', reason: 'Spread replica placement.' };
		} else {
			const request = {
				runtime,
				memoryMb: reservedMemoryMb(spec),
				cpuMillis: (spec.cpus ?? 1) * 1000 * (spec.replicas ?? 1),
				edgeNodeId: this.edgeNodeId(),
				candidates: this.withPortConflicts(this.candidates({ excludeWorkloadId: existing?.id }), project.id, spec),
				spec: placementSpec,
				nearNodeIds: placementSpec?.near ? this.nearNodeIds(placementSpec.near) : undefined,
				strategy: scheduling.strategy,
			};
			// An app placed by `auto` stays on its node while that node can still take it: a redeploy
			// is not a reason to move, and Rebalance is the tool that is (D214).
			const stay =
				!pinned && project.placement === 'auto' && existing?.nodeId && !existing.movingFromNodeId
					? resolvePlacement({ ...request, requested: existing.nodeId })
					: null;
			decision = stay?.ok
				? { ...stay, reason: 'Auto: staying on its current node.' }
				: resolvePlacement({ ...request, requested: pinned ?? project.placement });
			if (!decision.ok) throw new ValidationError(decision.message, decision.rejections?.length ? decision.rejections : decision.freeByNode);
		}
		// The last word on ports, whichever path chose the node (stay, pinned, spread copies): no two
		// apps hold one loopback port on a node, or one project's host would reach the other (D225).
		for (const nodeId of new Set([decision.nodeId, ...(replicas ?? []).map((replica) => replica.nodeId)])) {
			const conflict = nodePortConflict(this.ctx, project.id, spec, nodeId, this.nodeName(nodeId));
			if (conflict) throw new ConflictError(conflict);
		}
		if (crossNode) this.ctx.endpoints.reconcile(project.id, decision.nodeId);
		if (runtime === 'function') this.assertFunctionTarget(decision.nodeId, Boolean(spec.function && functionIsPython(spec.function)));
		if (crossNode) for (const replica of replicas ?? []) this.ctx.endpoints.reconcile(project.id, replica.nodeId);
		if (spec.runtime === 'process' && spec.engine === 'node')
			for (const nodeId of new Set([decision.nodeId, ...(replicas ?? []).map((replica) => replica.nodeId)]))
				this.assertNodeEngineTarget(nodeId);
		if (spec.compose) spec = { ...spec, compose: this.assignComposePorts(project, spec.compose, decision.nodeId) };
		if (spec.compose) {
			const primary = primaryComposeRoute(spec.compose);
			spec = { ...spec, port: primary?.hostPort ?? spec.port, healthPath: primary?.healthPath ?? spec.healthPath };
		}
		this.ctx.quota.assertCanAdmitMemory(
			project.orgId,
			project.id,
			Math.max(0, reservedMemoryMb(spec) - (existing?.memoryMb ?? 0)),
		);
		this.assertRunnerResolvable(project, spec);
		const upstream = upstreamFor(project.id, spec);
		return {
			spec,
			nodeId: decision.nodeId,
			upstream,
			activationVersion: activationVersion(spec, this.attachmentsVersion(project.id, decision.nodeId, spec.runtime, project.orgId, spec)),
			...(replicas ? { replicas } : {}),
		};
	}

	/**
	 * Give every exposed compose service a stable loopback port on its node. Yoal assigns these
	 * (never the compose file): a host port is host-global, so two stacks on one node must not
	 * collide. An existing port is kept when it is still free, which keeps redeploys quiet.
	 */
	private assignComposePorts(project: ProjectRow, spec: ComposeSpec, nodeId: string): ComposeSpec {
		// Every app port on the node counts, copies and process apps included (D225).
		const used = new Set<number>(nodeAppPortClaims(this.ctx, nodeId, project.id).keys());
		const next = { ...spec, routes: spec.routes.map((route) => ({ ...route })) };
		for (const route of next.routes) {
			let port = route.hostPort;
			if (!port || used.has(port)) {
				port = undefined;
				for (let candidate = COMPOSE_PORT_MIN; candidate <= COMPOSE_PORT_MAX; candidate++)
					if (!used.has(candidate)) {
						port = candidate;
						break;
					}
				if (port === undefined) throw new ValidationError('This node has no free ports left for compose services.');
			}
			route.hostPort = port;
			used.add(port);
		}
		return next;
	}

	/** Persist the project-level spec (validated); placement is still resolved at deploy time. */
	setSpec(principal: Principal, project: ProjectRow, input: WorkloadSpecInput): WorkloadView | null {
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		const runtime = effectiveRuntime(project);
		if (runtime === 'static')
			throw new ValidationError(
				`Project "${project.slug}" is static. Create it with runtime "process", "container", "function" or "compose" to run a workload.`,
			);
		if (runtime === 'compose' && !featureEnabled(this.ctx.config, 'COMPOSE'))
			throw new ValidationError('Compose stacks are not enabled on this platform (YOAL_FEATURE_COMPOSE).');
		// The digest is Yoal's to set at deploy time (R1); an input never carries one.
		const { imageDigest: _ignored, ...specInput } = input as WorkloadSpecInput & { imageDigest?: string };
		assertReleasePhaseSpec(this.ctx.config, specInput as Partial<WorkloadSpec>, this.projectSpec(project));
		let spec = workloadSpecSchema.parse({ ...specInput, runtime });
		if (spec.compose)
			spec = {
				...spec,
				memoryMb: composeMemoryMb(spec.compose),
				cpus: composeCpus(spec.compose),
				socketActivation: false,
			};
		this.assertEnvResolvable(project, spec);
		this.assertRunnerResolvable(project, spec);
		const reservedPort = appSpecPortProblem(this.ctx, spec) ?? laterPortProblem(this.ctx, project.id, spec);
		if (reservedPort) throw new ValidationError(reservedPort);
		const existing = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
		// A port change applies on the app's current node(s) at once (the row below is re-applied),
		// so it must be free there now, not only at the next deploy (D225).
		if (existing) {
			const here = new Set([existing.nodeId, ...this.copyPlacements(existing).map((copy) => copy.nodeId)]);
			for (const nodeId of here) {
				if (!nodeId) continue;
				const conflict = nodePortConflict(this.ctx, project.id, spec, nodeId, this.nodeName(nodeId));
				if (conflict) throw new ConflictError(conflict);
			}
		}
		// The running workload keeps its pinned digest while the image is unchanged, so saving other
		// fields neither restarts it on a moved tag nor drops the pin. A new image runs by tag until
		// the next deploy pins it.
		const runningDigest = existing
			? workloadSpecSchema.safeParse(parseJson<unknown>(existing.specJson, null)).data
			: undefined;
		// The number of copies of a deployed app changes through `scaleCopies`, which places or
		// removes them; writing a new count into the spec alone would leave the rows behind it.
		const wantedReplicas = spec.replicas;
		if (runningDigest && runningDigest.replicas !== wantedReplicas) {
			const kept = workloadSpecSchema.safeParse({ ...spec, replicas: runningDigest.replicas });
			if (kept.success) spec = kept.data;
		}
		const liveSpec: WorkloadSpec =
			runningDigest?.imageDigest && runningDigest.image === spec.image
				? { ...spec, imageDigest: runningDigest.imageDigest }
				: spec;
		this.ctx.quota.assertCanAdmitMemory(
			project.orgId,
			project.id,
			Math.max(0, reservedMemoryMb(spec) - (existing?.memoryMb ?? 0)),
		);
		this.ctx.db
			.update(projects)
			.set({ workloadJson: JSON.stringify(spec), updatedAt: this.ctx.now() })
			.where(eq(projects.id, project.id))
			.run();
		if (existing)
			this.ctx.db
				.update(workloads)
				.set({
					specJson: JSON.stringify(liveSpec),
					runtime: storedWorkloadRuntime(spec.runtime),
					runtimeName: spec.runtime,
					memoryMb: reservedMemoryMb(spec),
					cpus: Math.round(spec.cpus),
					// A function's socket is named after the workload id (phase 4), not the project.
					upstream: spec.runtime === 'function' ? upstreamFor(existing.id, spec) : upstreamFor(project.id, spec),
					status: 'pending',
					updatedAt: this.ctx.now(),
				})
				.where(eq(workloads.id, existing.id))
				.run();
		this.ctx.projects.bump(project.orgId);
		if (existing && wantedReplicas !== spec.replicas) this.scaleCopies(this.requireProject(project.id), wantedReplicas);
		return this.view(project);
	}

	/**
	 * Replace a project's environment in one step: write any new secret values as project secrets,
	 * then save the plain env and references into the spec. Everything is validated before the
	 * first write, so a refused save creates no secret versions. A running workload restarts with
	 * the result on its next reconcile.
	 */
	async setVariables(principal: Principal, project: ProjectRow, input: WorkloadVariables): Promise<WorkloadView | null> {
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		const variables = workloadVariablesSchema.parse(input);
		// Adding a name needs `secret:create`, a new value for a live one `secret:update`; all are
		// checked before anything is written.
		for (const secret of variables.newSecrets) this.ctx.secrets.requireWrite(principal, { name: secret.name, projectId: project.id });
		const runtime = effectiveRuntime(project);
		if (runtime === 'static')
			throw new ValidationError(`Project "${project.slug}" is static and has no environment variables.`);
		const current = this.projectSpec(project);
		if (!current && runtime === 'container')
			throw new ValidationError('Set the container image under Runtime before adding variables.');
		const spec = workloadSpecSchema.parse({
			...(current ?? this.defaultSpec(project)),
			env: variables.env,
			secrets: variables.secrets,
		});
		const pending = new Set<string>();
		for (const secret of variables.newSecrets) {
			if (pending.has(secret.name)) throw new ValidationError(`Secret ${secret.name} is set more than once.`);
			pending.add(secret.name);
		}
		this.assertEnvResolvable(project, spec, pending);
		for (const secret of variables.newSecrets) {
			await this.ctx.secrets.set(principal, { name: secret.name, value: secret.value, projectId: project.id });
		}
		return this.setSpec(principal, project, spec);
	}

	/**
	 * Refuse a spec whose variables clash or whose secret references cannot resolve for this
	 * project. Activation skips a missing secret, so without this the app would start without it.
	 */
	private assertEnvResolvable(project: ProjectRow, spec: WorkloadSpec, pending: Set<string> = new Set()): void {
		const issues = workloadEnvIssues(spec);
		const check = (name: string) => {
			const resolved = this.ctx.secrets.resolve(project.orgId, project.id, name);
			if (!resolved) issues.push(`Secret ${name} does not exist for this project or the organisation.`);
		};
		for (const ref of spec.secrets) {
			if (pending.has(ref.name) && ref.version === undefined) continue;
			const resolved = this.ctx.secrets.resolve(project.orgId, project.id, ref.name);
			if (!resolved) issues.push(`Secret ${ref.name} does not exist for this project or the organisation.`);
			else if (ref.version !== undefined && !resolved.versions.includes(ref.version))
				issues.push(`Secret ${ref.name} has no version ${ref.version}.`);
		}
		// Compose services name their own secrets; the value is shared at the project level.
		for (const service of spec.compose?.services ?? [])
			for (const name of service.secrets) if (!pending.has(name)) check(name);
		if (issues.length > 0) throw new ValidationError(issues.join(' '), issues);
	}

	/**
	 * A runner's GitHub credential is read by the control plane only, so it is not in
	 * `spec.secrets`; check it resolves here or the pool would fail at its first activation.
	 */
	private assertRunnerResolvable(project: ProjectRow, spec: WorkloadSpec): void {
		if (!spec.runner) return;
		if (spec.runner.auth.method === 'installation') {
			if (!this.ctx.githubApp.hasInstallationFor(project.orgId, spec.runner.owner))
				throw new ValidationError(
					`Yoal's GitHub App is not installed on ${spec.runner.owner} for this organisation. Install it from Settings → GitHub, or use a token.`,
				);
			return;
		}
		const missing = githubRunnerSecretNames(spec.runner).filter(
			(name) => !this.ctx.secrets.resolve(project.orgId, project.id, name),
		);
		if (missing.length > 0)
			throw new ValidationError(
				`Runner credential secret ${missing.join(', ')} does not exist. Create it before deploying.`,
				missing.map((name) => `Secret ${name} does not exist.`),
			);
	}

	/**
	 * A function runs on workerd, which only an agent that advertised `functions` in its heartbeat
	 * can render (D110). Refuse the deploy instead of leaving the app pending forever.
	 */
	private assertFunctionTarget(nodeId: string, python = false): void {
		const node = this.ctx.db
			.select({ name: nodes.name, capabilitiesJson: nodes.capabilitiesJson })
			.from(nodes)
			.where(eq(nodes.id, nodeId))
			.get();
		const capabilities = nodeCapabilities(node?.capabilitiesJson ?? null);
		if (!node || !capabilities.includes('functions'))
			throw new ValidationError(
				`Node "${node?.name ?? nodeId}" does not support functions; update the node's agent first.`,
			);
		// A Python host loads Pyodide from the node's warmed cache, never from the internet (D121).
		if (python && !capabilities.includes(FUNCTIONS_PYTHON_CAPABILITY))
			throw new ValidationError(
				`Node "${node.name}" cannot run Python functions yet: its Pyodide cache is not installed. Run \`sudo bun /opt/yoal/current/repo/scripts/install/pyodide.ts\` on the node (or upgrade it), then deploy again.`,
			);
	}

	/**
	 * A Node.js process app runs on the node's pinned Node (D125), which the agent advertises as
	 * `process-node`. Refuse the deploy instead of crash-looping a unit with no `node` on its PATH.
	 */
	private assertNodeEngineTarget(nodeId: string): void {
		const node = this.ctx.db
			.select({ name: nodes.name, capabilitiesJson: nodes.capabilitiesJson })
			.from(nodes)
			.where(eq(nodes.id, nodeId))
			.get();
		if (node && nodeCapabilities(node.capabilitiesJson).includes(PROCESS_NODE_CAPABILITY)) return;
		throw new ValidationError(
			`Node "${node?.name ?? nodeId}" cannot run Node.js apps yet: its pinned Node.js is not installed. Run \`sudo bun /opt/yoal/current/repo/scripts/install/node.ts\` on the node (or upgrade it), then deploy again.`,
		);
	}

	/** Re-point the workload at an existing deployment (promote/rollback); placement is preserved. */
	syncDeployment(project: ProjectRow, deploymentId: string, options: { auto?: boolean } = {}): void {
		const deployment = this.ctx.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get();
		if (!deployment || !deployment.workloadJson || !deployment.nodeId) return;
		const parsed = workloadSpecSchema.safeParse(parseJson<unknown>(deployment.workloadJson, null));
		if (!parsed.success) return;
		// A promote or rollback restores a release, not a scale: the number of copies is whatever
		// the app runs now, so rolling back never drops capacity that was added since (SCALING §2).
		const live = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
		const liveSpec = live ? workloadSpecSchema.safeParse(parseJson<unknown>(live.specJson, null)).data : undefined;
		const scaled = liveSpec ? workloadSpecSchema.safeParse({ ...parsed.data, replicas: liveSpec.replicas }) : null;
		const spec = scaled?.success ? scaled.data : parsed.data;
		this.record(
			project,
			deploymentId,
			{
				spec,
				nodeId: deployment.nodeId,
				upstream: upstreamFor(project.id, spec),
				activationVersion: activationVersion(
					spec,
					this.attachmentsVersion(project.id, deployment.nodeId, spec.runtime, project.orgId, spec),
				),
			},
			{ keepSpread: true, auto: options.auto },
		);
	}

	/** Record the resolved workload for a new deployment (called from DeploymentService). */
	record(
		project: ProjectRow,
		deploymentId: string,
		resolved: ResolvedWorkload,
		/** `auto` marks an automatic rollback: its own failure pauses instead of rolling back again. */
		options: { keepSpread?: boolean; auto?: boolean } = {},
	): void {
		const now = this.ctx.now();
		const existing = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
		const id = existing?.id ?? newId('wld_');
		let priorRows = existing
			? this.ctx.db.select().from(workloadReplicas).where(eq(workloadReplicas.workloadId, id)).all()
			: [];
		const nodesBefore = new Set([...(existing?.nodeId ? [existing.nodeId] : []), ...priorRows.map((row) => row.nodeId)]);
		// The deployment the app actually runs. A surge deploy that is being replaced is undone first:
		// its temporary copy goes, and what counts is what the app's own copy is still on.
		let running = existing?.deploymentId ?? null;
		if (existing?.rolloutSurge) {
			const own = priorRows.find((row) => row.replicaIndex === 0);
			if (own?.deploymentId) running = own.deploymentId;
			this.ctx.db.delete(workloadReplicas).where(eq(workloadReplicas.workloadId, id)).run();
			priorRows = [];
		}
		// A promote or rollback keeps the copies where they are; the workload's node is copy 0's.
		const keptFirst = options.keepSpread && !resolved.replicas ? [...priorRows].sort((a, b) => a.replicaIndex - b.replicaIndex)[0] : undefined;
		const values = {
			orgId: project.orgId,
			projectId: project.id,
			deploymentId,
			nodeId: keptFirst?.nodeId ?? resolved.nodeId,
			runtime: storedWorkloadRuntime(resolved.spec.runtime),
			runtimeName: resolved.spec.runtime,
			status: 'pending' as const,
			specJson: JSON.stringify(resolved.spec),
			memoryMb: reservedMemoryMb(resolved.spec),
			cpus: Math.round(resolved.spec.cpus),
			// A function dials a socket named after its workload (phase 4), not after the project, so
			// recompute it once the row id exists. Every other tier keeps the project socket.
			upstream: resolved.spec.runtime === 'function' ? upstreamFor(id, resolved.spec) : resolved.upstream,
			message: null,
			// A deploy decides placement afresh, so it ends any move that was in flight.
			movingFromNodeId: null,
			placementReason: 'deploy',
			rolloutStatus: null as string | null,
			rolloutMessage: null as string | null,
			rolloutStartedAt: null as number | null,
			rolloutFromDeploymentId: null as string | null,
			rolloutSurge: false,
			rolloutAuto: Boolean(options.auto),
			// A person's deploy, promote or rollback supersedes the note an automatic rollback left.
			...(options.auto ? {} : { rollbackNote: null, rollbackAt: null }),
			updatedAt: now,
		};
		if (existing) this.ctx.db.update(workloads).set(values).where(eq(workloads.id, existing.id)).run();
		else
			this.ctx.db
				.insert(workloads)
				.values({ ...values, id, createdAt: now })
				.run();

		// Copies. A fresh plan names every copy (kept ones included); a plan with none means one
		// copy on the workload's node. A promote or rollback (`keepSpread`) leaves them alone.
		let kept = priorRows;
		if (resolved.replicas) kept = this.writeCopies(id, project.id, priorRows, resolved.replicas, now).kept;
		else if (!options.keepSpread) {
			this.ctx.db.delete(workloadReplicas).where(eq(workloadReplicas.workloadId, id)).run();
			kept = [];
		}

		// A new release reaches a set of copies one at a time (SCALING §4): every copy that stays
		// where it is keeps running the previous deployment until the rollout controller reaches it.
		const scheduling = this.ctx.cluster.get().scheduling;
		const changed = running !== null && running !== deploymentId;
		const total = this.ctx.db.select({ id: workloadReplicas.id }).from(workloadReplicas).where(eq(workloadReplicas.workloadId, id)).all().length;
		const rolling = changed && total >= 2 && kept.length > 0 && scheduling.rollingDeploys && this.copyRelease(running) !== null;
		let waiting = 0;
		for (const row of kept) {
			// Mid-rollout, a copy not yet reached still runs the release before that one.
			const runs = row.deploymentId ?? running;
			const previous = rolling && runs && runs !== deploymentId && this.copyRelease(runs) !== null ? runs : null;
			if (previous) waiting += 1;
			this.ctx.db
				.update(workloadReplicas)
				.set({
					deploymentId: previous,
					appliedVersion: null,
					...(changed && !previous && runs !== deploymentId ? { status: 'pending' as const } : {}),
					updatedAt: now,
				})
				.where(eq(workloadReplicas.id, row.id))
				.run();
		}
		if (waiting > 0)
			this.ctx.db
				.update(workloads)
				.set({ rolloutStatus: 'rolling', rolloutStartedAt: now, rolloutFromDeploymentId: running })
				.where(eq(workloads.id, id))
				.run();
		else if (changed && total === 0 && existing && scheduling.rollingDeploys && scheduling.surgeDeploys)
			this.startSurge(project, { ...existing, ...values, id }, resolved.spec, running!, existing.status === 'running', now);
		this.reconcileEndpoints(project.id, nodesBefore);
	}

	/**
	 * Deploy a single-copy HTTP app without a gap (SCALING §4): a temporary second copy starts on
	 * another node on the new release, takes the traffic once it is healthy, and only then is the
	 * app's own copy restarted. The extra copy is removed when the rollout ends. Skipped, leaving
	 * the plain restart in place, when the app is not serving, must stay on its node, or no other
	 * node has room.
	 */
	private startSurge(project: ProjectRow, workload: WorkloadRow, spec: WorkloadSpec, running: string, serving: boolean, now: number): boolean {
		if (!serving || !workload.nodeId || spec.replicas !== 1 || spec.ingress === 'none') return false;
		if (this.scalingMode(project, { ...spec, replicas: 2 }, workload).mode !== 'spread') return false;
		if (this.copyRelease(running) === null) return false;
		const planned = planReplicas({
			count: 2,
			memoryMb: spec.memoryMb,
			cpuMillis: Math.round((spec.cpus ?? 1) * 1000),
			spread: this.ctx.cluster.get().replicas.spread,
			strategy: this.ctx.cluster.get().scheduling.strategy,
			reason: 'surge',
			existing: [{ index: 0, nodeId: workload.nodeId }],
			candidates: this.copyCandidates(project, spec, workload.id),
		});
		if (!planned.ok || planned.kept.length !== 1) return false;
		const extra = planned.plan.assignments.find((copy) => copy.index !== 0)!;
		const row = { workloadId: workload.id, projectId: project.id, appliedVersion: null, rolledAt: null, createdAt: now, updatedAt: now };
		this.ctx.db
			.insert(workloadReplicas)
			.values([
				// The app's own copy: still serving, still on the release it was.
				{ ...row, id: newId('wrl_'), nodeId: workload.nodeId, replicaIndex: 0, status: 'running', placementReason: 'deploy', deploymentId: running },
				{ ...row, id: newId('wrl_'), nodeId: extra.nodeId, replicaIndex: extra.index, status: 'pending', placementReason: extra.reason, deploymentId: null },
			])
			.run();
		this.ctx.db
			.update(workloads)
			.set({
				rolloutStatus: 'rolling',
				rolloutStartedAt: now,
				rolloutFromDeploymentId: running,
				rolloutSurge: true,
				// Two copies exist for the length of the rollout, and both nodes must account for theirs.
				memoryMb: spec.memoryMb * 2,
			})
			.where(eq(workloads.id, workload.id))
			.run();
		return true;
	}

	/** A surge deploy is over: the temporary copy goes and the app is one copy on its node again. */
	private endSurge(workload: WorkloadRow, now: number): void {
		const rows = this.ctx.db.select().from(workloadReplicas).where(eq(workloadReplicas.workloadId, workload.id)).all();
		const project = this.requireProject(workload.projectId);
		this.ctx.db.delete(workloadReplicas).where(eq(workloadReplicas.workloadId, workload.id)).run();
		this.ctx.db
			.update(workloads)
			.set({ rolloutSurge: false, memoryMb: reservedMemoryMb(this.specOf(project, workload)), updatedAt: now })
			.where(eq(workloads.id, workload.id))
			.run();
		this.reconcileEndpoints(workload.projectId, rows.map((row) => row.nodeId));
		this.ctx.projects.bump(workload.orgId);
	}

	/**
	 * Make the copy rows match a plan: a copy whose node is unchanged is left exactly as it is,
	 * one that moved or is new starts `pending`, and one the plan dropped is deleted.
	 */
	private writeCopies(
		workloadId: string,
		projectId: string,
		prior: ReplicaRow[],
		assignments: WorkloadReplica[],
		now: number,
	): { kept: ReplicaRow[]; added: ReplicaRow[]; removed: ReplicaRow[] } {
		const kept: ReplicaRow[] = [];
		const added: ReplicaRow[] = [];
		const wanted = new Set(assignments.map((copy) => copy.index));
		const removed = prior.filter((row) => !wanted.has(row.replicaIndex));
		for (const row of removed) this.ctx.db.delete(workloadReplicas).where(eq(workloadReplicas.id, row.id)).run();
		for (const copy of assignments) {
			const row = prior.find((entry) => entry.replicaIndex === copy.index);
			if (row && row.nodeId === copy.nodeId) {
				kept.push(row);
				continue;
			}
			const values = {
				nodeId: copy.nodeId,
				status: 'pending' as const,
				placementReason: copy.reason,
				deploymentId: null,
				appliedVersion: null,
				updatedAt: now,
			};
			if (row) {
				this.ctx.db.update(workloadReplicas).set(values).where(eq(workloadReplicas.id, row.id)).run();
				added.push({ ...row, ...values });
			} else {
				const fresh = { id: newId('wrl_'), workloadId, projectId, replicaIndex: copy.index, createdAt: now, rolledAt: null, ...values };
				this.ctx.db.insert(workloadReplicas).values(fresh).run();
				added.push(fresh);
			}
		}
		return { kept, added, removed };
	}

	/** Where a workload's copies are now: its rows, or its one node when it has none. */
	private copyPlacements(workload: WorkloadRow): Array<{ index: number; nodeId: string }> {
		const rows = this.ctx.db.select().from(workloadReplicas).where(eq(workloadReplicas.workloadId, workload.id)).all();
		if (rows.length > 0) return rows.map((row) => ({ index: row.replicaIndex, nodeId: row.nodeId }));
		if (!workload.nodeId) return [];
		// Without rows every copy shares the workload's node: one copy, or an older same-node set
		// (D90) whose copies should stay put when the app is next scaled or deployed.
		const replicas = workloadSpecSchema.safeParse(parseJson<unknown>(workload.specJson, null)).data?.replicas ?? 1;
		return Array.from({ length: Math.max(1, replicas) }, (_, index) => ({ index, nodeId: workload.nodeId! }));
	}

	/** Nodes that may hold a copy of this app: compute nodes that match its placement and can run it. */
	private copyCandidates(project: ProjectRow, spec: WorkloadSpec, excludeWorkloadId?: string) {
		const all = this.candidates({ excludeWorkloadId });
		const placementSpec = placementSpecFor(project);
		const matching = placementSpec ? matchingPlacementSpec(all, placementSpec) : all;
		return this.replicaCandidates(matching.filter((candidate) => this.canHost(candidate.id, spec, project.id)));
	}

	/** A deployment a copy can still run: active, with its release and the spec it was made with. */
	private copyRelease(deploymentId: string | null): { deployment: typeof deployments.$inferSelect; spec: WorkloadSpec } | null {
		if (!deploymentId) return null;
		const deployment = this.ctx.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get();
		if (!deployment || deployment.status !== 'active' || !deployment.workloadJson) return null;
		const parsed = workloadSpecSchema.safeParse(parseJson<unknown>(deployment.workloadJson, null));
		return parsed.success ? { deployment, spec: withEngineCommand(parsed.data) } : null;
	}

	/**
	 * Keep each node's loopback service endpoints in step with the copies it holds: every node
	 * that now runs the project gets its endpoints, every node that stopped has them freed (C2).
	 */
	private reconcileEndpoints(projectId: string, nodesBefore: Iterable<string>): void {
		if (!featureEnabled(this.ctx.config, 'SERVICE_ENDPOINTS')) return;
		const workload = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, projectId)).get();
		const now = new Set(workload ? this.copyPlacements(workload).map((copy) => copy.nodeId) : []);
		if (workload?.movingFromNodeId) now.add(workload.movingFromNodeId);
		for (const nodeId of now) this.ctx.endpoints.reconcile(projectId, nodeId);
		for (const nodeId of nodesBefore) if (!now.has(nodeId)) this.ctx.endpoints.reconcile(null, nodeId);
	}

	/**
	 * How this app's copies may be placed (SCALING §2), and what stops it being placed more freely.
	 * `spread` and `stack` put copies on several nodes; `node` keeps them all on the app's one node;
	 * `single` means one copy only.
	 */
	scalingMode(project: ProjectRow, spec: WorkloadSpec, workload: WorkloadRow | null): { mode: ScalingMode; blocker: string | null } {
		if (spec.runtime === 'function' || spec.runner) return { mode: 'node', blocker: null };
		if (spec.runtime === 'compose') return { mode: 'single', blocker: 'a compose stack runs as one unit; scale a service inside the compose file instead' };
		const worker = spec.ingress === 'none';
		const pin = this.nodePin(project, spec, workload);
		const multiNode = featureEnabled(this.ctx.config, 'MULTI_NODE_REPLICAS');
		if (worker) return pin || !multiNode ? { mode: 'node', blocker: pin } : { mode: 'stack', blocker: null };
		// An HTTP copy owns its node's port or socket, so a second copy needs a second node.
		if (!multiNode) return { mode: 'single', blocker: 'copies on several nodes are turned off on this install (YOAL_FEATURE_MULTI_NODE_REPLICAS)' };
		if (pin) return { mode: 'single', blocker: `an HTTP app runs one copy per node, and this one must stay on its node because ${pin}` };
		return { mode: 'spread', blocker: null };
	}

	/** Why every copy of this app must share one node; null when copies may run on several. */
	private nodePin(project: ProjectRow, spec: WorkloadSpec, workload: WorkloadRow | null): string | null {
		if (project.placement !== 'auto')
			return project.placement === 'edge' ? 'its placement pins it to the edge' : 'its placement names one node (set it to auto to scale across nodes)';
		if (placementSpecFor(project)?.node) return 'its placement constraints name one node';
		if (spec.data) return 'it keeps a persistent data directory on that node';
		if (workload && this.ctx.appVolumes.mountsForWorkload(workload.id).length > 0) return 'its app volumes live on that node';
		if (featureEnabled(this.ctx.config, 'SERVICE_ENDPOINTS') && spec.runtime === 'process')
			return this.ctx.brokers.requiredNode(project.id) ? 'its message broker is only reachable on that node (D111)' : null;
		try {
			return this.attachmentNode(project.id) ? 'it runs next to its attached database, storage or broker (D56)' : null;
		} catch {
			return 'its attachments live on different nodes';
		}
	}

	view(project: ProjectRow): WorkloadView | null {
		const row = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
		return row ? this.toView(project, row) : null;
	}

	get(principal: Principal, project: ProjectRow): WorkloadView | null {
		this.ctx.iam.require(principal, 'deployment:read', { type: 'project', id: project.id });
		return this.view(project);
	}

	remove(principal: Principal, project: ProjectRow): void {
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		const row = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
		if (!row) throw new NotFoundError('Workload');
		const runner = workloadSpecSchema.safeParse(parseJson<unknown>(row.specJson, null)).data?.runner;
		this.ctx.db.delete(workloads).where(eq(workloads.id, row.id)).run();
		// Registrations are removed from GitHub in the background; the units stop on reconcile.
		void this.ctx.githubRunners.deregisterProject(project, runner);
		this.ctx.db.update(projects).set({ workloadJson: null, updatedAt: this.ctx.now() }).where(eq(projects.id, project.id)).run();
		this.ctx.audit.record({
			principal,
			action: 'workload.remove',
			resource: 'workload',
			resourceId: row.id,
			args: { project: project.slug },
			result: 'ok',
		});
		this.ctx.projects.bump(project.orgId);
	}

	capacity(principal: Principal): NodeCapacityView[] {
		if (!this.ctx.platformIam.canView(principal)) throw new CoreError('forbidden', 'Platform admin permission required.', 403);
		return this.capacityInternal();
	}

	capacityInternal(): NodeCapacityView[] {
		const reserved = this.reservedByNode();
		const reservedDisk = this.ctx.appVolumes.reservedDiskByNode();
		const reservedCpu = this.reservedCpuByNode();
		const databaseCounts = this.ctx.databases.countByNode();
		const storageCounts = this.ctx.storage.countByNode();
		const brokerCounts = this.ctx.brokers.countByNode();
		return this.ctx.db
			.select()
			.from(nodes)
			.all()
			.map((node) => {
				const stats = parseJson<Record<string, unknown> | null>(node.statsJson, null);
				const total = stats?.diskTotalBytes;
				return {
					nodeId: node.id,
					name: node.name,
					mode: node.mode,
					status: node.status,
					sliceMemoryMb: node.sliceMemoryMb,
					reservedMemoryMb: reserved.get(node.id) ?? 0,
					freeMemoryMb: node.sliceMemoryMb - (reserved.get(node.id) ?? 0),
					workloadCount:
						(this.countByNode().get(node.id) ?? 0) +
						(databaseCounts.get(node.id) ?? 0) +
						(storageCounts.get(node.id) ?? 0) +
						(brokerCounts.get(node.id) ?? 0),
					diskFreeBytes: nodeDiskFreeBytes(stats),
					diskTotalBytes:
						typeof total === 'number' && Number.isFinite(total) ? Math.max(0, Math.floor(total)) : null,
					reservedDiskBytes: reservedDisk.get(node.id) ?? 0,
				};
			});
	}

	/** Desired state for one node, including only public spec fields and secret references. */
	desiredForNode(nodeId: string): WorkloadDesired[] {
		const replicaRows = this.ctx.db
			.select()
			.from(workloadReplicas)
			.where(eq(workloadReplicas.nodeId, nodeId))
			.all();
		const replicaWorkloadIds = [...new Set(replicaRows.map((row) => row.workloadId))];
		const rows = this.ctx.db
			.select({ workload: workloads, project: projects, deployment: deployments })
			.from(workloads)
			.innerJoin(projects, eq(projects.id, workloads.projectId))
			.innerJoin(deployments, eq(deployments.id, workloads.deploymentId))
			.where(
				and(
					or(
						eq(workloads.nodeId, nodeId),
						// A surge move: the old node keeps its copy until the new one reports running.
						eq(workloads.movingFromNodeId, nodeId),
						replicaWorkloadIds.length > 0 ? inArray(workloads.id, replicaWorkloadIds) : sql`0`,
					),
					isNull(projects.deletedAt),
					eq(deployments.status, 'active'),
				),
			)
			.all();

		// Apps whose database is moving stay listed but stopped, so the agent keeps their state (D97).
		const quiesced = this.ctx.moves.quiescedProjectIds();
		const identityNode = this.nodeHasCapability(nodeId, WORKLOAD_IDENTITY_CAPABILITY);
		return rows.flatMap(({ workload, project, deployment: current }) => {
			const currentSpec = this.specOf(project, workload);
			const isolated = featureEnabled(this.ctx.config, 'ORG_NETWORKS');
			const volumes = this.ctx.appVolumes.mountsForWorkload(workload.id);
			// One copy of this workload as it should run on this node, on the given release. Every
			// copy runs the workload's own deployment except, mid-rollout, the ones not reached yet.
			const render = (deployment: typeof current, spec: WorkloadSpec, cpus: number): WorkloadDesired => {
				const release = this.ctx.db
					.select({ sha256: releases.sha256 })
					.from(releases)
					.where(eq(releases.id, deployment.releaseId))
					.get();
				const worker = spec.ingress === 'none';
				return {
					id: workload.id,
					projectId: project.id,
					projectSlug: project.slug,
					deploymentId: deployment.id,
					...(isolated ? { orgId: project.orgId, networkName: orgNetworkName(project.orgId) } : {}),
					runtime: spec.runtime,
					// Desired, not observed. The row's status is the agent's last report; echoing a
					// reported `stopped` back (an idle-stopped function, a crashed unit) makes the agent
					// remove the units, so the socket stops listening and the app never cold-starts again.
					status: quiesced.has(project.id) ? 'stopped' : 'running',
					release: release?.sha256 ?? null,
					...(spec.command ? { command: spec.command } : {}),
					// Node apps only (D125): every Bun workload's desired state stays byte-for-byte the same.
					...(spec.runtime === 'process' && spec.engine === 'node' ? { engine: 'node' as const } : {}),
					...(spec.image ? { image: desiredImage(spec) } : {}),
					// A function owns a socket per replica (phase 4). Replica 0 keeps the workload id, so
					// a single-host function dials `<workload-id>.sock`, matching the helper's socket unit.
					upstream:
						spec.runtime === 'function'
							? upstreamFor(workload.id, spec)
							: (workload.upstream ?? upstreamFor(project.id, spec)),
					// The row holds the whole reservation (D90); each unit is capped at one replica's share.
					memoryMb: spec.memoryMb,
					cpus,
					port: spec.port,
					healthPath: spec.healthPath,
					socketActivation: worker || spec.runtime === 'compose' ? false : spec.socketActivation,
					// Scale to zero for process apps (D121); only sent when it applies, so every other
					// workload's desired state is byte-for-byte what it was.
					...(spec.idleStopSeconds && processIdleStopIssue(spec) === null
						? { idleStopSeconds: spec.idleStopSeconds }
						: {}),
					// Rendered for the node that asks: attachments resolve to that node's loopback
					// endpoints, and a copy still running on the node it is leaving keeps its version.
					activationVersion: activationVersion(
						spec,
						this.attachmentsVersion(project.id, nodeId, spec.runtime, project.orgId, spec),
					),
					env: spec.env,
					secrets: spec.secrets,
					dataSizeMb: spec.data?.sizeMb ?? null,
					...(volumes.length > 0 ? { volumes } : {}),
					...(worker ? { ingress: 'none' as const } : {}),
					...(spec.runner ? { runner: { provider: 'github' as const } } : {}),
					...(spec.function ? { function: spec.function } : {}),
					// Compose services, volumes and routes. Host ports were assigned at deploy time.
					...(spec.compose ? { compose: spec.compose } : {}),
					// A marker only; the token arrives through activation. Old agents never see it.
					...(identityNode && workloadGetsIdentity(spec) ? { identity: true as const } : {}),
				};
			};
			const spec = currentSpec;
			const base = render(current, spec, workload.cpus);
			// A spread workload carries only the copies assigned to this node (C4).
			const assigned = replicaRows.filter((row) => row.workloadId === workload.id);
			if (assigned.length > 0) {
				return assigned.map((row) => {
					const id = workloadReplicaId(workload.id, row.replicaIndex);
					// Not yet reached by a rollout: this copy still runs the release before.
					const previous = row.deploymentId && row.deploymentId !== current.id ? this.copyRelease(row.deploymentId) : null;
					const copy = previous ? render(previous.deployment, previous.spec, Math.round(previous.spec.cpus)) : base;
					const copySpec = previous?.spec ?? spec;
					return {
						...copy,
						id,
						...(copySpec.runtime === 'function' ? { upstream: upstreamFor(id, copySpec) } : {}),
						replica: { index: row.replicaIndex },
					};
				});
			}
			// Plain single-copy workloads keep exactly the desired state they had before plan 21. A lone
			// worker that may be restarted elsewhere carries the lease that makes that safe (§8.4).
			if (spec.replicas === 1 && !spec.runner) {
				const ttlSeconds = this.runLeaseSeconds(project, workload, spec);
				return [ttlSeconds === null ? base : { ...base, runLease: { ttlSeconds } }];
			}
			return Array.from({ length: spec.replicas }, (_, index) => {
				const id = workloadReplicaId(workload.id, index);
				return {
					...base,
					id,
					// Each replica gets its own socket and therefore its own workerd host.
					...(spec.runtime === 'function' ? { upstream: upstreamFor(id, spec) } : {}),
					replica: { index },
				};
			});
		});
	}

	/**
	 * Everything the failover controller may re-place (docs/CLUSTERING.md §8.3, §3.10): each copy
	 * of a spread set, and each single-copy workload once the fleet has somewhere else to put it.
	 * A one-node install returns no single copies, so draining its only node stays what it was.
	 */
	replicaCopies(): ReplicaCopy[] {
		const copies: ReplicaCopy[] = [];
		const spreadWorkloads = new Set<string>();
		if (featureEnabled(this.ctx.config, 'MULTI_NODE_REPLICAS')) {
			const rows = this.ctx.db
				.select({ replica: workloadReplicas, workload: workloads, project: projects })
				.from(workloadReplicas)
				.innerJoin(workloads, eq(workloads.id, workloadReplicas.workloadId))
				.innerJoin(projects, eq(projects.id, workloadReplicas.projectId))
				.all();
			for (const { replica, workload, project } of rows) {
				spreadWorkloads.add(replica.workloadId);
				copies.push({
					id: replica.id,
					workloadId: replica.workloadId,
					projectId: replica.projectId,
					orgId: project.orgId,
					projectSlug: project.slug,
					nodeId: replica.nodeId,
					replicaIndex: replica.replicaIndex,
					status: replica.status,
					ingress: this.specOf(project as ProjectRow, workload).ingress === 'none' ? 'none' : 'http',
					updatedAt: replica.updatedAt,
				});
			}
		}
		if (!featureEnabled(this.ctx.config, 'WORKLOAD_MOVES')) return copies;
		const computeNodes = this.candidates().filter((candidate) => candidate.roles?.includes('compute') ?? true);
		if (computeNodes.length < 2) return copies;
		const failoverSingles = this.ctx.cluster.get().scheduling.failoverSingleCopies;
		const singles = this.ctx.db
			.select({ workload: workloads, project: projects })
			.from(workloads)
			.innerJoin(projects, eq(projects.id, workloads.projectId))
			.innerJoin(deployments, eq(deployments.id, workloads.deploymentId))
			.where(and(isNull(projects.deletedAt), eq(deployments.status, 'active')))
			.all();
		for (const { workload, project } of singles) {
			if (!workload.nodeId || spreadWorkloads.has(workload.id)) continue;
			const singleSpec = this.specOf(project as ProjectRow, workload);
			const ingress = singleSpec.ingress === 'none' ? 'none' : 'http';
			copies.push({
				id: workload.id,
				workloadId: workload.id,
				projectId: workload.projectId,
				orgId: project.orgId,
				projectSlug: project.slug,
				nodeId: workload.nodeId,
				replicaIndex: 0,
				status: workload.status,
				ingress,
				updatedAt: workload.updatedAt,
				single: true,
				// A worker may be started elsewhere only when its node is bound to stop it first.
				autoFailover: failoverSingles && (ingress === 'http' || this.runLeaseSeconds(project as ProjectRow, workload, singleSpec) !== null),
			});
		}
		return copies;
	}

	/**
	 * Why a single-copy workload cannot leave its node, or null when it can. Every reason is data
	 * or an address that lives on that node; nothing here is a preference.
	 */
	moveBlocker(
		project: ProjectRow,
		workload: WorkloadRow,
		spec: WorkloadSpec = this.specOf(project, workload),
		/** A move that carries the app volumes along (SCALING §7) asks about everything else. */
		options: { ignoreVolumes?: boolean } = {},
	): string | null {
		if (project.placement !== 'auto')
			return project.placement === 'edge'
				? 'its placement pins it to the edge'
				: 'its placement pins it to this node; set the placement to auto to let it move';
		if (placementSpecFor(project)?.node) return 'its placement constraints name one node';
		if (this.ctx.relocations.isRelocating(project.id)) return 'it is already moving to another node with its data';
		if (this.ctx.moves.quiescedProjectIds().has(project.id)) return 'it is stopped while its database moves';
		if (spec.data) return 'it keeps a persistent data directory on this node';
		if (!options.ignoreVolumes && this.ctx.appVolumes.mountsForWorkload(workload.id).length > 0)
			return 'its app volumes live on this node';
		if (spec.runtime === 'compose') return 'a compose stack keeps its volumes and ports on this node';
		const crossNode = featureEnabled(this.ctx.config, 'SERVICE_ENDPOINTS') && spec.runtime === 'process';
		if (crossNode) {
			if (this.ctx.brokers.requiredNode(project.id)) return 'its message broker is only reachable on this node (D111)';
			return null;
		}
		try {
			if (this.attachmentNode(project.id)) return 'it runs next to its attached database, storage or broker (D56)';
		} catch {
			return 'its attachments live on different nodes';
		}
		return null;
	}

	/**
	 * The run lease a single-copy worker carries, in seconds, or null when it has none (§8.4). A
	 * lease is what lets a lone worker be started on another node after its own went silent: the
	 * node stops it by itself once it has been out of contact for the TTL, and the fleet only
	 * restarts it after the failover grace, which must leave that node time to do so. It is opt-in
	 * (`scheduling.workerRunLeases`), because the same rule stops the worker when the control plane
	 * itself is unreachable for that long.
	 */
	runLeaseSeconds(project: ProjectRow, workload: WorkloadRow, spec: WorkloadSpec): number | null {
		const config = this.ctx.cluster.get();
		if (!config.scheduling.workerRunLeases || !config.failover.enabled || !config.scheduling.failoverSingleCopies) return null;
		if (!featureEnabled(this.ctx.config, 'WORKLOAD_MOVES')) return null;
		if (spec.ingress !== 'none' || spec.replicas !== 1 || spec.runner || !workload.nodeId) return null;
		const ttl = config.scheduling.runLeaseSeconds;
		// The node must have surely stopped it before the fleet starts another.
		if (config.replicas.failoverGraceSeconds < ttl + RUN_LEASE_MARGIN_SECONDS) return null;
		if (!this.nodeHasCapability(workload.nodeId, RUN_LEASES_CAPABILITY)) return null;
		// A worker that cannot move gains nothing from a lease and would only be stopped by it.
		if (this.moveBlocker(project, workload, spec)) return null;
		const computeNodes = this.ctx.db.select().from(nodes).all().filter((node) => this.ctx.nodes.view(node).roles.includes('compute'));
		return computeNodes.length >= 2 ? ttl : null;
	}

	/** True when the project consumes a database, private storage or a broker. */
	private hasAttachments(projectId: string): boolean {
		return (
			this.ctx.databases.requiredNode(projectId) !== null ||
			this.ctx.storage.requiredNode(projectId) !== null ||
			this.ctx.brokers.requiredNode(projectId) !== null
		);
	}

	/** Can this node run the workload at all (a functions host, a Node.js runtime)? */
	private canHost(nodeId: string, spec: WorkloadSpec, projectId?: string): boolean {
		// A node where another app holds this one's port can never take it (D225).
		if (projectId && nodePortConflict(this.ctx, projectId, spec, nodeId)) return false;
		try {
			if (spec.runtime === 'function') this.assertFunctionTarget(nodeId, Boolean(spec.function && functionIsPython(spec.function)));
			if (spec.runtime === 'process' && spec.engine === 'node') this.assertNodeEngineTarget(nodeId);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Admission for moving one copy (§8.2 steps 1–4): an online compute node with room, not one
	 * that already holds a copy of this workload (nor its zone under `spread: zone`), and not in
	 * `exclude` (the controller's flapping and rate-limit filter). `to` asks for one node. Writes
	 * nothing. The id is a `workload_replicas` row or, for a single copy, the workload itself.
	 */
	planReplicaMove(
		copyId: string,
		exclude: ReadonlySet<string> = new Set(),
		to?: string,
		options: { ignoreVolumes?: boolean } = {},
	): { ok: true; nodeId: string; nodeName: string } | { ok: false; message: string } {
		const row = this.ctx.db.select().from(workloadReplicas).where(eq(workloadReplicas.id, copyId)).get();
		if (!row) {
			const single = this.ctx.db.select().from(workloads).where(eq(workloads.id, copyId)).get();
			return single ? this.planSingleMove(single, exclude, to, options) : { ok: false, message: 'The copy no longer exists.' };
		}
		const workload = this.ctx.db.select().from(workloads).where(eq(workloads.id, row.workloadId)).get();
		if (!workload) return { ok: false, message: 'The workload no longer exists.' };
		const spec = this.specOf(this.requireProject(workload.projectId), workload);
		const siblings = this.ctx.db
			.select()
			.from(workloadReplicas)
			.where(eq(workloadReplicas.workloadId, row.workloadId))
			.all()
			.filter((other) => other.id !== row.id);
		const all = this.candidates({ excludeWorkloadId: workload.id });
		const zoneOf = new Map(all.map((candidate) => [candidate.id, candidate.zone ?? 'default']));
		const spread = this.ctx.cluster.get().replicas.spread;
		const keptNodes = new Set(siblings.map((other) => other.nodeId));
		const keptZones = new Set(siblings.map((other) => zoneOf.get(other.nodeId) ?? 'default'));
		// The siblings still hold their own shares; only this copy's room was given back above.
		const share = Math.ceil(workload.memoryMb / Math.max(1, siblings.length + 1));
		for (const candidate of all) if (keptNodes.has(candidate.id)) candidate.reservedMemoryMb += share;
		const candidates = this.replicaCandidates(
			all
				.filter((candidate) => candidate.id !== row.nodeId && !exclude.has(candidate.id))
				.filter((candidate) => to === undefined || candidate.id === to)
				.filter((candidate) => !keptNodes.has(candidate.id))
				.filter((candidate) => spread !== 'zone' || !keptZones.has(candidate.zone ?? 'default'))
				.filter((candidate) => this.canHost(candidate.id, spec, workload.projectId)),
		);
		if (candidates.length === 0)
			return { ok: false, message: 'placement_blocked: no other online node can take this copy.' };
		const planned = planReplicas({
			count: 1,
			memoryMb: spec.memoryMb,
			cpuMillis: Math.round((spec.cpus ?? 1) * 1000),
			spread,
			strategy: this.ctx.cluster.get().scheduling.strategy,
			candidates,
		});
		if (!planned.ok) return { ok: false, message: `placement_blocked: ${planned.message}` };
		const target = planned.plan.assignments[0]!;
		return { ok: true, nodeId: target.nodeId, nodeName: candidates.find((c) => c.id === target.nodeId)?.name ?? target.nodeId };
	}

	private planSingleMove(
		workload: WorkloadRow,
		exclude: ReadonlySet<string>,
		to?: string,
		options: { ignoreVolumes?: boolean } = {},
	): { ok: true; nodeId: string; nodeName: string } | { ok: false; message: string } {
		if (!workload.nodeId) return { ok: false, message: 'The workload has not been placed yet.' };
		const project = this.requireProject(workload.projectId);
		const spec = this.specOf(project, workload);
		const blocker = this.moveBlocker(project, workload, spec, options);
		if (blocker) return { ok: false, message: `placement_blocked: ${project.slug} cannot move because ${blocker}.` };
		const candidates = this.candidates({ excludeWorkloadId: workload.id }).filter(
			(candidate) =>
				candidate.id !== workload.nodeId && !exclude.has(candidate.id) && this.canHost(candidate.id, spec, workload.projectId),
		);
		if (candidates.length === 0)
			return { ok: false, message: 'placement_blocked: no other online node can take this workload.' };
		const placementSpec = placementSpecFor(project);
		const decision = resolvePlacement({
			runtime: effectiveRuntime(project),
			requested: to ?? 'auto',
			memoryMb: reservedMemoryMb(spec),
			cpuMillis: (spec.cpus ?? 1) * 1000 * (spec.replicas ?? 1),
			edgeNodeId: this.edgeNodeId(),
			candidates,
			spec: placementSpec,
			nearNodeIds: placementSpec?.near ? this.nearNodeIds(placementSpec.near) : undefined,
			strategy: this.ctx.cluster.get().scheduling.strategy,
		});
		if (!decision.ok) return { ok: false, message: `placement_blocked: ${decision.message}` };
		return {
			ok: true,
			nodeId: decision.nodeId,
			nodeName: candidates.find((candidate) => candidate.id === decision.nodeId)?.name ?? decision.nodeId,
		};
	}

	/**
	 * Re-place one copy (§8.3 step 6): the row keeps its index, records why it moved and goes
	 * `pending` until the new node reports it. Desired state for both nodes and the ingress
	 * upstreams follow from the bump. The caller (the failover controller) holds the lease.
	 */
	moveReplica(copyId: string, nodeId: string, reason: MoveReason): void {
		const row = this.ctx.db.select().from(workloadReplicas).where(eq(workloadReplicas.id, copyId)).get();
		if (!row) {
			const single = this.ctx.db.select().from(workloads).where(eq(workloads.id, copyId)).get();
			if (!single) throw new NotFoundError('Workload replica');
			this.moveSingle(single, nodeId, reason);
			return;
		}
		const workload = this.ctx.db.select().from(workloads).where(eq(workloads.id, row.workloadId)).get();
		if (!workload) throw new NotFoundError('Workload');
		const now = this.ctx.now();
		this.ctx.db
			.update(workloadReplicas)
			.set({ nodeId, status: 'pending', placementReason: reason, updatedAt: now })
			.where(eq(workloadReplicas.id, row.id))
			.run();
		if (row.replicaIndex === 0)
			this.ctx.db
				.update(workloads)
				.set({ nodeId, status: 'pending', updatedAt: now })
				.where(eq(workloads.id, workload.id))
				.run();
		// The copy's new node needs the loopback endpoints a deploy would have given it, or its
		// attachment env is empty (no DATABASE_URL) and it crash-loops; the old node's are freed.
		this.reconcileEndpoints(workload.projectId, [row.nodeId]);
		this.ctx.projects.bump(this.requireProject(workload.projectId).orgId);
	}

	/**
	 * Move a single-copy workload. An HTTP app with nothing attached moves with a **surge**: the
	 * new node starts its copy while the old one keeps serving, and the route follows only once
	 * the new copy reports `running` (`applyHeartbeat`). A failover has no old copy to keep, a
	 * worker must not run twice, and an attached app's environment names its node's loopback
	 * ports, so those three stop on the old node and start on the new one.
	 */
	private moveSingle(workload: WorkloadRow, nodeId: string, reason: MoveReason): void {
		const from = workload.nodeId;
		if (!from || from === nodeId) return;
		const project = this.requireProject(workload.projectId);
		const spec = this.specOf(project, workload);
		const now = this.ctx.now();
		const sourceOnline =
			this.ctx.db.select({ status: nodes.status }).from(nodes).where(eq(nodes.id, from)).get()?.status !== 'offline';
		const surge = reason !== 'failover' && sourceOnline && spec.ingress !== 'none' && !this.hasAttachments(project.id);
		this.ctx.sqlite.transaction(() => {
			this.ctx.db
				.update(workloads)
				.set({
					nodeId,
					status: 'pending',
					message: null,
					movingFromNodeId: surge ? from : null,
					movedAt: now,
					placementReason: reason,
					updatedAt: now,
				})
				.where(eq(workloads.id, workload.id))
				.run();
			// The deployments a rollback would restore follow the workload, as an app move does (D97).
			this.ctx.db
				.update(deployments)
				.set({ nodeId })
				.where(and(eq(deployments.projectId, project.id), eq(deployments.nodeId, from)))
				.run();
		})();
		if (featureEnabled(this.ctx.config, 'SERVICE_ENDPOINTS') && spec.runtime === 'process') {
			// The new node gets its loopback endpoints; the old node's are freed now the row moved.
			this.ctx.endpoints.reconcile(project.id, nodeId);
			this.ctx.endpoints.reconcile(null, from);
		}
		this.ctx.projects.bump(project.orgId);
	}

	/**
	 * Undo a surge move that never came up: the old node still runs its copy, so the workload
	 * goes back to it and the new node is told to stop. Returns false when there was no surge
	 * to undo (a stop/start move has nothing to fall back to).
	 */
	rollbackMove(copyId: string): boolean {
		const workload = this.ctx.db.select().from(workloads).where(eq(workloads.id, copyId)).get();
		if (!workload?.movingFromNodeId || !workload.nodeId) return false;
		const back = workload.movingFromNodeId;
		const failed = workload.nodeId;
		const now = this.ctx.now();
		this.ctx.sqlite.transaction(() => {
			this.ctx.db
				.update(workloads)
				.set({ nodeId: back, movingFromNodeId: null, status: 'running', message: null, movedAt: now, updatedAt: now })
				.where(eq(workloads.id, workload.id))
				.run();
			this.ctx.db
				.update(deployments)
				.set({ nodeId: back })
				.where(and(eq(deployments.projectId, workload.projectId), eq(deployments.nodeId, failed)))
				.run();
		})();
		this.ctx.projects.bump(workload.orgId);
		return true;
	}

	/** A move with data switched the workload's node: bring each node's service endpoints in step. */
	afterRelocation(projectId: string, fromNodeId: string): void {
		this.reconcileEndpoints(projectId, [fromNodeId]);
	}

	/** Does this node run (or still run, mid-move) the given copy of the workload? */
	runsOnNode(row: Pick<WorkloadRow, 'id' | 'nodeId' | 'movingFromNodeId'>, replica: number, nodeId: string): boolean {
		if (row.nodeId === nodeId || row.movingFromNodeId === nodeId) return true;
		return Boolean(
			this.ctx.db
				.select({ id: workloadReplicas.id })
				.from(workloadReplicas)
				.where(
					and(
						eq(workloadReplicas.workloadId, row.id),
						eq(workloadReplicas.replicaIndex, replica),
						eq(workloadReplicas.nodeId, nodeId),
					),
				)
				.get(),
		);
	}

	/**
	 * The fleet as the rebalance planner sees it (§3.10): each node's ceiling and reservations, and
	 * every copy with the reason it must stay, if any.
	 */
	balanceSnapshot(exclude: ReadonlySet<string> = new Set()): { nodes: BalanceNode[]; units: BalanceUnit[] } {
		const candidates = this.candidates();
		const zoneOf = new Map(candidates.map((candidate) => [candidate.id, candidate.zone ?? 'default']));
		const balanceNodes: BalanceNode[] = candidates.map((candidate) => ({
			id: candidate.id,
			name: candidate.name,
			zone: candidate.zone ?? 'default',
			// A node whose host memory is nearly full gives work away but takes none.
			eligible:
				candidate.status === 'online' &&
				(candidate.roles?.includes('compute') ?? true) &&
				!exclude.has(candidate.id) &&
				!candidate.pressured,
			capacityMb: candidate.sliceMemoryMb,
			reservedMb: candidate.reservedMemoryMb,
			cpuCapacityMillis: candidate.cpuBudgetMillis ?? null,
			reservedCpuMillis: candidate.reservedCpuMillis ?? 0,
		}));
		const spread = this.ctx.cluster.get().replicas.spread;
		const rows = this.ctx.db
			.select({ workload: workloads, project: projects })
			.from(workloads)
			.innerJoin(projects, eq(projects.id, workloads.projectId))
			.innerJoin(deployments, eq(deployments.id, workloads.deploymentId))
			.where(and(isNull(projects.deletedAt), eq(deployments.status, 'active')))
			.all();
		const replicaRows = featureEnabled(this.ctx.config, 'MULTI_NODE_REPLICAS')
			? this.ctx.db.select().from(workloadReplicas).all()
			: [];
		const units: BalanceUnit[] = [];
		for (const { workload, project } of rows) {
			if (!workload.nodeId || !ACTIVE_STATUSES.includes(workload.status)) continue;
			const spec = this.specOf(project as ProjectRow, workload);
			const allowed = candidates.filter((candidate) => this.canHost(candidate.id, spec, workload.projectId)).map((candidate) => candidate.id);
			const allowedNodeIds = allowed.length === candidates.length ? null : allowed;
			const copies = replicaRows.filter((row) => row.workloadId === workload.id);
			if (copies.length === 0) {
				units.push({
					id: workload.id,
					label: project.slug,
					nodeId: workload.nodeId,
					memoryMb: workload.memoryMb,
					cpuMillis: workload.cpus * 1000,
					blocker: workload.movingFromNodeId
						? 'it is already moving'
						: this.moveBlocker(project as ProjectRow, workload, spec),
					avoidNodeIds: [],
					avoidZones: [],
					allowedNodeIds,
				});
				continue;
			}
			for (const copy of copies) {
				const siblings = copies.filter((other) => other.id !== copy.id);
				units.push({
					id: copy.id,
					label: `${project.slug} [r${copy.replicaIndex}]`,
					nodeId: copy.nodeId,
					memoryMb: Math.ceil(workload.memoryMb / copies.length),
					cpuMillis: workload.cpus * 1000,
					blocker: copy.status === 'pending' ? 'it is already moving' : null,
					avoidNodeIds: siblings.map((other) => other.nodeId),
					avoidZones: spread === 'zone' ? siblings.map((other) => zoneOf.get(other.nodeId) ?? 'default') : [],
					allowedNodeIds,
				});
			}
		}
		return { nodes: balanceNodes, units };
	}

	/**
	 * Decrypted values for one workload. The node token must own the workload's node; the payload
	 * is never cached on disk by the agent.
	 */
	activation(nodeId: string, desiredId: string): WorkloadActivation {
		// Read replicas (`db_dbr_…`) carry the database prefix too, so route them first (C7).
		if (this.ctx.databaseReplicas.isReplicaWorkloadId(desiredId))
			return this.ctx.databaseReplicas.activation(nodeId, desiredId);
		if (this.ctx.databases.isDatabaseId(desiredId)) return this.ctx.databases.activation(nodeId, desiredId);
		if (this.ctx.storage.isStorageId(desiredId)) return this.ctx.storage.activation(nodeId, desiredId);
		if (this.ctx.brokers.isBrokerId(desiredId)) return this.ctx.brokers.activation(nodeId, desiredId);
		if (this.ctx.kubernetes.isMachineId(desiredId)) return this.ctx.kubernetes.activation(nodeId, desiredId);
		if (this.ctx.registry.isRegistryId(desiredId)) return this.ctx.registry.activation(nodeId, desiredId);
		const { workloadId, replica } = parseWorkloadReplicaId(desiredId);
		const row = this.ctx.db.select().from(workloads).where(eq(workloads.id, workloadId)).get();
		if (!row) throw new NotFoundError('Workload');
		this.assertWorkloadOnNode(row, workloadId, replica, nodeId);
		const project = this.requireProject(row.projectId);
		// A copy a rollout has not reached yet is activated with the release it still runs.
		const copy = this.ctx.db
			.select()
			.from(workloadReplicas)
			.where(
				and(
					eq(workloadReplicas.workloadId, workloadId),
					eq(workloadReplicas.replicaIndex, replica),
					eq(workloadReplicas.nodeId, nodeId),
				),
			)
			.get();
		const previous = copy?.deploymentId && copy.deploymentId !== row.deploymentId ? this.copyRelease(copy.deploymentId) : null;
		const spec = previous?.spec ?? this.specOf(project, row);
		const deploymentId = previous?.deployment.id ?? row.deploymentId;
		if (!copy && replica >= spec.replicas) throw new NotFoundError('Workload replica');
		const appErrorEnv = this.ctx.appErrors.consumerEnv(row.projectId);
		if (appErrorEnv.SENTRY_DSN && deploymentId) {
			appErrorEnv.SENTRY_RELEASE = deploymentId;
			appErrorEnv.SENTRY_ENVIRONMENT = project.productionDeploymentId === deploymentId ? 'production' : 'preview';
		}
		// Attached database, storage and broker connection values sit under the spec's own env and secrets (D56, S4, D111).
		const env: Record<string, string> = {
			...this.ctx.email.consumerEnv(row.projectId),
			// The node that asks is the node the copy runs on: its loopback endpoints, not copy 0's.
			...this.ctx.brokers.consumerEnv(row.projectId, nodeId, spec.runtime),
			...this.ctx.storage.consumerEnv(row.projectId, nodeId, spec.runtime),
			...this.ctx.databases.consumerEnv(row.projectId, nodeId, spec.runtime),
			...this.ctx.userPools.consumerEnv(row.projectId),
			...appErrorEnv,
			...spec.env,
		};
		const files: Record<string, string> = {};
		// A compose service may name secrets the top-level workload does not; resolve the union.
		const secretNames = new Set(spec.secrets.map((ref) => ref.name));
		for (const service of spec.compose?.services ?? []) for (const name of service.secrets) secretNames.add(name);
		for (const ref of spec.secrets) {
			const value = this.ctx.secrets.getValue(row.orgId, ref.name, ref.version, row.projectId);
			if (!value) continue;
			if (ref.delivery === 'file') files[ref.name] = value.value;
			else env[ref.name] = value.value;
		}
		// Compose services declare names only (secrets are delivered as env for containers).
		for (const name of secretNames) {
			if (Object.hasOwn(env, name)) continue;
			const value = this.ctx.secrets.getValue(row.orgId, name, undefined, row.projectId);
			if (value) env[name] = value.value;
		}
		// Containers pull with the org's credential for the image's registry (R2), if it has one.
		const registryAuth =
			spec.runtime === 'container'
				? this.ctx.registryCredentials.authForImage(row.orgId, spec.image, desiredId)
				: spec.compose
					? [
							...new Map(
								spec.compose.services.flatMap((service) =>
									this.ctx.registryCredentials
										.authForImage(row.orgId, service.image, `${desiredId}--${service.name}`)
										.map((entry) => [`${entry.registry}:${entry.username}`, entry] as const),
								),
							).values(),
						]
					: [];
		return {
			workloadId: desiredId,
			activationVersion: activationVersion(spec, this.attachmentsVersion(row.projectId, nodeId, spec.runtime, row.orgId, spec)),
			env,
			files,
			...(registryAuth.length > 0 ? { registryAuth } : {}),
		};
	}

	/**
	 * The activation the agent endpoint serves. A runner replica additionally gets a fresh,
	 * single-use JIT config on every call (D91): the agent only asks again after the replica's
	 * container exited, so each job runs on a newly registered runner.
	 */
	async activationFor(nodeId: string, desiredId: string): Promise<WorkloadActivation> {
		const activation = this.activation(nodeId, desiredId);
		const { workloadId, replica } = parseWorkloadReplicaId(desiredId);
		const row = this.ctx.db.select().from(workloads).where(eq(workloads.id, workloadId)).get();
		if (!row) return activation;
		const project = this.requireProject(row.projectId);
		const spec = this.specOf(project, row);
		if (spec.runner) {
			try {
				const env = await this.ctx.githubRunners.mintJitConfig({
					orgId: row.orgId,
					projectId: row.projectId,
					projectSlug: project.slug,
					workloadId: row.id,
					replica,
					runner: spec.runner,
				});
				if (row.message?.startsWith(RUNNER_MESSAGE_PREFIX)) this.ctx.githubRunners.noteFailure(row.id, null);
				return { ...activation, env: { ...activation.env, ...env } };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.ctx.githubRunners.noteFailure(row.id, `${RUNNER_MESSAGE_PREFIX}${message}`.slice(0, 500));
				throw error;
			}
		}
		if (!workloadGetsIdentity(spec) || !this.nodeHasCapability(nodeId, WORKLOAD_IDENTITY_CAPABILITY))
			return activation;
		const identity = await this.ctx.workloadIdentity.activation(row.id, WORKLOAD_IDENTITY_AUDIENCE);
		// Identity is only for process and container workloads; compose returns before this.
		const identityUrl = workloadIdentityUrl(spec.runtime === 'process' ? 'process' : 'container');
		// Attached storage gets short-lived STS credentials when the node understands them. Any
		// failure keeps the sealed attachment key already present in `activation.env` (IAM.md §7.4).
		const storage = await this.ctx.storage.workloadConsumerEnv(
			{ kind: 'workload', userId: row.id, orgId: row.orgId, role: 'viewer', permissions: new Set() },
			row.projectId,
			row.nodeId,
			spec.runtime,
			{ sts: this.nodeHasCapability(nodeId, STORAGE_STS_CAPABILITY) },
		);
		return {
			...activation,
			env: {
				...activation.env,
				...storage.env,
				// Platform values win over the user's environment: the token file is the workload's,
				// and the metadata endpoint is how it refreshes it.
				[WORKLOAD_IDENTITY_TOKEN_ENV]: WORKLOAD_IDENTITY_MOUNT_PATH,
				...(identityUrl ? { [WORKLOAD_IDENTITY_URL_ENV]: identityUrl } : {}),
			},
			identity,
			...(storage.sts.length > 0 ? { storageSts: storage.sts } : {}),
		};
	}

	/**
	 * Mint a token for one workload on this node, for the agent's metadata endpoint. The node token
	 * has already proved which node is asking, and this checks the workload is placed there.
	 */
	async identityFor(
		nodeId: string,
		desiredId: string,
		audience: string = WORKLOAD_IDENTITY_AUDIENCE,
	): Promise<WorkloadIdentityResponse> {
		const { workloadId, replica } = parseWorkloadReplicaId(desiredId);
		const row = this.ctx.db.select().from(workloads).where(eq(workloads.id, workloadId)).get();
		if (!row) throw new NotFoundError('Workload');
		this.assertWorkloadOnNode(row, workloadId, replica, nodeId);
		const project = this.requireProject(row.projectId);
		const spec = this.specOf(project, row);
		if (replica >= spec.replicas) throw new NotFoundError('Workload replica');
		if (!workloadGetsIdentity(spec) || !this.nodeHasCapability(nodeId, WORKLOAD_IDENTITY_CAPABILITY))
			throw new ValidationError('This workload does not use workload identity.');
		return this.ctx.workloadIdentity.response(row.id, audience);
	}

	/** A spread copy (C4) lives on its own node; a copy re-placed by failover keeps its index. */
	private assertWorkloadOnNode(
		row: WorkloadRow,
		workloadId: string,
		replica: number,
		nodeId: string,
	): void {
		if (row.nodeId === nodeId || row.movingFromNodeId === nodeId) return;
		const spreadCopy = this.ctx.db
			.select({ id: workloadReplicas.id })
			.from(workloadReplicas)
			.where(
				and(
					eq(workloadReplicas.workloadId, workloadId),
					eq(workloadReplicas.replicaIndex, replica),
					eq(workloadReplicas.nodeId, nodeId),
				),
			)
			.get();
		if (!spreadCopy) throw new CoreError('forbidden', 'This workload is placed on another node.', 403);
	}

	/** Does this node's agent advertise a capability? An agent that predates capabilities has none. */
	private nodeHasCapability(nodeId: string, capability: string): boolean {
		const row = this.ctx.db
			.select({ capabilitiesJson: nodes.capabilitiesJson })
			.from(nodes)
			.where(eq(nodes.id, nodeId))
			.get();
		return nodeCapabilities(row?.capabilitiesJson ?? null).includes(capability);
	}

	/** Apply the agent's actual-state report from a heartbeat. */
	applyHeartbeat(
		nodeId: string,
		reports: Array<{ id: string; status: WorkloadStatus; restarts: number }>,
		/** The desired-state version the node has converged to, when it reports one. */
		actualStateVersion?: number,
	): void {
		this.applyReplicaReports(nodeId, reports, actualStateVersion);
		for (const report of aggregateReplicaReports(reports)) {
			const row = this.ctx.db.select().from(workloads).where(eq(workloads.id, report.id)).get();
			if (!row || row.nodeId !== nodeId) continue;
			const status: WorkloadStatus =
				report.status === 'running' && report.restarts >= 5 ? 'failed' : report.status;
			// A surge move ends here: the new copy is up, so the route follows it and the old node
			// drops its copy on the next pull.
			const arrived = status === 'running' && row.movingFromNodeId !== null;
			if (status === row.status && !arrived) continue;
			if (arrived) this.ctx.projects.bump(row.orgId);
			this.ctx.db
				.update(workloads)
				.set({
					...(arrived ? { movingFromNodeId: null } : {}),
					status,
					message: report.restarts >= 5 ? `Restart loop (${report.restarts} restarts)` : row.message,
					updatedAt: this.ctx.now(),
				})
				.where(eq(workloads.id, row.id))
				.run();
		}
	}

	/**
	 * Per-copy status for spread replicas (C4): the failover controller completes a move when the
	 * copy reports `running` from its new node. Only rows placed on the reporting node change.
	 */
	private applyReplicaReports(
		nodeId: string,
		reports: Array<{ id: string; status: WorkloadStatus; restarts: number }>,
		actualStateVersion?: number,
	): void {
		if (!featureEnabled(this.ctx.config, 'MULTI_NODE_REPLICAS')) return;
		const rows = this.ctx.db.select().from(workloadReplicas).where(eq(workloadReplicas.nodeId, nodeId)).all();
		if (rows.length === 0) return;
		const byCopy = new Map(rows.map((row) => [workloadReplicaId(row.workloadId, row.replicaIndex), row]));
		const now = this.ctx.now();
		for (const report of reports) {
			const row = byCopy.get(report.id);
			if (!row) continue;
			// A copy a rollout just restarted: until the node has converged to that change, its report
			// still describes the old unit, and `running` would let the rollout race ahead.
			const awaiting = row.appliedVersion !== null;
			if (awaiting && (actualStateVersion === undefined || actualStateVersion < row.appliedVersion!)) continue;
			const status = report.status === 'running' && report.restarts >= 5 ? 'failed' : report.status;
			// Up or definitely failed: either way the node has answered for the restarted copy.
			const confirmed = awaiting && (status === 'running' || status === 'failed');
			if (status === row.status && !confirmed) continue;
			this.ctx.db
				.update(workloadReplicas)
				.set({ status, ...(confirmed ? { appliedVersion: null } : {}), updatedAt: now })
				.where(eq(workloadReplicas.id, row.id))
				.run();
		}
	}

	// ------------------------------------------------------------------ rolling deploys (SCALING §4)

	/**
	 * Advance every rollout by at most one copy. A copy is restarted on the new release only when
	 * every copy already on it is confirmed running, so a set never loses more than one copy at a
	 * time. A copy that fails, or does not come up in time, pauses the rollout: the copies not yet
	 * reached keep serving the previous release, and nothing more is touched until a human acts.
	 * Called by the controller that holds the failover lease.
	 */
	rolloutTick(now: number = this.ctx.now()): Array<{ key: string; title: string; detail: string; severity: 'warning' | 'info' }> {
		const alerts: Array<{ key: string; title: string; detail: string; severity: 'warning' | 'info' }> = [];
		const timeoutMs = this.ctx.cluster.get().scheduling.rolloutTimeoutSeconds * 1000;
		const rolling = this.ctx.db.select().from(workloads).where(eq(workloads.rolloutStatus, 'rolling')).all();
		for (const workload of rolling) {
			const rows = this.ctx.db
				.select()
				.from(workloadReplicas)
				.where(eq(workloadReplicas.workloadId, workload.id))
				.all()
				.sort((a, b) => a.replicaIndex - b.replicaIndex);
			const project = this.ctx.db.select().from(projects).where(eq(projects.id, workload.projectId)).get();
			// Copies that are not serving anyway go first, so a rollout never takes a healthy copy
			// down while a broken one is still waiting for the fix.
			const waiting = rows
				.filter((row) => row.deploymentId !== null && row.deploymentId !== workload.deploymentId)
				.sort((a, b) => Number(a.status === 'running') - Number(b.status === 'running') || a.replicaIndex - b.replicaIndex);
			const updated = rows.filter((row) => !waiting.includes(row));
			const slug = project?.slug ?? workload.projectId;
			const overdue = (row: ReplicaRow) => now - (row.rolledAt ?? row.updatedAt) >= timeoutMs;
			// Restarted and not yet confirmed by its node, or placed and not yet up.
			const unsettled = updated.filter((row) => row.appliedVersion !== null || row.status !== 'running');
			const failed = unsettled.find((row) => (row.appliedVersion === null && row.status === 'failed') || overdue(row));
			if (failed) {
				const node = this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, failed.nodeId)).get()?.name ?? failed.nodeId;
				const what =
					failed.status === 'failed' && failed.appliedVersion === null
						? `Copy r${failed.replicaIndex} failed on ${node} with the new release.`
						: `Copy r${failed.replicaIndex} on ${node} did not become healthy within ${Math.round(timeoutMs / 1000)} s.`;
				// The previous release is known to work, so it goes back by itself; once. If the
				// rollback fails too, the problem is not the release, and a person has to look.
				const from = workload.rolloutFromDeploymentId;
				if (project && from && !workload.rolloutAuto && this.ctx.cluster.get().scheduling.autoRollback && this.copyRelease(from)) {
					const serving = waiting.length > 0 ? 'The app kept serving on the previous release throughout.' : '';
					const detail = `${what} ${slug} was rolled back to its previous release automatically. ${serving}`.trim();
					this.ctx.deployments.revertFailedRelease(project as ProjectRow, workload.deploymentId, from, what);
					this.ctx.db
						.update(workloads)
						.set({ rollbackNote: detail, rollbackAt: now })
						.where(eq(workloads.id, workload.id))
						.run();
					alerts.push({ key: `rollout:${workload.id}`, title: `${slug}: a failed release was rolled back`, detail, severity: 'warning' });
					continue;
				}
				const rest =
					waiting.length > 0
						? `The rollout is paused: ${waiting.length} of ${rows.length} ${waiting.length === 1 ? 'copy still runs' : 'copies still run'} the previous release and ${waiting.length === 1 ? 'keeps' : 'keep'} serving.`
						: 'Every other copy is on the new release.';
				const detail = `${what} ${rest} Roll back, or deploy a fix.`;
				this.ctx.db
					.update(workloads)
					.set({ rolloutStatus: 'paused', rolloutMessage: detail, updatedAt: now })
					.where(eq(workloads.id, workload.id))
					.run();
				alerts.push({ key: `rollout:${workload.id}`, title: `Rollout of ${slug} paused`, detail, severity: 'warning' });
				continue;
			}
			// One at a time: every copy on the new release is confirmed before the next is touched.
			if (unsettled.length > 0) continue;
			const next = waiting[0];
			if (!next) {
				this.ctx.db
					.update(workloads)
					.set({ rolloutStatus: null, rolloutMessage: null, rolloutFromDeploymentId: null, rolloutAuto: false, updatedAt: now })
					.where(eq(workloads.id, workload.id))
					.run();
				if (workload.rolloutSurge) this.endSurge(workload, now);
				continue;
			}
			this.ctx.projects.bump(workload.orgId);
			this.ctx.db
				.update(workloadReplicas)
				.set({
					deploymentId: null,
					status: 'pending',
					// The node must be seen converged to this change before `running` counts.
					appliedVersion: this.ctx.projects.stateVersion(),
					rolledAt: now,
					updatedAt: now,
				})
				.where(eq(workloadReplicas.id, next.id))
				.run();
		}
		return alerts;
	}

	/** Carry on with a paused rollout: the failed copy is retried, then the rest follow. */
	resumeRollout(principal: Principal, project: ProjectRow): void {
		this.ctx.iam.require(principal, 'deployment:create', { type: 'project', id: project.id });
		const workload = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
		if (!workload || workload.rolloutStatus !== 'paused') throw new ConflictError(`"${project.slug}" has no paused rollout.`);
		const now = this.ctx.now();
		this.ctx.projects.bump(project.orgId);
		const version = this.ctx.projects.stateVersion();
		for (const row of this.ctx.db.select().from(workloadReplicas).where(eq(workloadReplicas.workloadId, workload.id)).all()) {
			if (row.deploymentId !== null && row.deploymentId !== workload.deploymentId) continue;
			if (row.status === 'running' && row.appliedVersion === null) continue;
			this.ctx.db
				.update(workloadReplicas)
				.set({ status: 'pending', appliedVersion: version, rolledAt: now, updatedAt: now })
				.where(eq(workloadReplicas.id, row.id))
				.run();
		}
		this.ctx.db
			.update(workloads)
			.set({ rolloutStatus: 'rolling', rolloutMessage: null, updatedAt: now })
			.where(eq(workloads.id, workload.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'workload.rollout_resume',
			resource: 'workload',
			resourceId: workload.id,
			args: { project: project.slug },
			result: 'ok',
		});
	}

	// ------------------------------------------------------------------ scaling (SCALING §2–§3)

	/**
	 * Change how many copies run, without a deploy. Copies that stay are not touched; new ones are
	 * placed on nodes with room and removed ones are the highest indices. Nothing is written when
	 * the fleet cannot take the copies, unless `partial` asks for as many as fit (the autoscaler).
	 */
	scaleCopies(
		project: ProjectRow,
		replicas: number,
		options: { partial?: boolean } = {},
	): { from: number; to: number; added: Array<{ index: number; nodeId: string }>; removed: Array<{ index: number; nodeId: string }> } {
		if (effectiveRuntime(project) === 'static') throw new ValidationError(`"${project.slug}" is a static site; the edge serves it, so it has no copies to scale.`);
		const workload = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get() ?? null;
		const current = workload ? this.specOf(project, workload) : (this.projectSpec(project) ?? this.defaultSpec(project));
		const from = current.replicas;
		const limit = this.ctx.cluster.get().replicas.max;
		if (replicas > limit) throw new ValidationError(`This install allows at most ${limit} replicas per workload.`);
		const check = (count: number): WorkloadSpec => {
			const parsed = workloadSpecSchema.safeParse({ ...current, replicas: count });
			if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'That number of copies is not valid for this app.', parsed.error.issues);
			return parsed.data;
		};
		let next = check(replicas);
		const { mode, blocker } = this.scalingMode(project, next, workload);
		if (replicas > 1 && mode === 'single') throw new ValidationError(`"${project.slug}" cannot run ${replicas} copies: ${blocker}.`);

		if (workload?.rolloutSurge)
			throw new ConflictError(`"${project.slug}" is in the middle of a deploy. Scale it once the new release is up.`);
		const now = this.ctx.now();
		let added: ReplicaRow[] = [];
		let removed: ReplicaRow[] = [];
		const nodesBefore = new Set(workload ? this.copyPlacements(workload).map((copy) => copy.nodeId) : []);
		if (workload) {
			const prior = this.ctx.db.select().from(workloadReplicas).where(eq(workloadReplicas.workloadId, workload.id)).all();
			if (mode === 'spread' || mode === 'stack') {
				const plan = (count: number) =>
					planReplicas({
						count,
						memoryMb: next.memoryMb,
						cpuMillis: Math.round((next.cpus ?? 1) * 1000),
						spread: this.ctx.cluster.get().replicas.spread,
						strategy: this.ctx.cluster.get().scheduling.strategy,
						stack: mode === 'stack',
						reason: 'scale',
						existing: this.copyPlacements(workload),
						candidates: this.copyCandidates(project, next, workload.id),
					});
				let planned = plan(replicas);
				if (!planned.ok && options.partial && planned.placeable > from) {
					next = check(planned.placeable);
					planned = plan(planned.placeable);
				}
				if (!planned.ok) throw new ValidationError(planned.message, planned.refusals);
				this.ctx.quota.assertCanAdmitMemory(project.orgId, project.id, Math.max(0, reservedMemoryMb(next) - workload.memoryMb));
				const assignments = planned.plan.assignments;
				// One copy left on the workload's own node needs no row: it is the plain single-copy shape.
				const collapse = assignments.length === 1 && assignments[0]!.index === 0 && assignments[0]!.nodeId === workload.nodeId;
				if (collapse) {
					removed = prior.filter((row) => row.replicaIndex !== 0);
					this.ctx.db.delete(workloadReplicas).where(eq(workloadReplicas.workloadId, workload.id)).run();
				} else {
					// A single copy becoming a set keeps running as copy 0: same id, same unit, no restart.
					const seed =
						prior.length === 0
							? this.copyPlacements(workload).map((copy) => ({ id: newId('wrl_'), workloadId: workload.id, projectId: project.id, nodeId: copy.nodeId, replicaIndex: copy.index, status: workload.status, placementReason: 'deploy', deploymentId: null, appliedVersion: null, rolledAt: null, createdAt: now, updatedAt: now }))
							: [];
					for (const row of seed) this.ctx.db.insert(workloadReplicas).values(row).run();
					const written = this.writeCopies(workload.id, project.id, [...prior, ...seed], assignments, now);
					added = written.added;
					removed = written.removed;
					const first = assignments[0]!;
					if (first.nodeId !== workload.nodeId)
						this.ctx.db.update(workloads).set({ nodeId: first.nodeId }).where(eq(workloads.id, workload.id)).run();
				}
			} else if (replicas > from) {
				// Every copy shares the app's node, so that node must hold the extra reservation.
				const node = this.candidates({ excludeWorkloadId: workload.id }).find((candidate) => candidate.id === workload.nodeId);
				const free = node ? node.sliceMemoryMb - node.reservedMemoryMb : 0;
				if (free < reservedMemoryMb(next))
					throw new ValidationError(
						`${node?.name ?? 'Its node'} has ${Math.max(0, free)} MB free, but ${replicas} copies reserve ${reservedMemoryMb(next)} MB${blocker ? `. They cannot use another node because ${blocker}` : ''}.`,
					);
				this.ctx.quota.assertCanAdmitMemory(project.orgId, project.id, Math.max(0, reservedMemoryMb(next) - workload.memoryMb));
			}
			this.ctx.db
				.update(workloads)
				.set({ specJson: JSON.stringify(next), memoryMb: reservedMemoryMb(next), updatedAt: now })
				.where(eq(workloads.id, workload.id))
				.run();
		}
		// The configured spec too, so the next deploy plans the same number of copies.
		const configured = this.projectSpec(project);
		if (configured) {
			const saved = workloadSpecSchema.safeParse({ ...configured, replicas: next.replicas });
			if (saved.success)
				this.ctx.db.update(projects).set({ workloadJson: JSON.stringify(saved.data), updatedAt: now }).where(eq(projects.id, project.id)).run();
		}
		if (workload) this.reconcileEndpoints(project.id, nodesBefore);
		this.ctx.projects.bump(project.orgId);
		const brief = (row: ReplicaRow) => ({ index: row.replicaIndex, nodeId: row.nodeId });
		return { from, to: next.replicas, added: added.map(brief), removed: removed.map(brief) };
	}

	/** How many copies this fleet could run right now, counting the ones that already do. */
	scaleCapacity(project: ProjectRow, workload: WorkloadRow | null, spec: WorkloadSpec): number {
		const limit = this.ctx.cluster.get().replicas.max;
		const { mode } = this.scalingMode(project, { ...spec, replicas: 2 }, workload);
		if (mode === 'single') return 1;
		if (mode === 'node') {
			const node = this.candidates({ excludeWorkloadId: workload?.id }).find((candidate) => candidate.id === workload?.nodeId);
			if (!node || spec.memoryMb <= 0) return limit;
			return Math.max(1, Math.min(limit, Math.floor((node.sliceMemoryMb - node.reservedMemoryMb) / spec.memoryMb)));
		}
		const planned = planReplicas({
			count: limit,
			memoryMb: spec.memoryMb,
			cpuMillis: Math.round((spec.cpus ?? 1) * 1000),
			spread: this.ctx.cluster.get().replicas.spread,
			stack: mode === 'stack',
			existing: workload ? this.copyPlacements(workload) : [],
			candidates: this.copyCandidates(project, spec, workload?.id),
		});
		return Math.max(1, planned.ok ? limit : planned.placeable);
	}

	/** The runner pool as GitHub reports it, for the dashboard and `GET .../runners`. */
	async runnerPool(principal: Principal, project: ProjectRow): Promise<GithubRunnerPoolView | null> {
		this.ctx.iam.require(principal, 'deployment:read', { type: 'project', id: project.id });
		const row = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
		const spec = row ? this.specOf(project, row) : this.projectSpec(project);
		if (!spec?.runner) return null;
		return this.ctx.githubRunners.pool(principal, project, spec);
	}

	private requireProject(projectId: string): ProjectRow {
		const row = this.ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
		if (!row) throw new NotFoundError('Project');
		return row as ProjectRow;
	}

	private toView(project: ProjectRow, row: WorkloadRow): WorkloadView {
		const spec = workloadSpecSchema.safeParse(parseJson<unknown>(row.specJson, null)).data;
		return {
			ingress: spec?.ingress ?? 'http',
			replicas: spec?.replicas ?? 1,
			runner: spec?.runner ? { provider: 'github', target: githubRunnerTarget(spec.runner) } : null,
			id: row.id,
			projectId: project.id,
			projectSlug: project.slug,
			deploymentId: row.deploymentId,
			nodeId: row.nodeId,
			runtime: workloadRuntimeOf(row),
			status: row.status,
			memoryMb: row.memoryMb,
			cpus: row.cpus,
			// A function's socket follows the workload id (phase 4). Recomputed from the row id so a
			// row written before this change still reports the socket the helper now creates.
			upstream: (spec?.runtime === 'function' ? upstreamFor(row.id, spec) : null) ?? row.upstream,
			// Containers (R1): the image as configured and the digest the running deployment pinned.
			image: spec?.image ?? null,
			imageDigest: spec?.imageDigest ?? null,
			message: row.message,
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
		};
	}

	/**
	 * The node a project must run on because of its attached databases, private storage and
	 * brokers, or null when nothing pins it. Throws when they live on different nodes.
	 */
	attachmentNode(projectId: string): string | null {
		const nodeIds = [
			...new Set(
				[
					this.ctx.databases.requiredNode(projectId),
					this.ctx.storage.requiredNode(projectId),
					this.ctx.brokers.requiredNode(projectId),
				].filter((id): id is string => id !== null),
			),
		];
		if (nodeIds.length > 1)
			throw new ValidationError(
				'Attached databases, private storage and brokers live on different nodes; detach one, or make the storage public.',
			);
		return nodeIds[0] ?? null;
	}

	/**
	 * Attachment fingerprint for the activation version. Databases alone keep their existing
	 * fingerprint, and projects with no attachments keep the plain spec hash (no restart on upgrade).
	 * Secret references add the version each one resolves to, so saving a new secret value restarts
	 * the app with it; a spec without secret references keeps its hash.
	 */
	private attachmentsVersion(
		projectId: string,
		nodeId: string | null,
		runtime: WorkloadRuntime,
		orgId: string,
		spec: WorkloadSpec,
	): string {
		return [
			this.ctx.databases.consumerVersion(projectId, nodeId, runtime),
			this.ctx.storage.consumerVersion(projectId, nodeId, runtime),
			this.ctx.brokers.consumerVersion(projectId, nodeId, runtime),
			this.ctx.userPools.consumerVersion(projectId),
			this.ctx.email.consumerVersion(projectId),
			this.ctx.appVolumes.projectVersion(projectId),
			this.secretsVersion(orgId, projectId, spec),
			this.restartVersion(projectId),
		]
			.filter(Boolean)
			.join(':');
	}

	/** A console restart (D127) bumps this; zero adds nothing, so existing hashes stay put. */
	private restartVersion(projectId: string): string {
		const generation =
			this.ctx.db
				.select({ generation: workloads.restartGeneration })
				.from(workloads)
				.where(eq(workloads.projectId, projectId))
				.get()?.generation ?? 0;
		return generation > 0 ? `restart:${generation}` : '';
	}

	private secretsVersion(orgId: string, projectId: string, spec: WorkloadSpec): string {
		if (spec.secrets.length === 0) return '';
		const resolved = spec.secrets.map((ref) => {
			const found = this.ctx.secrets.resolve(orgId, projectId, ref.name);
			const version = ref.version ?? found?.versions[0] ?? 0;
			return `${ref.name}=${found?.scope ?? 'missing'}@${version}`;
		});
		return `secrets:${sha256Hex(resolved.join(','))}`;
	}

	/** Resolve a `near` reference to the node running that database or storage instance. */
	private nearNodeIds(reference: string): string[] {
		const database = this.ctx.sqlite
			.query<{ nodeId: string }, [string, string]>(
				'SELECT node_id AS nodeId FROM databases WHERE (id = ? OR name = ?) AND deleted_at IS NULL LIMIT 1',
			)
			.get(reference, reference);
		if (database) return [database.nodeId];
		const storage = this.ctx.sqlite
			.query<{ nodeId: string }, [string, string]>(
				'SELECT node_id AS nodeId FROM storage_instances WHERE (id = ? OR name = ?) AND deleted_at IS NULL LIMIT 1',
			)
			.get(reference, reference);
		return storage ? [storage.nodeId] : [];
	}

	/** Edge node id (config or first edge), for placement by other services. */
	edgeNode(): string | null {
		return this.edgeNodeId();
	}

	/** Placement candidates with current reservations (workloads + databases). */
	placementCandidates(): PlacementCandidate[] {
		return this.candidates();
	}

	private edgeNodeId(): string | null {
		if (this.ctx.config.edgeNodeId) return this.ctx.config.edgeNodeId;
		return (
			this.ctx.sqlite
				.query<{ id: string }, []>("SELECT id FROM nodes WHERE mode = 'edge' ORDER BY created_at ASC LIMIT 1")
				.get()?.id ?? null
		);
	}

	/** Candidates as the spread planner wants them: compute nodes, ingress nodes last. */
	private replicaCandidates(candidates: PlacementCandidate[]) {
		return candidates
			.filter((candidate) => candidate.roles?.includes('compute') ?? candidate.mode !== 'edge')
			.map((candidate) => ({
				id: candidate.id,
				name: candidate.name,
				zone: candidate.zone ?? 'default',
				status: candidate.status,
				freeMemoryMb: candidate.sliceMemoryMb - candidate.reservedMemoryMb,
				freeCpuMillis:
					candidate.cpuBudgetMillis == null ? null : candidate.cpuBudgetMillis - (candidate.reservedCpuMillis ?? 0),
				ingress: candidate.mode === 'edge' || (candidate.roles?.includes('ingress') ?? false),
				pressured: candidate.pressured,
			}));
	}

	/**
	 * What a workload itself reserves, per node, so a redeploy or a move is not refused for the
	 * room its own running copies already hold.
	 */
	private ownReservation(workloadId: string): Map<string, { memoryMb: number; cpuMillis: number }> {
		const own = new Map<string, { memoryMb: number; cpuMillis: number }>();
		const row = this.ctx.db.select().from(workloads).where(eq(workloads.id, workloadId)).get();
		if (!row || !ACTIVE_STATUSES.includes(row.status)) return own;
		const copies = this.ctx.db.select().from(workloadReplicas).where(eq(workloadReplicas.workloadId, workloadId)).all();
		const add = (nodeId: string, memoryMb: number) => {
			const entry = own.get(nodeId) ?? { memoryMb: 0, cpuMillis: 0 };
			own.set(nodeId, { memoryMb: entry.memoryMb + memoryMb, cpuMillis: entry.cpuMillis + row.cpus * 1000 });
		};
		if (copies.length > 0) for (const copy of copies) add(copy.nodeId, Math.ceil(row.memoryMb / copies.length));
		else if (row.nodeId) add(row.nodeId, row.memoryMb);
		return own;
	}

	/** Mark the nodes where another app already holds this app's loopback port (D225). */
	private withPortConflicts(candidates: PlacementCandidate[], projectId: string, spec: WorkloadSpec): PlacementCandidate[] {
		return candidates.map((candidate) => ({
			...candidate,
			portConflict: nodePortConflict(this.ctx, projectId, spec, candidate.id, candidate.name),
		}));
	}

	private nodeName(nodeId: string): string {
		return this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).get()?.name ?? nodeId;
	}

	private candidates(options: { excludeWorkloadId?: string } = {}): PlacementCandidate[] {
		const reserved = this.reservedByNode();
		const reservedDisk = this.ctx.appVolumes.reservedDiskByNode();
		const reservedCpu = this.reservedCpuByNode();
		if (options.excludeWorkloadId)
			for (const [nodeId, own] of this.ownReservation(options.excludeWorkloadId)) {
				reserved.set(nodeId, Math.max(0, (reserved.get(nodeId) ?? 0) - own.memoryMb));
				reservedCpu.set(nodeId, Math.max(0, (reservedCpu.get(nodeId) ?? 0) - own.cpuMillis));
			}
		// Overcommit raises the admission ceiling, never the slice's own limit on the node (D214).
		const { memoryOvercommitPercent, cpuOvercommitPercent, memoryPressurePercent } = this.ctx.cluster.get().scheduling;
		// Disk tiers (plus `remote`) answer the `volumeClass` / `volumeId` placement constraints (D169).
		const volumeFacts = this.ctx.disks.placementFacts();
		return this.ctx.db
			.select()
			.from(nodes)
			.all()
			.map((node) => {
				const facts = this.ctx.nodes.view(node);
				const volume = volumeFacts.get(node.id);
				return {
					id: node.id,
					name: node.name,
					mode: node.mode,
					status: node.status,
					sliceMemoryMb: Math.floor((node.sliceMemoryMb * memoryOvercommitPercent) / 100),
					reservedMemoryMb: reserved.get(node.id) ?? 0,
					diskFreeBytes: nodeDiskFreeBytes(parseJson<Record<string, unknown> | null>(node.statsJson, null)),
					reservedDiskBytes: reservedDisk.get(node.id) ?? 0,
					zone: facts.zone,
					roles: facts.roles,
					labels: facts.derivedLabels,
					volumeClasses: volume?.classes ?? [],
					volumeIds: volume?.ids ?? [],
					cpuBudgetMillis:
						facts.cpuBudgetMillis == null ? facts.cpuBudgetMillis : Math.floor((facts.cpuBudgetMillis * cpuOvercommitPercent) / 100),
					reservedCpuMillis: reservedCpu.get(node.id) ?? 0,
					pressured: hostMemoryPercent(node.statsJson) >= memoryPressurePercent,
				};
			});
	}

	/** CPU already reserved by workloads, databases and storage instances, in millis. */
	private reservedCpuByNode(): Map<string, number> {
		const reserved = new Map<string, number>();
		const add = (rows: Array<{ nodeId: string | null; total: number | null }>) => {
			for (const row of rows)
				if (row.nodeId) reserved.set(row.nodeId, (reserved.get(row.nodeId) ?? 0) + Math.round(row.total ?? 0));
		};
		add(
			this.ctx.sqlite
				.query<{ nodeId: string | null; total: number | null }, [string, string, string]>(
					`SELECT w.node_id AS nodeId, SUM(w.cpus * 1000) AS total FROM workloads w
					 JOIN projects p ON p.id = w.project_id AND p.deleted_at IS NULL
					 WHERE w.node_id IS NOT NULL AND w.status IN (?, ?, ?)
					   AND NOT EXISTS (SELECT 1 FROM workload_replicas r WHERE r.workload_id = w.id)
					 GROUP BY w.node_id`,
				)
				.all('pending', 'starting', 'running'),
		);
		// A spread workload (C4) reserves one share on each copy's own node, not all on copy 0's.
		add(
			this.ctx.sqlite
				.query<{ nodeId: string | null; total: number | null }, [string, string, string]>(
					 `SELECT r.node_id AS nodeId, SUM(w.cpus * 1000) AS total FROM workload_replicas r
					  JOIN workloads w ON w.id = r.workload_id
					  JOIN projects p ON p.id = w.project_id AND p.deleted_at IS NULL
					  WHERE w.status IN (?, ?, ?) GROUP BY r.node_id`,
				)
				.all('pending', 'starting', 'running'),
		);
		add(
			this.ctx.sqlite
				.query<{ nodeId: string | null; total: number | null }, []>(
					'SELECT node_id AS nodeId, SUM(cpus * 1000) AS total FROM databases WHERE deleted_at IS NULL GROUP BY node_id',
				)
				.all(),
		);
		add(
			this.ctx.sqlite
				.query<{ nodeId: string | null; total: number | null }, []>(
					'SELECT node_id AS nodeId, SUM(cpus * 1000) AS total FROM storage_instances WHERE deleted_at IS NULL GROUP BY node_id',
				)
				.all(),
		);
		return reserved;
	}

	private reservedByNode(): Map<string, number> {
		const rows = this.ctx.sqlite
			.query<{ nodeId: string; total: number | null }, [string, string, string]>(
				// Only live projects reserve budget: a trashed project's workload is no longer in desired
				// state, so its agent stops it and never reports it again (docs/OPERATIONS.md L5).
				`SELECT w.node_id AS nodeId, SUM(w.memory_mb) AS total FROM workloads w
				 JOIN projects p ON p.id = w.project_id AND p.deleted_at IS NULL
				 WHERE w.node_id IS NOT NULL AND w.status IN (?, ?, ?)
				   AND NOT EXISTS (SELECT 1 FROM workload_replicas r WHERE r.workload_id = w.id)
				 GROUP BY w.node_id`,
			)
			.all('pending', 'starting', 'running');
		const reserved = new Map(rows.map((row) => [row.nodeId, row.total ?? 0]));
		// A spread workload (C4) holds `memory_mb` for the whole set; each copy's share is charged
		// to the node that runs it. Charging the total to copy 0's node starved that node and left
		// the others looking empty.
		const spread = this.ctx.sqlite
			.query<{ nodeId: string; total: number | null }, [string, string, string]>(
				`SELECT r.node_id AS nodeId,
				        SUM(w.memory_mb * 1.0 / (SELECT COUNT(*) FROM workload_replicas c WHERE c.workload_id = w.id)) AS total
				 FROM workload_replicas r
				 JOIN workloads w ON w.id = r.workload_id
				 JOIN projects p ON p.id = w.project_id AND p.deleted_at IS NULL
				 WHERE w.status IN (?, ?, ?) GROUP BY r.node_id`,
			)
			.all('pending', 'starting', 'running');
		for (const row of spread) reserved.set(row.nodeId, (reserved.get(row.nodeId) ?? 0) + Math.ceil(row.total ?? 0));
		// Managed databases and storage share the same slice budget (D55, S1).
		for (const [nodeId, total] of this.ctx.databases.reservedByNode())
			reserved.set(nodeId, (reserved.get(nodeId) ?? 0) + total);
		for (const [nodeId, total] of this.ctx.storage.reservedByNode())
			reserved.set(nodeId, (reserved.get(nodeId) ?? 0) + total);
		for (const [nodeId, total] of this.ctx.brokers.reservedByNode())
			reserved.set(nodeId, (reserved.get(nodeId) ?? 0) + total);
		for (const [nodeId, total] of this.ctx.kubernetes.reservedByNode())
			reserved.set(nodeId, (reserved.get(nodeId) ?? 0) + total);
		return reserved;
	}

	private countByNode(): Map<string, number> {
		const rows = this.ctx.sqlite
			.query<{ nodeId: string; n: number }, []>(
				'SELECT node_id AS nodeId, COUNT(*) AS n FROM workloads WHERE node_id IS NOT NULL GROUP BY node_id',
			)
			.all();
		return new Map(rows.map((row) => [row.nodeId, row.n]));
	}
}

const RUNNER_MESSAGE_PREFIX = 'Runner: ';

/** Slice budget a workload reserves: one share per replica (D90). */
export function reservedMemoryMb(spec: Pick<WorkloadSpec, 'memoryMb' | 'replicas'>): number {
	return spec.memoryMb * (spec.replicas ?? 1);
}

const STATUS_RANK: Record<WorkloadStatus, number> = { failed: 4, pending: 3, starting: 2, stopped: 1, running: 0 };

/**
 * Fold replica reports (`<id>-r<n>`) into one report per workload: the worst status wins and
 * restarts is the largest count, so one crash-looping copy marks the pool failed.
 */
export function aggregateReplicaReports(
	reports: Array<{ id: string; status: WorkloadStatus; restarts: number }>,
): Array<{ id: string; status: WorkloadStatus; restarts: number }> {
	const merged = new Map<string, { id: string; status: WorkloadStatus; restarts: number }>();
	for (const report of reports) {
		const { workloadId } = parseWorkloadReplicaId(report.id);
		const current = merged.get(workloadId);
		if (!current) {
			merged.set(workloadId, { id: workloadId, status: report.status, restarts: report.restarts });
			continue;
		}
		if (STATUS_RANK[report.status] > STATUS_RANK[current.status]) current.status = report.status;
		current.restarts = Math.max(current.restarts, report.restarts);
	}
	return [...merged.values()];
}

/**
 * The upstream Caddy proxies to on the workload's node. Socket activation is the default.
 *
 * `id` is the socket id: a function passes its desired-state id — the workload id for replica 0
 * and `<id>-r<n>` for the rest (phase 4, `workloadReplicaId`) — so every host has its own socket.
 * Processes and containers pass the project id, which is the socket the helper has always created.
 */
export function upstreamFor(id: string, spec: WorkloadSpec): string {
	// Workers have no route; the value is never dialled and marks the row in listings.
	if (spec.ingress === 'none') return 'none';
	// A compose stack's primary route is the project's own host; other routes carry their own
	// loopback port in the desired-state route list.
	if (spec.runtime === 'compose') {
		const route = spec.compose ? primaryComposeRoute(spec.compose) : null;
		return `127.0.0.1:${route?.hostPort ?? spec.port}`;
	}
	// Functions are socket-activated like a process app (D110): workerd takes the listener.
	if ((spec.runtime === 'process' || spec.runtime === 'function') && spec.socketActivation)
		return `unix//run/yoal-workloads/${id}.sock`;
	return `127.0.0.1:${spec.port}`;
}

/** The route the project's own host serves (the first one when the file marked none). */
/** The route the project's own host serves; null for a fully private stack. */
export function primaryComposeRoute(spec: Pick<ComposeSpec, 'routes'>): ComposeRoute | null {
	return spec.routes.find((route) => route.primary) ?? spec.routes[0] ?? null;
}

/** Whole-stack admission: every service reserves its own memory. */
export function composeMemoryMb(spec: Pick<ComposeSpec, 'services'>): number {
	return spec.services.reduce((total, service) => total + service.memoryMb, 0);
}

/** Whole-stack CPU reservation, rounded like a single workload's. */
export function composeCpus(spec: Pick<ComposeSpec, 'services'>): number {
	return spec.services.reduce((total, service) => total + service.cpus, 0);
}

/**
 * Stable hash of the parts that affect activation, so the agent knows when to re-fetch values.
 * `databases` is the attachment fingerprint; it is left out when empty so projects without
 * databases keep their existing version (no restart on upgrade).
 */
export function activationVersion(spec: WorkloadSpec, databases = ''): string {
	return sha256Hex(
		JSON.stringify({
			env: spec.env,
			secrets: spec.secrets,
			command: spec.command,
			image: spec.image,
			// Only pinned deployments carry it (R1), so every existing workload keeps its version.
			...(spec.imageDigest ? { imageDigest: spec.imageDigest } : {}),
			port: spec.port,
			...(databases ? { databases } : {}),
			// Only present when set, so existing workloads keep their version (no restart on upgrade).
			// `replicas` is left out on purpose: scaling adds or removes copies without restarting any.
			...(spec.ingress === 'none' ? { ingress: 'none' } : {}),
			...(spec.runner ? { runner: spec.runner } : {}),
			// A binding or compatibility change must restart the host, so the function spec is part of
			// the activation hash (D110). Omitted for every other tier, keeping existing versions.
			...(spec.function ? { function: spec.function } : {}),
			// An override changes the service account the token names, so it must re-apply. The token
			// itself is never hashed: a refresh must not restart the workload.
			...(spec.identity ? { identity: spec.identity } : {}),
			// Services, images, commands and routes are the compose program; any change re-renders.
			...(spec.compose ? { compose: spec.compose } : {}),
		}),
	);
}

/**
 * The image reference a node runs: `<registry>/<repository>@<digest>` once a deploy pinned it (R1),
 * else the image as configured (local images, runners, deployments from before pinning).
 */
export function desiredImage(spec: Pick<WorkloadSpec, 'image' | 'imageDigest'>): string | undefined {
	if (!spec.image) return undefined;
	return spec.imageDigest ? pinnedImageReference(spec.image, spec.imageDigest) : spec.image;
}

/** Capabilities a node reported in its last heartbeat; empty for agents that predate them. */
function nodeCapabilities(json: string | null): string[] {
	const parsed = parseJson<unknown>(json, []);
	return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
}

/** `storedRuntime` narrowed for a workload row, whose CHECK only allows process/container. */
function storedWorkloadRuntime(runtime: WorkloadRuntime): 'process' | 'container' {
	return storedRuntime(runtime) as 'process' | 'container';
}

function placementSpecFor(project: ProjectRow): import('@yoal/contracts').PlacementSpec | null {
	if (!project.placementJson) return null;
	try {
		const parsed = placementSpecSchema.safeParse(JSON.parse(project.placementJson));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/**
 * Clear the Bun default from a Node.js process app (D125), so the node runs its package.json
 * `start` script instead. A spec still carrying `bun run start` (the starting value of a new
 * process project, or one saved before the engine was switched) gets no command; any other
 * explicit command is the user's and is left alone.
 */
export function withEngineCommand(spec: WorkloadSpec): WorkloadSpec {
	if (spec.runtime !== 'process' || spec.engine !== 'node' || !spec.command) return spec;
	const bun = BUN_DEFAULT_COMMAND;
	const isBunDefault = spec.command.length === bun.length && spec.command.every((arg, index) => arg === bun[index]);
	if (!isBunDefault) return spec;
	const { command: _bun, ...rest } = spec;
	return rest as WorkloadSpec;
}

/** Host memory in use as a percentage, from the node's last heartbeat; 0 when it has not reported. */
function hostMemoryPercent(statsJson: string | null): number {
	const stats = parseJson<{ memoryBytes?: number; memoryTotalBytes?: number } | null>(statsJson, null);
	if (!stats?.memoryBytes || !stats.memoryTotalBytes) return 0;
	return (stats.memoryBytes / stats.memoryTotalBytes) * 100;
}
