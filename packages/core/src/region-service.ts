import { hostname } from 'node:os';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
	DATABASE_REPLICAS_CAPABILITY,
	DEFAULT_REGION,
	REGION_PROMOTION_RUNNER_LEASE_SECONDS,
	REGIONS_DOWNGRADE_NOTE,
	nextRegionPromotionStage,
	nodeRegionSchema,
	regionOf,
	regionPromoteRequestSchema,
	regionPromotionLeaseFree,
	standbyRegionRefusal,
	zoneRegions,
	type Principal,
	type RegionPromoteRequest,
	type RegionPromotionPlan,
	type RegionPromotionStage,
	type RegionPromotionStepView,
	type RegionPromotionView,
	type RegionView,
	type RegionsView,
} from '@yoal/contracts';
import { databaseFailovers, databaseReplicas, databases, nodes, projects, regionPromotionSteps, regionPromotions } from '@yoal/db';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { compareLsn } from './database-replicas.ts';
import { buildSystemPrincipal } from './iam/system.ts';
import { maxPlannedLag, pickStandbyNode, regionPlanHash, regionSteeringSet, type StandbyCandidate } from './regions.ts';
import { newId, parseJson } from './util.ts';

/**
 * Regions and the region promotion (HA-PLAN H26, W13; Wave 5 lane A).
 *
 * - `view` lists regions (node `region`, migration 0132), ambiguous zones (`zoneRegions`), the open
 *   promotion and recent ones. Needs `platform:ha`; `enabled` says whether `REGIONS` is on.
 * - `standbyTarget` picks the node a database's standby-region async replica goes on, or refuses
 *   with the contract's reason (`standbyRegionRefusal`).
 * - `promote` is `yoal ha region promote <region>`, run on the control plane in the surviving
 *   region. Without `confirm` it returns the plan (never stored). Confirmed (the region typed back,
 *   the plan hash, `acceptDataLoss`, a reason), it runs in dependency order, each step through an
 *   existing fenced path and never a shortcut:
 *   1. **control plane**: the W9 promote of this node, a CAS at the planned epoch
 *      (`ControlPlaneService.promote`); only then is the record written, under the new epoch;
 *   2. **databases**, standby-region databases first: the W10 promotion at the planned primary
 *      generation (`DatabaseReplicaService.promoteForRegion`), each fenced by its own lease;
 *   3. **steering**: the active region becomes the target, so every driver offers that region's
 *      ingress on its next fenced tick (`steeringRegion`, stacked steering H18).
 *   A step that fails stops the run with the step and the reason; nothing is skipped silently (a
 *   database with no replica in the region is a `skipped` step the operator saw in the plan).
 *   While the old region still holds a valid lease generation the promotion is refused unless
 *   `breakGlass` is passed, which is audited.
 * - `tick` resumes an open promotion: the runner lease (`runner_id`, `lease_expires_at`, `attempt`)
 *   lets another control plane take over a crashed run once it expires, and each step is
 *   idempotent at its fenced generation, so nothing runs twice.
 *
 * Platform admin only (`canAdminister`), never MCP. Both writes refuse while `REGIONS` is off.
 */
export class RegionService {
	/** This process's runner identity for the promotion lease (no randomness: seeded fixtures). */
	readonly #runnerId: string;
	#running = false;

	constructor(
		private readonly ctx: CoreContext,
		options: { runnerId?: string } = {},
	) {
		this.#runnerId = options.runnerId ?? `${hostname().slice(0, 40)}:${process.pid}`;
	}

	enabled(): boolean {
		return featureEnabled(this.ctx.config, 'REGIONS');
	}

	// ------------------------------------------------------------------ reads

