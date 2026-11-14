import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { appVolumeAttachments, appVolumeSnapshots, appVolumes, deployments, nodes, projectRelocations, projects, workloads } from '@yoal/db';
import {
	relocationRequestSchema,
	type Principal,
	type RelocationPhase,
	type RelocationView,
	type RelocationVolumeView,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import { buildSystemPrincipal } from './iam/system.ts';
import type { ProjectRow } from './projects.ts';
import { newId, parseJson, randomToken } from './util.ts';

type RelocationRow = typeof projectRelocations.$inferSelect;

interface VolumeStep {
	volumeId: string;
	name: string;
	sizeMb: number;
	snapshotId: string | null;
	newVolumeId: string | null;
	/** The name the replacement volume carries until the switch gives it the real one. */
	tempName: string | null;
}

const ACTIVE: RelocationPhase[] = ['stopping', 'snapshotting', 'restoring'];
export const RELOCATION_STOP_TIMEOUT_MS = 10 * 60_000;
export const RELOCATION_COPY_TIMEOUT_MS = 2 * 60 * 60_000;

export interface RelocationAlert {
	key: string;
	title: string;
	detail: string;
	severity: 'info' | 'warning';
}

/**
 * Moving an app together with its app volumes (docs/SCALING.md §7).
 *
 * The app is stopped for the copy, so this is a move with downtime, started by a person. The
 * phases are `stopping` (the source node stops the app), `snapshotting` (each volume is archived
 * to the backup target), `restoring` (a replacement volume is filled on the target node) and then
 * one transaction switches the attachments, the volume names and the workload's node. Every step
 * before that switch leaves the source exactly as it was, so a failure restarts the app in place;
 * after it, the old volumes sit in the trash for the usual retention, as a way back.
 */
export class RelocationService {
	constructor(private readonly ctx: CoreContext) {}

	/** Projects stopped while they move; the same set a database move uses, read by desired state. */
	quiescedProjectIds(): Set<string> {
		return new Set(this.#active().map((row) => row.projectId));
	}

	isRelocating(projectId: string): boolean {
		return this.#active().some((row) => row.projectId === projectId);
	}

	start(principal: Principal, slug: string, raw: unknown): RelocationView {
		const input = relocationRequestSchema.parse(raw ?? {});
		const project = this.ctx.projects.requireRow(principal, slug);
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		const workload = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
		if (!workload?.nodeId) throw new ValidationError(`"${project.slug}" has not been deployed yet.`);
		if (this.isRelocating(project.id)) throw new ConflictError(`"${project.slug}" is already moving.`);
		const volumes = this.ctx.db
			.select()
			.from(appVolumes)
			.where(and(eq(appVolumes.projectId, project.id), isNull(appVolumes.deletedAt)))
			.all();
		if (volumes.length === 0)
			throw new ConflictError(`"${project.slug}" has no app volumes, so it does not need a move with data. Use an ordinary move instead.`);
		const unready = volumes.find((volume) => volume.status !== 'ready' || volume.restoreSnapshotId !== null);
		if (unready) throw new ConflictError(`Volume "${unready.name}" is ${unready.status}; a move needs every volume ready.`);
		const elsewhere = volumes.find((volume) => volume.nodeId !== workload.nodeId);
		if (elsewhere) throw new ConflictError(`Volume "${elsewhere.name}" is not on the app's node, so the move cannot account for it.`);

		// Everything but the volumes must already allow a move; the volumes are what this carries.
		const blocker = this.ctx.workloads.moveBlocker(project, workload, undefined, { ignoreVolumes: true });
		if (blocker) throw new ConflictError(`"${project.slug}" cannot move because ${blocker}.`);
		let target: string | undefined;
		if (input.node) {
			const node = this.ctx.db
				.select({ id: nodes.id, name: nodes.name })
				.from(nodes)
				.all()
				.find((row) => row.id === input.node || row.name === input.node);
			if (!node) throw new NotFoundError('Node');
			if (node.id === workload.nodeId) throw new ConflictError(`"${project.slug}" already runs on ${node.name}.`);
			target = node.id;
		}
		const plan = this.ctx.workloads.planReplicaMove(workload.id, new Set(), target, { ignoreVolumes: true });
		if (!plan.ok) throw new ConflictError(plan.message.replace(/^placement_blocked: /, ''));
		// Fail now, not after the app is down, when either node cannot do its part or nothing can hold the archive.
		this.ctx.appVolumes.lifecycle.assertNodeCapable(workload.nodeId, 'snapshot');
		this.ctx.appVolumes.lifecycle.assertNodeCapable(plan.nodeId, 'restore');
		this.ctx.backupTargets.placementFor(project.orgId, undefined);
		const room = this.ctx.workloads.placementCandidates().find((candidate) => candidate.id === plan.nodeId);
		const needBytes = volumes.reduce((sum, volume) => sum + volume.sizeMb, 0) * 1024 * 1024;
		if (room?.diskFreeBytes != null && room.diskFreeBytes - (room.reservedDiskBytes ?? 0) < needBytes)
			throw new ConflictError(`${plan.nodeName} does not have ${Math.ceil(needBytes / 1048576)} MB of disk free for the volumes.`);

		const now = this.ctx.now();
		const id = newId('rel_');
		const steps: VolumeStep[] = volumes.map((volume) => ({
			volumeId: volume.id,
			name: volume.name,
			sizeMb: volume.sizeMb,
			snapshotId: null,
			newVolumeId: null,
			tempName: null,
		}));
		this.ctx.db
			.insert(projectRelocations)
			.values({
				id,
				orgId: project.orgId,
				projectId: project.id,
				workloadId: workload.id,
				fromNodeId: workload.nodeId,
				toNodeId: plan.nodeId,
				phase: 'stopping',
				detail: 'Stopping the app on its node.',
				volumesJson: JSON.stringify(steps),
				phaseStartedAt: now,
				createdBy: principal.userId,
				createdAt: now,
			})
			.run();
		// The row quiesces the project, so this bump is the version that tells the source to stop it.
		this.ctx.projects.bump(project.orgId);
		this.ctx.db.update(projectRelocations).set({ quiesceVersion: this.ctx.projects.stateVersion() }).where(eq(projectRelocations.id, id)).run();
		this.ctx.audit.record({
			principal,
			action: 'project.relocate',
			resource: 'project',
			resourceId: project.id,
			args: { slug: project.slug, from: workload.nodeId, to: plan.nodeId, volumes: volumes.map((volume) => volume.name) },
			result: 'ok',
		});
		return this.#view(this.#require(id));
	}

	/** Stop a move before its switch; the app starts again where it was. */
	cancel(principal: Principal, slug: string): RelocationView {
		const project = this.ctx.projects.requireRow(principal, slug);
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		const row = this.#active().find((entry) => entry.projectId === project.id);
		if (!row) throw new ConflictError(`"${project.slug}" is not moving.`);
		this.#abort(row, 'cancelled', 'The move was cancelled.', this.ctx.now());
		return this.#view(this.#require(row.id));
	}

	/** The latest move of a project, or null when it has never moved with its data. */
	latest(principal: Principal, project: ProjectRow): RelocationView | null {
		this.ctx.iam.require(principal, 'deployment:read', { type: 'project', id: project.id });
		const row = this.ctx.db
			.select()
			.from(projectRelocations)
			.where(eq(projectRelocations.projectId, project.id))
			.orderBy(desc(projectRelocations.createdAt))
			.limit(1)
			.get();
		return row ? this.#view(row) : null;
	}

	// ------------------------------------------------------------------ node protocol

	/** The source applied the stop: it no longer reports the app's units. */
	onHeartbeat(nodeId: string, actualStateVersion: number, reportedIds: readonly string[]): void {
		for (const row of this.#active()) {
			if (row.phase !== 'stopping' || row.fromNodeId !== nodeId || row.stoppedAt !== null) continue;
			if (actualStateVersion < row.quiesceVersion) continue;
			if (reportedIds.some((id) => id === row.workloadId || id.startsWith(`${row.workloadId}-r`))) continue;
			this.ctx.db.update(projectRelocations).set({ stoppedAt: this.ctx.now() }).where(eq(projectRelocations.id, row.id)).run();
		}
	}

	/** Advance every move from what the nodes have reported. Called under the controller's lease. */
	tick(now: number = this.ctx.now()): RelocationAlert[] {
		const alerts: RelocationAlert[] = [];
		for (const row of this.#active()) {
			try {
				const alert = this.#advance(row, now);
				if (alert) alerts.push(alert);
			} catch (error) {
				alerts.push(this.#abort(row, 'failed', error instanceof Error ? error.message : String(error), now));
			}
		}
		return alerts;
	}

	#advance(row: RelocationRow, now: number): RelocationAlert | null {
		const project = this.ctx.db.select().from(projects).where(eq(projects.id, row.projectId)).get() as ProjectRow | undefined;
		if (!project || project.deletedAt) return this.#abort(row, 'cancelled', 'The project was deleted.', now);
		const system = buildSystemPrincipal('system:relocation', row.orgId);
		const steps = parseJson<VolumeStep[]>(row.volumesJson, []);
		const elapsed = now - row.phaseStartedAt;

		if (row.phase === 'stopping') {
			if (row.stoppedAt === null) {
				if (elapsed >= RELOCATION_STOP_TIMEOUT_MS)
					return this.#abort(row, 'failed', `${this.#nodeName(row.fromNodeId)} did not stop the app within 10 minutes. Is the node online?`, now);
				return null;
			}
			// The app is down, so nothing is writing: the archive is consistent without a freeze.
			for (const step of steps) {
				const snapshot = this.ctx.appVolumes.lifecycle.createSnapshot(system, project, step.name, {
					label: `move to ${this.#nodeName(row.toNodeId)}`,
					quiesce: false,
					pinned: true,
				});
				step.snapshotId = snapshot.id;
			}
			this.#phase(row, 'snapshotting', `Copying ${steps.length} volume${steps.length === 1 ? '' : 's'} off ${this.#nodeName(row.fromNodeId)}.`, steps, now);
			return null;
		}

		if (row.phase === 'snapshotting') {
			const snapshots = this.#snapshots(steps);
			const failed = steps.find((step) => snapshots.get(step.snapshotId!)?.status === 'failed' || !snapshots.has(step.snapshotId!));
			if (failed)
				return this.#abort(row, 'failed', `The copy of volume "${failed.name}" failed: ${snapshots.get(failed.snapshotId!)?.error ?? 'the snapshot was removed'}.`, now);
			if (steps.some((step) => snapshots.get(step.snapshotId!)?.status !== 'ok')) {
				if (elapsed >= RELOCATION_COPY_TIMEOUT_MS) return this.#abort(row, 'failed', 'Copying the volumes off the node took more than two hours.', now);
				return null;
			}
			for (const step of steps) {
				const source = this.ctx.db.select().from(appVolumes).where(eq(appVolumes.id, step.volumeId)).get();
				if (!source) throw new Error(`Volume "${step.name}" was removed during the move.`);
				// A temporary name: the real one is still the source volume's until the switch.
				step.tempName = `mv-${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
				const created = this.ctx.appVolumes.create(
					system,
					project,
					{ name: step.tempName, sizeMb: source.sizeMb, singleWriter: source.singleWriter },
					{ restoreFrom: { snapshotId: step.snapshotId!, sourceName: source.name, diskId: null, nodeId: row.toNodeId } },
				);
				step.newVolumeId = created.id;
			}
			this.#phase(row, 'restoring', `Restoring ${steps.length} volume${steps.length === 1 ? '' : 's'} on ${this.#nodeName(row.toNodeId)}.`, steps, now);
			return null;
		}

		// restoring
		const replacements = new Map(
			this.ctx.db
				.select()
				.from(appVolumes)
				.where(inArray(appVolumes.id, steps.map((step) => step.newVolumeId!)))
				.all()
				.map((volume) => [volume.id, volume]),
		);
		const broken = steps.find((step) => {
			const volume = replacements.get(step.newVolumeId!);
			return !volume || volume.status === 'failed' || volume.deletedAt !== null;
		});
		if (broken)
			return this.#abort(row, 'failed', `Restoring volume "${broken.name}" on ${this.#nodeName(row.toNodeId)} failed: ${replacements.get(broken.newVolumeId!)?.message ?? 'the volume was removed'}.`, now);
		if (steps.some((step) => replacements.get(step.newVolumeId!)!.restoreSnapshotId !== null || replacements.get(step.newVolumeId!)!.status !== 'ready')) {
			if (elapsed >= RELOCATION_COPY_TIMEOUT_MS) return this.#abort(row, 'failed', 'Restoring the volumes on the target took more than two hours.', now);
			return null;
		}
		this.#switch(row, project, steps, now);
		return {
			key: `relocation:${row.projectId}`,
			title: `${project.slug} moved to ${this.#nodeName(row.toNodeId)}`,
			detail: `${project.slug} and ${steps.length} volume${steps.length === 1 ? '' : 's'} moved from ${this.#nodeName(row.fromNodeId)}. The old volumes are in the trash for the usual retention.`,
			severity: 'info',
		};
	}

	/**
	 * The switch: the replacement volumes take the names and the attachments, the old ones go to
	 * the trash, and the workload is placed on the target. One transaction, so the app either
	 * still belongs to the source with its data or belongs to the target with the copy.
	 */
	#switch(row: RelocationRow, project: ProjectRow, steps: VolumeStep[], now: number): void {
		const purgeAt = now + this.ctx.policies.trashMs();
		this.ctx.sqlite.transaction(() => {
			for (const step of steps) {
				// Out of the way of the real name, and inside the 40 characters a volume name may have.
				const retired = `${step.name.slice(0, 28)}-moved-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 5)}`;
				this.ctx.db
					.update(appVolumes)
					.set({ name: retired, deletedAt: now, purgeAt, status: 'deleting', message: `Moved to ${this.#nodeName(row.toNodeId)}.`, updatedAt: now })
					.where(eq(appVolumes.id, step.volumeId))
					.run();
				this.ctx.db.update(appVolumeAttachments).set({ volumeId: step.newVolumeId! }).where(eq(appVolumeAttachments.volumeId, step.volumeId)).run();
				this.ctx.db.update(appVolumes).set({ name: step.name, message: null, updatedAt: now }).where(eq(appVolumes.id, step.newVolumeId!)).run();
				// The archive did its job; it is an ordinary snapshot of the retired volume from here on.
				if (step.snapshotId) this.ctx.db.update(appVolumeSnapshots).set({ pinned: false }).where(eq(appVolumeSnapshots.id, step.snapshotId)).run();
			}
			this.ctx.db
				.update(workloads)
				.set({ nodeId: row.toNodeId, status: 'pending', message: null, movingFromNodeId: null, movedAt: now, placementReason: 'manual', updatedAt: now })
				.where(eq(workloads.id, row.workloadId))
				.run();
			this.ctx.db
				.update(deployments)
				.set({ nodeId: row.toNodeId })
				.where(and(eq(deployments.projectId, row.projectId), eq(deployments.nodeId, row.fromNodeId)))
				.run();
			this.ctx.db
				.update(projectRelocations)
				.set({ phase: 'done', detail: `Running on ${this.#nodeName(row.toNodeId)}.`, volumesJson: JSON.stringify(steps), finishedAt: now })
				.where(eq(projectRelocations.id, row.id))
				.run();
		})();
		this.ctx.workloads.afterRelocation(project.id, row.fromNodeId);
		this.ctx.audit.record({
			principal: buildSystemPrincipal('system:relocation', row.orgId),
			action: 'project.relocated',
			resource: 'project',
			resourceId: row.projectId,
			args: { slug: project.slug, from: row.fromNodeId, to: row.toNodeId },
			result: 'ok',
		});
		this.ctx.projects.bump(row.orgId);
	}

	/** End a move without the switch: the half-made copies are removed and the app starts where it was. */
	#abort(row: RelocationRow, phase: 'failed' | 'cancelled', reason: string, now: number): RelocationAlert {
		const steps = parseJson<VolumeStep[]>(row.volumesJson, []);
		const purgeAt = now + this.ctx.policies.trashMs();
		for (const step of steps) {
			if (step.newVolumeId)
				this.ctx.db
					.update(appVolumes)
					.set({ deletedAt: now, purgeAt, status: 'deleting', restoreSnapshotId: null, updatedAt: now })
					.where(eq(appVolumes.id, step.newVolumeId))
					.run();
			if (step.snapshotId) this.ctx.db.update(appVolumeSnapshots).set({ pinned: false }).where(eq(appVolumeSnapshots.id, step.snapshotId)).run();
		}
		this.ctx.db
			.update(projectRelocations)
			.set({ phase, error: reason.slice(0, 1000), detail: `Still on ${this.#nodeName(row.fromNodeId)}; the app was started again there.`, finishedAt: now })
			.where(eq(projectRelocations.id, row.id))
			.run();
		this.ctx.projects.bump(row.orgId);
		const slug = this.ctx.db.select({ slug: projects.slug }).from(projects).where(eq(projects.id, row.projectId)).get()?.slug ?? row.projectId;
		return {
			key: `relocation:${row.projectId}`,
			title: phase === 'failed' ? `Moving ${slug} failed` : `Moving ${slug} was cancelled`,
			detail: `${reason} Nothing was changed: ${slug} runs on ${this.#nodeName(row.fromNodeId)} with its data.`,
			severity: phase === 'failed' ? 'warning' : 'info',
		};
	}

	// ------------------------------------------------------------------ internals

	#phase(row: RelocationRow, phase: RelocationPhase, detail: string, steps: VolumeStep[], now: number): void {
		this.ctx.db
			.update(projectRelocations)
			.set({ phase, detail, volumesJson: JSON.stringify(steps), phaseStartedAt: now })
			.where(eq(projectRelocations.id, row.id))
			.run();
	}

	#active(): RelocationRow[] {
		return this.ctx.db.select().from(projectRelocations).where(inArray(projectRelocations.phase, ACTIVE)).all();
	}

	#require(id: string): RelocationRow {
		const row = this.ctx.db.select().from(projectRelocations).where(eq(projectRelocations.id, id)).get();
		if (!row) throw new NotFoundError('Relocation');
		return row;
	}

	#snapshots(steps: VolumeStep[]) {
		const ids = steps.map((step) => step.snapshotId).filter((id): id is string => id !== null);
		if (ids.length === 0) return new Map<string, typeof appVolumeSnapshots.$inferSelect>();
		return new Map(
			this.ctx.db
				.select()
				.from(appVolumeSnapshots)
				.where(inArray(appVolumeSnapshots.id, ids))
				.all()
				.map((snapshot) => [snapshot.id, snapshot]),
		);
	}

	#nodeName(id: string): string {
		return this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, id)).get()?.name ?? id;
	}

	#view(row: RelocationRow): RelocationView {
		const steps = parseJson<VolumeStep[]>(row.volumesJson, []);
		const snapshots = this.#snapshots(steps);
		const replacements = new Map(
			steps.some((step) => step.newVolumeId)
				? this.ctx.db
						.select()
						.from(appVolumes)
						.where(inArray(appVolumes.id, steps.map((step) => step.newVolumeId).filter((id): id is string => id !== null)))
						.all()
						.map((volume) => [volume.id, volume])
				: [],
		);
		const state = (step: VolumeStep): RelocationVolumeView['state'] => {
			if (row.phase === 'done') return 'restored';
			const replacement = step.newVolumeId ? replacements.get(step.newVolumeId) : undefined;
			if (replacement) return replacement.status === 'failed' ? 'failed' : replacement.restoreSnapshotId === null && replacement.status === 'ready' ? 'restored' : 'restoring';
			const snapshot = step.snapshotId ? snapshots.get(step.snapshotId) : undefined;
			if (snapshot) return snapshot.status === 'ok' ? 'snapshotted' : snapshot.status === 'failed' ? 'failed' : 'snapshotting';
			return 'waiting';
		};
		const slug = this.ctx.db.select({ slug: projects.slug }).from(projects).where(eq(projects.id, row.projectId)).get()?.slug ?? row.projectId;
		return {
			id: row.id,
			project: slug,
			from: { id: row.fromNodeId, name: this.#nodeName(row.fromNodeId) },
			to: { id: row.toNodeId, name: this.#nodeName(row.toNodeId) },
			phase: row.phase as RelocationPhase,
			active: ACTIVE.includes(row.phase as RelocationPhase),
			detail: row.detail,
			error: row.error,
			volumes: steps.map((step) => ({ name: step.name, sizeMb: step.sizeMb, state: state(step) })),
			startedAt: new Date(row.createdAt).toISOString(),
			finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
		};
	}
}
