import { describe, expect, test } from 'bun:test';
import type { LinkMapView, NodeLinkView } from '@yoal/contracts';
import { formatBps, formatRtt, layoutNodes, pairEdges, sparkline } from './_links.ts';

const node = (id: string, zone = 'z') => ({
	id,
	name: id,
	zone,
	status: 'online',
	roles: ['compute'],
	privateAddress: '10.47.1.1',
	privateNetwork: null,
	lanEndpoint: null,
	capable: true,
});
const link = (from: string, to: string, over: Partial<NodeLinkView> = {}): NodeLinkView => ({
	fromNodeId: from,
	toNodeId: to,
	path: 'direct',
	rttMs: 10,
	rttMinMs: 9,
	rttMaxMs: 11,
	lossPercent: 0,
	sampledAt: '2026-11-14T00:00:00.000Z',
	history: [],
	downSince: null,
	test: null,
	...over,
});
const view = (links: NodeLinkView[], ids = ['a', 'b']): LinkMapView => ({
	generatedAt: '',
	nodes: ids.map((id) => node(id)),
	links,
	running: 0,
	queued: 0,
});

describe('link map', () => {
	test('one edge per pair, with throughput oriented by who ran the test', () => {
		const test = { id: 't', status: 'ok' as const, error: null, startedAt: '2026-11-14T00:00:00.000Z', finishedAt: null, uploadBps: 5, downloadBps: 9, rttMs: 1, jitterMs: 0, bytes: 1, seconds: 1 };
		const [edge] = pairEdges(view([link('a', 'b'), link('b', 'a', { rttMs: 12, test })]));
		expect(pairEdges(view([link('a', 'b'), link('b', 'a')]))).toHaveLength(1);
		// b ran it: b's upload is b→a (reverse), its download is a→b (forward).
		expect(edge).toMatchObject({ a: 'a', b: 'b', rttMs: 10, forwardBps: 9, reverseBps: 5, state: 'ok' });
	});

	test('silence is down, partial loss is lossy, no sample is unknown', () => {
		const state = (over: Partial<NodeLinkView>) => pairEdges(view([link('a', 'b', over)]))[0]!.state;
		expect(state({ rttMs: null, lossPercent: 100 })).toBe('down');
		expect(state({ lossPercent: 33 })).toBe('lossy');
		expect(state({ rttMs: null, lossPercent: null, sampledAt: null })).toBe('unknown');
	});

	test('nodes are placed inside the canvas, grouped by zone', () => {
		const points = layoutNodes([node('c', 'z2'), node('a', 'z1'), node('b', 'z1')], 600, 360);
		expect(points.map((point) => point.id)).toEqual(['a', 'b', 'c']);
		expect(points.every((point) => point.x > 0 && point.x < 600 && point.y > 0 && point.y < 360)).toBe(true);
	});

	test('units', () => {
		expect(formatBps(1_420_000_000)).toBe('1.42 Gbit/s');
		expect(formatBps(812_400_000)).toBe('812 Mbit/s');
		expect(formatBps(null)).toBe('—');
		expect(formatRtt(0.84)).toBe('0.8 ms');
		expect(formatRtt(41.2)).toBe('41 ms');
	});

	test('a sparkline breaks where a minute was lost', () => {
		const line = sparkline([10, 20, null, 15, 15], 100, 24);
		expect(line.segments).toHaveLength(2);
		expect(line).toMatchObject({ min: 10, max: 20 });
		expect(sparkline([null, null], 100, 24).segments).toEqual([]);
	});
});
