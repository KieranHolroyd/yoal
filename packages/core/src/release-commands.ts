import type { ReleaseCommandResult, ReleaseCommandSpec, ReleaseCommandTask, ReleaseCommandRunStatus } from '@yoal/contracts';
import type { CoreContext } from './context.ts';

/**
 * The release-command scheduler (HA-PLAN H25, I16). Owned by Wave 1 lane C; the agent side that
 * runs `releaseCommands` is lane D. Backed by `release_command_runs` (0119), whose partial unique
 * indexes are the run lease: one live attempt and at most one success per release id. Nothing
 * calls it while `RELEASE_PHASE` is off, because a spec with `release` is refused then.
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

export class ReleaseCommandScheduler {
	constructor(private readonly ctx: CoreContext) {}

	/** Queue the release command for `releaseId` (the deployment id) unless one is live or succeeded. */
	schedule(_input: { releaseId: string; orgId: string; projectId: string; workloadId: string; spec: ReleaseCommandSpec; createdBy: string | null }): ReleaseCommandRun {
		void this.ctx;
		throw new Error('not implemented (HA Wave 1 lane C): release-command scheduler');
	}

	/** Whether the rollout for `releaseId` may start (`succeeded`), must wait, or has failed. */
	gate(_releaseId: string): ReleaseGate {
		throw new Error('not implemented (HA Wave 1 lane C): release-command gate');
	}

	/** The `releaseCommands` desired-state entries for a node that advertises `release-phase`. */
	tasksForNode(_nodeId: string): ReleaseCommandTask[] {
		throw new Error('not implemented (HA Wave 1 lane C): release-command tasks');
	}

	/** Apply a heartbeat's `releaseCommandResults` from `nodeId`; results for runs it does not hold are ignored. */
	recordResults(_nodeId: string, _results: readonly ReleaseCommandResult[]): void {
		throw new Error('not implemented (HA Wave 1 lane C): release-command results');
	}
}