	view(principal: Principal): RegionsView {
		this.#requireHa(principal);
		const rows = this.#nodes();
		const control = this.#controlNodeId();
		const databaseRows = this.ctx.db
			.select({ nodeId: databases.nodeId, standbyRegion: databases.standbyRegion })
			.from(databases)
			.where(isNull(databases.deletedAt))
			.all();
		const regionOfNode = new Map(rows.map((row) => [row.id, regionOf(row)]));
		const names = [...new Set(rows.map((row) => regionOf(row)))].sort();
		const regions: RegionView[] = names.map((name) => {
			const members = rows.filter((row) => regionOf(row) === name);
			return {
				name,
				zones: [...new Set(members.map((row) => row.zone))].sort(),
				nodes: members.map((row) => ({
					id: row.id,
					name: row.name,
					zone: row.zone,
					online: row.status === 'online',
					roles: this.ctx.nodes.view(row).roles,
				})),
				primary: control !== null && regionOfNode.get(control) === name,
				databases: {
					primaries: databaseRows.filter((row) => regionOfNode.get(row.nodeId) === name).length,
					standbys: databaseRows.filter((row) => row.standbyRegion === name).length,
				},
			};
		});
		const promotions = this.ctx.db.select().from(regionPromotions).orderBy(desc(regionPromotions.startedAt)).limit(10).all();
		const open = promotions.find((row) => row.finishedAt === null) ?? null;
		return {
			enabled: this.enabled(),
			regions,
			conflicts: zoneRegions(rows).conflicts,
			active: open ? this.#promotionView(open) : null,
			recent: promotions.filter((row) => row.finishedAt !== null).map((row) => this.#promotionView(row)),
			notes: this.#regionValuesStored() ? [REGIONS_DOWNGRADE_NOTE] : [],
		};
	}

	/**
	 * The region traffic is steered to, or null while `REGIONS` is off (every driver keeps today's
	 * whole ingress set). The target of the last promotion whose steering step finished; before any,
	 * the region of the edge (where traffic goes today), else of the control plane.
	 */
	steeringRegion(): string | null {
		if (!this.enabled()) return null;
		return this.activeRegion();
	}

	/** The ingress ids a steering driver should offer, by region (see `regionSteeringSet`). */
	steeringIngress<T extends { region?: string | null; status: string }>(ingress: readonly T[]): T[] {
		return regionSteeringSet(ingress, this.steeringRegion());
	}

	activeRegion(): string {
		const promoted = this.ctx.db
			.select({ toRegion: regionPromotions.toRegion })
			.from(regionPromotions)
			.innerJoin(
				regionPromotionSteps,
				and(eq(regionPromotionSteps.promotionId, regionPromotions.id), eq(regionPromotionSteps.kind, 'steering'), eq(regionPromotionSteps.status, 'done')),
			)
			.orderBy(desc(regionPromotions.startedAt))
			.limit(1)
			.get();
		if (promoted) return promoted.toRegion;
		const anchor = this.ctx.workloads.edgeNode() ?? this.#controlNodeId();
		const row = anchor ? this.ctx.db.select({ region: nodes.region }).from(nodes).where(eq(nodes.id, anchor)).get() : undefined;
		return row ? regionOf(row) : DEFAULT_REGION;
	}

	// ------------------------------------------------------------------ standby region

	/**
	 * Where a database's standby-region async replica goes, or a `ValidationError` with the
	 * contract's refusal. `existing` when a live replica is already in that region (nothing to add).
	 */
	standbyTarget(input: { primaryNodeId: string; region: string; memoryMb: number; databaseId?: string }): {
		nodeId: string;
		nodeName: string;
		existing: boolean;
	} {
		const rows = this.#nodes();
		const primary = rows.find((row) => row.id === input.primaryNodeId);
		if (input.databaseId) {
			const replica = this.ctx.db
				.select({ nodeId: databaseReplicas.nodeId })
				.from(databaseReplicas)
				.where(and(eq(databaseReplicas.databaseId, input.databaseId), isNull(databaseReplicas.removingAt)))
				.all()
				.map((row) => rows.find((node) => node.id === row.nodeId))
				.find((node) => node !== undefined && regionOf(node) === input.region);
			if (replica && regionOf(primary ?? {}) !== input.region) return { nodeId: replica.id, nodeName: replica.name, existing: true };
		}
		const free = new Map(this.ctx.workloads.placementCandidates().map((candidate) => [candidate.id, candidate.sliceMemoryMb - candidate.reservedMemoryMb]));
		const candidates: StandbyCandidate[] = rows.map((row) => ({
			id: row.id,
			name: row.name,
			zone: row.zone,
			region: row.region,
			status: row.status,
			roles: this.ctx.nodes.view(row).roles,
			overlay: Boolean(row.privateAddress),
			replicaCapable: parseJson<string[]>(row.capabilitiesJson, []).includes(DATABASE_REPLICAS_CAPABILITY),
			freeMemoryMb: free.get(row.id) ?? 0,
		}));
		const picked = pickStandbyNode({ region: input.region, primaryNodeId: input.primaryNodeId, memoryMb: input.memoryMb, candidates });
		const refusal = standbyRegionRefusal({
			primaryRegion: primary?.region,
			standbyRegion: input.region,
			candidateNodes: picked.node ? [picked.node.name] : [],
		});
		if (refusal)
			throw new ValidationError(
				picked.reasons.length > 0 && refusal.code === 'standby-region-has-no-data-node'
					? `${refusal.message} ${picked.reasons.join('; ')}.`
					: refusal.message,
			);
		return { nodeId: picked.node!.id, nodeName: picked.node!.name, existing: false };
	}

	// ------------------------------------------------------------------ promotion

	async promote(principal: Principal, region: string, raw: RegionPromoteRequest): Promise<RegionPromotionPlan | RegionPromotionView> {
		this.#requireAdmin(principal);
		if (!this.enabled())
			throw new ValidationError('Regions are not enabled on this platform (YOAL_FEATURE_REGIONS), so there is no region to promote.');
		const input = regionPromoteRequestSchema.parse(raw);
		const target = nodeRegionSchema.parse(region);
		if (!this.#nodes().some((row) => regionOf(row) === target)) throw new NotFoundError(`Region "${target}"`);

		const open = this.#openPromotion();
		if (open) {
			if (open.toRegion !== target)
				throw new ConflictError(`A promotion to region "${open.toRegion}" is still open (${open.stage}); it must finish or fail first.`);
			if (input.confirm === undefined) return this.#promotionView(open);
			// Typing the region and the confirmed plan's hash again resumes the open promotion.
			if (input.confirm !== target) throw new ValidationError(`Type the region name exactly: "${target}".`);
			if (input.planHash !== open.planHash)
				throw new ConflictError('That is not the plan this promotion was confirmed with; resume it with the hash it shows.');
			await this.#run(open.id, principal);
			return this.#promotionView(this.#requirePromotion(open.id));
		}

		const plan = await this.#plan(target);
		if (input.confirm === undefined) return plan;
		if (input.confirm !== target) throw new ValidationError(`Type the region name exactly: "${target}".`);
		if (input.planHash !== plan.planHash)
			throw new CoreError('precondition_failed', 'The plan changed since it was shown (a generation moved). Review the new plan and confirm its hash.', 412);
		if (plan.blockers.length > 0) throw new ConflictError(`The promotion cannot run: ${plan.blockers.join('; ')}.`);
		if (plan.liveLeases.length > 0 && !input.breakGlass)
			throw new ConflictError(
				`Region "${plan.fromRegion}" still holds a valid lease: ${plan.liveLeases.join('; ')}. Wait for it to expire, or pass breakGlass only once that region is known to be stopped.`,
			);

		// 1. The control plane first, at the planned epoch; the record is written under the new one.
		const controlPlanned = plan.steps[0]!;
		const control = await this.#controlStep(principal, controlPlanned.expectedGeneration, input.breakGlass);
		const now = this.ctx.now();
		const id = newId('rgp_');
		const epoch = control.fencedGeneration ?? controlPlanned.expectedGeneration;
		this.ctx.sqlite.transaction(() => {
			this.ctx.db
				.insert(regionPromotions)
				.values({
					id,
					toRegion: target,
					fromRegion: plan.fromRegion,
					stage: 'databases',
					planHash: plan.planHash,
					runnerId: this.#runnerId,
					leaseExpiresAt: now + REGION_PROMOTION_RUNNER_LEASE_SECONDS * 1000,
					attempt: 1,
					acceptDataLoss: true,
					reason: input.reason!,
					confirmedBy: principal.userId,
					confirmedAt: now,
					startedAt: now,
				})
				.run();
			for (const step of plan.steps)
				this.ctx.db
					.insert(regionPromotionSteps)
					.values({
						promotionId: id,
						position: step.position,
						step: step.step,
						kind: step.kind,
						resourceId: step.resourceId,
						name: step.name,
						targetNodeId: step.targetNodeId,
						// Steering is fenced by the new control epoch (contract): only its holder writes.
						expectedGeneration: step.kind === 'steering' ? epoch : step.expectedGeneration,
						fencedGeneration: step.kind === 'control-plane' ? control.fencedGeneration : null,
						status: step.kind === 'control-plane' ? control.status : step.status,
						lagBytes: step.lagBytes,
						lagSeconds: step.lagSeconds,
						startedAt: step.kind === 'control-plane' ? now : null,
						finishedAt: step.kind === 'control-plane' || step.status === 'skipped' ? now : null,
						message: step.kind === 'control-plane' ? control.message : step.message,
					})
					.run();
		})();
		this.ctx.audit.record({
			principal,
			action: 'ha.region.promote',
			resource: 'platform',
			resourceId: id,
			args: {
				toRegion: target,
				fromRegion: plan.fromRegion,
				planHash: plan.planHash,
				breakGlass: input.breakGlass,
				liveLeases: plan.liveLeases,
				maxLagSeconds: plan.maxLagSeconds,
				reason: input.reason,
				controlEpoch: epoch,
			},
			result: 'ok',
		});
		await this.#run(id, principal);
		return this.#promotionView(this.#requirePromotion(id));
	}

	/**
	 * Resume an open promotion (the control plane's 5 s loop). Only the holder of a live runner
	 * lease runs it; a crashed runner's promotion is taken over once its lease expires. Does nothing
	 * while `REGIONS` is off or while this control plane is not primary.
	 */
	async tick(): Promise<void> {
		if (!this.enabled() || this.#running) return;
		const open = this.#openPromotion();
		if (!open) return;
		if (!regionPromotionLeaseFree(open, this.ctx.now()) && open.runnerId !== this.#runnerId) return;
		await this.#run(open.id, null);
	}

	// ------------------------------------------------------------------ plan

	async #plan(target: string): Promise<RegionPromotionPlan & { blockers: string[]; liveLeases: string[] }> {
		const rows = this.#nodes();
		const byId = new Map(rows.map((row) => [row.id, row]));
		const blockers: string[] = [];
		const liveLeases: string[] = [];
		const steps: RegionPromotionStepView[] = [];

		// Control plane: this node must be in the target region; its epoch is the fence.
		const controlId = this.ctx.controlPlane.nodeId;
		const controlRow = byId.get(controlId);
		if (!controlRow || regionOf(controlRow) !== target)
			throw new ConflictError(
				`Run the promotion on the control plane in region "${target}": this one runs on ${controlRow?.name ?? controlId}, in region "${controlRow ? regionOf(controlRow) : 'unknown'}". Enrol a control-plane standby there first (yoal ha control enrol).`,
			);
		const epoch = await this.ctx.controlPlane.highestEpoch();
		steps.push(this.#step({ position: 0, step: 'control-plane', kind: 'control-plane', resourceId: 'control-plane', name: `control plane on ${controlRow.name}`, targetNodeId: controlRow.id, expectedGeneration: epoch }));
		const lease = this.ctx.controlPlane.lease();
		if (lease && lease.holderNodeId !== controlId && Date.parse(lease.expiresAt) > this.ctx.now())
			liveLeases.push(`the control-plane lease is held by ${byId.get(lease.holderNodeId)?.name ?? lease.holderNodeId} until ${lease.expiresAt}`);

		// Databases whose primary is elsewhere: those with a standby region here first, then by name.
		const databaseRows = this.ctx.db
			.select()
			.from(databases)
			.where(isNull(databases.deletedAt))
			.all()
			.filter((row) => regionOf(byId.get(row.nodeId) ?? {}) !== target)
			.sort((a, b) => Number(b.standbyRegion === target) - Number(a.standbyRegion === target) || a.name.localeCompare(b.name));
		const replicaRows = this.ctx.db.select().from(databaseReplicas).where(isNull(databaseReplicas.removingAt)).all();
		const fromRegions = new Map<string, number>();
		for (const database of databaseRows) {
			const replica = replicaRows
				.filter((row) => row.databaseId === database.id && row.status !== 'pending' && regionOf(byId.get(row.nodeId) ?? {}) === target)
				.sort((a, b) => compareLsn(b.replayLsn, a.replayLsn) || (byId.get(a.nodeId)?.name ?? '').localeCompare(byId.get(b.nodeId)?.name ?? ''))[0];
			const base = { position: steps.length, step: 'databases' as const, kind: 'database' as const, resourceId: database.id, name: database.name, expectedGeneration: database.primaryGeneration };
			if (!replica) {
				// Visible in the plan the operator confirms, never dropped silently.
				if (database.standbyRegion === target)
					blockers.push(`${database.name} has standby region "${target}" but no replica there that has streamed`);
				steps.push(this.#step({ ...base, status: 'skipped', message: `No replica of ${database.name} in region "${target}"; it stays where it is.` }));
				continue;
			}
			const from = regionOf(byId.get(database.nodeId) ?? {});
			fromRegions.set(from, (fromRegions.get(from) ?? 0) + 1);
			steps.push(this.#step({ ...base, targetNodeId: replica.nodeId, lagBytes: replica.lagBytes, lagSeconds: replica.lagSeconds }));
			// The database lease is the fence: still valid means the old primary may be serving.
			const strict = await this.ctx.databaseMembers.promotionRefusal(database, replica.nodeId, false);
			const forced = strict ? await this.ctx.databaseMembers.promotionRefusal(database, replica.nodeId, true) : null;
			if (forced) blockers.push(`${database.name}: ${forced}`);
			else if (strict) liveLeases.push(`${database.name}: ${strict}`);
		}

		// Steering last, fenced by the new control epoch.
		const selection = this.ctx.steering.selection();
		steps.push(
			this.#step({
				position: steps.length,
				step: 'steering',
				kind: 'steering',
				resourceId: selection.kind,
				name: selection.stacked.length > 0 ? `steering: ${selection.kind} (stacked ${selection.stacked.join(', ')})` : `steering: ${selection.kind}`,
				expectedGeneration: epoch,
			}),
		);
		const ingress = this.#ingressIn(target);
		if (!ingress.some((node) => node.status === 'online')) blockers.push(`no ingress node in region "${target}" is online, so traffic cannot move there`);

		const active = this.activeRegion();
		const busiest = [...fromRegions.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
		const fromRegion = active !== target ? active : (busiest ?? active);
		const moving = steps.some((step) => step.kind === 'database' && step.status !== 'skipped');
		const snapshot = this.ctx.controlPlane.snapshot();
		const controlNeeded = this.ctx.controlPlane.enabled() && !(snapshot?.role === 'primary' && snapshot.lease.holderNodeId === controlId);
		if (active === target && !moving && !controlNeeded)
			throw new ValidationError(`Region "${target}" already serves traffic and holds every database it can: there is nothing to promote.`);
		return {
			toRegion: target,
			fromRegion,
			steps,
			planHash: regionPlanHash(target, steps),
			maxLagSeconds: maxPlannedLag(steps),
			blockers,
			liveLeases,
		};
	}

	#step(input: Partial<RegionPromotionStepView> & Pick<RegionPromotionStepView, 'position' | 'step' | 'kind' | 'resourceId' | 'name' | 'expectedGeneration'>): RegionPromotionStepView {
		return {
			targetNodeId: null,
			fencedGeneration: null,
			status: 'pending',
			lagBytes: null,
			lagSeconds: null,
			startedAt: null,
			finishedAt: null,
			message: null,
			...input,
		};
	}

	// ------------------------------------------------------------------ run

	/**
	 * The W9 control-plane step, at `expected`. Idempotent: a node already primary at a higher epoch
	 * than planned (a crash after its promote, before the record) records itself done at that epoch.
	 */
	async #controlStep(principal: Principal, expected: number, breakGlass: boolean): Promise<{ status: 'done' | 'skipped'; fencedGeneration: number | null; message: string }> {
		const plane = this.ctx.controlPlane;
		if (!plane.enabled())
			return { status: 'skipped', fencedGeneration: null, message: 'No control-plane standby (CONTROL_STANDBY is off); this control plane already runs in the region.' };
		const before = plane.snapshot();
		if (before?.role === 'primary' && before.lease.holderNodeId === plane.nodeId) {
			const epoch = await plane.highestEpoch();
			if (epoch > expected) return { status: 'done', fencedGeneration: epoch, message: `Already primary at epoch ${epoch} (planned at ${expected}).` };
			// Already serving at the planned epoch: still check the lease is at that epoch (no CAS).
			await plane.promote(principal, expected);
			return { status: 'skipped', fencedGeneration: null, message: `This control plane already holds the lease at epoch ${expected}.` };
		}
		await plane.promote(principal, expected, { breakGlass });
		const epoch = await plane.highestEpoch();
		if (epoch <= expected) throw new ConflictError(`The control-plane promotion did not move the epoch past ${expected}; nothing else was changed.`);
		return { status: 'done', fencedGeneration: epoch, message: `Promoted at epoch ${epoch}${breakGlass ? ' (break glass)' : ''}.` };
	}

	async #run(id: string, principal: Principal | null): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		try {
			if (!this.#takeLease(id)) return;
			// A control plane that is not primary must not write the promotion (W9 fence).
			if (!this.ctx.controlPlane.mayActAsPrimary()) return;
			for (;;) {
				const promotion = this.#requirePromotion(id);
				if (promotion.finishedAt !== null) return;
				const steps = this.#steps(id);
				const next = steps.find((step) => step.status === 'pending' || step.status === 'running');
				if (!next) {
					this.#finish(id, 'completed', null);
					return;
				}
				// Stage follows the first unfinished step, in the fixed order.
				const stage: RegionPromotionStage = next.step;
				if (promotion.stage !== stage) this.#setStage(id, stage);
				const outcome: { status: 'done' | 'running' | 'failed'; fencedGeneration?: number; message: string } =
					next.kind === 'database'
						? await this.#databaseStep(promotion, next, principal)
						: next.kind === 'steering'
							? this.#steeringStep(promotion, next)
							: { status: 'failed' as const, message: 'The control-plane step was not recorded as finished; start a new promotion.' };
				this.#renewLease(id);
				if (outcome.status === 'running') return;
				this.#finishStep(id, next.position, outcome.status, outcome.fencedGeneration ?? null, outcome.message);
				if (outcome.status === 'failed') {
					this.#finish(id, 'failed', `${next.name}: ${outcome.message}`);
					return;
				}
				const after = nextRegionPromotionStage(stage);
				if (after === 'completed' && !this.#steps(id).some((step) => step.status === 'pending' || step.status === 'running')) {
					this.#finish(id, 'completed', null);
					return;
				}
			}
		} finally {
			this.#running = false;
		}
	}

	/**
	 * One database through the fenced W10 path at its planned generation. Idempotent: the failover
	 * at `expected + 1` to the planned node is this step's, whoever started it; a database at any
	 * other generation fails the step ("someone else acted").
	 */
	async #databaseStep(
		promotion: typeof regionPromotions.$inferSelect,
		step: typeof regionPromotionSteps.$inferSelect,
		principal: Principal | null,
	): Promise<{ status: 'done' | 'running' | 'failed'; fencedGeneration?: number; message: string }> {
		const database = this.ctx.db.select().from(databases).where(eq(databases.id, step.resourceId)).get();
		if (!database || database.deletedAt) return { status: 'failed', message: 'The database was deleted during the promotion.' };
		const generation = step.expectedGeneration + 1;
		if (database.nodeId === step.targetNodeId && database.primaryGeneration >= generation)
			return { status: 'done', fencedGeneration: database.primaryGeneration, message: `Primary on the target node at generation ${database.primaryGeneration}.` };
		const failover = this.ctx.db
			.select()
			.from(databaseFailovers)
			.where(and(eq(databaseFailovers.databaseId, database.id), eq(databaseFailovers.generation, generation)))
			.orderBy(desc(databaseFailovers.startedAt))
			.get();
		if (failover) {
			if (failover.toNodeId !== step.targetNodeId)
				return { status: 'failed', message: `Generation ${generation} was taken by a promotion to another node; someone else acted.` };
			if (failover.status === 'completed')
				return { status: 'done', fencedGeneration: generation, message: `Promoted at generation ${generation}.` };
			if (failover.status === 'failed' || failover.status === 'rolled-back')
				return { status: 'failed', message: failover.message ?? `The promotion was ${failover.status}.` };
			if (step.status === 'pending') this.#markRunning(promotion.id, step.position);
			return { status: 'running', message: `Promotion at generation ${generation} is ${failover.status}.` };
		}
		if (database.primaryGeneration !== step.expectedGeneration)
			return { status: 'failed', message: `The database is at generation ${database.primaryGeneration}, not the planned ${step.expectedGeneration}; someone else acted.` };
		const replica = this.ctx.db
			.select()
			.from(databaseReplicas)
			.where(and(eq(databaseReplicas.databaseId, database.id), eq(databaseReplicas.nodeId, step.targetNodeId ?? ''), isNull(databaseReplicas.removingAt)))
			.get();
		if (!replica) return { status: 'failed', message: 'The planned replica is gone.' };
		this.#markRunning(promotion.id, step.position);
		try {
			await this.ctx.databaseReplicas.promoteForRegion(principal ?? buildSystemPrincipal('system:failover', database.orgId), {
				databaseId: database.id,
				replicaId: replica.id,
				expectedGeneration: step.expectedGeneration,
			});
		} catch (error) {
			return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
		}
		return { status: 'running', message: `Promotion at generation ${generation} started.` };
	}

	/**
	 * Steering, fenced by the new control epoch: once this step is done the target is the active
	 * region (`steeringRegion`), and every driver offers its ingress on the next controller tick.
	 */
	#steeringStep(
		promotion: typeof regionPromotions.$inferSelect,
		step: typeof regionPromotionSteps.$inferSelect,
	): { status: 'done' | 'failed'; message: string } {
		if (this.ctx.controlPlane.enabled() && !this.ctx.controlPlane.mayActAsPrimary())
			return { status: 'failed', message: `This control plane no longer holds epoch ${step.expectedGeneration}.` };
		const ingress = this.#ingressIn(promotion.toRegion).filter((node) => node.status === 'online');
		if (ingress.length === 0)
			return { status: 'failed', message: `No ingress node in region "${promotion.toRegion}" is online. Bring one up, then run the promotion again.` };
		const names = ingress.map((node) => node.name).join(', ');
		const selection = this.ctx.steering.selection();
		const drivers = [selection.kind, ...selection.stacked];
		const said = drivers.map((kind) =>
			kind === 'direct'
				? `direct: Yoal writes nothing; point your DNS or balancer at ${names}`
				: kind === 'external-lb'
					? `external-lb: writes nothing; the balancer in region "${promotion.toRegion}" probes ${names}`
					: `${kind}: offers ${names} on its next fenced tick`,
		);
		return { status: 'done', message: `Traffic moves to region "${promotion.toRegion}". ${said.join('. ')}.` };
	}

