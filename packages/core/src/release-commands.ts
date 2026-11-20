import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { deployments, nodes, projects, releaseCommandRuns, releases, workloadReplicas, workloads } from '@yoal/db';
import {
	RELEASE_PHASE_CAPABILITY,
	jobLimits,
	workloadSpecSchema,
	type Principal,
	type ReleaseCommandResult,
	type ReleaseCommandRunStatus,
	type ReleaseCommandSpec,
	type ReleaseCommandTask,
	type WorkloadActivation,
} from '@yoal/contracts';
import { nodeHasCapability } from './capability-gate.ts';
import type { CoreContext } from './context.ts';
import { NotFoundError } from './errors.ts';
import { OFFLINE_AFTER_MS } from './nodes.ts';
import type { ProjectRow } from './projects.ts';
import { newId, parseJson } from './util.ts';
import { desiredImage } from './workloads.ts';

/**
 * The release-command scheduler (HA-PLAN H25, I16). Owned by Wave 1 lane C; the agent side that
 * runs `releaseCommands` is lane D. Backed by `release_command_runs` (0119), whose partial unique
 * index is the run lease: at most one queued, running or succeeded attempt per release id, ever
 * (a failed attempt frees it for a retry; a success closes it). Nothing
 * calls it while `RELEASE_PHASE` is off, because a spec with `release` is refused then.
 *
 * **The lease and a partition (I16).** A run is leased to one node with a start deadline
 * (`startBy`). The node starts it only before that deadline and kills it at its timeout, by
 * itself, whether or not it can reach the control plane (lane D; the same rule a lone worker's run
 * lease follows, `WorkloadService.runLeaseSeconds`). The control plane therefore never hands the
 * run to a second node: a leased run stays that node's until the node reports an outcome or the
 * lease expires, which is after the latest moment the command could still be running anywhere:
 * `startBy` + clock-skew allowance + timeout + the agent's stop grace + a margin. An expired lease
 * ends the attempt as `timeout` with an unknown outcome and fails the deployment; it is not retried
 * automatically, because the command may have run. A person retries (a new attempt), knowing that.
 */
export interface ReleaseCommandRun {
	id: string;
	releaseId: string;
	workloadId: string;
	attempt: number;
	status: ReleaseCommandRunStatus;
	nodeId: string | null;
	exitCode: number | null;
	error: string | null;
}

/** Where a release stands before its rollout may start. */
export type ReleaseGate = { state: 'none' } | { state: 'pending'; run: ReleaseCommandRun } | { state: 'succeeded'; run: ReleaseCommandRun } | { state: 'failed'; run: ReleaseCommandRun };

/** A release command run as the REST, CLI, MCP and dashboard surfaces show it. */
export interface ReleaseCommandRunView {
	id: string;
	/** The deployment this command prepares. */
	releaseId: string;
	/** The job trigger these runs carry in job views (HA-PLAN H25: "a job with trigger `release`"). */
	trigger: 'release';
	attempt: number;
	status: ReleaseCommandRunStatus;
	command: string[];
	timeoutSeconds: number;
	node: { id: string; name: string } | null;
	exitCode: number | null;
	error: string | null;
	createdAt: string;
	/** The node must start it before this; null until leased. */
	startBy: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	durationMs: number | null;
}

/** How long a leased node has to start the run. */
export const RELEASE_START_WINDOW_MS = 120_000;
/** Clock skew between a node and the control plane that the lease still tolerates. */
export const RELEASE_CLOCK_SKEW_MS = 60_000;
/** Held on top of the node's own deadlines before a silent lease is declared lost. */
export const RELEASE_LEASE_MARGIN_MS = 60_000;
/** The agent's grace between SIGTERM and SIGKILL for a run it stops (apps/agent/src/jobs.ts). */
const AGENT_STOP_GRACE_MS = 30_000;

type RunRow = typeof releaseCommandRuns.$inferSelect;
const LIVE: ReleaseCommandRunStatus[] = ['queued', 'running'];

