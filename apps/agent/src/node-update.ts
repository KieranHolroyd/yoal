import { readFile } from 'node:fs/promises';
import { compareSemver, parseSemver, type DesiredState, type NodeUpdateTask } from '@yoal/contracts';
import { atomicWriteFile } from './state.ts';

/**
 * Applies `nodeUpdate` from desired state (D99). The agent cannot replace its own binary (its
 * sandbox makes /opt read-only and it is not root), so it hands the version to the helper's fixed
 * `node/update` verb, which verifies the signed release, swaps both binaries and restarts the
 * services. Success needs no report: the restarted agent's heartbeat carries the new version.
 *
 * Each generation is attempted once. The attempt is written to disk before the helper is called,
 * so an agent restarted mid-update (or one that came back on the old version) reports a failure
 * instead of retrying in a loop. Retrying is an operator decision: a new generation.
 *
 * The helper arms a rollback guard before it swaps the binaries: unless the new agent confirms
 * within ten minutes, a systemd timer restores the previous pair. The new agent confirms once the
 * control plane accepted its first heartbeat, which proves the agent starts, reaches the control
 * plane and (by answering the confirm) that the new helper serves its socket.
 */

/** What the helper's guard verb reports after a rollback (see the helper's node-update.ts). */
export interface HelperNodeUpdateRollback {
	from: string;
	to: string;
	afterSeconds: number;
	rolledBackAt: string;
}

export interface HelperNodeUpdateApi {
	updateNode(input: { version: string; repo: string }, signal?: AbortSignal): Promise<{ version: string }>;
	/** Disarm the rollback guard for `version`; `false` when none is armed (or the helper predates it). */
	confirmNodeUpdate(version: string, signal?: AbortSignal): Promise<{ confirmed: boolean }>;
	/** The last rollback the guard performed, or null (also from a helper without the guard). */
	nodeUpdateRollback(signal?: AbortSignal): Promise<HelperNodeUpdateRollback | null>;
}

export interface NodeUpdateResult {
	generation: number;
	error: string;
}

interface Attempt {
	generation: number;
	/** The target release; lets the restarted agent recognise its own install. */
	version?: string;
	/** When the helper reported the install; the restart follows within seconds. */
	installedAt?: number;
	/** The new agent told the helper it is healthy, which disarmed the rollback guard. */
	confirmed?: boolean;
	error?: string;
	reported?: boolean;
}

export interface NodeUpdateRunnerOptions {
	helper: HelperNodeUpdateApi;
	/** This binary's version (embedded at build time). */
	currentVersion: string;
	/** `${dataDir}/node-update.json`. */
	statePath: string;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	now?: () => number;
	/** How long after a successful install to wait for the restart before calling it a failure. */
	restartGraceMs?: number;
}

export class NodeUpdateRunner {
	private readonly log: NonNullable<NodeUpdateRunnerOptions['log']>;
	private readonly now: () => number;
	private readonly restartGraceMs: number;
	private pending: NodeUpdateResult | null = null;
	private running = false;
	/** Set once there is nothing (more) to confirm, so later heartbeats skip the disk read. */
	private confirmSettled = false;
	private confirmFailureLogged = false;

	constructor(private readonly options: NodeUpdateRunnerOptions) {
		this.log = options.log ?? (() => undefined);
		this.now = options.now ?? Date.now;
		this.restartGraceMs = options.restartGraceMs ?? 120_000;
	}

	pendingResult(): NodeUpdateResult | null {
		return this.pending;
	}

	/** After the control plane accepted a heartbeat carrying `result`. */
	async acknowledge(result: NodeUpdateResult | null): Promise<void> {
		if (!result || this.pending !== result) return;
		this.pending = null;
		const attempt = await this.read();
		if (attempt?.generation === result.generation) await this.write({ ...attempt, reported: true });
	}

