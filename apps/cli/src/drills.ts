/**
 * Node offline drills (D235): view types mirrored from `@yoal/contracts` (node-drill.ts) and the
 * CLI's formatting for `yoal ha drill`.
 */

export interface DrillEventView {
	kind: string;
	status: string;
	stage: string;
	subject: string;
	fromNode: string | null;
	toNode: string | null;
	reason: string;
	detectedAt: number;
}

export interface DrillView {
	id: string;
	nodeId: string;
	nodeName: string;
	status: 'running' | 'completed' | 'cancelled' | 'failed';
	random: boolean;
	durationSeconds: number;
	startedAt: number;
	endsAt: number;
	offlineAt: number | null;
	cancelledAt: number | null;
	restoredAt: number | null;
	finishedAt: number | null;
	message: string | null;
	createdBy: string;
	observations: {
		offlineDetectedAfterMs: number | null;
		backOnlineAfterMs: number | null;
		events: DrillEventView[];
		moreEvents: number;
	} | null;
}

export interface DrillCandidateView {
	nodeId: string;
	nodeName: string;
	eligible: boolean;
	reason: string | null;
	controlNode: boolean;
	needsControlOptIn: boolean;
}

export interface DrillListView {
	running: DrillView | null;
	recent: DrillView[];
	candidates: DrillCandidateView[];
	limits: { minSeconds: number; maxSeconds: number; defaultSeconds: number };
}

export function formatMs(value: number | null | undefined): string {
	if (value === null || value === undefined) return '—';
	const seconds = Math.round(value / 1000);
	return seconds < 120 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

/** The finished drill's report: what was measured and what the failover controller did. */
export function formatDrill(drill: DrillView): string {
	const lines = [
		`Drill ${drill.id} on ${drill.nodeName}${drill.random ? ' (picked at random)' : ''}: ${drill.status}`,
		`  planned           ${formatMs(drill.durationSeconds * 1000)} offline`,
		`  marked offline    ${drill.offlineAt === null ? '—' : `${formatMs(drill.offlineAt - drill.startedAt)} after the start`}`,
		`  back online       ${drill.observations?.backOnlineAfterMs === undefined || drill.observations?.backOnlineAfterMs === null ? '—' : `${formatMs(drill.observations.backOnlineAfterMs)} after the end`}`,
	];
	if (drill.message) lines.push(`  note              ${drill.message}`);
	const events = drill.observations?.events ?? [];
	if (events.length === 0) lines.push(drill.status === 'running' ? '  failover actions  (in progress)' : '  failover actions  none');
	else {
		lines.push('  failover actions');
		for (const event of events) {
			const path = event.fromNode || event.toNode ? ` ${event.fromNode ?? '—'} → ${event.toNode ?? '—'}` : '';
			lines.push(`    ${event.kind.padEnd(9)}${event.subject}${path}: ${event.status} (${event.stage})${event.reason ? `, ${event.reason}` : ''}`);
		}
		if (drill.observations?.moreEvents) lines.push(`    and ${drill.observations.moreEvents} more`);
	}
	return lines.join('\n');
}

export function formatDrillList(view: DrillListView): string {
	const lines: string[] = [];
	if (view.running) {
		lines.push(`Running: ${view.running.nodeName} (${view.running.id}) until ${new Date(view.running.endsAt).toISOString()}`, '');
	}
	lines.push('Nodes:');
	for (const node of view.candidates)
		lines.push(`  ${node.nodeName.padEnd(20)} ${node.eligible ? 'eligible' : `no: ${node.reason}`}${node.controlNode ? ' [control plane]' : ''}`);
	lines.push('', 'Recent drills:');
	if (view.recent.length === 0) lines.push('  none');
	for (const drill of view.recent) {
		lines.push(
			`  ${new Date(drill.startedAt).toISOString().slice(0, 16).replace('T', ' ')}  ${drill.nodeName.padEnd(16)} ${drill.status.padEnd(10)} detected ${formatMs(drill.offlineAt === null ? null : drill.offlineAt - drill.startedAt).padEnd(6)} back ${formatMs(drill.observations?.backOnlineAfterMs)}  ${drill.id}`,
		);
	}
	return lines.join('\n');
}
