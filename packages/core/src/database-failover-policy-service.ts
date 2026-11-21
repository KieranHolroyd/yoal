import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
	databaseFailoverDrills,
	databaseFailovers,
	databaseReplicas,
	databases,
	nodes,
} from '@yoal/db';
import {
	DB_MEMBER_CAPABILITY,
	DB_MEMBER_SELF_FENCING_CAPABILITY,
	autoEnabledFor,
	databaseFailoverEvidenceSchema,
	databaseReplicaReadable,
	timeToWritableMs,
	withinTimeToWritable,
	type DatabaseFailoverArmRequest,
	type DatabaseFailoverDrill,
	type DatabaseFailoverDrillRequest,
	type DatabaseFailoverEvidence,
	type DatabaseFailoverPolicyView,
	type FailoverArmRefusal,
	type FailoverArmRefusalCode,
	type Permission,
	type Principal,
} from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import type { DatabaseRow } from './databases.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import type { NodeView } from './nodes.ts';
import { ObjectStoreDatabaseLeaseStore } from './database-sync.ts';
import { newId, parseJson } from './util.ts';

/** W9-SPEC §3 `DB_TTL`: a lease's last write is its expiry minus this. */
const DB_LEASE_TTL_MS = 15_000;

/** A passed drill older than this no longer arms `auto` (W11-SPEC §3). */
const DRILL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type DrillRow = typeof databaseFailoverDrills.$inferSelect;

/**
 * Per-database automatic failover policy (HA-PLAN W11; docs/build-plan/W11-SPEC.md §3/§12).
 *
 * `view` and `refusals` are real reads: they explain the current policy and every prerequisite that
 * fails, because a surface must not pretend `auto` is armed. Arming, disarming and drills are lane
 * A's, against the model; until it merges they throw, so no caller can record a policy the member
 * machine does not enforce.
 */
export class DatabaseFailoverPolicyService {
	constructor(private readonly ctx: CoreContext) {}

	/** The policy, the evidence behind it and why `auto` is or is not in force. */
	view(principal: Principal, databaseName: string): DatabaseFailoverPolicyView {
		const database = this.#require(principal, databaseName, 'database:read');
		return this.#view(database);
	}

	/** Every prerequisite that currently refuses `auto`, in a stable order for the surfaces. */
	refusals(principal: Principal, databaseName: string): FailoverArmRefusal[] {
		const database = this.#require(principal, databaseName, 'database:read');
		return this.#evaluate(database).refusals;
	}

	/**
	 * The live half of the policy (W11-MODEL assumption 9 + review blockers 2/10). The controller and
	 * `view.active` use this one predicate: the flag, the per-database mode, a steady sync state, and
	 * the §1.3 durability condition. Arming separately enforces every §3 refusal.
	 */
	autoActiveForRow(
		database: Pick<DatabaseRow, 'failoverMode' | 'durabilityEffective' | 'acceptDataLoss' | 'syncState'>,
	): boolean {
		if (!featureEnabled(this.ctx.config, 'DB_AUTO_PROMOTE')) return false;
		if (database.failoverMode !== 'auto') return false;
		if (database.syncState !== 'steady') return false;
		return autoEnabledFor(true, database.durabilityEffective, database.acceptDataLoss);
	}

