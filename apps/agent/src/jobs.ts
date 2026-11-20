import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import {
	agentJobHeartbeatResponseSchema,
	agentJobLeaseSchema,
	jobLimits,
	levelForPriority,
	parseLogLine,
	parseWorkloadReplicaId,
	type AgentJobLease,
	type AgentJobResult,
	type AgentJobRun,
	type DesiredState,
	type ReleaseCommandResult,
	type ReleaseCommandTask,
	type ReleaseSpec,
	type RuntimeLogBatch,
	type WorkloadActivation,
	type WorkloadDesired,
} from '@yoal/contracts';
import type { HelperLogResult, LogReadOptions } from './helper-client.ts';

/**
 * Job runs (plan 09): the agent's half of app cron jobs and one-off commands.
 *
 * The control plane queues runs bound to this node. This runner leases them (a long-poll while it
 * holds nothing), fetches the app's activation and asks the helper to start each one as a
 * transient unit. While runs are held it polls their status every couple of seconds, drains their
 * output to `/api/agent/logs` tagged with the run id, and heartbeats every `heartbeatSeconds`;
 * the heartbeat's answer names runs to stop (cancelled or replaced). A run that outlives its
 * timeout plus a grace period is stopped here too, in case `RuntimeMaxSec` did not fire. On exit
 * it reports the outcome, then removes the unit and its files.
 *
 * Held runs, their log cursors and unsent results are persisted in `jobs-state.json`, so an agent
 * restart picks up where it left off instead of losing a run or reporting it twice.
 */

export interface HelperJobStatus {
	runId: string;
	outcome: 'running' | 'succeeded' | 'failed' | 'timeout' | 'killed' | 'not-found';
	exitCode: number | null;
	signal: number | null;
	startedAt: number | null;
	finishedAt: number | null;
}

export interface HelperJobApi {
	startJob(input: {
		run: { runId: string; command: string[]; timeoutSeconds: number };
		workload: WorkloadDesired;
		activation: WorkloadActivation;
		/** HA-PLAN H25: a release command may run before any copy of the app exists. */
		release?: boolean;
	}): Promise<HelperJobStatus>;
	jobStatus(runId: string, timeoutSeconds?: number): Promise<HelperJobStatus>;
	jobLogs(runId: string, options?: LogReadOptions): Promise<HelperLogResult>;
	stopJob(runId: string, force?: boolean): Promise<void>;
	removeJob(runId: string): Promise<void>;
}

export interface JobRunnerOptions {
	controlUrl: string;
	nodeToken: string;
	helper: HelperJobApi;
	fetchActivation: (id: string, signal: AbortSignal) => Promise<WorkloadActivation>;
	/** `<dataDir>/jobs-state.json`; null keeps state in memory (tests). */
	statePath: string | null;
	fetch?: typeof fetch;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	now?: () => number;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	/** Seconds the control plane holds an empty lease open. */
	leaseWaitSeconds?: number;
	/** How often held runs are polled. */
	pollMs?: number;
}

/** One run this node holds. */
export interface HeldRun {
	runId: string;
	workloadId: string;
	command: string[];
	timeoutSeconds: number;
	/** Agent clock when the helper accepted it. */
	startedAt: number | null;
	cursor: string | null;
	/** Why the agent asked the unit to stop, and when (escalates to SIGKILL after the grace). */
	stop: { reason: 'cancel' | 'timeout'; at: number; forced: boolean } | null;
	/** The outcome, kept until the control plane has it. */
	result: AgentJobResult | null;
}

interface StateFile {
	version: 1;
	runs: HeldRun[];
}

const IDLE_POLL_MS = 5_000;
const POLL_MS = 2_000;
const ERROR_BACKOFF_MAX_MS = 30_000;
const LINES_PER_READ = 500;
const LINES_PER_POST = 400;
/** systemd's stop timeout on the helper side; SIGKILL follows if the run is still there. */
const STOP_GRACE_MS = 30_000;
/** systemd's exit statuses for a command that never ran (`systemd.exec(5)`, 200–243). */
const EXEC_STATUS: Record<number, string> = {
	200: 'the working directory could not be entered (CHDIR)',
	203: 'the program was not found or could not be executed (EXEC); is it on PATH or in the release?',
	217: 'the dynamic user could not be set up (USER)',
	226: 'the sandbox could not be set up (NAMESPACE)',
	243: 'a credential could not be loaded (CREDENTIALS)',
};