function toRun(row: RunRow): ReleaseCommandRun {
	return {
		id: row.id,
		releaseId: row.releaseId,
		workloadId: row.workloadId,
		attempt: row.attempt,
		status: row.status,
		nodeId: row.nodeId,
		exitCode: row.exitCode,
		error: row.error,
	};
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function isUniqueViolation(error: unknown): boolean {
	return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

export class ReleaseCommandScheduler {
	constructor(private readonly ctx: CoreContext) {}

	/** The latest moment a run leased with this `startBy` could still be running on its node. */
	static leaseExpiresAt(row: Pick<RunRow, 'startBy' | 'timeoutSeconds'>): number | null {
		if (row.startBy === null) return null;
		return (
			row.startBy +
			RELEASE_CLOCK_SKEW_MS +
			(row.timeoutSeconds + jobLimits.timeoutGraceSeconds) * 1000 +
			AGENT_STOP_GRACE_MS +
			RELEASE_LEASE_MARGIN_MS
		);
	}

	/** Queue the release command for `releaseId` (the deployment id) unless one is live or succeeded. */
	schedule(input: { releaseId: string; orgId: string; projectId: string; workloadId: string; spec: ReleaseCommandSpec; createdBy: string | null }): ReleaseCommandRun {
		const held = this.leaseHolder(input.releaseId);
		if (held) return toRun(held);
		const now = this.ctx.now();
		const last = this.ctx.db
			.select({ attempt: releaseCommandRuns.attempt })
			.from(releaseCommandRuns)
			.where(eq(releaseCommandRuns.releaseId, input.releaseId))
			.orderBy(desc(releaseCommandRuns.attempt))
			.get();
		const row: RunRow = {
			id: newId('rc_'),
			releaseId: input.releaseId,
			orgId: input.orgId,
			projectId: input.projectId,
			workloadId: input.workloadId,
			attempt: (last?.attempt ?? 0) + 1,
			status: 'queued',
			commandJson: JSON.stringify(input.spec.command),
			timeoutSeconds: input.spec.timeoutSeconds,
			nodeId: null,
			startBy: null,
			exitCode: null,
			error: null,
			createdBy: input.createdBy,
			createdAt: now,
			startedAt: null,
			finishedAt: null,
			updatedAt: now,
		};
		try {
			this.ctx.db.insert(releaseCommandRuns).values(row).run();
		} catch (error) {
			// Another caller queued it first: the index is the lease, so theirs is the run.
			const winner = isUniqueViolation(error) ? this.leaseHolder(input.releaseId) : null;
			if (winner) return toRun(winner);
			throw error;
		}
		this.lease(row, now);
		return toRun(this.ctx.db.select().from(releaseCommandRuns).where(eq(releaseCommandRuns.id, row.id)).get()!);
	}

	/** Whether the rollout for `releaseId` may start (`succeeded`), must wait, or has failed. */
	gate(releaseId: string): ReleaseGate {
		const row = this.latest(releaseId);
		if (!row) return { state: 'none' };
		const run = toRun(row);
		if (row.status === 'succeeded') return { state: 'succeeded', run };
		if (row.status === 'queued' || row.status === 'running') return { state: 'pending', run };
		return { state: 'failed', run };
	}

	/**
	 * Lease what waits for a node, and end leases that ran out (see the class comment). Called by the
	 * controller that holds the failover lease, before `rolloutTick` reads the gates.
	 */
	tick(now: number = this.ctx.now()): void {
		const rows = this.ctx.db.select().from(releaseCommandRuns).where(inArray(releaseCommandRuns.status, LIVE)).all();
		const unleasedLimitMs = this.ctx.cluster.get().scheduling.rolloutTimeoutSeconds * 1000;
		for (const row of rows) {
			if (row.nodeId === null) {
				// Never handed to a node, so nothing can be running: safe to give up on.
				if (now - row.createdAt >= unleasedLimitMs)
					this.finish(row, 'failed', now, null, `No node could run the release command within ${Math.round(unleasedLimitMs / 1000)} s: none of the nodes that hold this app's copies is online with an agent that declares "${RELEASE_PHASE_CAPABILITY}".`);
				else this.lease(row, now);
				continue;
			}
			const expiresAt = ReleaseCommandScheduler.leaseExpiresAt(row);
			if (expiresAt !== null && now >= expiresAt)
				this.finish(
					row,
					'timeout',
					now,
					null,
					`${this.nodeName(row.nodeId)} ${row.status === 'running' ? 'stopped reporting the release command' : 'never reported starting the release command'}; its lease expired. The outcome is unknown, so it is not run again automatically.`,
				);
		}
	}

	/** The `releaseCommands` desired-state entries for a node that advertises `release-phase`. */
	tasksForNode(nodeId: string): ReleaseCommandTask[] {
		const now = this.ctx.now();
		const rows = this.ctx.db
			.select()
			.from(releaseCommandRuns)
			.where(and(eq(releaseCommandRuns.nodeId, nodeId), inArray(releaseCommandRuns.status, LIVE)))
			.all()
			// A queued run past its start deadline must not start any more; one already running stays
			// listed until its result arrives, so a restarted agent sees it is still its own.
			.filter((row) => row.status === 'running' || (row.startBy !== null && row.startBy > now))
			.sort((a, b) => a.createdAt - b.createdAt);
		const tasks: ReleaseCommandTask[] = [];
		for (const row of rows) {
			const deployment = this.ctx.db.select().from(deployments).where(eq(deployments.id, row.releaseId)).get();
			if (!deployment) continue;
			const spec = workloadSpecSchema.safeParse(parseJson<unknown>(deployment.workloadJson, null)).data;
			const release = this.ctx.db.select({ sha256: releases.sha256 }).from(releases).where(eq(releases.id, deployment.releaseId)).get();
			const image = spec ? desiredImage(spec) : undefined;
			tasks.push({
				runId: row.id,
				releaseId: row.releaseId,
				workloadId: row.workloadId,
				release: spec?.runtime === 'container' ? null : (release?.sha256 ?? null),
				...(image ? { image } : {}),
				command: parseJson<string[]>(row.commandJson, []),
				timeoutSeconds: row.timeoutSeconds,
				attempt: row.attempt,
				startBy: new Date(row.startBy!).toISOString(),
			});
		}
		return tasks.slice(0, 20);
	}

	/** Release shas a node must hold for the release commands leased to it (process apps). */
	releaseShasForNode(nodeId: string): string[] {
		return this.tasksForNode(nodeId).flatMap((task) => (task.release ? [task.release] : []));
	}

	/** Apply a heartbeat's `releaseCommandResults` from `nodeId`; results for runs it does not hold are ignored. */
	recordResults(nodeId: string, results: readonly ReleaseCommandResult[]): void {
		const now = this.ctx.now();
		for (const result of results) {
			const row = this.ctx.db.select().from(releaseCommandRuns).where(eq(releaseCommandRuns.id, result.runId)).get();
			if (!row || row.nodeId !== nodeId || row.releaseId !== result.releaseId) continue;
			if (!LIVE.includes(row.status)) {
				// Too late: the lease already ran out and the deployment was failed. Keep what the node says
				// for the record, but never revive the run: a retry may already hold the lease.
				if (row.status === 'timeout' && result.status !== 'running' && row.exitCode === null)
					this.ctx.db
						.update(releaseCommandRuns)
						.set({
							exitCode: result.exitCode,
							error: `${row.error ?? ''} The node later reported "${result.status}"${result.exitCode !== null ? ` (exit ${result.exitCode})` : ''}.`.trim().slice(0, 2_000),
							updatedAt: now,
						})
						.where(eq(releaseCommandRuns.id, row.id))
						.run();
				continue;
			}
			if (result.status === 'running') {
				if (row.status === 'queued')
					this.ctx.db
						.update(releaseCommandRuns)
						.set({ status: 'running', startedAt: result.startedAt ?? now, updatedAt: now })
						.where(and(eq(releaseCommandRuns.id, row.id), eq(releaseCommandRuns.status, 'queued')))
						.run();
				continue;
			}
			this.finish(row, result.status, result.finishedAt ?? now, result.exitCode, result.error, result.startedAt);
		}
	}

	/**
	 * The activation a node fetches for a run it holds: the new release's environment and secrets,
	 * as a copy of that release would get on this node. A run the node does not hold is a 404.
	 */
	activation(nodeId: string, runId: string): WorkloadActivation {
		const row = this.ctx.db.select().from(releaseCommandRuns).where(eq(releaseCommandRuns.id, runId)).get();
		if (!row || row.nodeId !== nodeId || !LIVE.includes(row.status)) throw new NotFoundError('Release command run');
		return this.ctx.workloads.releaseActivation(nodeId, row.workloadId, row.releaseId);
	}

	/** May this node post output for this run under this workload? (The log drain's check.) */
	runForLogs(nodeId: string, runId: string, workloadId: string): { orgId: string; projectId: string; deploymentId: string | null } | null {
		const row = this.ctx.db.select().from(releaseCommandRuns).where(eq(releaseCommandRuns.id, runId)).get();
		if (!row || row.nodeId !== nodeId || row.workloadId !== workloadId) return null;
		return { orgId: row.orgId, projectId: row.projectId, deploymentId: row.releaseId };
	}

	/** Cancel attempts for this workload's other releases that no node holds yet (a newer deploy won). */
	cancelSuperseded(workloadId: string, keepReleaseId: string): void {
		const now = this.ctx.now();
		for (const row of this.ctx.db
			.select()
			.from(releaseCommandRuns)
			.where(and(eq(releaseCommandRuns.workloadId, workloadId), eq(releaseCommandRuns.status, 'queued'), isNull(releaseCommandRuns.nodeId)))
			.all())
			if (row.releaseId !== keepReleaseId) this.finish(row, 'cancelled', now, null, 'A newer deployment replaced this one before it started.');
	}

	// ---------------------------------------------------------------- views

	/** Every attempt for one deployment, oldest first. */
	runsForRelease(releaseId: string): ReleaseCommandRunView[] {
		return this.ctx.db
			.select()
			.from(releaseCommandRuns)
			.where(eq(releaseCommandRuns.releaseId, releaseId))
			.orderBy(releaseCommandRuns.attempt)
			.all()
			.map((row) => this.view(row));
	}

	/** The project's recent attempts, newest first. */
	list(principal: Principal, project: ProjectRow, options: { limit?: number } = {}): ReleaseCommandRunView[] {
		this.ctx.iam.require(principal, 'project:read', { type: 'project', id: project.id });
		return this.ctx.db
			.select()
			.from(releaseCommandRuns)
			.where(eq(releaseCommandRuns.projectId, project.id))
			.orderBy(desc(releaseCommandRuns.createdAt))
			.limit(Math.min(Math.max(options.limit ?? 20, 1), 100))
			.all()
			.map((row) => this.view(row));
	}

	get(principal: Principal, project: ProjectRow, runId: string): ReleaseCommandRunView {
		this.ctx.iam.require(principal, 'project:read', { type: 'project', id: project.id });
		const row = this.ctx.db.select().from(releaseCommandRuns).where(eq(releaseCommandRuns.id, runId)).get();
		if (!row || row.projectId !== project.id) throw new NotFoundError('Release command run');
		return this.view(row);
	}

	/** A run's output, from the runtime log drain (`log_events.job_run_id` holds the `rc_` id). */
	logs(principal: Principal, project: ProjectRow, runId: string, input: { cursor?: string; limit?: number } = {}) {
		const run = this.get(principal, project, runId);
		return this.ctx.logs.query(principal, project, { ...input, jobRunId: run.id });
	}

	// ---------------------------------------------------------------- internals

	private view(row: RunRow): ReleaseCommandRunView {
		return {
			id: row.id,
			releaseId: row.releaseId,
			trigger: 'release',
			attempt: row.attempt,
			status: row.status,
			command: parseJson<string[]>(row.commandJson, []),
			timeoutSeconds: row.timeoutSeconds,
			node: row.nodeId ? { id: row.nodeId, name: this.nodeName(row.nodeId) } : null,
			exitCode: row.exitCode,
			error: row.error,
			createdAt: new Date(row.createdAt).toISOString(),
			startBy: iso(row.startBy),
			startedAt: iso(row.startedAt),
			finishedAt: iso(row.finishedAt),
			durationMs: row.startedAt !== null && row.finishedAt !== null ? Math.max(0, row.finishedAt - row.startedAt) : null,
		};
	}

	/** The attempt that holds the lease: queued, running or succeeded. */
	private leaseHolder(releaseId: string): RunRow | null {
		return (
			this.ctx.db
				.select()
				.from(releaseCommandRuns)
				.where(and(eq(releaseCommandRuns.releaseId, releaseId), inArray(releaseCommandRuns.status, ['queued', 'running', 'succeeded'])))
				.get() ?? null
		);
	}

	private latest(releaseId: string): RunRow | null {
		return (
			this.ctx.db
				.select()
				.from(releaseCommandRuns)
				.where(eq(releaseCommandRuns.releaseId, releaseId))
				.orderBy(desc(releaseCommandRuns.attempt))
				.get() ?? null
		);
	}

	/**
	 * Hand a queued run to a node: one that holds a copy of the app (so it has the release, the
	 * image and the attachments' endpoints), is online, and declares `release-phase`. Never while
	 * another release command for the same app is leased, so two migrations never overlap.
	 */
	private lease(row: RunRow, now: number): void {
		if (row.nodeId !== null || row.status !== 'queued') return;
		const busy = this.ctx.db
			.select({ id: releaseCommandRuns.id, nodeId: releaseCommandRuns.nodeId })
			.from(releaseCommandRuns)
			.where(and(eq(releaseCommandRuns.workloadId, row.workloadId), inArray(releaseCommandRuns.status, LIVE)))
			.all()
			.some((other) => other.id !== row.id && other.nodeId !== null);
		if (busy) return;
		const nodeId = this.pickNode(row.workloadId, now);
		if (!nodeId) return;
		const changed = this.ctx.db
			.update(releaseCommandRuns)
			.set({ nodeId, startBy: now + RELEASE_START_WINDOW_MS, updatedAt: now })
			.where(and(eq(releaseCommandRuns.id, row.id), eq(releaseCommandRuns.status, 'queued'), isNull(releaseCommandRuns.nodeId)))
			.returning({ id: releaseCommandRuns.id })
			.all();
		if (changed.length > 0) this.ctx.projects.bump(row.orgId);
	}

	private pickNode(workloadId: string, now: number): string | null {
		const workload = this.ctx.db.select().from(workloads).where(eq(workloads.id, workloadId)).get();
		if (!workload) return null;
		const copies = this.ctx.db
			.select({ nodeId: workloadReplicas.nodeId })
			.from(workloadReplicas)
			.where(eq(workloadReplicas.workloadId, workloadId))
			.orderBy(workloadReplicas.replicaIndex)
			.all()
			.map((copy) => copy.nodeId);
		const preferred = [...new Set([...(workload.nodeId ? [workload.nodeId] : []), ...copies])];
		if (preferred.length === 0) return null;
		const rows = this.ctx.db.select().from(nodes).where(inArray(nodes.id, preferred)).all();
		for (const nodeId of preferred) {
			const node = rows.find((row) => row.id === nodeId);
			if (!node || node.status !== 'online') continue;
			if (node.lastHeartbeatAt === null || now - node.lastHeartbeatAt >= OFFLINE_AFTER_MS) continue;
			if (!nodeHasCapability(node, RELEASE_PHASE_CAPABILITY)) continue;
			return node.id;
		}
		return null;
	}

	private finish(row: RunRow, status: ReleaseCommandRunStatus, finishedAt: number, exitCode: number | null, error: string | null, startedAt?: number | null): void {
		const now = this.ctx.now();
		this.ctx.db
			.update(releaseCommandRuns)
			.set({
				status,
				finishedAt,
				exitCode,
				error: error?.slice(0, 2_000) ?? null,
				...(startedAt !== undefined && startedAt !== null && row.startedAt === null ? { startedAt } : {}),
				updatedAt: now,
			})
			.where(and(eq(releaseCommandRuns.id, row.id), inArray(releaseCommandRuns.status, LIVE)))
			.run();
		// The node drops the task from its desired state now, and the rollout reads the gate next tick.
		if (row.nodeId) this.ctx.projects.bump(row.orgId);
		const project = this.ctx.db.select({ slug: projects.slug }).from(projects).where(eq(projects.id, row.projectId)).get();
		this.ctx.audit.record({
			principal: { kind: 'system', userId: 'system:release', orgId: row.orgId, role: 'owner', permissions: new Set() } as unknown as Principal,
			action: 'deployment.release_command',
			resource: 'deployment',
			resourceId: row.releaseId,
			args: { project: project?.slug ?? row.projectId, run: row.id, attempt: row.attempt, status, exitCode },
			result: status === 'succeeded' ? 'ok' : 'error',
		});
	}

	private nodeName(nodeId: string): string {
		return this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).get()?.name ?? nodeId;
	}
}
