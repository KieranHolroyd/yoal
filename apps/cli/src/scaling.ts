/**
 * Horizontal scaling for one app (docs/SCALING.md): wire types and the text `yoal scale` prints.
 * Types mirror `ScalingView` in packages/contracts/src/scaling.ts; the CLI bundle stays free of
 * runtime dependencies (D40), so keep them in sync.
 */
import { formatTime, renderTable } from './output.ts';

export interface ScalingPolicyView {
	enabled: boolean;
	min: number;
	max: number;
	metric: 'cpu' | 'memory' | 'requests';
	target: number;
	scaleDownMinutes: number;
}

export interface ScalingStatusView {
	project: string;
	deployed: boolean;
	replicas: number;
	mode: 'spread' | 'stack' | 'node' | 'single';
	blocker: string | null;
	capacity: number;
	limit: number;
	memoryMb: number;
	cpuMillis: number;
	copies: Array<{
		index: number;
		nodeName: string;
		zone: string;
		status: string;
		release: 'current' | 'previous';
		memoryBytes: number | null;
		cpuMillis: number | null;
	}>;
	rollout: { status: 'rolling' | 'paused'; message: string | null; updated: number; total: number } | null;
	policy: ScalingPolicyView;
	autoscale: { observed: number | null; desired: number | null; reason: string | null; evaluatedAt: string | null; available: boolean };
	events: Array<{ from: number; to: number; reason: string; detail: string | null; at: string }>;
}

export interface ScaleResultView {
	project: string;
	from: number;
	to: number;
	added: Array<{ index: number; nodeName: string }>;
	removed: Array<{ index: number; nodeName: string }>;
}

const MODES: Record<ScalingStatusView['mode'], string> = {
	spread: 'one copy per node',
	stack: 'copies spread across nodes, then share them',
	node: 'every copy on its one node',
	single: 'one copy only',
};

const signal = (policy: ScalingPolicyView): string =>
	policy.metric === 'requests' ? `${policy.target} requests/s per copy` : `${policy.metric === 'cpu' ? 'CPU' : 'memory'} at ${policy.target}%`;

export function formatScaling(view: ScalingStatusView): string {
	if (!view.deployed && view.copies.length === 0 && view.mode === 'single' && view.memoryMb === 0)
		return `${view.project} is a static site: the edge serves it, so there is nothing to scale.`;
	const lines = [
		`${view.project}: ${view.replicas} ${view.replicas === 1 ? 'copy' : 'copies'} (${MODES[view.mode]}); this fleet has room for ${view.capacity}.`,
	];
	if (view.blocker) lines.push(`Cannot scale across nodes: ${view.blocker}.`);
	if (view.rollout)
		lines.push(
			'',
			view.rollout.status === 'paused'
				? `Rollout paused at ${view.rollout.updated} of ${view.rollout.total}. ${view.rollout.message ?? ''}\nRun \`yoal scale ${view.project} --resume\` to retry, or \`yoal rollback ${view.project}\`.`
				: `Rolling out: ${view.rollout.updated} of ${view.rollout.total} copies on the new release.`,
		);
	if (view.copies.length > 0)
		lines.push(
			'',
			renderTable(
				['COPY', 'NODE', 'ZONE', 'STATUS', 'RELEASE', 'MEMORY', 'CPU'],
				view.copies.map((copy) => [
					`r${copy.index}`,
					copy.nodeName,
					copy.zone,
					copy.status,
					copy.release,
					copy.memoryBytes === null ? '-' : `${Math.round(copy.memoryBytes / 1048576)}/${view.memoryMb} MB`,
					copy.cpuMillis === null ? '-' : `${Math.round((copy.cpuMillis / Math.max(1, view.cpuMillis)) * 100)}%`,
				]),
			),
		);
	else if (!view.deployed) lines.push('', 'Not deployed yet: the next deploy starts this many copies.');
	lines.push(
		'',
		view.policy.enabled
			? `Autoscaling: ${view.policy.min}-${view.policy.max} copies, holding ${signal(view.policy)}.`
			: `Autoscaling: off. Turn it on with \`yoal scale ${view.project} --auto --min 1 --max 3\`.`,
	);
	if (view.policy.enabled && view.autoscale.reason) lines.push(`  ${view.autoscale.reason}`);
	if (view.events.length > 0)
		lines.push(
			'',
			renderTable(
				['WHEN', 'COPIES', 'WHY'],
				view.events.slice(0, 5).map((event) => [formatTime(event.at), `${event.from} → ${event.to}`, event.detail ?? event.reason]),
			),
		);
	return lines.join('\n');
}
