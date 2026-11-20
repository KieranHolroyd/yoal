import { describe, expect, test } from 'bun:test';
import { runObjectStoreConformance, summarize } from './conformance.ts';
import { MemoryObjectStore } from './memory.ts';
import { probeConditionalWrites } from './probe.ts';

describe('object-store conformance suite', () => {
	test('the in-memory reference store passes every case', async () => {
		const root = new MemoryObjectStore();
		const report = await runObjectStoreConformance(
			{ name: 'memory', open: (options) => root.scoped(options?.prefix ?? ''), presign: false, endpointOverride: false },
			{ writers: 200, generations: 3, largeObjectBytes: 4 * 1024 * 1024 },
		);
		const failed = report.cases.filter((result) => !result.ok);
		expect(failed).toEqual([]);
		expect(report.metrics.contention?.winnersPerGeneration).toEqual([1, 1, 1]);
		expect(report.metrics.contention?.loserStatuses).toEqual({ '412': 597 });
		expect(report.metrics.conditionalWrites.count).toBeGreaterThan(600);
	});

	test('a store that ignores conditions fails the contention and probe cases', async () => {
		const root = new MemoryObjectStore();
		const report = await runObjectStoreConformance(
			{
				name: 'ignores-conditions',
				open: (options) => {
					const store = root.scoped(options?.prefix ?? '');
					store.writeConditional = async (key, body) => {
						await store.put(key, new TextEncoder().encode(body));
						return { status: 200, etag: (await store.readVersioned(key)).etag, serverDate: Date.now() };
					};
					return store;
				},
				presign: false,
				endpointOverride: false,
			},
			{ writers: 20, generations: 2, only: ['conditional', 'contention', 'probe'] },
		);
		expect(report.ok).toBe(false);
		const failed = report.cases.filter((result) => !result.ok).map((result) => result.name);
		expect(failed).toContain('conditional create: exactly one create wins');
		expect(failed).toContain('active conditional-write probe');
		expect(failed.some((name) => name.startsWith('contention'))).toBe(true);
	});

	test('the probe reports a store without conditional PUT as unsupported', async () => {
		const store = new MemoryObjectStore();
		store.writeConditional = async () => ({ status: 501, etag: null, serverDate: null });
		expect(await probeConditionalWrites(store)).toEqual({ support: 'unsupported', detail: 'the store has no conditional PUT (501)' });
	});

	test('summarize computes nearest-rank percentiles', () => {
		const samples = Array.from({ length: 100 }, (_unused, index) => index + 1);
		expect(summarize(samples)).toEqual({ count: 100, p50Ms: 50, p99Ms: 99, maxMs: 100 });
		expect(summarize([])).toEqual({ count: 0, p50Ms: 0, p99Ms: 0, maxMs: 0 });
	});
});