	/**
	 * Arm `auto` after checking every policy gate, recording `autoArmedAt` and the evidence. The
	 * write is audited and the evidence is persisted so an operator can explain an existing `auto`
	 * after the fleet has changed (W11-SPEC §3/§12).
	 */
	async arm(
		principal: Principal,
		databaseName: string,
		request: DatabaseFailoverArmRequest,
	): Promise<DatabaseFailoverPolicyView> {
		const database = this.#require(principal, databaseName, 'database:update');
		if (!featureEnabled(this.ctx.config, 'DB_AUTO_PROMOTE'))
			throw new CoreError(
				'unavailable',
				'Automatic database failover is off: enable DB_AUTO_PROMOTE first (HA-PLAN W11).',
				409,
			);
		// The request carries the operator's async acknowledgement; evaluate the policy as it would
		// be after that write, so the refusal list matches what arming will actually record.
		const effective: DatabaseRow = {
			...database,
			acceptDataLoss: request.acceptDataLoss || database.acceptDataLoss,
		};
		const { evidence, refusals } = this.#evaluate(effective, request.drillId);
		if (refusals.length > 0) {
			const summary = refusals.map((refusal) => refusal.message).join(' ');
			throw new ConflictError(`Automatic failover cannot be armed: ${summary}`);
		}
		const now = this.ctx.now();
		const armedEvidence: DatabaseFailoverEvidence = { ...evidence, observedAt: new Date(now).toISOString() };
		this.ctx.db
			.update(databases)
			.set({
				failoverMode: 'auto',
				acceptDataLoss: effective.acceptDataLoss,
				autoArmedAt: now,
				lastFailoverDrillAt: evidence.drillPassedAt === null ? null : Date.parse(evidence.drillPassedAt),
				failoverEvidenceJson: JSON.stringify(armedEvidence),
				updatedAt: now,
			})
			.where(eq(databases.id, database.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'database.failover.arm',
			resource: 'database',
			resourceId: database.id,
			args: {
				name: database.name,
				acceptDataLoss: effective.acceptDataLoss,
				drillId: evidence.drillId,
				dataNodeCount: evidence.dataNodeCount,
				dataZones: evidence.dataZones,
				autoPromoteEnabled: evidence.autoPromoteEnabled,
			},
			result: 'ok',
		});
		this.ctx.projects.bump(database.orgId);
		return this.#view({ ...effective, failoverMode: 'auto', autoArmedAt: now, failoverEvidenceJson: JSON.stringify(armedEvidence) });
	}

	/**
	 * Disarm immediately (W11-SPEC §12). It never fences a healthy primary: turning `auto` off only
	 * removes the automatic acquisition path, so a live primary keeps serving and its lease.
	 */
	async disarm(principal: Principal, databaseName: string): Promise<DatabaseFailoverPolicyView> {
		const database = this.#require(principal, databaseName, 'database:update');
		const now = this.ctx.now();
		this.ctx.db
			.update(databases)
			.set({
				failoverMode: 'manual',
				autoArmedAt: null,
				// The evidence explained the armed policy; it is stale once the policy is manual.
				failoverEvidenceJson: '{}',
				updatedAt: now,
			})
			.where(eq(databases.id, database.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'database.failover.disarm',
			resource: 'database',
			resourceId: database.id,
			args: { name: database.name, previousMode: database.failoverMode },
			result: 'ok',
		});
		this.ctx.projects.bump(database.orgId);
		return this.view(principal, database.name);
	}

