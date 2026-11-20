import type { DesiredState } from '@yoal/contracts';
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

/** Databases: purges, backups, PITR, rotations, credentials, pooler restarts and replication (C7). */
export class DatabaseState extends DesiredStatePart {
	async tasks(): Promise<Pick<DesiredState, DatabaseFields>> {
		const { node } = this.state;
		return {
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
			databaseReplicaPromotions: this.ctx.databaseReplicas.promotionsForNode(node.id),
		};
	}
}
