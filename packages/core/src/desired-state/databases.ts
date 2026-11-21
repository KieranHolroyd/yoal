import type { DesiredState } from '@yoal/contracts';
import { featureEnabled } from '../config.ts';
import { DesiredStatePart } from './context.ts';

type DatabaseFields =
	| 'databasePurges'
	| 'databaseBackupTasks'
	| 'databasePitrTasks'
	| 'databaseRotations'
	| 'databaseCredentialTasks'
	| 'databaseStudioPrincipals'
	| 'databasePoolerRestarts'
	| 'databaseReplication'
	| 'databaseReplicaLinks'
	| 'databaseReplicaPromotions';

/** W10 fields, omitted entirely while SYNC_REPLICA is off so the golden desired state is unchanged. */
type DurabilityFields = 'databaseMembers' | 'databaseSyncTasks' | 'databaseSwitchovers';

/** Databases: purges, backups, PITR, rotations, credentials, pooler restarts and replication (C7). */
export class DatabaseState extends DesiredStatePart {
	async tasks(): Promise<
		Pick<DesiredState, DatabaseFields | DurabilityFields> & Pick<Partial<DesiredState>, 'databaseReplicaRewinds'>
	> {
		const { node } = this.state;
		const rewinds = this.ctx.databaseReplicas.rewindsForNode(node.id);
		const base: Pick<DesiredState, DatabaseFields> = {
			// Trashed databases plus the old copy a finished (or rolled-back) move left here.
			databasePurges: [
				...new Set([
					...this.ctx.databases.purgesForNode(node.id),
					...this.ctx.moves.purgesForNode(node.id),
					// Removed replicas, promotion leftovers and fenced old primaries (C7).
					...this.ctx.databaseReplicas.purgesForNode(node.id),
				]),
			].sort(),
			databaseBackupTasks: await this.ctx.databases.backupTasksForNode(node.id),
			databasePitrTasks: await this.ctx.databases.pitrTasksForNode(node.id),
			databaseRotations: this.ctx.databases.rotationTasksForNode(node.id),
			databaseCredentialTasks: this.ctx.databases.credentialTasksForNode(node.id),
			databaseStudioPrincipals: this.ctx.databaseStudio.principals.tasksForNode(node.id),
			databasePoolerRestarts: this.ctx.databases.poolerRestartTasksForNode(node.id),
			databaseReplication: this.ctx.databaseReplicas.replicationTasksForNode(node.id),
			databaseReplicaLinks: this.ctx.databaseReplicas.linksForNode(node.id),
			databaseReplicaPromotions: await this.ctx.databaseReplicas.promotionsForNode(node.id),
		};
		// Lane C's rewinds are omitted while empty, so the flag-off desired state (and the golden
		// fixtures) stay byte-identical.
		const withRewinds = rewinds.length > 0 ? { databaseReplicaRewinds: rewinds } : {};
		// W10 (SYNC_REPLICA): the keys are absent, not empty, with the flag off. That keeps every
		// existing desired state byte-identical (the golden test) and an older agent unaffected.
		// The exception is a resume task: it is a recovery path and must reach the node even after
		// the flag is turned off, so it is included only when one exists.
		const switchovers = this.ctx.databaseMembers.switchoverTasksForNode(node.id);
		if (!featureEnabled(this.ctx.config, 'SYNC_REPLICA')) {
			return {
				...base,
				...withRewinds,
				...(switchovers.length > 0 ? { databaseSwitchovers: switchovers } : {}),
			} as Pick<DesiredState, DatabaseFields | DurabilityFields> & Pick<Partial<DesiredState>, 'databaseReplicaRewinds'>;
		}
		return {
			...base,
			...withRewinds,
			// HA-PLAN H26: rendered per node, so a node outside a database's primary region never
			// carries its W11 policy (identical to before while every node is in one region).
			databaseMembers: this.ctx.databaseMembers.membersDesiredAll(500, node.id),
			databaseSyncTasks: this.ctx.databaseMembers.syncTasksForNode(node.id),
			databaseSwitchovers: switchovers,
		};
	}
}
