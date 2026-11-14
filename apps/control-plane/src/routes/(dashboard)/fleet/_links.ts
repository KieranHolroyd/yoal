import type { LinkMapView, NodeLinkView } from '@yoal/contracts';

/** Layout and formatting for the link map (docs/CLUSTERING.md §4.6). Pure, so it is testable. */

export interface MapPoint {
	id: string;
	name: string;
	zone: string;
	x: number;
	y: number;
	/** Which side of the circle the label sits on, so it never crosses the edges. */
	anchor: 'start' | 'middle' | 'end';
	labelDy: number;
}

/** One undirected pair, with the measurement from each end. */
export interface MapEdge {
	key: string;
	a: string;
	b: string;
	path: NodeLinkView['path'];
	/** The better-informed latency of the two directions. */
	rttMs: number | null;
	lossPercent: number | null;
	/** Throughput a→b and b→a, from whichever end ran the test. */
	forwardBps: number | null;
	reverseBps: number | null;
	testStatus: string | null;
	testError: string | null;
	state: 'ok' | 'lossy' | 'down' | 'unknown';
	forward: NodeLinkView | null;
	backward: NodeLinkView | null;
	/** The last hour of round trips from whichever end has more of them; null where all were lost. */
	history: Array<number | null>;
	downSince: string | null;
}

/** Nodes on a circle, zone by zone, so nodes that share a failure domain sit together. */
export function layoutNodes(nodes: LinkMapView['nodes'], width: number, height: number): MapPoint[] {
	const ordered = [...nodes].sort((a, b) => a.zone.localeCompare(b.zone) || a.name.localeCompare(b.name));
	const cx = width / 2;
	const cy = height / 2;
	const radius = Math.min(width * 0.32, height * 0.36);
	if (ordered.length === 1) return [{ id: ordered[0]!.id, name: ordered[0]!.name, zone: ordered[0]!.zone, x: cx, y: cy, anchor: 'middle', labelDy: -22 }];
	return ordered.map((node, index) => {
		// Two nodes sit left and right; more start at the top.
		const angle = (ordered.length === 2 ? Math.PI : -Math.PI / 2) + (index / ordered.length) * Math.PI * 2;
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		return {
			id: node.id,
			name: node.name,
			zone: node.zone,
			x: cx + radius * cos,
			y: cy + radius * sin,
			anchor: Math.abs(cos) < 0.3 ? 'middle' : cos > 0 ? 'start' : 'end',
			labelDy: Math.abs(cos) < 0.3 ? (sin < 0 ? -22 : 32) : 4,
		};
	});
}

export function pairEdges(view: LinkMapView): MapEdge[] {
	const byKey = new Map(view.links.map((link) => [`${link.fromNodeId}>${link.toNodeId}`, link]));
	const edges: MapEdge[] = [];
	const ids = view.nodes.map((node) => node.id);
	for (let i = 0; i < ids.length; i++)
		for (let j = i + 1; j < ids.length; j++) {
			const a = ids[i]!;
			const b = ids[j]!;
			const forward = byKey.get(`${a}>${b}`) ?? null;
			const backward = byKey.get(`${b}>${a}`) ?? null;
			if (!forward && !backward) continue;
			const rtts = [forward?.rttMs, backward?.rttMs].filter((value): value is number => typeof value === 'number');
			const losses = [forward?.lossPercent, backward?.lossPercent].filter((value): value is number => typeof value === 'number');
			const sampled = Boolean(forward?.sampledAt || backward?.sampledAt);
			const loss = losses.length ? Math.max(...losses) : null;
			// A test run from a measures a→b as its upload and b→a as its download; from b, the reverse.
			const test = latestTest(forward, backward);
			const fromA = test === forward?.test;
			edges.push({
				key: `${a}:${b}`,
				a,
				b,
				path: (forward ?? backward)!.path,
				rttMs: rtts.length ? Math.min(...rtts) : null,
				lossPercent: loss,
				forwardBps: test?.status === 'ok' ? (fromA ? test.uploadBps : test.downloadBps) : null,
				reverseBps: test?.status === 'ok' ? (fromA ? test.downloadBps : test.uploadBps) : null,
				testStatus: test?.status ?? null,
				testError: test?.error ?? null,
				state: !sampled ? 'unknown' : rtts.length === 0 ? 'down' : (loss ?? 0) > 0 ? 'lossy' : 'ok',
				forward,
				backward,
				history: (forward?.history.length ?? 0) >= (backward?.history.length ?? 0) ? (forward?.history ?? []) : (backward?.history ?? []),
				downSince: forward?.downSince ?? backward?.downSince ?? null,
			});
		}
	return edges;
}

function latestTest(forward: NodeLinkView | null, backward: NodeLinkView | null) {
	const tests = [forward?.test, backward?.test].filter((test): test is NonNullable<NodeLinkView['test']> => Boolean(test));
	return tests.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0] ?? null;
}

/** `812 Mbit/s`, `1.42 Gbit/s`. */
export function formatBps(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return '—';
	if (value >= 1e9) return `${(value / 1e9).toFixed(2)} Gbit/s`;
	if (value >= 1e6) return `${Math.round(value / 1e6)} Mbit/s`;
	return `${Math.round(value / 1e3)} kbit/s`;
}

export function formatRtt(value: number | null | undefined): string {
	if (value === null || value === undefined) return '—';
	return value < 10 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`;
}

export const pathLabels: Record<NodeLinkView['path'], string> = {
	private: 'Private network',
	direct: 'Public endpoint',
	relayed: 'Relayed through a hub',
	none: 'No path',
};

/**
 * Points for a sparkline of round trips, in a `width`×`height` box. A lost minute breaks the line
 * rather than drawing through it, so an outage reads as a gap.
 */
export function sparkline(values: Array<number | null>, width: number, height: number): { segments: string[]; min: number | null; max: number | null } {
	const present = values.filter((value): value is number => value !== null);
	if (present.length === 0) return { segments: [], min: null, max: null };
	const min = Math.min(...present);
	const max = Math.max(...present);
	const span = max - min || 1;
	const step = values.length > 1 ? width / (values.length - 1) : 0;
	const segments: string[] = [];
	let current: string[] = [];
	values.forEach((value, index) => {
		if (value === null) {
			if (current.length > 0) segments.push(current.join(' '));
			current = [];
			return;
		}
		// 2px of headroom top and bottom so the stroke is never clipped.
		const y = height - 2 - ((value - min) / span) * (height - 4);
		current.push(`${(index * step).toFixed(1)},${y.toFixed(1)}`);
	});
	if (current.length > 0) segments.push(current.join(' '));
	return { segments, min, max };
}
