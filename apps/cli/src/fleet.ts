/**
 * Fleet scheduling and links (docs/CLUSTERING.md §3.10, §4.6): wire types and the text `yoal fleet`
 * prints. Types mirror `SchedulingView` and `LinkMapView` in packages/contracts; the CLI bundle
 * stays free of runtime dependencies (D40), so keep them in sync.
 */
import { renderTable } from './output.ts';

export interface FleetMoveView {
	unitId: string;
	label: string;
	fromNodeName: string;
	toNodeName: string;
	memoryMb: number;
}

export interface FleetPlanView {
	strategy: string;
	moves: FleetMoveView[];
	gapBefore: number;
	gapAfter: number;
	summary: string;
}

export interface FleetStatusView {
	strategy: string;
	memoryOvercommitPercent: number;
	cpuOvercommitPercent: number;
	autoRebalance: boolean;
	nodes: Array<{
		id: string;
		name: string;
		zone: string;
		status: string;
		eligible: boolean;
		capacityMb: number;
		reservedMb: number;
		reservedPercent: number;
		usedMemoryMb: number | null;
		totalMemoryMb: number | null;
		cpuPercent: number | null;
		copies: number;
		movable: number;
	}>;
	units: Array<{ id: string; label: string; nodeId: string; memoryMb: number; blocker: string | null }>;
	plan: FleetPlanView;
}

export interface FleetRebalanceResult {
	applied: boolean;
	plan: FleetPlanView;
	moved: FleetMoveView[];
	skipped: Array<{ label: string; reason: string }>;
}

export interface RelocationStatusView {
	project: string;
	from: { name: string };
	to: { name: string };
	phase: string;
	active: boolean;
	detail: string | null;
	error: string | null;
	volumes: Array<{ name: string; sizeMb: number; state: string }>;
}

export function formatRelocation(view: RelocationStatusView): string {
	const lines = [`${view.project}: ${view.from.name} → ${view.to.name} (${view.phase})`];
	if (view.detail) lines.push(view.detail);
	if (view.error) lines.push(`Error: ${view.error}`);
	if (view.volumes.length > 0)
		lines.push('', renderTable(['VOLUME', 'SIZE', 'STATE'], view.volumes.map((volume) => [volume.name, `${volume.sizeMb} MB`, volume.state])));
	if (view.active) lines.push('', `The app is stopped while its data is copied. \`yoal fleet move ${view.project} --status\` shows progress; \`--cancel\` starts it again where it was.`);
	return lines.join('\n');
}

export interface FleetLinksView {
	nodes: Array<{ id: string; name: string; zone: string; privateNetwork: string | null; capable: boolean }>;
	links: Array<{
		fromNodeId: string;
		toNodeId: string;
		path: string;
		rttMs: number | null;
		lossPercent: number | null;
		test: { status: string; error: string | null; uploadBps: number | null; downloadBps: number | null; jitterMs: number | null } | null;
	}>;
	running: number;
	queued: number;
}

const bar = (percent: number, width = 20): string => {
	const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
	return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
};

/** `812 Mbit/s`, `1.4 Gbit/s`. */
export function formatBps(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return '-';
	if (value >= 1e9) return `${(value / 1e9).toFixed(2)} Gbit/s`;
	if (value >= 1e6) return `${(value / 1e6).toFixed(0)} Mbit/s`;
	return `${(value / 1e3).toFixed(0)} kbit/s`;
}

export function formatMoves(moves: FleetMoveView[]): string {
	if (moves.length === 0) return 'No moves.';
	return renderTable(
		['WORKLOAD', 'FROM', 'TO', 'MEMORY'],
		moves.map((move) => [move.label, move.fromNodeName, move.toNodeName, `${move.memoryMb} MB`]),
	);
}

export function formatFleetStatus(view: FleetStatusView, options: { pinned?: boolean } = {}): string {
	const lines = [
		`Strategy: ${view.strategy}${view.autoRebalance ? ' (automatic rebalance on)' : ''}` +
			(view.memoryOvercommitPercent > 100 ? `   Memory overcommit: ${view.memoryOvercommitPercent}%` : ''),
		'',
		renderTable(
			['NODE', 'ZONE', 'STATUS', 'RESERVED', '', 'IN USE', 'CPU', 'COPIES'],
			view.nodes.map((node) => [
				node.name,
				node.zone,
				node.eligible ? node.status : `${node.status} (no new work)`,
				`${node.reservedMb}/${node.capacityMb} MB`,
				`${bar(node.reservedPercent)} ${node.reservedPercent}%`,
				node.usedMemoryMb === null ? '-' : `${node.usedMemoryMb}/${node.totalMemoryMb ?? '?'} MB`,
				node.cpuPercent === null ? '-' : `${node.cpuPercent}%`,
				`${node.copies} (${node.movable} movable)`,
			]),
		),
		'',
		`Rebalance: ${view.plan.summary}`,
	];
	if (view.plan.moves.length > 0) lines.push('', formatMoves(view.plan.moves), '', 'Run `yoal fleet rebalance --apply` to make these moves.');
	const pinned = view.units.filter((unit) => unit.blocker);
	if (options.pinned && pinned.length > 0) {
		const names = new Map(view.nodes.map((node) => [node.id, node.name]));
		lines.push(
			'',
			'Pinned:',
			renderTable(
				['WORKLOAD', 'NODE', 'WHY'],
				pinned.map((unit) => [unit.label, names.get(unit.nodeId) ?? unit.nodeId, unit.blocker ?? '']),
			),
		);
	}
	return lines.join('\n');
}

export function formatFleetLinks(view: FleetLinksView): string {
	const names = new Map(view.nodes.map((node) => [node.id, node.name]));
	if (view.links.length === 0) return 'No links: fewer than two nodes are on the managed overlay.';
	const rows = view.links.map((link) => [
		names.get(link.fromNodeId) ?? link.fromNodeId,
		names.get(link.toNodeId) ?? link.toNodeId,
		link.path,
		link.rttMs === null ? (link.lossPercent === 100 ? 'unreachable' : '-') : `${link.rttMs.toFixed(1)} ms`,
		link.lossPercent ? `${link.lossPercent}%` : '0%',
		link.test?.status === 'ok' ? formatBps(link.test.uploadBps) : (link.test?.status ?? '-'),
		link.test?.status === 'ok' ? formatBps(link.test.downloadBps) : link.test?.status === 'failed' ? (link.test.error ?? '') : '-',
	]);
	const lines = [renderTable(['FROM', 'TO', 'PATH', 'LATENCY', 'LOSS', 'UPLOAD', 'DOWNLOAD'], rows)];
	if (view.running + view.queued > 0) lines.push('', `${view.running} test(s) running, ${view.queued} queued.`);
	return lines.join('\n');
}
