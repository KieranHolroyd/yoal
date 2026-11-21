import { describe, expect, test } from 'bun:test';
import { LocalObjectStore, type ConditionalStore, type ObjectStore } from './object-store.ts';
import { MemoryConditionalStore } from './ha-lease.ts';
import { ArbiterUnavailableError, arbiterStore, casOutcome } from './ha-control-arbiter.ts';

/** A store whose conditional methods answer the scripted statuses. */
function scripted(reads: Array<Awaited<ReturnType<ConditionalStore['readVersioned']>>>, writes: Array<Awaited<ReturnType<ConditionalStore['writeConditional']>>>): ObjectStore & ConditionalStore {
	const store = {
		kind: 's3' as const,
		async readVersioned() {
			return reads.shift()!;
		},
		async writeConditional() {
			return writes.shift()!;
		},
	} as unknown as ObjectStore & ConditionalStore;
	return store;
}

describe('W9 arbiter store (W9-SPEC §2, CLUSTERING §6.3)', () => {
	test('an S3/Azure/GCS-style conditional store becomes the arbiter unchanged', async () => {
		const memory = new MemoryConditionalStore(() => 1_000);
		const store = arbiterStore(memory as unknown as ObjectStore);
		const created = await store.writeConditional('yoal/ha/control-lease.json', '{"epoch":1}', { ifNoneMatch: '*' });
		expect(created).toMatchObject({ status: 200 });
		expect(created.etag).toBeTruthy();
		const read = await store.readVersioned('yoal/ha/control-lease.json');
		expect(read).toMatchObject({ status: 200, body: '{"epoch":1}', etag: created.etag });
		// 409/412 are preserved: the lease re-reads and never retries blindly.
		const lost = await store.writeConditional('yoal/ha/control-lease.json', '{}', { ifMatch: '"stale"' });
		expect(lost.status).toBe(412);
	});

	test('a store without a conditional write fails closed before any lease exists', () => {
		const local = new LocalObjectStore('/tmp/yoal-arbiter-test', 'http://localhost', 'secret');
		expect(() => arbiterStore(local)).toThrow(ArbiterUnavailableError);
	});

	test('a success without a strong ETag is 501, not a renewable lease', async () => {
		const store = arbiterStore(
			scripted(
				[{ status: 200, body: '{"epoch":1}', etag: null, serverDate: 1_000 }],
				[{ status: 200, etag: null, serverDate: 1_000 }],
			),
		);
		expect((await store.readVersioned('k')).status).toBe(501);
		const write = await store.writeConditional('k', '{}', { ifNoneMatch: '*' });
		expect(write.status).toBe(501);
	});

	test('Azure 201 Created is a win; 409 and 412 map to a lost race', () => {
		expect(casOutcome(200, true)).toBe('won');
		expect(casOutcome(200, false)).toBe('unavailable');
		expect(casOutcome(409)).toBe('lost');
		expect(casOutcome(412)).toBe('lost');
		expect(casOutcome(501)).toBe('unavailable');
		expect(casOutcome(500)).toBe('error');
	});

	test('a conditional create answered 201 is normalised to 200', async () => {
		const store = arbiterStore(
			scripted([], [{ status: 201, etag: '"etag-1"', serverDate: 2_000 }]),
		);
		expect(await store.writeConditional('k', '{}', { ifNoneMatch: '*' })).toMatchObject({ status: 200, etag: '"etag-1"' });
	});
});
