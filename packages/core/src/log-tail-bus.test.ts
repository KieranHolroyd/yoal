import { describe, expect, test } from 'bun:test';
import type { LogRecord } from '@yoal/contracts';
import { LogTailBus } from './log-tail-bus.ts';
import type { UnifiedLogRow } from './log-store/sqlite-sources.ts';
import type { LogReadBoundary } from './log-store/types.ts';

function row(seq: number, overrides: Partial<UnifiedLogRow> = {}): UnifiedLogRow {
	return {
		tag: 'le',
		seq,
		ts: 1_000 + seq,
		observed_ts: null,
		org_id: 'org_1',
		scope_kind: 'project',
		scope_id: 'prj_a',
		stream: 'deployment:dep_1',
		source: 'runtime',
		channel: 'stdout',
		severity_number: 9,
		body: `line ${seq}`,
		attributes: null,
		resource: null,
		trace_id: null,
		span_id: null,
		request_id: null,
		project_id: 'prj_a',
		deployment_id: 'dep_1',
		build_id: null,
		job_run_id: null,
		node_id: 'node_1',
		...overrides,
	};
}

const projectA: LogReadBoundary = { orgId: 'org_1', scopes: [{ kind: 'project', id: 'prj_a' }], crossOrg: false };
const everything = (): boolean => true;

describe('LogTailBus', () => {
	test('delivers matching rows in the boundary and nothing else', () => {
		const bus = new LogTailBus();
		const subscription = bus.subscribe({ boundary: projectA, predicate: (record) => record.body.includes('keep') });
		bus.publish([
			row(1, { body: 'keep me' }),
			row(2, { body: 'drop me' }),
			row(3, { body: 'keep other project', scope_id: 'prj_b' }),
			row(4, { body: 'keep other org', org_id: 'org_2' }),
		]);
		expect(subscription.take().records.map((record) => record.id)).toEqual(['le:1']);
		expect(subscription.take().records).toEqual([]);
	});

	test('a platform scope reaches only a cross-org boundary', () => {
		const bus = new LogTailBus();
		const scopes = [{ kind: 'platform' as const, id: 'node_1' }];
		const tenant = bus.subscribe({ boundary: { orgId: 'org_1', scopes, crossOrg: false }, predicate: everything });
		const admin = bus.subscribe({ boundary: { orgId: 'org_1', scopes, crossOrg: true }, predicate: everything });
		bus.publish([row(1, { tag: 'lr', org_id: 'platform', scope_kind: 'platform', scope_id: 'node_1', source: 'platform' })]);
		expect(tenant.take().records).toEqual([]);
		expect(admin.take().records.map((record) => record.id)).toEqual(['lr:1']);
	});

	test('a subscriber that falls behind keeps the newest lines and counts the dropped ones', () => {
		const bus = new LogTailBus();
		const subscription = bus.subscribe({ boundary: projectA, predicate: everything, capacity: 3 });
		bus.publish([row(1), row(2), row(3), row(4), row(5)]);
		const { records, dropped } = subscription.take();
		expect(records.map((record) => record.id)).toEqual(['le:3', 'le:4', 'le:5']);
		expect(dropped).toBe(2);
	});

	test('a throwing predicate is "no match", never a crash', () => {
		const bus = new LogTailBus();
		const subscription = bus.subscribe({
			boundary: projectA,
			predicate: (record: LogRecord) => {
				if (record.body === 'line 1') throw new Error('boom');
				return true;
			},
		});
		bus.publish([row(1), row(2)]);
		expect(subscription.take().records.map((record) => record.id)).toEqual(['le:2']);
	});

	test('the floor skips rows a catch-up already sent, including ones queued meanwhile', () => {
		const bus = new LogTailBus();
		const subscription = bus.subscribe({ boundary: projectA, predicate: everything });
		bus.publish([row(1), row(2)]);
		subscription.setFloor({ le: 2 });
		bus.publish([row(2), row(3)]);
		expect(subscription.take().records.map((record) => record.id)).toEqual(['le:3']);
		expect(subscription.vector).toEqual({ le: 3 });
	});

	test('wait resolves on new rows, on timeout and on close; close unsubscribes', async () => {
		const bus = new LogTailBus();
		const subscription = bus.subscribe({ boundary: projectA, predicate: everything });
		const started = Date.now();
		await subscription.wait(20);
		expect(Date.now() - started).toBeGreaterThanOrEqual(15);
		const waiting = subscription.wait(5_000);
		bus.publish([row(7)]);
		await waiting;
		expect(subscription.pending).toBe(1);
		const controller = new AbortController();
		subscription.take();
		const aborted = subscription.wait(5_000, controller.signal);
		controller.abort();
		await aborted;
		expect(bus.size).toBe(1);
		subscription.close();
		expect(bus.size).toBe(0);
		expect(subscription.closed).toBe(true);
		await subscription.wait(5_000);
	});

	test('publishing with no subscriber does no work', () => {
		const bus = new LogTailBus();
		expect(() => bus.publish([row(1, { body: undefined as unknown as string })])).not.toThrow();
	});
});
