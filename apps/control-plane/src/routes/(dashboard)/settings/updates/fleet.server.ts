import {
	compareSemver,
	isActiveRollout,
	parseSemver,
	type NodeRolloutView,
	type Principal
} from '@yoal/contracts';
import type { NodeView } from '@yoal/core';
import { core } from '#lib/server/core.js';
import type { FleetNode, FleetNodeState, FleetView } from './fleet-ui.js';

/**
 * The fleet half of the updates page: every node against the control plane's release, plus the
 * running rollout and the last few (CLUSTERING §3.11). Built for the page load and re-read by
 * `./fleet` while the page is open, so a rollout is followed without reloading the whole page.
 */
export function fleetView(principal: Principal): FleetView {
	const targetVersion = parseSemver(core.ctx.config.desiredAgentVersion)?.version ?? null;
	const defaults = core.cluster.get().updates;
	const counts: FleetView['counts'] = { current: 0, behind: 0, manual: 0, updating: 0, failed: 0 };
	const empty: FleetView = {
		at: Date.now(),
		readable: false,
		targetVersion,
		nodes: [],
		counts,
		active: null,
		recent: [],
		defaults,
		canUpdate: false
	};

	let rows: NodeView[];
	try {
		rows = core.nodes.list(principal);
	} catch {
		return empty;
	}

	let active: NodeRolloutView | null = null;
	let recent: NodeRolloutView[] = [];
	try {
		active = core.nodeRollouts.active(principal);
		recent = core.nodeRollouts
			.list(principal, 6)
			.filter((rollout) => !isActiveRollout(rollout.status))
			.slice(0, 5);
	} catch {
		// A role that can list nodes but not read rollouts still sees the versions.
	}

	const target = parseSemver(targetVersion);
	const nodes = rows.map((node): FleetNode => {
		const state = nodeState(node, target);
		counts[state] += 1;
		return {
			id: node.id,
			name: node.name,
			status: node.status,
			zone: node.zone,
			roles: node.roles,
			version: node.agentVersion ?? node.version,
			state,
			guarded: node.capabilities.includes('node-update-guard'),
			error: node.update?.status === 'failed' ? node.update.error : null,
			lastHeartbeatAt: node.lastHeartbeatAt
		};
	});

	return {
		...empty,
		readable: true,
		nodes,
		active,
		recent,
		canUpdate: core.ctx.platformIam.allows(principal, 'platform:updates')
	};
}

/** Same rule as the node list: a pending request wins, then the version, then a reported failure. */
function nodeState(node: NodeView, target: ReturnType<typeof parseSemver>): FleetNodeState {
	if (node.update?.status === 'pending') return 'updating';
	const running = parseSemver(node.agentVersion);
	if (!target || (running && compareSemver(running, target) >= 0)) return 'current';
	if (node.update?.status === 'failed') return 'failed';
	return node.capabilities.includes('node-update') ? 'behind' : 'manual';
}
