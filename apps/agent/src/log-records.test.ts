import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeLogBatchSchema, type NodeLogBatch, type NodeLogRecord } from '@yoal/contracts';
import {
	LogRecordsPostError,
	NodeLogBatcher,
	loadLogsSecret,
	logsHmac,
	postNodeLogBatch,
} from './log-records.ts';

function record(body: string): NodeLogRecord {
	return { ts: 1_700_000_000_000, source: 'access', severityNumber: 9, body, attributes: {}, resource: {} };
}

const site = { kind: 'site', host: 'app.example.com' } as const;
const other = { kind: 'workload', workloadId: 'wl_app' } as const;

describe('NodeLogBatcher', () => {
	test('one batch per target, at most 1,000 records, with the dropped count', async () => {
		const posted: NodeLogBatch[] = [];
		const batcher = new NodeLogBatcher({ post: async (batch) => void posted.push(batch) });
		batcher.add(site, Array.from({ length: 1_500 }, (_, index) => record(`r${index}`)));
		batcher.noteDropped(site, 7);
		batcher.add(other, record('otlp'));
		await batcher.flush();

		expect(posted.map((batch) => [batch.target, batch.records.length, batch.dropped])).toEqual([
			[site, 1_000, 7],
			[site, 500, 0],
			[other, 1, 0],
		]);
		for (const batch of posted) expect(nodeLogBatchSchema.safeParse(batch).success).toBe(true);
		expect(batcher.stats).toMatchObject({ sent: 1_501, pending: 0, dropped: 0 });
	});

	test('a sampled-out count alone still reaches the control plane', async () => {
		const posted: NodeLogBatch[] = [];
		const batcher = new NodeLogBatcher({ post: async (batch) => void posted.push(batch) });
		batcher.noteDropped(site, 3);
		await batcher.flush();
		expect(posted).toEqual([{ target: site, records: [], dropped: 3 }]);
	});

	test('a retryable failure keeps the batch, in order, for the next pass', async () => {
		const posted: NodeLogBatch[] = [];
		let fail = true;
		const batcher = new NodeLogBatcher({
			post: async (batch) => {
				if (fail) throw new LogRecordsPostError('down', 503);
				posted.push(batch);
			},
		});
		batcher.add(site, [record('a'), record('b')]);
		batcher.noteDropped(site, 2);
		await batcher.flush();
		expect(batcher.stats.pending).toBe(2);
		batcher.add(site, record('c'));
		fail = false;
		await batcher.flush();
		expect(posted).toHaveLength(1);
		expect(posted[0]!.records.map((entry) => entry.body)).toEqual(['a', 'b', 'c']);
		expect(posted[0]!.dropped).toBe(2);
	});

	test('a permanent refusal drops only that batch', async () => {
		const posted: NodeLogBatch[] = [];
		const batcher = new NodeLogBatcher({
			post: async (batch) => {
				if (batch.target.kind === 'site') throw new LogRecordsPostError('nope', 422);
				posted.push(batch);
			},
		});
		batcher.add(site, record('bad'));
		batcher.add(other, record('good'));
		await batcher.flush();
		expect(posted.map((batch) => batch.target)).toEqual([other]);
		expect(batcher.stats).toMatchObject({ rejectedBatches: 1, dropped: 1, pending: 0 });
	});

	test('a control plane without the route is left alone for five minutes', async () => {
		let now = 0;
		let calls = 0;
		const batcher = new NodeLogBatcher({
			now: () => now,
			post: async () => {
				calls += 1;
				throw new LogRecordsPostError('404', 404, true);
			},
		});
		batcher.add(site, record('a'));
		batcher.add(other, record('b'));
		await batcher.flush();
		expect(calls).toBe(1);
		expect(batcher.stats.pending).toBe(0);
		batcher.add(site, record('c'));
		now = 60_000;
		await batcher.flush();
		expect(calls).toBe(1);
		now = 5 * 60_000 + 1;
		await batcher.flush();
		expect(calls).toBe(2);
	});

	test('memory is bounded per target and in targets; the overflow is counted', async () => {
		const posted: NodeLogBatch[] = [];
		const batcher = new NodeLogBatcher({ post: async (batch) => void posted.push(batch), maxPerTarget: 3, maxTargets: 2 });
		batcher.add(site, ['a', 'b', 'c', 'd', 'e'].map(record));
		expect(batcher.room(site)).toBe(0);
		batcher.add(other, record('x'));
		batcher.add({ kind: 'site', host: 'third.example.com' }, record('y'));
		await batcher.flush();
		// The idlest target (the first) was evicted when the third arrived.
		expect(posted.map((batch) => batch.target)).toEqual([other, { kind: 'site', host: 'third.example.com' }]);
		expect(batcher.stats.dropped).toBe(2 + 3);
	});
});

describe('postNodeLogBatch', () => {
	test('POSTs the batch with the node token and maps failures', async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const ok = (async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return new Response('{"ok":true,"stored":1}', { status: 200 });
		}) as unknown as typeof fetch;
		const batch: NodeLogBatch = { target: site, records: [record('a')], dropped: 0 };
		await postNodeLogBatch({ controlUrl: 'https://control.example.com', nodeToken: 'tok' }, batch, ok);
		expect(calls[0]!.url).toBe('https://control.example.com/api/agent/log-records');
		expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
		expect(JSON.parse(String(calls[0]!.init.body))).toEqual(batch);

		const respond = (status: number, type: string) =>
			(async () => new Response('x', { status, headers: { 'content-type': type } })) as unknown as typeof fetch;
		const failure = async (status: number, type = 'application/json') => {
			try {
				await postNodeLogBatch({ controlUrl: 'https://c', nodeToken: 't' }, batch, respond(status, type));
			} catch (error) {
				return error as LogRecordsPostError;
			}
			throw new Error('expected a failure');
		};
		expect((await failure(503)).retry).toBe(true);
		expect((await failure(429)).retry).toBe(true);
		expect((await failure(403)).retry).toBe(false);
		expect((await failure(404)).routeMissing).toBe(false);
		expect((await failure(404, 'text/html')).routeMissing).toBe(true);
		const network = (async () => {
			throw new Error('ECONNREFUSED');
		}) as unknown as typeof fetch;
		await expect(postNodeLogBatch({ controlUrl: 'https://c', nodeToken: 't' }, batch, network)).rejects.toMatchObject({ retry: true });
	});
});

describe('logs secret', () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	test('is created once, 0600, and stable across loads', () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-logs-key-'));
		dirs.push(dir);
		const first = loadLogsSecret(dir);
		expect(first.length).toBe(32);
		expect(statSync(join(dir, 'logs.key')).mode & 0o777).toBe(0o600);
		expect(loadLogsSecret(dir).equals(first)).toBe(true);
		expect(logsHmac(first, 'a', 'x')).not.toBe(logsHmac(first, 'b', 'x'));
	});
});
