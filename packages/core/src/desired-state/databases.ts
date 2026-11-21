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
type DurabilityFields = 'databaseMembers' | 'databaseSyncTasks' | 'databaseRewindTasks' | 'databaseSwitchovers';

/** Databases: purges, backups, PITR, rotations, credentials, pooler restarts and replication (C7). */
export class DatabaseState extends DesiredStatePart {
	async tasks(): Promise<Pick<DesiredState, DatabaseFields | DurabilityFields>> {
		const { node } = this.state;
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
		// W10 (SYNC_REPLICA): the keys are absent, not empty, with the flag off. That keeps every
		// existing desired state byte-identical (the golden test) and an older agent unaffected.
		// The cast is deliberate: the type carries the keys, the flag-off runtime value does not.
		if (!featureEnabled(this.ctx.config, 'SYNC_REPLICA')) return base as Pick<DesiredState, DatabaseFields | DurabilityFields>;
		return {
			...base,
			databaseMembers: this.ctx.databaseMembers.membersDesiredAll(),
			databaseSyncTasks: this.ctx.databaseMembers.syncTasksForNode(node.id),
			databaseRewindTasks: this.ctx.databaseMembers.rewindTasksForNode(node.id),
			databaseSwitchovers: this.ctx.databaseMembers.switchoverTasksForNode(node.id),
		};
	}
}