	/**
	 * After the control plane accepted a heartbeat: if this binary is the release the last attempt
	 * installed, tell the helper so its rollback guard stands down. Once per install; a failed call
	 * (including a 404 from a helper process that has not restarted into the new release yet) is
	 * retried on the next heartbeat, and if it never succeeds the guard rolls the node back, which is
	 * right: a helper that cannot answer is not healthy. Never throws into the heartbeat.
	 */
	async confirmHealthy(signal?: AbortSignal): Promise<void> {
		if (this.confirmSettled) return;
		try {
			await this.confirmOnce(signal);
		} catch (error) {
			if (signal?.aborted || this.confirmFailureLogged) return;
			this.confirmFailureLogged = true;
			const message = error instanceof Error ? error.message : String(error);
			this.log('warn', `Could not confirm this release to the helper yet (retrying each heartbeat): ${message}`);
		}
	}

	private async confirmOnce(signal?: AbortSignal): Promise<void> {
		const attempt = await this.read();
		if (
			!attempt ||
			attempt.installedAt === undefined ||
			attempt.version !== this.options.currentVersion ||
			attempt.confirmed
		) {
			this.confirmSettled = true;
			return;
		}
		const { confirmed } = await this.options.helper.confirmNodeUpdate(attempt.version, signal);
		await this.write({ ...attempt, confirmed: true });
		this.confirmSettled = true;
		this.log(
			'info',
			confirmed
				? `Confirmed ${attempt.version} to the helper; its rollback guard is disarmed`
				: `Running ${attempt.version}; the helper had no rollback guard armed for it`,
		);
	}

	async runOnce(state: DesiredState, signal?: AbortSignal): Promise<void> {
		const task = state.nodeUpdate;
		if (!task || this.running) return;
		const current = parseSemver(this.options.currentVersion);
		// Already there (the control plane settles it from the heartbeat), or nothing to compare.
		if (!current || compareSemver(current, task.version) >= 0) return;

		const attempt = await this.read();
		if (attempt && attempt.generation >= task.generation) {
			await this.reportStale(task, attempt, signal);
			return;
		}
		this.running = true;
		try {
			await this.write({ generation: task.generation, version: task.version });
			this.log('info', `Updating this node from ${current.version} to ${task.version} (signed release from ${task.repo})`);
			await this.options.helper.updateNode({ version: task.version, repo: task.repo }, signal);
			await this.write({ generation: task.generation, version: task.version, installedAt: this.now() });
			this.log('info', `The helper installed ${task.version}; the agent restarts now`);
		} catch (error) {
			if (signal?.aborted) return;
			const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
			this.log('warn', `Node update to ${task.version} failed: ${message}`);
			await this.write({ generation: task.generation, error: message });
			this.pending = { generation: task.generation, error: message };
		} finally {
			this.running = false;
		}
	}

	/** An attempted generation that never produced the new version: report it once. */
	private async reportStale(task: NodeUpdateTask, attempt: Attempt, signal?: AbortSignal): Promise<void> {
		if (attempt.reported || this.pending?.generation === task.generation) return;
		if (attempt.installedAt !== undefined && this.now() - attempt.installedAt < this.restartGraceMs) return;
		let error = attempt.error;
		if (!error && attempt.installedAt !== undefined) {
			// The guard's marker says why we run the old version; old helpers lack the verb.
			const rollback = await this.options.helper.nodeUpdateRollback(signal).catch(() => null);
			error =
				rollback && rollback.from === task.version
					? `${task.version} was installed but did not confirm a healthy heartbeat within ${describeSeconds(rollback.afterSeconds)}, so the node rolled back to ${rollback.to}.`
					: `${task.version} was installed, but the agent still runs ${this.options.currentVersion} after a restart. Check that yoal-agent.service runs the binary the helper replaced.`;
		}
		error ??= `The update to ${task.version} was interrupted (the agent restarted before the helper answered). Retry it from the node list.`;
		if (this.pending?.generation === task.generation) return;
		this.pending = { generation: task.generation, error };
	}

	private async read(): Promise<Attempt | null> {
		try {
			const value = JSON.parse(await readFile(this.options.statePath, 'utf8')) as Attempt;
			return Number.isInteger(value?.generation) ? value : null;
		} catch {
			return null;
		}
	}

	private async write(attempt: Attempt): Promise<void> {
		await atomicWriteFile(this.options.statePath, `${JSON.stringify(attempt)}\n`);
	}
}

/** `600` → `10 minutes`, `90` → `90 seconds`. */
function describeSeconds(seconds: number): string {
	if (seconds >= 120 && seconds % 60 === 0) return `${seconds / 60} minutes`;
	return `${seconds} seconds`;
}
