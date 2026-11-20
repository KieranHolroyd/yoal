import { describe, expect, test } from 'bun:test';
import { DnsProviderError, type DnsProvider, type DnsRecord, type DnsRecordInput } from '../dns/provider.ts';
import {
	DnsFailoverDriver,
	emptyDnsFailoverState,
	type DnsFailoverEvent,
	type DnsFailoverRecordTarget,
	type DnsFailoverState,
} from './driver.ts';
import type { DnsFailoverNode, ProbeObservation } from './health.ts';
import type { IngressProber } from './probe.ts';

/**
 * The `dns-failover` driver against a fake Cloudflare API and a fake prober. The cases are the
 * lane's conformance cases: record-set reconciliation, idempotent writes, quorum and hold-down,
 * the last healthy record, API failure and retry, and the leased write path.
 */

const T0 = 1_000_000;
const EPOCH = 7;

class FakeProvider implements DnsProvider {
	readonly kind = 'cloudflare';
	readonly records: DnsRecord[] = [];
	readonly ops: string[] = [];
	readonly failures = new Map<string, Error>();
	writes = 0;
	#sequence = 0;

	async listRecords(name: string): Promise<DnsRecord[]> {
		this.ops.push(`list:${name}`);
		this.#fail('list');
		return this.records.filter((record) => record.name === name);
	}

	async createRecord(input: DnsRecordInput): Promise<DnsRecord> {
		this.ops.push(`create:${input.name}:${input.content}`);
		this.#fail('create');
		const record: DnsRecord = {
			id: `rec_${++this.#sequence}`,
			name: input.name,
			type: input.type,
			content: input.content,
			ttl: input.proxied ? 1 : input.ttl,
			proxied: input.proxied,
		};
		this.records.push(record);
		this.writes += 1;
		return { ...record };
	}

	async updateRecord(id: string, input: DnsRecordInput): Promise<DnsRecord> {
		this.ops.push(`update:${input.name}:${input.content}`);
		this.#fail('update');
		const record = this.records.find((candidate) => candidate.id === id);
		if (!record) throw new DnsProviderError('missing record', false, 404);
		record.ttl = input.proxied ? 1 : input.ttl;
		record.proxied = input.proxied;
		this.writes += 1;
		return { ...record };
	}

	async deleteRecord(id: string): Promise<void> {
		const record = this.records.find((candidate) => candidate.id === id);
		this.ops.push(`delete:${record?.content ?? id}`);
		this.#fail('delete');
		const index = this.records.findIndex((candidate) => candidate.id === id);
		if (index === -1) throw new DnsProviderError('missing record', false, 404);
		this.records.splice(index, 1);
		this.writes += 1;
	}

	contents(name: string): string[] {
		return this.records.filter((record) => record.name === name).map((record) => record.content).sort();
	}

	#fail(operation: string): void {
		const error = this.failures.get(operation);
		if (error) throw error;
	}
}

class FakeProber implements IngressProber {
	readonly failing = new Set<string>();
	/** Nodes a second-zone observer also sees as failed. */
	readonly corroborated = new Set<string>();
	calls = 0;

	async probe(nodes: readonly DnsFailoverNode[], at: number): Promise<ProbeObservation[]> {
		this.calls += 1;
		const primary = nodes.map(
			(node): ProbeObservation => ({
				nodeId: node.id,
				observerId: 'primary',
				observerZone: 'control',
				ok: !this.failing.has(node.id),
				at,
				reason: this.failing.has(node.id) ? 'timeout' : 'ok',
			}),
		);
		const second = [...this.corroborated].map(
			(nodeId): ProbeObservation => ({ nodeId, observerId: 'corroborator', observerZone: 'z2', ok: false, at, reason: 'timeout' }),
		);
		return [...primary, ...second];
	}
}

interface Harness {
	driver: DnsFailoverDriver;
	provider: FakeProvider;
	prober: FakeProber;
	nodes: DnsFailoverNode[];
	state: { current: DnsFailoverState };
	events: DnsFailoverEvent[];
	clock: { now: number };
	lease: { epoch: number; holds(): boolean };
}