	/**
	 * Start a failover drill: the same promotion path, measured from the primary's last successful
	 * lease write to the new primary accepting writes (W11-SPEC §12, §9). The promotion is
	 * asynchronous (fence → pg_ctl promote → re-point), so this records a `running` drill and the
	 * completion writes the measurement. A passed drill is what `arm` reads; a running, failed,
	 * unmeasured or too-slow drill refuses `auto`.
	 */
	async drill(
		principal: Principal,
		databaseName: string,
		request: DatabaseFailoverDrillRequest,
	): Promise<DatabaseFailoverDrill> {
		const database = this.#require(principal, databaseName, 'database:update');
		if (!featureEnabled(this.ctx.config, 'SYNC_REPLICA'))
			throw new CoreError('unavailable', 'Failover drills need the replica machine: enable SYNC_REPLICA first.', 409);
		if (database.engine !== 'postgres')
			throw new ValidationError('Failover drills are available for Postgres only.');
		if (database.deletedAt) throw new NotFoundError('Database');
		const active = this.#activeSwitchover(database.id);
		if (active) throw new ConflictError('A planned switchover is in progress; wait for it to finish before drilling.');
		if (database.syncState !== 'steady')
			throw new ConflictError(
				'A sync-set change is open, so the database is non-promotable (W9-SPEC §5.5). Wait for it to close before drilling.',
			);
		if (this.#activeFailover(database.id))
			throw new ConflictError(`"${database.name}" is already failing over; wait for it to finish.`);
		// Review blocker 11: a drill never promotes the production database. It must name a disposable
		// target explicitly; the default (no target) is refused rather than guessing.
		if (!request.drillDatabaseId)
			throw new ValidationError(
				'A failover drill needs a disposable database: pass drillDatabaseId (or `--target <database>`) naming a database with a cross-node replica.',
			);
		const target = this.ctx.databases.requireRow(principal, request.drillDatabaseId);
		if (target.id === database.id)
			throw new ValidationError('A drill must not promote the database whose policy it proves; name a disposable copy instead.');
		if (target.engine !== 'postgres') throw new ValidationError('Failover drills are available for Postgres only.');
		if (target.deletedAt) throw new NotFoundError('Database');
		if (this.#activeFailover(target.id))
			throw new ConflictError(`"${target.name}" is already failing over; wait for it to finish.`);
		if (target.syncState !== 'steady')
			throw new ConflictError(`"${target.name}" has an open sync-set change; it is non-promotable.`);
		if (!this.ctx.arbiter)
			throw new CoreError('unavailable', 'A failover drill must prove an arbiter compare-and-swap, and no arbiter is configured.', 409);
		const replicas = this.ctx.db
			.select()
			.from(databaseReplicas)
			.where(and(eq(databaseReplicas.databaseId, target.id), isNull(databaseReplicas.removingAt)))
			.all();
		const nodeById = new Map(this.#allNodes().map((node) => [node.id, node]));
		const candidate = replicas
			.filter(
				(replica) =>
					replica.nodeId !== target.nodeId &&
					replica.primaryGeneration === target.primaryGeneration &&
					databaseReplicaReadable(replica.status) &&
					nodeById.get(replica.nodeId)?.status === 'online',
			)
			.sort((a, b) => a.nodeId.localeCompare(b.nodeId))[0];
		if (!candidate)
			throw new ConflictError(
				`No readable replica on another online node follows "${target.name}", so a drill has nothing to promote.`,
			);
		const now = this.ctx.now();
		const id = newId('drl_');
		// The lease's last write before the loss is its expiry minus one TTL; that is the §9 clock.
		const lastLeaseWriteAt = target.syncLeaseExpiresAt === null ? null : target.syncLeaseExpiresAt - DB_LEASE_TTL_MS;
		this.ctx.db
			.insert(databaseFailoverDrills)
			.values({
				id,
				databaseId: database.id,
				drillDatabaseId: target.id,
				status: 'running',
				durability: target.durability,
				startedAt: now,
				generation: target.primaryGeneration + 1,
				fromNodeId: target.nodeId,
				toNodeId: candidate.nodeId,
				// Set from the actual lease CAS at completion, never assumed at start.
				arbiterTested: false,
				arbiterTestedAt: null,
				evidenceJson: JSON.stringify({ lastLeaseWriteAt, replicaId: candidate.id, targetName: target.name, note: request.note ?? null }),
				createdBy: principal.userId ?? principal.kind ?? 'system',
				createdAt: now,
			})
			.run();
		this.ctx.audit.record({
			principal,
			action: 'database.failover.drill.start',
			resource: 'database',
			resourceId: database.id,
			args: {
				name: database.name,
				drillId: id,
				target: target.name,
				from: target.nodeId,
				to: candidate.nodeId,
				durability: target.durability,
			},
			result: 'ok',
		});
		try {
			const failover = await this.ctx.databaseReplicas.promote(
				principal,
				target.name,
				candidate.id,
				// A sync drill must prove RPO 0; an async one is explicitly acknowledged by the drill.
				{ confirm: true, acceptDataLoss: target.durability === 'async' },
				{ source: 'drill', drillId: id },
			);
			this.ctx.db
				.update(databaseFailoverDrills)
				.set({
					evidenceJson: JSON.stringify({
						lastLeaseWriteAt,
						replicaId: candidate.id,
						targetName: target.name,
						failoverId: failover.id,
						note: request.note ?? null,
					}),
				})
				.where(eq(databaseFailoverDrills.id, id))
				.run();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#finishDrillRow(id, { passed: false, message });
			this.ctx.audit.record({
				principal,
				action: 'database.failover.drill.complete',
				resource: 'database',
				resourceId: database.id,
				args: { name: database.name, drillId: id, passed: false },
				result: 'error',
				error: message,
			});
			throw error;
		}
		this.ctx.projects.bump(database.orgId);
		return this.#drillView(this.ctx.db.select().from(databaseFailoverDrills).where(eq(databaseFailoverDrills.id, id)).get()!);
	}

	/**
	 * Called by the promotion path when a `promotion_source = 'drill'` failover reaches a terminal
	 * state. Two pieces of evidence are measured, not assumed (review blocker 5):
	 * - `arbiterTested` only if this drill's generation is actually held at its target node in the
	 *   arbiter (a real CAS), read back here;
	 * - `lostCommits` stays `null` unless a promotion path measured it. A sync drill with `null`
	 *   lost commits therefore **refuses** `auto` (drill-lost-commits); it is never hardcoded to 0.
	 */
	async completeDrill(
		drillId: string,
		outcome: { passed: boolean; writableAt: number | null; message?: string | null; failoverMessage?: string | null },
	): Promise<void> {
		const row = this.ctx.db.select().from(databaseFailoverDrills).where(eq(databaseFailoverDrills.id, drillId)).get();
		if (!row || row.status !== 'running') return;
		const evidence = parseJson<Record<string, unknown>>(row.evidenceJson, {});
		const lastLeaseWriteAt =
			typeof evidence.lastLeaseWriteAt === 'number' ? evidence.lastLeaseWriteAt : null;
		const measured = timeToWritableMs(lastLeaseWriteAt, outcome.writableAt);
		const passed = outcome.passed && withinTimeToWritable(measured);
		// A real CAS: the drill's acquired generation is at its target node in the arbiter.
		let arbiterTested = false;
		let arbiterTestedAt: number | null = null;
		const store = this.#leaseStore();
		if (store && row.toNodeId !== null) {
			try {
				const record = await store.read(row.drillDatabaseId ?? row.databaseId);
				if (record && record.lease.generation === row.generation && record.lease.holderNodeId === row.toNodeId) {
					arbiterTested = true;
					arbiterTestedAt = this.ctx.now();
				}
			} catch {
				// An unreadable arbiter is not evidence of a CAS.
			}
		}
		// No promotion path measures acknowledged-commit loss for an unplanned drill yet. Record
		// `null` and let the refusal (`drill-lost-commits`) block sync auto rather than claiming RPO 0.
		const lostCommits = null;
		const message = outcome.passed
			? measured === null
				? 'The promotion completed but there was no lease write to measure the time to writable; the drill is unmeasured.'
				: withinTimeToWritable(measured)
					? `The new primary was writable ${measured} ms after the primary's last lease write.`
					: `The new primary was writable ${measured} ms after the primary's last lease write, over the 30 s bound.`
			: (outcome.message ?? outcome.failoverMessage ?? 'The drill promotion failed.');
		this.#finishDrillRow(drillId, {
			passed,
			timeToWritableMs: measured,
			lostCommits,
			arbiterTested,
			arbiterTestedAt,
			message,
			evidence: { ...evidence, failoverMessage: outcome.failoverMessage ?? null, measuredAt: this.ctx.now() },
		});
		const database = this.ctx.db.select().from(databases).where(eq(databases.id, row.databaseId)).get();
		if (database && passed)
			this.ctx.db
				.update(databases)
				.set({ lastFailoverDrillAt: this.ctx.now(), updatedAt: this.ctx.now() })
				.where(eq(databases.id, database.id))
				.run();
		this.ctx.audit.record({
			orgId: database?.orgId,
			action: 'database.failover.drill.complete',
			resource: 'database',
			resourceId: row.databaseId,
			args: { name: database?.name ?? null, drillId, passed, timeToWritableMs: measured, lostCommits, arbiterTested },
			result: passed ? 'ok' : 'error',
			...(passed ? {} : { error: message }),
		});
		if (database) this.ctx.projects.bump(database.orgId);
	}

	#finishDrillRow(
		id: string,
		result: {
			passed: boolean;
			timeToWritableMs?: number | null;
			lostCommits?: number | null;
			arbiterTested?: boolean;
			arbiterTestedAt?: number | null;
			message?: string;
			evidence?: Record<string, unknown>;
		},
	): void {
		const now = this.ctx.now();
		this.ctx.db
			.update(databaseFailoverDrills)
			.set({
				status: result.passed ? 'passed' : 'failed',
				finishedAt: now,
				timeToWritableMs: result.timeToWritableMs ?? null,
				lostCommits: result.lostCommits ?? null,
				arbiterTested: result.arbiterTested ?? false,
				arbiterTestedAt: result.arbiterTestedAt ?? null,
				message: result.message?.slice(0, 2_000) ?? null,
				...(result.evidence ? { evidenceJson: JSON.stringify(result.evidence) } : {}),
			})
			.where(eq(databaseFailoverDrills.id, id))
			.run();
	}

