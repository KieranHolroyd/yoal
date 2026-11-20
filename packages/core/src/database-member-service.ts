import { and, eq, isNull } from 'drizzle-orm';
import { databaseReplicas, databases, nodes } from '@yoal/db';
import type { DatabaseMember, DatabaseMembersDesired, DurabilitySettings } from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { CoreError, NotFoundError } from './errors.ts';

/**
 * Database members and durability (HA-PLAN H21–H23, Wave 3 opening). The member machine, the sync
 * set and promotion are lane A/B against docs/build-plan/W9-SPEC.md. This service is the read side
 * the lanes and the status surface share; writes fail loudly until a lane implements them.
 */
export class DatabaseMemberService {
	constructor(private readonly ctx: CoreContext) {}

	/** The primary and its replicas, as every consumer should ask for role and generation. */
	members(databaseId: string): DatabaseMember[] {
		const database = this.ctx.db.select().from(databases).where(eq(databases.id, databaseId)).get();
		if (!database || database.deletedAt) throw new NotFoundError('Database');
		const primary = this.ctx.db.select({ id: nodes.id, address: nodes.privateAddress }).from(nodes).where(eq(nodes.id, database.nodeId)).get();
		const replicas = this.ctx.db
			.select({ nodeId: databaseReplicas.nodeId, address: nodes.privateAddress })
			.from(databaseReplicas)
			.innerJoin(nodes, eq(nodes.id, databaseReplicas.nodeId))
			.where(and(eq(databaseReplicas.databaseId, databaseId), isNull(databaseReplicas.removingAt)))
			.all();
		return [
			...(primary ? [{ nodeId: primary.id, address: primary.address, role: 'primary' as const }] : []),
			...replicas.map((row) => ({ nodeId: row.nodeId, address: row.address, role: 'replica' as const })),
		];
	}

	durability(databaseId: string): DurabilitySettings {
		const row = this.ctx.db
			.select({
				durability: databases.durability,
				syncTimeoutSeconds: databases.syncTimeoutSeconds,
				onSyncLoss: databases.onSyncLoss,
			})
			.from(databases)
			.where(eq(databases.id, databaseId))
			.get();
		if (!row) throw new NotFoundError('Database');
		return row;
	}

	/** The desired-state entry lane B renders; null while the flag is off or the database is async. */
	membersDesired(databaseId: string): DatabaseMembersDesired | null {
		const row = this.ctx.db.select().from(databases).where(eq(databases.id, databaseId)).get();
		if (!row) return null;
		const members = this.members(databaseId);
		if (members.length < 2) return null;
		return {
			databaseId,
			generation: row.primaryGeneration,
			members,
			sync: row.syncReplicaNodeId ? [row.syncReplicaNodeId] : [],
			durability: row.durability,
		};
	}

	setDurability(): never {
		throw new CoreError('conflict', 'not implemented (HA Wave 3 lane B): database durability', 409);
	}

	promote(): never {
		throw new CoreError('conflict', 'not implemented (HA Wave 3 lane B): member promotion', 409);
	}
}
