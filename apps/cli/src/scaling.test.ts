import { describe, expect, test } from 'bun:test';
import { formatFleetLinks, formatFleetStatus, formatBps } from './fleet.ts';
import { formatScaling, type ScalingStatusView } from './scaling.ts';

const view = (over: Partial<ScalingStatusView> = {}): ScalingStatusView => ({
	project: 'shop',
	deployed: true,
	replicas: 2,
	mode: 'spread',
	blocker: null,
	capacity: 3,
	limit: 20,
	memoryMb: 256,
	cpuMillis: 1000,
	copies: [
		{ index: 0, nodeName: 'edge-b', zone: 'hel1', status: 'running', release: 'current', memoryBytes: 64 * 1048576, cpuMillis: 420 },
		{ index: 1, nodeName: 'edge', zone: 'par1', status: 'pending', release: 'previous', memoryBytes: null, cpuMillis: null },
	],
	rollout: null,
	policy: { enabled: false, min: 1, max: 3, metric: 'cpu', target: 70, scaleDownMinutes: 5 },
	autoscale: { observed: null, desired: null, reason: null, evaluatedAt: null, available: true },
	events: [],
	...over,
});

describe('yoal scale', () => {
	test('lists the copies with usage as a share of their limits', () => {
		const text = formatScaling(view());
		expect(text).toContain('shop: 2 copies (one copy per node); this fleet has room for 3.');
		expect(text).toContain('64/256 MB');
		expect(text).toContain('42%');
		expect(text).toContain('Autoscaling: off');
	});

	test('says why an app cannot scale out, and what a paused rollout needs', () => {
		const text = formatScaling(
			view({
				mode: 'single',
				blocker: 'its app volumes live on that node',
				rollout: { status: 'paused', message: 'Copy r1 failed on edge with the new release.', updated: 1, total: 2 },
				policy: { enabled: true, min: 2, max: 6, metric: 'requests', target: 50, scaleDownMinutes: 5 },
				autoscale: { observed: 80, desired: 4, reason: 'Request rate is 80 req/s per copy against a target of 50 req/s per copy.', evaluatedAt: null, available: true },
			}),
		);
		expect(text).toContain('Cannot scale across nodes: its app volumes live on that node.');
		expect(text).toContain('Rollout paused at 1 of 2');
		expect(text).toContain('yoal scale shop --resume');
		expect(text).toContain('Autoscaling: 2-6 copies, holding 50 requests/s per copy.');
	});
});

describe('yoal scale: rollback and sizing', () => {
	test('reports an automatic rollback and right-sizing advice', () => {
		const text = formatScaling(
			view({
				lastRollback: { at: '2026-11-14T12:00:00.000Z', note: 'Copy r1 failed on edge with the new release. shop was rolled back to its previous release automatically.' },
				sizing: { memoryPeakMb: 60, advice: 'lower', suggestedMemoryMb: 96, settled: true },
			}),
		);
		expect(text).toContain('Rolled back automatically');
		expect(text).toContain('96 MB would leave a quarter of headroom');
		expect(formatScaling(view({ rollout: { status: 'rolling', message: null, updated: 1, total: 2, surge: true } }))).toContain('temporary second copy');
	});
});

describe('yoal fleet', () => {
	test('formats throughput, capacity and links', () => {
		expect(formatBps(1_420_000_000)).toBe('1.42 Gbit/s');
		const status = formatFleetStatus({
			strategy: 'spread',
			memoryOvercommitPercent: 100,
			cpuOvercommitPercent: 100,
			autoRebalance: false,
			nodes: [{ id: 'n1', name: 'edge', zone: 'par1', status: 'online', eligible: true, capacityMb: 1024, reservedMb: 512, reservedPercent: 50, usedMemoryMb: 900, totalMemoryMb: 2048, cpuPercent: 12, copies: 2, movable: 1 }],
			units: [],
			plan: { strategy: 'spread', moves: [], gapBefore: 0, gapAfter: 0, summary: 'Only one node can take workloads, so there is nothing to balance.' },
		});
		expect(status).toContain('512/1024 MB');
		expect(status).toContain('2 (1 movable)');
		const links = formatFleetLinks({
			nodes: [
				{ id: 'a', name: 'edge', zone: 'par1', privateNetwork: null, capable: true },
				{ id: 'b', name: 'edge-b', zone: 'hel1', privateNetwork: null, capable: true },
			],
			links: [{ fromNodeId: 'a', toNodeId: 'b', path: 'direct', rttMs: 41.2, lossPercent: 0, test: { status: 'ok', error: null, uploadBps: 9e8, downloadBps: 8.5e8, jitterMs: 1 } }],
			running: 0,
			queued: 0,
		});
		expect(links).toContain('41.2 ms');
		expect(links).toContain('900 Mbit/s');
	});
});
