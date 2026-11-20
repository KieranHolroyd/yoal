import { and, eq } from 'drizzle-orm';
import { deployments, releases } from '@yoal/db';
import type { DesiredState } from '@yoal/contracts';
import { DesiredStatePart } from './context.ts';

/** Releases and workloads: what this node downloads and runs, and the volumes it mounts for them. */
export class ReleaseState extends DesiredStatePart {
	/** A process worker has no route, but the node running it still needs its active releases. */
	addWorkerReleases(projectId: string, releaseShas: Set<string>): void {
		for (const deployment of this.ctx.db
			.select({ releaseId: deployments.releaseId })
			.from(deployments)
			.where(and(eq(deployments.projectId, projectId), eq(deployments.status, 'active')))
			.all()) {
			const release = this.ctx.db
				.select({ sha256: releases.sha256 })
				.from(releases)
				.where(eq(releases.id, deployment.releaseId))
				.get();
			if (release) releaseShas.add(release.sha256);
		}
	}

	/** Each release this node holds, with a presigned URL to fetch it. */
	async releaseSpecs(releaseShas: Set<string>): Promise<DesiredState['releases']> {
		const releaseRows = this.ctx.db.select().from(releases).all().filter((row) => releaseShas.has(row.sha256));
		return Promise.all(
			releaseRows.map(async (release) => ({
				sha256: release.sha256,
				sizeBytes: release.sizeBytes,
				fileCount: release.fileCount,
				precompressed: release.precompressed,
				url: await this.ctx.objectStore.presignGet(release.objectKey, 3600),
			})),
		);
	}

	/** Every workload placed on this node, from every service that runs one. */
	workloads(): DesiredState['workloads'] {
		const { node } = this.state;
		// Managed databases ride the workload list as container workloads with a database profile.
		return [
			...this.ctx.workloads.desiredForNode(node.id),
			...this.ctx.databases.desiredForNode(node.id),
			// Postgres read replicas are their own database-profile workloads (C7).
			...this.ctx.databaseReplicas.desiredForNode(node.id),
			...this.ctx.storage.desiredForNode(node.id),
			...this.ctx.brokers.desiredForNode(node.id),
			// Kubernetes machines (docs/KUBERNETES.md).
			...this.ctx.kubernetes.desiredForNode(node.id),
			// The platform registry (docs/REGISTRY.md G1) on its node.
			...this.ctx.registry.desiredForNode(node.id),
		];
	}

	/** Disks, shares and their mounts. */
	volumes(): Pick<
		DesiredState,
		'volumes' | 'shareMounts' | 'shareUnmounts' | 'diskMounts' | 'diskUnmounts' | 'volumeProfileTasks'
	> {
		const { node } = this.state;
		return {
			volumes: this.ctx.disks.desiredForNode(node.id),
			shareMounts: this.ctx.shares.mountsForNode(node.id),
			shareUnmounts: this.ctx.shares.unmountsForNode(node.id),
			diskMounts: this.ctx.disks.mountsForNode(node.id),
			diskUnmounts: this.ctx.disks.unmountsForNode(node.id),
			volumeProfileTasks: this.ctx.disks.profileTasksForNode(node.id),
		};
	}

	/** App-volume usage, purges and snapshot/restore tasks (docs/VOLUMES.md). */
	async appVolumes(): Promise<Pick<DesiredState, 'appVolumes' | 'appVolumePurges' | 'appVolumeTasks'>> {
		const { node } = this.state;
		return {
			appVolumes: this.ctx.appVolumes.lifecycle.volumesForNode(node.id),
			appVolumePurges: this.ctx.appVolumes.lifecycle.purgesForNode(node.id),
			appVolumeTasks: await this.ctx.appVolumes.lifecycle.tasksForNode(node.id),
		};
	}
}
