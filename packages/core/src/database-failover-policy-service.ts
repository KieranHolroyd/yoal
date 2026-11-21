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
	databaseFailoverEvidenceSchema,
	databaseReplicaReadable,
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
import { CoreError } from './errors.ts';
import type { NodeView } from './nodes.ts';
import { parseJson } from './util.ts';

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
	 * Arm `auto` after checking the policy and recording `autoArmedAt` + evidence. Lane A owns the
	 * write and its audit record; the foundation refuses rather than writing a policy with no
	 * enforcement behind it.
	 */
	async arm(
		principal: Principal,
		databaseName: string,
		_request: DatabaseFailoverArmRequest,
	): Promise<DatabaseFailoverPolicyView> {
		const database = this.#require(principal, databaseName, 'database:update');
		if (!featureEnabled(this.ctx.config, 'DB_AUTO_PROMOTE'))
			throw new CoreError(
				'unavailable',
				'Automatic database failover is off: enable DB_AUTO_PROMOTE first (HA-PLAN W11).',
				409,
			);
		// The lane's write is not here yet, but arming must still refuse an ineligible policy: the
		// drill, member, zone and arbiter gates are the specification, not UI hints.
		const refusal = this.#evaluate(database).refusals[0];
		if (refusal)
			throw new CoreError('conflict', `Automatic failover cannot be armed: ${refusal.message}`, 409);
		throw new CoreError(
			'conflict',
			`not implemented (HA Wave 4 lane A): arming automatic failover for "${database.name}"`,
			409,
		);
	}

	/** Disarm immediately; a healthy primary is not fenced (W11-SPEC §12). Lane A owns the write. */
	async disarm(principal: Principal, databaseName: string): Promise<DatabaseFailoverPolicyView> {
		const database = this.#require(principal, databaseName, 'database:update');
		throw new CoreError(
			'conflict',
			`not implemented (HA Wave 4 lane A): disarming automatic failover for "${database.name}"`,
			409,
		);
	}

	/** Run a failover drill and record `lastFailoverDrillAt` + the measured time to writable. */
	async drill(
		principal: Principal,
		databaseName: string,
		_request: DatabaseFailoverDrillRequest,
	): Promise<DatabaseFailoverDrill> {
		const database = this.#require(principal, databaseName, 'database:update');
		throw new CoreError(
			'conflict',
			`not implemented (HA Wave 4 lane A): failover drill for "${database.name}"`,
			409,
		);
	}

	// ---------------------------------------------------------------- reads

	#view(database: DatabaseRow): DatabaseFailoverPolicyView {
		const { evidence, refusals, latestAttempt, latestPassed } = this.#evaluate(database);
		const rawEvidence = database.failoverEvidenceJson
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
			active: database.failoverMode === 'auto' && refusals.length === 0,
			refusals,
		};
	}

	/** Current eligibility evidence and the refusals derived from it (W11-SPEC §3). */
	#evaluate(database: DatabaseRow): {
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
		const latestPassed = this.#latestPassedDrill(database.id);
		const drillAge =
			latestPassed?.finishedAt === null || latestPassed?.finishedAt === undefined
				? null
				: now - latestPassed.finishedAt;

		const evidence: DatabaseFailoverEvidence = {
			autoPromoteEnabled: featureEnabled(this.ctx.config, 'DB_AUTO_PROMOTE'),
			dataNodeCount: dataNodes.length,
			dataZones: zones,
			membersCapable: memberNodeIds.length > 0 && missingCapability.length === 0,
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