export class JobRunner {
	private readonly controlUrl: string;
	private readonly doFetch: typeof fetch;
	private readonly doSleep: (ms: number, signal: AbortSignal) => Promise<void>;
	private readonly now: () => number;
	private readonly log: NonNullable<JobRunnerOptions['log']>;
	private readonly leaseWaitSeconds: number;
	private readonly pollMs: number;
	private readonly held = new Map<string, HeldRun>();
	private loaded = false;
	private lastHeartbeat = Number.NEGATIVE_INFINITY;
	private controlPlaneHasJobs = true;

	constructor(private readonly options: JobRunnerOptions) {
		this.controlUrl = options.controlUrl.replace(/\/$/, '');
		this.doFetch = options.fetch ?? fetch;
		this.doSleep = options.sleep ?? sleep;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => undefined);
		this.leaseWaitSeconds = options.leaseWaitSeconds ?? 20;
		this.pollMs = options.pollMs ?? POLL_MS;
	}

	/** Runs this node holds right now (tests and `/healthz`). */
	heldRuns(): HeldRun[] {
		return [...this.held.values()];
	}

	/** Lease, start, watch and report until shutdown. Never throws. */
	async run(getState: () => DesiredState | null, signal: AbortSignal): Promise<void> {
		let failures = 0;
		while (!signal.aborted) {
			let wait = IDLE_POLL_MS;
			try {
				const state = getState();
				const workloads = jobWorkloads(state);
				await this.tick(workloads, signal);
				// Held runs are polled; with nothing held the lease itself long-polls.
				wait = this.held.size > 0 ? this.pollMs : workloads.size > 0 && this.controlPlaneHasJobs ? 0 : IDLE_POLL_MS;
				failures = 0;
			} catch (error) {
				if (signal.aborted) break;
				failures += 1;
				wait = Math.min(1000 * 2 ** failures, ERROR_BACKOFF_MAX_MS);
				this.log('warn', `Jobs failed: ${errorText(error)}`);
			}
			if (wait > 0) await this.doSleep(wait, signal).catch(() => undefined);
		}
	}

	/** One round: lease new runs, watch held ones, heartbeat when due. */
	async tick(workloads: Map<string, WorkloadDesired>, signal: AbortSignal): Promise<void> {
		await this.load();
		if (workloads.size > 0 && this.held.size < jobLimits.concurrentPerNode) {
			const lease = await this.lease(this.held.size > 0 ? 0 : this.leaseWaitSeconds, signal);
			for (const run of lease.runs) await this.start(run, workloads, signal);
		}
		if (this.held.size === 0) return;
		if (this.now() - this.lastHeartbeat >= jobLimits.heartbeatSeconds * 1000) await this.heartbeat(signal);
		for (const run of [...this.held.values()]) await this.watch(run, signal);
	}

	// ---------------------------------------------------------------- lifecycle

	private async start(run: AgentJobRun, workloads: Map<string, WorkloadDesired>, signal: AbortSignal): Promise<void> {
		if (this.held.has(run.runId)) return;
		const held: HeldRun = {
			runId: run.runId,
			workloadId: run.workloadId,
			command: run.command,
			timeoutSeconds: run.timeoutSeconds,
			startedAt: null,
			cursor: null,
			stop: null,
			result: null,
		};
		this.held.set(run.runId, held);
		const workload = workloads.get(run.workloadId);
		try {
			if (!workload) throw new Error('The app is not running on this node any more.');
			const activation = await this.options.fetchActivation(workload.id, signal);
			await this.options.helper.startJob({
				run: { runId: run.runId, command: run.command, timeoutSeconds: run.timeoutSeconds },
				workload,
				activation,
			});
			held.startedAt = this.now();
			this.log('info', `Job run ${run.runId} started for ${workload.projectSlug}`);
		} catch (error) {
			held.result = { runId: run.runId, status: 'failed', exitCode: null, startedAt: null, finishedAt: this.now(), error: `Could not start: ${errorText(error)}`.slice(0, 2000) };
		}
		await this.persist();
	}

	private async watch(run: HeldRun, signal: AbortSignal): Promise<void> {
		if (!run.result) {
			let status: HelperJobStatus;
			try {
				status = await this.options.helper.jobStatus(run.runId, run.timeoutSeconds);
			} catch (error) {
				this.log('warn', `Job run ${run.runId}: status failed: ${errorText(error)}`);
				return;
			}
			await this.drain(run, signal).catch((error: unknown) => this.log('warn', `Job run ${run.runId}: log drain failed: ${errorText(error)}`));
			if (status.outcome === 'running') {
				await this.enforce(run);
				return;
			}
			run.result = this.resultFor(run, status);
			await this.persist();
		}
		if (!(await this.report(run.result, signal))) return;
		await this.options.helper.removeJob(run.runId).catch((error: unknown) => this.log('warn', `Job run ${run.runId}: cleanup failed: ${errorText(error)}`));
		this.held.delete(run.runId);
		await this.persist();
	}

	/** The agent's own timeout (in case `RuntimeMaxSec` did not fire) and SIGKILL escalation. */
	private async enforce(run: HeldRun): Promise<void> {
		const now = this.now();
		if (!run.stop && run.startedAt !== null && now - run.startedAt > (run.timeoutSeconds + jobLimits.timeoutGraceSeconds) * 1000)
			await this.requestStop(run, 'timeout');
		else if (run.stop && !run.stop.forced && now - run.stop.at > STOP_GRACE_MS) {
			await this.options.helper.stopJob(run.runId, true).catch(() => undefined);
			run.stop.forced = true;
			await this.persist();
		}
	}

	private async requestStop(run: HeldRun, reason: 'cancel' | 'timeout'): Promise<void> {
		if (run.stop) return;
		run.stop = { reason, at: this.now(), forced: false };
		await this.persist();
		await this.options.helper.stopJob(run.runId).catch((error: unknown) => this.log('warn', `Job run ${run.runId}: stop failed: ${errorText(error)}`));
	}

	/** Map the helper's reading (and why the agent stopped it) onto the wire statuses. */
	resultFor(run: HeldRun, status: HelperJobStatus): AgentJobResult {
		const base = { runId: run.runId, exitCode: status.exitCode, startedAt: status.startedAt ?? run.startedAt, finishedAt: status.finishedAt ?? this.now() };
		const stopped = run.stop?.reason;
		if (status.outcome === 'succeeded') return { ...base, status: 'succeeded', error: null };
		if (stopped === 'cancel') return { ...base, status: 'cancelled', error: 'Cancelled.' };
		if (status.outcome === 'timeout' || stopped === 'timeout')
			return { ...base, status: 'timeout', error: `Timed out after ${run.timeoutSeconds} s.` };
		if (status.outcome === 'not-found')
			return { ...base, status: 'failed', error: 'The run’s unit is gone from this node (was the node restarted?).' };
		if (status.outcome === 'killed') return { ...base, status: 'failed', error: `Killed by signal ${status.signal ?? '?'} (out of memory?).` };
		const exec = status.exitCode !== null ? EXEC_STATUS[status.exitCode] : undefined;
		return { ...base, status: 'failed', error: exec ? `The command did not start: ${exec}` : `Exited with status ${status.exitCode ?? '?'}.` };
	}

	/** Forward new journal lines for the run, then advance its cursor. */
	private async drain(run: HeldRun, signal: AbortSignal): Promise<void> {
		for (let page = 0; page < 20; page += 1) {
			const result = await this.options.helper.jobLogs(run.runId, { ...(run.cursor ? { cursor: run.cursor } : {}), lines: LINES_PER_READ });
			if (result.entries.length === 0) return;
			const lines = result.entries.map((entry) => {
				const parsed = parseLogLine(entry.message);
				return {
					ts: parsed.ts ?? entry.ts,
					stream: (entry.priority <= 3 ? 'stderr' : 'stdout') as 'stdout' | 'stderr',
					level: parsed.level ?? levelForPriority(entry.priority),
					message: parsed.message,
				};
			});
			for (let index = 0; index < lines.length; index += LINES_PER_POST) {
				const batch: RuntimeLogBatch = { workloadId: run.workloadId, jobRunId: run.runId, lines: lines.slice(index, index + LINES_PER_POST) };
				await this.post('/api/agent/logs', batch, signal);
			}
			run.cursor = result.nextCursor ?? run.cursor;
			await this.persist();
			if (result.entries.length < LINES_PER_READ) return;
		}
	}

	// ---------------------------------------------------------------- protocol

	private async lease(waitSeconds: number, signal: AbortSignal): Promise<AgentJobLease> {
		const response = await this.doFetch(`${this.controlUrl}/api/agent/jobs/lease?wait=${waitSeconds}`, {
			method: 'POST',
			headers: this.headers(),
			body: '{}',
			signal: AbortSignal.any([signal, AbortSignal.timeout((waitSeconds + 15) * 1000)]),
		});
		if (response.status === 404) {
			// A control plane that predates jobs: nothing will ever be queued, so ask rarely.
			this.controlPlaneHasJobs = false;
			await this.doSleep(60_000, signal).catch(() => undefined);
			return { runs: [], heartbeatSeconds: jobLimits.heartbeatSeconds };
		}
		if (!response.ok) throw new Error(`jobs/lease answered ${response.status}`);
		this.controlPlaneHasJobs = true;
		return agentJobLeaseSchema.parse(await response.json());
	}

	private async heartbeat(signal: AbortSignal): Promise<void> {
		const running = [...this.held.values()].filter((run) => !run.result);
		this.lastHeartbeat = this.now();
		if (running.length === 0) return;
		const response = await this.doFetch(`${this.controlUrl}/api/agent/jobs/heartbeat`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({ runIds: running.map((run) => run.runId) }),
			signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
		});
		if (!response.ok) throw new Error(`jobs/heartbeat answered ${response.status}`);
		const { stop } = agentJobHeartbeatResponseSchema.parse(await response.json());
		for (const runId of stop) {
			const run = this.held.get(runId);
			if (run && !run.result) await this.requestStop(run, 'cancel');
		}
	}

	/** True once the control plane has the result. */
	private async report(result: AgentJobResult, signal: AbortSignal): Promise<boolean> {
		try {
			await this.post('/api/agent/jobs/result', result, signal);
			return true;
		} catch (error) {
			this.log('warn', `Job run ${result.runId}: report failed, will retry: ${errorText(error)}`);
			return false;
		}
	}

	private async post(path: string, body: unknown, signal: AbortSignal): Promise<void> {
		const response = await this.doFetch(`${this.controlUrl}${path}`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify(body),
			signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`${path} answered ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
		}
	}

	private headers(): Record<string, string> {
		return { authorization: `Bearer ${this.options.nodeToken}`, 'content-type': 'application/json' };
	}

	// ---------------------------------------------------------------- state

	private async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		if (!this.options.statePath) return;
		let text: string;
		try {
			text = await fs.readFile(this.options.statePath, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') this.log('warn', `Job state is unreadable (${errorText(error)}); starting fresh`);
			return;
		}
		try {
			const parsed = JSON.parse(text) as Partial<StateFile>;
			for (const run of parsed.runs ?? []) {
				if (typeof run?.runId !== 'string' || typeof run.workloadId !== 'string' || !Array.isArray(run.command)) continue;
				this.held.set(run.runId, {
					runId: run.runId,
					workloadId: run.workloadId,
					command: run.command,
					timeoutSeconds: Number(run.timeoutSeconds) || jobLimits.maxTimeoutSeconds,
					startedAt: typeof run.startedAt === 'number' ? run.startedAt : null,
					cursor: typeof run.cursor === 'string' ? run.cursor : null,
					stop: run.stop ?? null,
					result: run.result ?? null,
				});
			}
			if (this.held.size > 0) this.log('info', `Resuming ${this.held.size} job run(s) from ${this.options.statePath}`);
		} catch (error) {
			this.log('warn', `Job state is invalid (${errorText(error)}); starting fresh`);
		}
	}

	private async persist(): Promise<void> {
		const path = this.options.statePath;
		if (!path) return;
		const body: StateFile = { version: 1, runs: [...this.held.values()] };
		const temp = `${path}.tmp`;
		await fs.mkdir(dirname(path), { recursive: true });
		await fs.writeFile(temp, JSON.stringify(body), { mode: 0o600 });
		await fs.rename(temp, path);
	}
}

/** App workloads on this node that can run jobs, by desired-state id. */
export function jobWorkloads(state: DesiredState | null): Map<string, WorkloadDesired> {
	const out = new Map<string, WorkloadDesired>();
	for (const workload of state?.workloads ?? []) {
		if (workload.runtime !== 'process' && workload.runtime !== 'container') continue;
		if (workload.database || workload.objectStorage || workload.broker || workload.runner || workload.function) continue;
		out.set(workload.id, workload);
	}
	return out;
}

// -------------------------------------------------------------------- release commands

/** What `ReleaseCommandRunner` needs from the agent's release cache. */
export interface ReleaseCache {
	ensureRelease(spec: ReleaseSpec, signal?: AbortSignal): Promise<boolean>;
	hasRelease(sha256: string): Promise<boolean>;
}

export interface ReleaseCommandRunnerOptions {
	helper: HelperJobApi;
	releases: ReleaseCache;
	fetchActivation: (id: string, signal: AbortSignal) => Promise<WorkloadActivation>;
	/** `<dataDir>/release-commands-state.json`; null keeps state in memory (tests). */
	statePath: string | null;
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	/** How often held runs are polled (default 2 s). */
	pollMs?: number;
	/** How often desired state is checked with nothing to run (default 5 s). */
	idleMs?: number;
}

/** One release-command run this node holds, started or refused. */
interface HeldReleaseCommand {
	runId: string;
	releaseId: string;
	workloadId: string;
	/** The helper's transient unit id: `jr_<the run id's 32 hex characters>`. */
	helperRunId: string;
	timeoutSeconds: number;
	/** Agent clock when the helper accepted it; null for a refusal or a start still in progress. */
	startedAt: number | null;
	stop: { at: number; forced: boolean } | null;
	result: ReleaseCommandResult | null;
}

interface ReleaseCommandsStateFile {
	version: 1;
	/** Every run id this node has ever started or refused, so a replayed desired state cannot run it again (I16). */
	seen: string[];
	runs: HeldReleaseCommand[];
}

/** systemd's SIGTERM→SIGKILL grace, the same as jobs. */
const RELEASE_STOP_GRACE_MS = 30_000;

/**
 * Release commands (HA-PLAN H25, I16): a command from desired state (`releaseCommands`) that must
 * run at most once per release before its copies roll.
 *
 * Rules this runner enforces on the node, whatever the control plane is doing:
 * - **Start deadline.** A task not started before `startBy` is refused and reported failed; the
 *   control plane re-leases a new attempt. The refusal is persisted, so a clock that moves back
 *   cannot start it later.
 * - **At most once.** Every `runId` this process has started or refused is persisted before the
 *   helper is asked to start it. A replayed desired state, an agent restart or a partition that
 *   swallows a heartbeat never runs it a second time.
 * - **Self-kill.** The run's timeout is enforced here, not by the control plane: with no contact
 *   for the whole run, the helper unit is stopped (then SIGKILLed after the grace).
 * - **Lease loss.** A run whose task disappears from desired state is stopped rather than being
 *   left to finish on a node that no longer holds it.
 *
 * It reuses the job path (`helper.startJob`), so the command runs in the app's sandbox, identity,
 * environment and volumes, never as the agent. Results ride the next heartbeat's
 * `releaseCommandResults`; they are re-sent until the control plane drops the task.
 */
export class ReleaseCommandRunner {
	private readonly now: () => number;
	private readonly doSleep: (ms: number, signal: AbortSignal) => Promise<void>;
	private readonly log: NonNullable<ReleaseCommandRunnerOptions['log']>;
	private readonly pollMs: number;
	private readonly idleMs: number;
	private readonly seen = new Set<string>();
	private readonly runs = new Map<string, HeldReleaseCommand>();
	private loaded = false;
	private dirty = false;

	constructor(private readonly options: ReleaseCommandRunnerOptions) {
		this.now = options.now ?? Date.now;
		this.doSleep = options.sleep ?? sleep;
		this.log = options.log ?? (() => undefined);
		this.pollMs = options.pollMs ?? POLL_MS;
		this.idleMs = options.idleMs ?? IDLE_POLL_MS;
	}

	/** Runs this node holds (tests and `/healthz`). */
	heldRuns(): HeldReleaseCommand[] {
		return [...this.runs.values()];
	}

	/** Start, watch and enforce until shutdown. Never throws. */
	async run(getState: () => DesiredState | null, signal: AbortSignal): Promise<void> {
		let failures = 0;
		while (!signal.aborted) {
			let wait = this.idleMs;
			try {
				await this.tick(getState(), signal);
				wait = this.runs.size > 0 ? this.pollMs : this.idleMs;
				failures = 0;
			} catch (error) {
				if (signal.aborted) break;
				failures += 1;
				wait = Math.min(1000 * 2 ** failures, ERROR_BACKOFF_MAX_MS);
				this.log('warn', `Release commands failed: ${errorText(error)}`);
			}
			if (wait > 0) await this.doSleep(wait, signal).catch(() => undefined);
		}
	}

	/** One round: prune acknowledged results, start new tasks, watch held ones. */
	async tick(state: DesiredState | null, signal: AbortSignal): Promise<void> {
		await this.load();
		const tasks = state?.releaseCommands ?? [];
		const live = new Set(tasks.map((task) => task.runId));

		// A finished result is kept until the control plane removes its task (proof it was applied).
		for (const run of [...this.runs.values()]) {
			if (run.result && run.result.status !== 'running' && !live.has(run.runId)) {
				this.runs.delete(run.runId);
				this.dirty = true;
			}
		}
		// A task that left desired state while running lost its lease here: stop it, never let a
		// second node's copy race this one.
		for (const run of this.runs.values()) {
			if ((!run.result || run.result.status === 'running') && !live.has(run.runId) && !run.stop) {
				await this.requestStop(run, 'lease-lost');
			}
		}

		for (const task of tasks) {
			if (signal.aborted) break;
			if (this.seen.has(task.runId)) continue;
			await this.start(task, state, signal);
		}
		for (const run of [...this.runs.values()]) {
			if (!run.result || run.result.status === 'running') await this.watch(run, signal);
		}
		if (this.dirty) await this.persist();
	}

	/** Results for the next heartbeat, for tasks still in desired state. */
	pendingResults(state: DesiredState | null): ReleaseCommandResult[] {
		const live = new Set((state?.releaseCommands ?? []).map((task) => task.runId));
		return [...this.runs.values()]
			.filter((run) => run.result && live.has(run.runId))
			.map((run) => ({ ...run.result! }))
			.sort((a, b) => a.runId.localeCompare(b.runId))
			.slice(0, 20);
	}

	private async start(task: ReleaseCommandTask, state: DesiredState | null, signal: AbortSignal): Promise<void> {
		// Persist the decision before acting, so a crash at any point can never run this id twice.
		this.seen.add(task.runId);
		this.dirty = true;
		const helperRunId = releaseHelperRunId(task.runId);
		const refused = (error: string): HeldReleaseCommand => ({
			runId: task.runId,
			releaseId: task.releaseId,
			workloadId: task.workloadId,
			helperRunId,
			timeoutSeconds: task.timeoutSeconds,
			startedAt: null,
			stop: null,
			result: {
				runId: task.runId,
				releaseId: task.releaseId,
				status: 'failed',
				exitCode: null,
				startedAt: null,
				finishedAt: this.now(),
				error: error.slice(0, 2_000),
			},
		});
		const startBy = Date.parse(task.startBy);
		if (!Number.isFinite(startBy) || this.now() >= startBy) {
			this.runs.set(task.runId, refused(`The start deadline (${task.startBy}) passed before this node could start the run.`));
			await this.persist();
			return;
		}

		const workload = releaseWorkload(state, task.workloadId);
		if (!workload) {
			this.runs.set(task.runId, refused('The app is not running on this node any more.'));
			await this.persist();
			return;
		}

		let release = workload.release;
		if (task.release) {
			release = task.release;
			try {
				if (!(await this.options.releases.hasRelease(task.release))) {
					const spec = state?.releases.find((entry) => entry.sha256 === task.release);
					if (!spec) throw new Error(`release ${task.release.slice(0, 12)} is missing from desired state`);
					await this.options.releases.ensureRelease(spec, signal);
				}
			} catch (error) {
				this.runs.set(task.runId, refused(`Could not prepare the new release: ${errorText(error)}`));
				await this.persist();
				return;
			}
		}
		// Never run a migration against the release the old copies still use: that is the failure
		// mode the release phase exists to prevent.
		if (workload.runtime === 'process' && !task.release) {
			this.runs.set(task.runId, refused('A process app’s release command needs the new release in the task.'));
			await this.persist();
			return;
		}
		if (workload.runtime === 'container' && !task.image) {
			this.runs.set(task.runId, refused('A container app’s release command needs the new image in the task.'));
			await this.persist();
			return;
		}

		const target: WorkloadDesired = {
			...workload,
			release,
			...(task.image ? { image: task.image } : {}),
		};
		const held: HeldReleaseCommand = {
			runId: task.runId,
			releaseId: task.releaseId,
			workloadId: task.workloadId,
			helperRunId,
			timeoutSeconds: task.timeoutSeconds,
			startedAt: null,
			stop: null,
			result: null,
		};
		this.runs.set(task.runId, held);
		try {
			const activation = await this.options.fetchActivation(workload.id, signal);
			// The deadline still applies after the activation fetch and release check: a slow
			// control plane must not make a stale lease look current.
			if (this.now() >= startBy) {
				held.result = {
					runId: task.runId,
					releaseId: task.releaseId,
					status: 'failed',
					exitCode: null,
					startedAt: null,
					finishedAt: this.now(),
					error: `The start deadline (${task.startBy}) passed before this node could start the run.`,
				};
				await this.persist();
				return;
			}
			await this.options.helper.startJob({
				run: { runId: helperRunId, command: task.command, timeoutSeconds: task.timeoutSeconds },
				workload: target,
				activation,
				release: true,
			});
			held.startedAt = this.now();
			held.result = {
				runId: task.runId,
				releaseId: task.releaseId,
				status: 'running',
				exitCode: null,
				startedAt: held.startedAt,
				finishedAt: null,
				error: null,
			};
			this.log('info', `Release command ${task.runId} started for ${workload.projectSlug} (${task.releaseId})`);
		} catch (error) {
			// The helper may have started the unit and lost the response. Ask it once before
			// declaring failure: a run this node did start must never be started again (I16).
			let started = false;
			try {
				const status = await this.options.helper.jobStatus(helperRunId, task.timeoutSeconds);
				if (status.outcome !== 'not-found') {
					held.startedAt = this.now();
					held.result = {
						runId: task.runId,
						releaseId: task.releaseId,
						status: 'running',
						exitCode: null,
						startedAt: held.startedAt,
						finishedAt: null,
						error: null,
					};
					started = true;
				}
			} catch {
				// Leave the failure below; the local helper is the only authority and is unreachable.
			}
			if (started) {
				this.log('info', `Release command ${task.runId} started for ${workload.projectSlug} (${task.releaseId})`);
			} else {
				held.result = {
					runId: task.runId,
					releaseId: task.releaseId,
					status: 'failed',
					exitCode: null,
					startedAt: null,
					finishedAt: this.now(),
					error: `Could not start: ${errorText(error)}`.slice(0, 2_000),
				};
			}
		}
		await this.persist();
	}

	private async watch(run: HeldReleaseCommand, signal: AbortSignal): Promise<void> {
		let status: HelperJobStatus;
		try {
			status = await this.options.helper.jobStatus(run.helperRunId, run.timeoutSeconds);
		} catch (error) {
			this.log('warn', `Release command ${run.runId}: status failed: ${errorText(error)}`);
			return;
		}
		if (status.outcome === 'running') {
			await this.enforce(run);
			return;
		}
		run.result = this.resultFor(run, status);
		await this.options.helper.removeJob(run.helperRunId).catch((error: unknown) => this.log('warn', `Release command ${run.runId}: cleanup failed: ${errorText(error)}`));
		this.dirty = true;
	}

	/** The node's own timeout, and SIGKILL after the grace, with no control plane involved. */
	private async enforce(run: HeldReleaseCommand): Promise<void> {
		const now = this.now();
		if (!run.stop && run.startedAt !== null && now - run.startedAt >= run.timeoutSeconds * 1_000) {
			await this.requestStop(run, 'timeout');
			return;
		}
		if (run.stop && !run.stop.forced && now - run.stop.at > RELEASE_STOP_GRACE_MS) {
			await this.options.helper.stopJob(run.helperRunId, true).catch(() => undefined);
			run.stop.forced = true;
			this.dirty = true;
		}
	}

	private async requestStop(run: HeldReleaseCommand, reason: 'timeout' | 'lease-lost'): Promise<void> {
		if (run.stop || (run.result && run.result.status !== 'running')) return;
		run.stop = { at: this.now(), forced: false };
		this.dirty = true;
		await this.options.helper.stopJob(run.helperRunId).catch((error: unknown) => this.log('warn', `Release command ${run.runId}: stop failed: ${errorText(error)}`));
		if (reason === 'lease-lost') {
			run.result = {
				runId: run.runId,
				releaseId: run.releaseId,
				status: 'failed',
				exitCode: null,
				startedAt: run.startedAt,
				finishedAt: this.now(),
				error: 'The release-command lease moved off this node; the run was stopped.',
			};
		}
	}

	private resultFor(run: HeldReleaseCommand, status: HelperJobStatus): ReleaseCommandResult {
		const base = {
			runId: run.runId,
			releaseId: run.releaseId,
			exitCode: status.exitCode,
			startedAt: status.startedAt ?? run.startedAt,
			finishedAt: status.finishedAt ?? this.now(),
		};
		if (status.outcome === 'succeeded') return { ...base, status: 'succeeded', error: null };
		if (status.outcome === 'timeout' || run.stop)
			return { ...base, status: 'timeout', error: `Timed out after ${run.timeoutSeconds} s.` };
		if (status.outcome === 'not-found')
			return { ...base, status: 'failed', error: 'The run’s unit is gone from this node (was the node restarted?).' };
		if (status.outcome === 'killed')
			return { ...base, status: 'failed', error: `Killed by signal ${status.signal ?? '?'} (out of memory?).` };
		const exec = status.exitCode !== null ? EXEC_STATUS[status.exitCode] : undefined;
		return { ...base, status: 'failed', error: exec ? `The command did not start: ${exec}` : `Exited with status ${status.exitCode ?? '?'}.` };
	}

	private async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		if (!this.options.statePath) return;
		let text: string;
		try {
			text = await fs.readFile(this.options.statePath, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') this.log('warn', `Release-command state is unreadable (${errorText(error)}); starting fresh`);
			return;
		}
		try {
			const parsed = JSON.parse(text) as Partial<ReleaseCommandsStateFile>;
			for (const id of parsed.seen ?? []) if (typeof id === 'string') this.seen.add(id);
			for (const run of parsed.runs ?? []) {
				if (typeof run?.runId !== 'string' || typeof run.releaseId !== 'string' || typeof run.helperRunId !== 'string') continue;
				this.runs.set(run.runId, {
					runId: run.runId,
					releaseId: run.releaseId,
					workloadId: String(run.workloadId ?? ''),
					helperRunId: run.helperRunId,
					timeoutSeconds: Number(run.timeoutSeconds) || jobLimits.maxTimeoutSeconds,
					startedAt: typeof run.startedAt === 'number' ? run.startedAt : null,
					stop: run.stop ?? null,
					result: run.result ?? null,
				});
			}
			if (this.runs.size > 0) this.log('info', `Resuming ${this.runs.size} release-command run(s) from ${this.options.statePath}`);
		} catch (error) {
			this.log('warn', `Release-command state is invalid (${errorText(error)}); starting fresh`);
		}
	}

	private async persist(): Promise<void> {
		this.dirty = false;
		const path = this.options.statePath;
		if (!path) return;
		const body: ReleaseCommandsStateFile = {
			version: 1,
			seen: [...this.seen].sort(),
			runs: [...this.runs.values()],
		};
		const temp = `${path}.tmp`;
		await fs.mkdir(dirname(path), { recursive: true });
		await fs.writeFile(temp, JSON.stringify(body), { mode: 0o600 });
		await fs.rename(temp, path);
	}
}

/** The app a release command belongs to: its exact desired-state id, else replica 0's base id. */
export function releaseWorkload(state: DesiredState | null, workloadId: string): WorkloadDesired | null {
	for (const workload of state?.workloads ?? []) {
		if (workload.id === workloadId) return workload;
	}
	for (const workload of state?.workloads ?? []) {
		if (parseWorkloadReplicaId(workload.id).workloadId === workloadId) return workload;
	}
	return null;
}

/** The helper's job run ids are `jr_`; a release command's lease id is `rc_` with the same 32 hex. */
export function releaseHelperRunId(runId: string): string {
	return `jr_${runId.slice(3)}`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}
