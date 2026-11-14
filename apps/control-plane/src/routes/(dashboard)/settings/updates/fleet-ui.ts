import type { ClusterConfig, NodeRolloutNodeState, NodeRolloutView } from '@yoal/contracts';
import type { Tone } from '#lib/status.js';

/**
 * The fleet half of the updates page (docs/CLUSTERING.md §3.11, D217): where every node stands
 * against the control plane's release, and the rollout moving them there.
 */

/** The two steps a release takes through a cluster; also the page's two tabs. */
export type UpdateStage = 'control' | 'fleet';

/**
 * - `current`: runs the target release (or there is no release to compare against).
 * - `behind`: an older agent that a rollout can update.
 * - `manual`: an older agent from before dashboard updates; someone updates it by hand once.
 * - `updating`: an update was requested and the new version has not reported in yet.
 * - `failed`: the node reported that its last update failed.
 */
export type FleetNodeState = 'current' | 'behind' | 'manual' | 'updating' | 'failed';

export interface FleetNode {
	id: string;
	name: string;
	/** `online`, `offline`, … as the node list shows it. */
	status: string;
	zone: string;
	roles: string[];
	/** The agent version from the last heartbeat. */
	version: string | null;
	state: FleetNodeState;
	/** True when the agent arms the on-node rollback guard (`node-update-guard`). */
	guarded: boolean;
	error: string | null;
	lastHeartbeatAt: string | null;
}

export interface FleetView {
	/** When the server built this, so the page can keep the newer of load data and a poll. */
	at: number;
	/** False when this principal may not read nodes; the rest is then empty. */
	readable: boolean;
	/** The release nodes should run: the control plane's own version. Null off a release build. */
	targetVersion: string | null;
	nodes: FleetNode[];
	counts: Record<FleetNodeState, number>;
	active: NodeRolloutView | null;
	/** Finished rollouts, newest first. */
	recent: NodeRolloutView[];
	defaults: ClusterConfig['updates'];
	canUpdate: boolean;
}

export const fleetStateCopy: Record<FleetNodeState, { label: string; tone: Tone; bar: string }> = {
	current: { label: 'Up to date', tone: 'success', bar: 'bg-success' },
	updating: { label: 'Updating', tone: 'info', bar: 'bg-info' },
	behind: { label: 'Behind', tone: 'warning', bar: 'bg-warning' },
	manual: { label: 'Update by hand', tone: 'warning', bar: 'bg-warning/50' },
	failed: { label: 'Failed', tone: 'danger', bar: 'bg-destructive' }
};

/** Left to right in the distribution bar: finished first, trouble last. */
export const fleetStateOrder: FleetNodeState[] = [
	'current',
	'updating',
	'behind',
	'manual',
	'failed'
];

/** A rollout's word for a node, when the node is part of the running rollout. */
export const rolloutNodeLabel: Record<NodeRolloutNodeState, string> = {
	pending: 'Waiting for its wave',
	draining: 'Draining',
	updating: 'Installing',
	verifying: 'Verifying',
	done: 'Updated',
	failed: 'Failed',
	skipped: 'Skipped'
};

/** The one-line state of the fleet, for the stage card and the fleet headline. */
export function fleetSummary(fleet: FleetView): { tone: Tone; label: string; live: boolean } {
	if (!fleet.readable) return { tone: 'neutral', label: 'Not visible to your role', live: false };
	if (fleet.nodes.length === 0) return { tone: 'neutral', label: 'No nodes enrolled', live: false };
	if (fleet.active) {
		const wave = Math.min(fleet.active.currentWave + 1, fleet.active.waves);
		return fleet.active.status === 'paused'
			? { tone: 'warning', label: `Paused at wave ${wave} of ${fleet.active.waves}`, live: false }
			: { tone: 'info', label: `Rolling out · wave ${wave} of ${fleet.active.waves}`, live: true };
	}
	if (!fleet.targetVersion) return { tone: 'neutral', label: 'No release to install', live: false };
	if (fleet.counts.failed > 0)
		return { tone: 'danger', label: `${fleet.counts.failed} failed to update`, live: false };
	if (fleet.counts.updating > 0)
		return { tone: 'info', label: `${fleet.counts.updating} updating`, live: true };
	const behind = fleet.counts.behind + fleet.counts.manual;
	if (behind > 0) return { tone: 'warning', label: `${behind} behind`, live: false };
	return { tone: 'success', label: 'In sync', live: false };
}