	// ------------------------------------------------------------------ records

	#takeLease(id: string): boolean {
		const now = this.ctx.now();
		const expires = now + REGION_PROMOTION_RUNNER_LEASE_SECONDS * 1000;
		// Conditional on the values read: a live lease held by another runner is never taken.
		const result = this.ctx.sqlite.run(
			`UPDATE region_promotions
			    SET attempt = attempt + CASE WHEN runner_id IS NULL OR runner_id = ? THEN 0 ELSE 1 END,
			        runner_id = ?, lease_expires_at = ?
			  WHERE id = ? AND finished_at IS NULL
			    AND (runner_id IS NULL OR runner_id = ? OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
			[this.#runnerId, this.#runnerId, expires, id, this.#runnerId, now],
		);
		return result.changes === 1;
	}

	#renewLease(id: string): void {
		this.ctx.sqlite.run('UPDATE region_promotions SET lease_expires_at = ? WHERE id = ? AND runner_id = ? AND finished_at IS NULL', [
			this.ctx.now() + REGION_PROMOTION_RUNNER_LEASE_SECONDS * 1000,
			id,
			this.#runnerId,
		]);
	}

	#setStage(id: string, stage: RegionPromotionStage): void {
		this.ctx.db.update(regionPromotions).set({ stage }).where(and(eq(regionPromotions.id, id), isNull(regionPromotions.finishedAt))).run();
	}

	#finish(id: string, stage: 'completed' | 'failed', error: string | null): void {
		const now = this.ctx.now();
		this.ctx.db
			.update(regionPromotions)
			.set({ stage, finishedAt: now, error: error?.slice(0, 2_000) ?? null, runnerId: null, leaseExpiresAt: null })
			.where(and(eq(regionPromotions.id, id), isNull(regionPromotions.finishedAt)))
			.run();
		this.ctx.audit.record({
			principal: buildSystemPrincipal('system:failover', 'platform'),
			action: stage === 'completed' ? 'ha.region.promote.completed' : 'ha.region.promote.failed',
			resource: 'platform',
			resourceId: id,
			args: { error },
			result: stage === 'completed' ? 'ok' : 'error',
		});
	}

	#markRunning(id: string, position: number): void {
		this.ctx.db
			.update(regionPromotionSteps)
			.set({ status: 'running', startedAt: this.ctx.now() })
			.where(and(eq(regionPromotionSteps.promotionId, id), eq(regionPromotionSteps.position, position), eq(regionPromotionSteps.status, 'pending')))
			.run();
	}

	#finishStep(id: string, position: number, status: 'done' | 'failed', fencedGeneration: number | null, message: string): void {
		const now = this.ctx.now();
		const current = this.#steps(id).find((step) => step.position === position);
		this.ctx.db
			.update(regionPromotionSteps)
			.set({ status, fencedGeneration, finishedAt: now, startedAt: current?.startedAt ?? now, message: message.slice(0, 1_000) })
			.where(and(eq(regionPromotionSteps.promotionId, id), eq(regionPromotionSteps.position, position)))
			.run();
	}

	#openPromotion(): typeof regionPromotions.$inferSelect | null {
		return this.ctx.db.select().from(regionPromotions).where(isNull(regionPromotions.finishedAt)).get() ?? null;
	}

	#requirePromotion(id: string): typeof regionPromotions.$inferSelect {
		const row = this.ctx.db.select().from(regionPromotions).where(eq(regionPromotions.id, id)).get();
		if (!row) throw new NotFoundError('Region promotion');
		return row;
	}

	#steps(id: string): Array<typeof regionPromotionSteps.$inferSelect> {
		return this.ctx.db.select().from(regionPromotionSteps).where(eq(regionPromotionSteps.promotionId, id)).orderBy(regionPromotionSteps.position).all();
	}

	#promotionView(row: typeof regionPromotions.$inferSelect): RegionPromotionView {
		const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());
		return {
			id: row.id,
			toRegion: row.toRegion,
			fromRegion: row.fromRegion,
			stage: row.stage,
			planHash: row.planHash,
			steps: this.#steps(row.id).map((step) => ({
				position: step.position,
				step: step.step,
				kind: step.kind,
				resourceId: step.resourceId,
				name: step.name,
				targetNodeId: step.targetNodeId,
				expectedGeneration: step.expectedGeneration,
				fencedGeneration: step.fencedGeneration,
				status: step.status,
				lagBytes: step.lagBytes,
				lagSeconds: step.lagSeconds,
				startedAt: iso(step.startedAt),
				finishedAt: iso(step.finishedAt),
				message: step.message,
			})),
			runnerId: row.runnerId,
			leaseExpiresAt: iso(row.leaseExpiresAt),
			attempt: row.attempt,
			acceptDataLoss: true,
			reason: row.reason,
			confirmedBy: row.confirmedBy,
			confirmedAt: new Date(row.confirmedAt).toISOString(),
			startedAt: new Date(row.startedAt).toISOString(),
			finishedAt: iso(row.finishedAt),
			error: row.error,
		};
	}

	// ------------------------------------------------------------------ facts

	#nodes(): Array<typeof nodes.$inferSelect> {
		return this.ctx.db.select().from(nodes).all();
	}

	#ingressIn(region: string): Array<{ id: string; name: string; status: string }> {
		const ids = new Set(this.ctx.ingressSet.nodes());
		return this.#nodes().filter((row) => ids.has(row.id) && regionOf(row) === region);
	}

	/** The node the control plane runs on: the lease holder when HA is on, else this process's node or the edge. */
	#controlNodeId(): string | null {
		const holder = this.ctx.controlPlane.snapshot()?.lease.holderNodeId;
		const known = (id: string | null | undefined) => (id && this.ctx.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, id)).get() ? id : null);
		return known(holder) ?? known(this.ctx.controlPlane.nodeId) ?? this.ctx.workloads.edgeNode();
	}

	#regionValuesStored(): boolean {
		if (this.ctx.sqlite.query("SELECT 1 FROM nodes WHERE region <> 'default' LIMIT 1").get()) return true;
		if (this.ctx.sqlite.query('SELECT 1 FROM databases WHERE standby_region IS NOT NULL AND deleted_at IS NULL LIMIT 1').get()) return true;
		if (this.ctx.cluster.get().replicas.spread === 'region') return true;
		return this.ctx.db
			.select({ placement: projects.placementJson })
			.from(projects)
			.where(isNull(projects.deletedAt))
			.all()
			.some((row) => parseJson<{ spread?: string } | null>(row.placement, null)?.spread === 'region');
	}

	#requireHa(principal: Principal): void {
		if (!this.ctx.platformIam.allows(principal, 'platform:ha'))
			throw new CoreError('forbidden', 'High availability is for platform operators and admins.', 403);
	}

	/** A region promotion moves writes: a platform admin, signed in, never MCP. */
	#requireAdmin(principal: Principal): void {
		if (principal.kind === 'mcp' || !this.ctx.platformIam.canAdminister(principal))
			throw new CoreError('forbidden', 'A region promotion needs a platform admin signed in to the dashboard or the CLI; MCP cannot run it.', 403);
	}
}