	#leaseStore() {
		return this.ctx.arbiter ? new ObjectStoreDatabaseLeaseStore(this.ctx.arbiter) : null;
	}

	// ---------------------------------------------------------------- reads

	#view(database: DatabaseRow): DatabaseFailoverPolicyView {
		const { evidence, refusals, latestAttempt, latestPassed } = this.#evaluate(database);		const rawEvidence = database.failoverEvidenceJson
			? parseJson<unknown>(database.failoverEvidenceJson, null)
			: null;
		const armed =
			rawEvidence && typeof rawEvidence === 'object' && Object.keys(rawEvidence).length > 0
				? databaseFailoverEvidenceSchema.safeParse(rawEvidence)
				: null;
		return {
			databaseId: database.id,
			failoverMode: database.failoverMode,
			acceptDataLoss: database.acceptDataLoss,
			autoArmedAt: iso(database.autoArmedAt),
			// The drills table is the authority; the column is a cache for reads that do not join it.
			lastFailoverDrillAt: iso(latestPassed?.finishedAt ?? database.lastFailoverDrillAt),
			lastDrill: latestAttempt ? this.#drillView(latestAttempt) : null,
			evidence,
			armedEvidence: armed?.success ? armed.data : null,
			// The same predicate the controller uses (review blocker 10): a surface never claims an
			// `auto` the controller would not act on.
			active: this.autoActiveForRow(database),
			refusals,
		};
	}

	/** Current eligibility evidence and the refusals derived from it (W11-SPEC §3). */
	#evaluate(database: DatabaseRow, drillId?: string): {
		evidence: DatabaseFailoverEvidence;
		refusals: FailoverArmRefusal[];
		latestAttempt: DrillRow | null;
		latestPassed: DrillRow | null;
	} {
		const now = this.ctx.now();
		const all = this.#allNodes();
		const byId = new Map(all.map((node) => [node.id, node]));
		const dataNodes = all.filter(
			(node) => node.roles.includes('data') && node.capabilities.includes(DB_MEMBER_CAPABILITY),
		);
		const zones = [...new Set(dataNodes.map((node) => node.zone))].sort();
		const memberNodeIds = this.#memberNodeIds(database);
		const involved = memberNodeIds.flatMap((id) => {
			const node = byId.get(id);
			return node ? [node] : [];
		});
		// A member whose node row is gone is as unusable as one on an old agent.
		const missingCapability = [
			...new Set([
				...memberNodeIds.filter((id) => !byId.has(id)),
				...involved.filter((node) => !node.capabilities.includes(DB_MEMBER_CAPABILITY)).map((node) => node.id),
			]),
		].sort();
		const crossNodeReplica = this.#hasCrossNodeReplica(database, byId);
		const switchover = this.#activeSwitchover(database.id);
		const latestAttempt = this.#latestDrill(database.id);
		// An explicit drill must be a passed one; it replaces the latest passed drill for arming.
		const latestPassed = drillId ? this.#passedDrill(database.id, drillId) : this.#latestPassedDrill(database.id);
		// F1 (review blocker 1): every data node and every involved member must advertise the real
		// self-fencing capability. Without it the control-plane controller must not promote.
		const selfFencing =
			dataNodes.length > 0 &&
			dataNodes.every((node) => node.capabilities.includes(DB_MEMBER_SELF_FENCING_CAPABILITY)) &&
			involved.every((node) => node.capabilities.includes(DB_MEMBER_SELF_FENCING_CAPABILITY));

		const drillAge =
			latestPassed?.finishedAt === null || latestPassed?.finishedAt === undefined
				? null
				: now - latestPassed.finishedAt;

		const evidence: DatabaseFailoverEvidence = {
			autoPromoteEnabled: featureEnabled(this.ctx.config, 'DB_AUTO_PROMOTE'),
			dataNodeCount: dataNodes.length,
			dataZones: zones,
			membersCapable: memberNodeIds.length > 0 && missingCapability.length === 0,
			selfFencing,
			drillId: latestPassed?.id ?? null,
			drillPassedAt: latestPassed?.finishedAt === null || latestPassed?.finishedAt === undefined ? null : iso(latestPassed.finishedAt),
			drillTimeToWritableMs: latestPassed?.timeToWritableMs ?? null,
			arbiterTested: latestPassed?.arbiterTested === true && latestPassed.arbiterTestedAt !== null,
			arbiterTestedAt: iso(latestPassed?.arbiterTestedAt ?? null),
			crossNodeReplica,
			switchoverStep: switchover?.switchoverStep ?? null,
			syncState: database.syncState,
			observedAt: new Date(now).toISOString(),
		};

		const refusals: FailoverArmRefusal[] = [];
		const refuse = (code: FailoverArmRefusalCode, message: string, detail: Record<string, unknown> = {}) =>
			refusals.push({ code, message, detail });

		if (!evidence.autoPromoteEnabled)
			refuse(
				'auto-promote-off',
				'Automatic database failover is off globally; enable DB_AUTO_PROMOTE first (HA-PLAN W11).',
			);
		if (database.engine !== 'postgres')
			refuse('engine-unsupported', `Automatic failover is implemented for Postgres only; this database is ${database.engine}.`, {
				engine: database.engine,
			});
		if (database.durability === 'sync') {
			// RPO 0 is only true while the sync set is in force; a downgraded database is async now.
			if (database.durabilityEffective !== 'sync')
				refuse(
					'sync-downgraded',
					'This sync database is currently downgraded to async, so RPO 0 is not in force; re-establish sync before arming auto.',
					{ durability: database.durability, durabilityEffective: database.durabilityEffective },
				);
			if (database.acceptDataLoss)
				refuse(
					'data-loss-not-needed',
					'acceptDataLoss only applies to an async database; clear it before arming this sync database.',
					{ durability: database.durability },
				);
		} else if (!database.acceptDataLoss) {
			refuse(
				'data-loss-not-accepted',
				'An async database may lose recent commits when it promotes; set acceptDataLoss on the database to arm auto.',
				{ durability: database.durability },
			);
		}
		if (dataNodes.length < 3)
			refuse(
				'too-few-data-nodes',
				'Auto needs at least three data nodes that declare db-member; there are fewer now.',
				{ count: dataNodes.length, required: 3 },
			);
		if (zones.length < 2)
			refuse('single-zone', 'Auto needs data nodes in at least two zones, so one zone loss is survivable.', {
				zones,
			});
		if (missingCapability.length > 0)
			refuse(
				'member-capability-missing',
				'Every involved member must run an agent that declares db-member; update the listed nodes first.',
				{ nodeIds: missingCapability },
			);
		if (!selfFencing)
			refuse(
				'no-self-fencing-path',
				'Every data node must advertise db-member-self-fencing (a real arbiter transport and peer channel); without it an automatic promotion could leave two primaries (HA-PLAN F1).',
				{ dataNodeCount: dataNodes.length },
			);
		if (!crossNodeReplica)
			refuse(
				'no-cross-node-replica',
				'No streaming replica is on another online node, so there is no automatic candidate to promote.',
				{ primaryNodeId: database.nodeId },
			);
		if (switchover)
			refuse(
				'switchover-active',
				'A planned switchover is in progress; wait for it to finish before arming auto.',
				{ switchoverStep: switchover.switchoverStep },
			);
		if (database.syncState !== 'steady')
			refuse(
				'sync-transition-open',
				'A sync-set transition is open, so the database is non-promotable; close it before arming auto.',
				{ syncState: database.syncState },
			);
		if (!latestAttempt)
			refuse('no-drill', 'No failover drill has run for this database; run one before arming auto.');
		else {
			if (latestAttempt.status === 'running')
				refuse(
					'drill-running',
					'The latest failover drill is still running; wait for it to finish before arming auto.',
					{ drillId: latestAttempt.id },
				);
			if (latestAttempt.status === 'failed')
				refuse('drill-failed', 'The latest failover drill did not pass; fix it and run another.', {
					drillId: latestAttempt.id,
					status: latestAttempt.status,
				});
		}
		if (latestPassed) {
			if (latestPassed.finishedAt === null || latestPassed.timeToWritableMs === null)
				refuse(
					'drill-unmeasured',
					'The latest passed drill has no finished time or no measured time to writable; run a complete drill.',
					{ drillId: latestPassed.id, finishedAt: iso(latestPassed.finishedAt), timeToWritableMs: latestPassed.timeToWritableMs },
				);
			else if (latestPassed.timeToWritableMs > 30_000)
				refuse(
					'drill-too-slow',
					'The latest passed drill was not writable within 30 s; fix the time-to-writable bound and run another.',
					{ drillId: latestPassed.id, timeToWritableMs: latestPassed.timeToWritableMs, maxMs: 30_000 },
				);
			if (latestPassed.durability === 'sync' && latestPassed.lostCommits !== 0)
				refuse(
					'drill-lost-commits',
					'The latest passed sync drill lost acknowledged commits; RPO 0 is not proven.',
					{ drillId: latestPassed.id, durability: latestPassed.durability, lostCommits: latestPassed.lostCommits },
				);
			if (!latestPassed.arbiterTested || latestPassed.arbiterTestedAt === null)
				refuse(
					'arbiter-untested',
					'The latest passed drill did not prove an arbiter compare-and-swap; run the drill with the arbiter.',
					{ drillId: latestPassed.id },
				);
			else if (latestPassed.finishedAt !== null && drillAge !== null && drillAge > DRILL_MAX_AGE_MS)
				refuse('drill-stale', 'The latest passed drill is older than 30 days; run a fresh one.', {
					drillId: latestPassed.id,
					finishedAt: iso(latestPassed.finishedAt),
					maxAgeDays: 30,
				});
		} else if (latestAttempt && latestAttempt.status === 'passed') {
			// A passed row that the passed-drill query did not return cannot be trusted.
			refuse('drill-failed', 'The latest drill is marked passed but could not be read as a passed drill.', {
				drillId: latestAttempt.id,
			});
		}

		return { evidence, refusals, latestAttempt, latestPassed };
	}

	#latestDrill(databaseId: string): DrillRow | null {
		return (
			this.ctx.db
				.select()
				.from(databaseFailoverDrills)
				.where(eq(databaseFailoverDrills.databaseId, databaseId))
				.orderBy(desc(databaseFailoverDrills.startedAt), desc(databaseFailoverDrills.id))
				.limit(1)
				.get() ?? null
		);
	}

	#latestPassedDrill(databaseId: string): DrillRow | null {
		return (
			this.ctx.db
				.select()
				.from(databaseFailoverDrills)
				.where(
					and(
						eq(databaseFailoverDrills.databaseId, databaseId),
						eq(databaseFailoverDrills.status, 'passed'),
					),
				)
				.orderBy(desc(databaseFailoverDrills.finishedAt), desc(databaseFailoverDrills.id))
				.limit(1)
				.get() ?? null
		);
	}

	/** The drill an arming request explicitly names; only a passed drill of this database counts. */
	#passedDrill(databaseId: string, drillId: string): DrillRow | null {
		return (
			this.ctx.db
				.select()
				.from(databaseFailoverDrills)
				.where(
					and(
						eq(databaseFailoverDrills.id, drillId),
						eq(databaseFailoverDrills.databaseId, databaseId),
						eq(databaseFailoverDrills.status, 'passed'),
					),
				)
				.get() ?? null
		);
	}

	/** A promotion is in flight; a drill and a switchover are mutually exclusive with it. */
	#activeFailover(databaseId: string): boolean {
		return Boolean(
			this.ctx.db
				.select({ id: databaseFailovers.id })
				.from(databaseFailovers)
				.where(
					and(
						eq(databaseFailovers.databaseId, databaseId),
						inArray(databaseFailovers.status, ['pending', 'promoting']),
					),
				)
				.get(),
		);
	}

	#drillView(row: DrillRow): DatabaseFailoverDrill {
		return {
			id: row.id,
			databaseId: row.databaseId,
			drillDatabaseId: row.drillDatabaseId,
			status: row.status,
			durability: row.durability,
			startedAt: new Date(row.startedAt).toISOString(),
			finishedAt: iso(row.finishedAt),
			timeToWritableMs: row.timeToWritableMs,
			lostCommits: row.lostCommits,
			generation: row.generation,
			fromNodeId: row.fromNodeId,
			toNodeId: row.toNodeId,
			arbiterTested: row.arbiterTested,
			arbiterTestedAt: iso(row.arbiterTestedAt),
			evidence: parseJson<Record<string, unknown>>(row.evidenceJson, {}),
			message: row.message,
		};
	}

	#allNodes(): NodeView[] {
		const ids = this.ctx.db.select({ id: nodes.id }).from(nodes).orderBy(asc(nodes.id)).all();
		return ids.flatMap((row) => {
			try {
				return [this.ctx.nodes.get(row.id)];
			} catch {
				return [];
			}
		});
	}

	#memberNodeIds(database: DatabaseRow): string[] {
		const replicas = this.ctx.db
			.select({ nodeId: databaseReplicas.nodeId })
			.from(databaseReplicas)
			.where(and(eq(databaseReplicas.databaseId, database.id), isNull(databaseReplicas.removingAt)))
			.all();
		return [...new Set([database.nodeId, ...replicas.map((row) => row.nodeId)])].sort();
	}

	#hasCrossNodeReplica(database: DatabaseRow, byNode: Map<string, NodeView>): boolean {
		const replicas = this.ctx.db
			.select({ nodeId: databaseReplicas.nodeId, status: databaseReplicas.status })
			.from(databaseReplicas)
			.where(and(eq(databaseReplicas.databaseId, database.id), isNull(databaseReplicas.removingAt)))
			.all();
		return replicas.some(
			(row) =>
				row.nodeId !== database.nodeId &&
				databaseReplicaReadable(row.status) &&
				byNode.get(row.nodeId)?.status === 'online',
		);
	}

	#activeSwitchover(databaseId: string) {
		return (
			this.ctx.db
				.select()
				.from(databaseFailovers)
				.where(
					and(
						eq(databaseFailovers.databaseId, databaseId),
						eq(databaseFailovers.kind, 'switchover'),
						inArray(databaseFailovers.status, ['pending', 'promoting']),
						isNotNull(databaseFailovers.switchoverStep),
					),
				)
				.get() ?? null
		);
	}

	#require(principal: Principal, databaseName: string, permission: Permission): DatabaseRow {
		const database = this.ctx.databases.requireRow(principal, databaseName);
		this.ctx.iam.require(principal, permission, { type: 'database', id: database.id });
		return database;
	}
}

function iso(value: number | null | undefined): string | null {
	return value === null || value === undefined ? null : new Date(value).toISOString();
}
