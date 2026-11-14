/**
 * Words and colours for fleet node updates (docs/CLUSTERING.md §3.11, D217), shared by the active
 * rollout panel, the recent list and the Update fleet dialog.
 */
import type {
	NodeRolloutNodeState,
	NodeRolloutPhase,
	NodeRolloutStatus,
	NodeRolloutStrategy,
	NodeRolloutView
} from '@yoal/contracts';
import type { Tone } from '#lib/status.js';

export const strategyCopy: Record<NodeRolloutStrategy, { label: string; summary: string }> = {
	availability: {
		label: 'Availability',
		summary:
			'A canary, then the largest waves that never take every ingress node, control node, copy of a workload or database with its replicas at once. At most half the fleet per wave.'
	},
	rolling: {
		label: 'Rolling',
		summary: 'A fixed number of nodes at a time, after a canary when the batch is bigger than one.'
	},
	parallel: {
		label: 'Parallel',
		summary:
			'Every node in one wave. Fastest; redundant groups go down together, so use it for a small fleet or a maintenance window.'
	}
};

export const statusTone: Record<NodeRolloutStatus, Tone> = {
	running: 'info',
	paused: 'warning',
	succeeded: 'success',
	failed: 'danger',
	cancelled: 'neutral'
};

export const nodeStateTone: Record<NodeRolloutNodeState, Tone> = {
	pending: 'neutral',
	draining: 'warning',
	updating: 'info',
	verifying: 'info',
	done: 'success',
	failed: 'danger',
	skipped: 'neutral'
};

export const phaseLabel: Record<NodeRolloutPhase, string> = {
	starting: 'Starting',
	blocked: 'Waiting for a group',
	draining: 'Draining',
	updating: 'Updating',
	soaking: 'Soaking',
	paused: 'Paused',
	done: 'Done'
};

/** Node states that mean the rollout is working on the node right now. */
export const busyStates: ReadonlySet<NodeRolloutNodeState> = new Set([
	'draining',
	'updating',
	'verifying'
]);

/** The rollout's nodes grouped by wave, in wave order. */
export function wavesOf(
	rollout: NodeRolloutView
): Array<{ index: number; nodes: NodeRolloutView['nodes'] }> {
	const byWave = new Map<number, NodeRolloutView['nodes']>();
	for (const node of rollout.nodes) byWave.set(node.wave, [...(byWave.get(node.wave) ?? []), node]);
	return [...byWave.entries()]
		.sort(([a], [b]) => a - b)
		.map(([index, nodes]) => ({ index, nodes }));
}

/** Nodes the rollout has finished with, either way. */
export function settledCount(rollout: NodeRolloutView): number {
	return rollout.counts.done + rollout.counts.failed + rollout.counts.skipped;
}

/** The form fields / query parameters for a rollout plan or start. */
export interface RolloutChoice {
	strategy: NodeRolloutStrategy;
	batchSize: number;
	drain: boolean;
	canary: boolean;
	soakSeconds: number;
	maxFailures: number;
}

export function rolloutParams(choice: RolloutChoice): URLSearchParams {
	const params = new URLSearchParams({
		strategy: choice.strategy,
		drain: String(choice.drain),
		canary: String(choice.canary),
		soakSeconds: String(choice.soakSeconds),
		maxFailures: String(choice.maxFailures)
	});
	// Only `rolling` reads the batch size; leave it out so a stray value cannot fail the others.
	if (choice.strategy === 'rolling') params.set('batchSize', String(choice.batchSize));
	return params;
}
