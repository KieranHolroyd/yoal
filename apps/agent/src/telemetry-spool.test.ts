import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MetricBucket } from '@yoal/contracts';
import { TelemetrySpool } from './telemetry-spool.ts';

const dirs: string[] = [];

function directory(): string {
	const dir = mkdtempSync(join(tmpdir(), 'yoal-telemetry-spool-'));
	dirs.push(dir);
	return dir;
}

function bucket(host: string, minute: number): MetricBucket {
	return {
		host,
		projectId: 'prj_1',
		bucket: new Date(Date.UTC(2026, 10, 20, 10, minute)).toISOString(),
		requests: 1,
		status2xx: 1,
		status3xx: 0,
		status4xx: 0,
		status5xx: 0,
		bytes: 10,
		durationP50Ms: 1,
		durationP95Ms: 2,
		topPaths: [],
		topReferrers: [],
	};
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('telemetry spool (HA-PLAN H28, W12)', () => {
	test('persists batches across a restart and replays oldest-first', async () => {
		const dir = join(directory(), 'spool');
		const first = new TelemetrySpool(dir);
		await first.open();
		await first.append([bucket('shop.test', 0), bucket('shop.test', 1)]);
		await first.append([bucket('shop.test', 2)]);
		expect(first.report()).toMatchObject({ queued: 3 });

		const restarted = new TelemetrySpool(dir);
		await restarted.open();
		expect(restarted.report()).toMatchObject({ queued: 3 });
		const taken = await restarted.take(2);
		expect(taken.buckets.map((item) => item.bucket)).toEqual([bucket('shop.test', 0).bucket, bucket('shop.test', 1).bucket]);
		await restarted.ack(taken.segments);
		expect(restarted.report()).toMatchObject({ queued: 1 });
		const rest = await restarted.take();
		expect(rest.buckets.map((item) => item.bucket)).toEqual([bucket('shop.test', 2).bucket]);
		await restarted.ack(rest.segments);
		expect(restarted.report()).toMatchObject({ queued: 0, bytes: 0 });
	});

	test('is bounded by bucket count and records the dropped minutes as gaps', async () => {
		const spool = new TelemetrySpool(join(directory(), 'spool'), { maxBuckets: 3 });
		await spool.open();
		await spool.append([bucket('shop.test', 0), bucket('shop.test', 1)]);
		await spool.append([bucket('shop.test', 2), bucket('shop.test', 3)]);
		// The oldest segment (minutes 0 and 1) is gone; minutes 2 and 3 stay.
		expect(spool.report()).toMatchObject({ queued: 2, dropped: 2 });
		expect(spool.report().gaps).toEqual([
			{
				host: 'shop.test',
				from: Date.parse(bucket('shop.test', 0).bucket),
				to: Date.parse(bucket('shop.test', 2).bucket),
				buckets: 2,
			},
		]);
		const taken = await spool.take();
		expect(taken.buckets.map((item) => item.bucket)).toEqual([bucket('shop.test', 2).bucket, bucket('shop.test', 3).bucket]);
	});

	test('is bounded by bytes as well as count', async () => {
		const spool = new TelemetrySpool(join(directory(), 'spool'), { maxBytes: 200 });
		await spool.open();
		for (let minute = 0; minute < 6; minute++) await spool.append([bucket('shop.test', minute)]);
		expect(spool.report().bytes).toBeLessThanOrEqual(400);
		expect(spool.report().dropped).toBeGreaterThan(0);
	});

	test('a batch larger than the bound keeps its newest buckets and reports the rest', async () => {
		const spool = new TelemetrySpool(join(directory(), 'spool'), { maxBuckets: 2 });
		await spool.open();
		await spool.append([bucket('shop.test', 0), bucket('shop.test', 1), bucket('shop.test', 2)]);
		expect(spool.report()).toMatchObject({ queued: 2, dropped: 1 });
		const taken = await spool.take();
		expect(taken.buckets.map((item) => item.bucket)).toEqual([bucket('shop.test', 1).bucket, bucket('shop.test', 2).bucket]);
	});

	test('the gap record survives a restart', async () => {
		const dir = join(directory(), 'spool');
		const spool = new TelemetrySpool(dir, { maxBuckets: 1 });
		await spool.open();
		await spool.append([bucket('shop.test', 0)]);
		await spool.append([bucket('shop.test', 1)]);
		expect(spool.report().gaps).toHaveLength(1);

		const restarted = new TelemetrySpool(dir, { maxBuckets: 1 });
		await restarted.open();
		expect(restarted.report()).toMatchObject({ queued: 1, dropped: 1 });
		expect(restarted.report().gaps[0]).toMatchObject({ host: 'shop.test', buckets: 1 });
	});
});
