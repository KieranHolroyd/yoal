import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
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
import { CoreError, NotFoundError } from './errors.ts';
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
		const { evidence, refusals } = this.#evaluate(database);
		const lastDrill = this.#lastDrill(database.id);
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
			lastFailoverDrillAt: iso(database.lastFailoverDrillAt),
			lastDrill: lastDrill ? this.#drillView(lastDrill) : null,
			evidence,
			armedEvidence: armed?.success ? armed.data : null,
			active: database.failoverMode === 'auto' && refusals.length === 0,
			refusals,
		};
	}

	/** Current eligibility evidence and the refusals derived from it (W11-SPEC §3). */
	#evaluate(database: DatabaseRow): { evidence: DatabaseFailoverEvidence; refusals: FailoverArmRefusal[] } {
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
		const missingCapability = involved
			.filter((node) => !node.capabilities.includes(DB_MEMBER_CAPABILITY))
			.map((node) => node.id);
		const crossNodeReplica = this.#hasCrossNodeReplica(database, byId);
		const switchover = this.#activeSwitchover(database.id);
		const drill = this.#lastDrill(database.id);
		const drillAge = drill?.finishedAt === null || drill?.finishedAt === undefined ? null : now - drill.finishedAt;

		const evidence: DatabaseFailoverEvidence = {
			autoPromoteEnabled: featureEnabled(this.ctx.config, 'DB_AUTO_PROMOTE'),
			dataNodeCount: dataNodes.length,
			dataZones: zones,
			membersCapable: involved.length > 0 && missingCapability.length === 0,
			drillId: drill?.id ?? null,
			drillPassedAt: drill?.status === 'passed' && drill.finishedAt !== null ? iso(drill.finishedAt) : null,
			drillTimeToWritableMs: drill?.timeToWritableMs ?? null,
			arbiterTested: drill?.arbiterTested ?? false,
			arbiterTestedAt: iso(drill?.arbiterTestedAt ?? null),
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
				'No replica is on another online node, so there is no automatic candidate to promote.',
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
		if (!drill) refuse('no-drill', 'No failover drill has run for this database; run one before arming auto.');
		else if (drill.status !== 'passed')
			refuse('drill-failed', 'The last failover drill did not pass; fix it and run another.', {
				drillId: drill.id,
				status: drill.status,
			});
		else if (!drill.arbiterTested)
			refuse('arbiter-untested', 'The last drill did not prove an arbiter compare-and-swap; run the drill with the arbiter.', {
				drillId: drill.id,
			});
		else if (drillAge === null || drillAge > DRILL_MAX_AGE_MS)
			refuse('drill-stale', 'The last passed drill is older than 30 days; run a fresh one.', {
				drillId: drill.id,
				finishedAt: iso(drill.finishedAt),
				maxAgeDays: 30,
			});

		return { evidence, refusals };
	}

	#lastDrill(databaseId: string): DrillRow | null {
		return (
			this.ctx.db
				.select()
				.from(databaseFailoverDrills)
				.where(eq(databaseFailoverDrills.databaseId, databaseId))
				.orderBy(desc(databaseFailoverDrills.startedAt))
				.limit(1)
				.get() ?? null
		);
	}

	#drillView(row: DrillRow): DatabaseFailoverDrill {
		return {
			id: row.id,
			databaseId: row.databaseId,
			status: row.status,
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
		const ids = this.ctx.db.select({ id: nodes.id }).from(nodes).all();
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
		return [...new Set([database.nodeId, ...replicas.map((row) => row.nodeId)])];
	}

	#hasCrossNodeReplica(database: DatabaseRow, byNode: Map<string, NodeView>): boolean {
		const replicas = this.ctx.db
			.select({ nodeId: databaseReplicas.nodeId })
			.from(databaseReplicas)
			.where(and(eq(databaseReplicas.databaseId, database.id), isNull(databaseReplicas.removingAt)))
			.all();
		return replicas.some((row) => row.nodeId !== database.nodeId && byNode.get(row.nodeId)?.status === 'online');
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