function harness(
	options: {
		provider?: DnsProvider | null;
		nodes?: DnsFailoverNode[];
		records?: DnsFailoverRecordTarget[];
		probeIntervalMs?: number;
	} = {},
): Harness {
	const clock = { now: T0 };
	const provider = new FakeProvider();
	const prober = new FakeProber();
	const nodes = options.nodes ?? [
		{ id: 'a', name: 'edge-a', zone: 'z1', address: '192.0.2.10', status: 'online', offlineSince: null },
		{ id: 'b', name: 'edge-b', zone: 'z2', address: '192.0.2.11', status: 'online', offlineSince: null },
	];
	const state: { current: DnsFailoverState } = { current: emptyDnsFailoverState() };
	const events: DnsFailoverEvent[] = [];
	const driver = new DnsFailoverDriver({
		provider: options.provider === undefined ? provider : options.provider,
		nodes: () => nodes,
		records: options.records ?? [{ name: 'sites.test', ttl: 60, proxied: false }],
		prober,
		observer: { id: 'primary', zone: 'control' },
		now: () => clock.now,
		state: {
			load: () => structuredClone(state.current),
			save: (next) => {
				state.current = structuredClone(next);
			},
		},
		onEvent: (event) => events.push({ ...event }),
		health: { staleAfterMs: 10 * 60_000 },
		probeIntervalMs: options.probeIntervalMs ?? 0,
		retryDelaysMs: [5_000, 15_000, 45_000, 60_000],
	});
	return {
		driver,
		provider,
		prober,
		nodes,
		state,
		events,
		clock,
		lease: { epoch: EPOCH, holds: () => true },
	};
}

describe('dns-failover record set', () => {
	test('reconciles every managed name once and never duplicates a write', async () => {
		const h = harness();
		const first = await h.driver.apply(h.lease);
		expect(first.written).toBe(2);
		expect(h.provider.contents('sites.test')).toEqual(['192.0.2.10', '192.0.2.11']);
		expect(h.state.current.records).toEqual(['a', 'b']);
		expect(h.events.map((event) => event.action)).toEqual(['add', 'add']);

		const second = await h.driver.apply(h.lease);
		expect(second.written).toBe(0);
		expect(h.events).toHaveLength(2);
		expect(h.provider.contents('sites.test')).toEqual(['192.0.2.10', '192.0.2.11']);
	});

	test('re-creates a missing record and removes one that no ingress owns', async () => {
		const h = harness();
		await h.driver.apply(h.lease);
		h.provider.records.splice(0, 1);
		h.provider.records.push({ id: 'stray', name: 'sites.test', type: 'A', content: '203.0.113.99', ttl: 60, proxied: false });
		const report = await h.driver.apply(h.lease);
		expect(report.written).toBe(2);
		expect(h.provider.contents('sites.test')).toEqual(['192.0.2.10', '192.0.2.11']);
		expect(h.events.map((event) => event.action)).toContain('remove');
	});

	test('updates a drifted TTL but refuses to flip a proxy state', async () => {
		const h = harness();
		await h.driver.apply(h.lease);
		h.provider.records[0]!.ttl = 120;
		const ttl = await h.driver.apply(h.lease);
		expect(ttl.written).toBe(1);
		expect(h.provider.records[0]!.ttl).toBe(60);

		h.provider.records[0]!.proxied = true;
		const proxy = await h.driver.apply(h.lease);
		expect(proxy.written).toBe(0);
		expect(proxy.failed).toBe(1);
		expect(h.provider.records[0]!.proxied).toBe(true);
		expect(h.events.at(-1)).toMatchObject({ action: 'update', status: 'failed' });
		expect(proxy.alerts.map((alert) => alert.key)).toContain('steering:dns-failover:proxy:sites.test');
	});
});

describe('dns-failover detection', () => {
	test('a single witness waits 90s; a corroborated probe withdraws at 45s', async () => {
		const single = harness();
		await single.driver.apply(single.lease);
		single.clock.now += 20_000;
		single.prober.failing.add('b');
		await single.driver.apply(single.lease);
		single.clock.now += 46_000;
		const waiting = await single.driver.apply(single.lease);
		expect(waiting.withdrawn).toEqual([]);
		single.clock.now += 45_000;
		const removed = await single.driver.apply(single.lease);
		expect(removed.withdrawn).toEqual(['b']);
		expect(removed.records).toEqual(['a']);

		const quorum = harness();
		await quorum.driver.apply(quorum.lease);
		quorum.clock.now += 20_000;
		quorum.prober.failing.add('b');
		quorum.prober.corroborated.add('b');
		await quorum.driver.apply(quorum.lease);
		quorum.clock.now += 46_000;
		const removedFast = await quorum.driver.apply(quorum.lease);
		expect(removedFast.withdrawn).toEqual(['b']);
		expect(quorum.provider.contents('sites.test')).toEqual(['192.0.2.10']);
		expect(quorum.events.at(-1)).toMatchObject({ action: 'remove', status: 'completed', epoch: EPOCH });
	});

	test('never withdraws the last healthy record', async () => {
		const h = harness();
		await h.driver.apply(h.lease);
		h.clock.now += 20_000;
		h.prober.failing.add('a');
		h.prober.failing.add('b');
		h.prober.corroborated.add('a');
		h.prober.corroborated.add('b');
		await h.driver.apply(h.lease);
		h.clock.now += 46_000;
		const report = await h.driver.apply(h.lease);
		expect(report.withdrawn).toEqual([]);
		expect(report.written).toBe(0);
		expect(h.provider.contents('sites.test')).toEqual(['192.0.2.10', '192.0.2.11']);
		expect(report.alerts.map((alert) => alert.severity)).toContain('critical');
		expect(report.alerts.map((alert) => alert.key)).toContain('steering:dns-failover:last-healthy:a');
	});

	test('an API timeout leaves the set alone and retries after five seconds', async () => {
		const h = harness();
		await h.driver.apply(h.lease);
		h.provider.failures.set('delete', new DnsProviderError('Cloudflare API unreachable: timed out', true));
		h.clock.now += 20_000;
		h.prober.failing.add('b');
		h.prober.corroborated.add('b');
		await h.driver.apply(h.lease);
		h.clock.now += 46_000;
		const failed = await h.driver.apply(h.lease);
		expect(failed.written).toBe(0);
		expect(failed.failed).toBe(1);
		expect(h.provider.contents('sites.test')).toEqual(['192.0.2.10', '192.0.2.11']);
		expect(h.events.at(-1)).toMatchObject({ action: 'remove', status: 'failed' });
		expect(failed.alerts.map((alert) => alert.key)).toContain('steering:dns-failover:api');

		h.provider.failures.delete('delete');
		h.clock.now += 5_000;
		const retried = await h.driver.apply(h.lease);
		expect(retried.written).toBe(1);
		expect(retried.failed).toBe(0);
		expect(h.provider.contents('sites.test')).toEqual(['192.0.2.10']);
	});

	test('re-adds after 120 s of health, at most once per 10 minutes', async () => {
		const h = harness();
		await h.driver.apply(h.lease);
		h.clock.now += 20_000;
		h.prober.failing.add('b');
		h.prober.corroborated.add('b');
		await h.driver.apply(h.lease);
		h.clock.now += 46_000;
		expect((await h.driver.apply(h.lease)).withdrawn).toEqual(['b']);

		h.prober.failing.delete('b');
		h.prober.corroborated.delete('b');
		h.clock.now += 1_000;
		await h.driver.apply(h.lease);
		h.clock.now += 119_000;
		expect((await h.driver.apply(h.lease)).added).toEqual([]);
		h.clock.now += 2_000;
		const added = await h.driver.apply(h.lease);
		expect(added.added).toEqual(['b']);
		expect(h.provider.contents('sites.test')).toEqual(['192.0.2.10', '192.0.2.11']);

		// Withdraw again inside the 10-minute re-add interval: it stays out even when healthy.
		h.prober.failing.add('b');
		h.prober.corroborated.add('b');
		h.clock.now += 20_000;
		await h.driver.apply(h.lease);
		h.clock.now += 46_000;
		expect((await h.driver.apply(h.lease)).withdrawn).toEqual(['b']);
		h.prober.failing.delete('b');
		h.prober.corroborated.delete('b');
		h.clock.now += 1_000;
		await h.driver.apply(h.lease);
		h.clock.now += 120_000;
		expect((await h.driver.apply(h.lease)).added).toEqual([]);
	});

	test('a node withdrawn twice in 30 minutes is pinned for 30 minutes', async () => {
		const h = harness();
		await h.driver.apply(h.lease);
		const withdraw = async () => {
			h.clock.now += 20_000;
			h.prober.failing.add('b');
			h.prober.corroborated.add('b');
			await h.driver.apply(h.lease);
			h.clock.now += 46_000;
			expect((await h.driver.apply(h.lease)).withdrawn).toEqual(['b']);
			h.prober.failing.delete('b');
			h.prober.corroborated.delete('b');
		};
		await withdraw();
		h.clock.now += 1_000;
		await h.driver.apply(h.lease);
		h.clock.now += 120_000;
		expect((await h.driver.apply(h.lease)).added).toEqual(['b']);
		await withdraw();
		h.clock.now += 1_000;
		await h.driver.apply(h.lease);
		h.clock.now += 120_000;
		expect((await h.driver.apply(h.lease)).added).toEqual([]);
		expect(h.state.current.pinnedUntil.b).toBeGreaterThan(h.clock.now);
	});
});

describe('dns-failover lease and preflight', () => {
	test('no lease means no write and no event', async () => {
		const h = harness();
		h.lease = { epoch: EPOCH, holds: () => false };
		const report = await h.driver.apply(h.lease);
		expect(report.fenced).toBe(true);
		expect(report.written).toBe(0);
		expect(h.provider.writes).toBe(0);
		expect(h.events).toEqual([]);
		expect(h.state.current.records).toBeNull();
	});

	test('a lease lost mid-reconcile stops the remaining writes', async () => {
		const h = harness();
		let calls = 0;
		h.lease = { epoch: EPOCH, holds: () => ++calls <= 3 };
		const report = await h.driver.apply(h.lease);
		expect(report.fenced).toBe(true);
		expect(h.provider.writes).toBe(1);
		expect(h.events).toHaveLength(1);
	});

	test('desired() is read-only so the contract cannot write without a lease', async () => {
		const h = harness();
		await h.driver.desired();
		expect(h.provider.writes).toBe(0);
		expect(h.events).toEqual([]);
		expect(h.state.current.records).toBeNull();
	});

	test('preflight refuses one ingress, a missing provider, a missing address and a bad name', () => {
		const one = harness({ nodes: [{ id: 'a', name: 'edge-a', zone: 'z1', address: '192.0.2.10', status: 'online', offlineSince: null }] });
		expect(one.driver.preflight()).toContainEqual({ nodeId: 'a', reason: expect.stringContaining('at least two ingress') });

		const noProvider = harness({ provider: null });
		expect(noProvider.driver.preflight().map((finding) => finding.reason)).toContainEqual(expect.stringContaining('No DNS provider'));

		const noAddress = harness({
			nodes: [
				{ id: 'a', name: 'edge-a', zone: 'z1', address: '', status: 'online', offlineSince: null },
				{ id: 'b', name: 'edge-b', zone: 'z2', address: '192.0.2.11', status: 'online', offlineSince: null },
			],
		});
		expect(noAddress.driver.preflight()).toContainEqual({ nodeId: 'a', reason: expect.stringContaining('no public address') });

		const badName = harness({ records: [{ name: 'https://sites.test/path', ttl: 60, proxied: false }] });
		expect(badName.driver.preflight()).toContainEqual({ nodeId: null, reason: expect.stringContaining('not a hostname') });
	});

	test('with one ingress apply writes nothing', async () => {
		const h = harness({ nodes: [{ id: 'a', name: 'edge-a', zone: 'z1', address: '192.0.2.10', status: 'online', offlineSince: null }] });
		const report = await h.driver.apply(h.lease);
		expect(report.written).toBe(0);
		expect(h.provider.writes).toBe(0);
		expect(report.alerts.map((alert) => alert.key)).toContain('steering:dns-failover:one-ingress');
	});
});
