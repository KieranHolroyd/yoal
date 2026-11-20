import { describe, expect, test } from 'bun:test';
import type { SteeringDriver } from '@yoal/contracts';
import type { CoreContext } from '../context.ts';
import { SteeringService } from '../ingress-service.ts';
import { steeringConformanceCases, type SteeringConformanceSubject } from './conformance-cases.ts';
import { steeringContext, steeringNode } from './conformance.ts';
import { createDirectDriver } from './direct/index.ts';
import { STEERING_DRIVER_FACTORIES } from './registry.ts';
import type { DnsProvider, DnsRecord, DnsRecordInput } from './dns/provider.ts';
import { DnsFailoverDriver, emptyDnsFailoverState, type DnsFailoverState } from './dns-failover/driver.ts';
import type { DnsFailoverNode, ProbeObservation } from './dns-failover/health.ts';

/**
 * The shared steering conformance suite (HA-PLAN H18, Wave 2). Both drivers that exist in this
 * branch run through it: `direct` (the today path) and `dns-failover` (lane E).
 */

class MemoryProvider implements DnsProvider {
	readonly kind = 'fake';
	readonly records: DnsRecord[] = [];
	writes = 0;
	#seq = 0;
	async listRecords(name: string): Promise<DnsRecord[]> {
		return this.records.filter((record) => record.name === name);
	}
	async createRecord(input: DnsRecordInput): Promise<DnsRecord> {
		const record: DnsRecord = { id: `r${++this.#seq}`, ...input, ttl: input.proxied ? 1 : input.ttl };
		this.records.push(record);
		this.writes += 1;
		return record;
	}
	async updateRecord(id: string, input: DnsRecordInput): Promise<DnsRecord> {
		const record = this.records.find((candidate) => candidate.id === id)!;
		Object.assign(record, input);
		this.writes += 1;
		return record;
	}
	async deleteRecord(id: string): Promise<void> {
		const index = this.records.findIndex((candidate) => candidate.id === id);
		if (index >= 0) this.records.splice(index, 1);
		this.writes += 1;
	}
}

const NODES: DnsFailoverNode[] = [
	{ id: 'a', name: 'edge-a', zone: 'z1', address: '192.0.2.10', status: 'online', offlineSince: null },
	{ id: 'b', name: 'edge-b', zone: 'z2', address: '192.0.2.11', status: 'online', offlineSince: null },
];

function dnsDriver(options: { failAll?: () => boolean; multiObserver?: boolean } = {}): {
	driver: DnsFailoverDriver;
	provider: MemoryProvider;
	state: { current: DnsFailoverState };
	clock: { now: number };
} {
	const clock = { now: 1_000_000 };
	const provider = new MemoryProvider();
	const state = { current: emptyDnsFailoverState() };
	const driver = new DnsFailoverDriver({
		provider,
		nodes: () => NODES,
		records: [{ name: 'sites.test', ttl: 60, proxied: false }],
		prober: {
			async probe(targets, at): Promise<ProbeObservation[]> {
				const fail = options.failAll?.() ?? false;
				const primary = targets.map(
					(node): ProbeObservation => ({
						nodeId: node.id,
						observerId: 'primary',
						observerZone: 'control',
						ok: !fail,
						at,
						reason: fail ? 'timeout' : 'ok',
					}),
				);
				if (!options.multiObserver) return primary;
				return primary.map((report) => report).concat(primary.map((report) => ({ ...report, observerId: 'corroborator', observerZone: 'z2' })));
			},
		},
		observer: { id: 'primary', zone: 'control' },
		now: () => clock.now,
		state: {
			load: () => structuredClone(state.current),
			save: (next) => {
				state.current = structuredClone(next);
			},
		},
		onEvent: () => undefined,
		health: { staleAfterMs: 10 * 60_000 },
		probeIntervalMs: 0,
	});
	return { driver, provider, state, clock };
}

function lastHealthyScenario(): Promise<{ withdrawn: string[]; records: string[] }> | { withdrawn: string[]; records: string[] } {
	let failing = false;
	// Corroborate so the 45 s hold-down (not the 90 s single-witness one) is due at 66 s: without
	// that, the case would pass even if the last-healthy guard were deleted.
	const h = dnsDriver({ failAll: () => failing, multiObserver: true });
	const lease = { epoch: 1, holds: () => true };
	const run = async () => {
		await h.driver.apply(lease);
		failing = true;
		h.clock.now += 20_000;
		await h.driver.apply(lease);
		h.clock.now += 46_000;
		const report = await h.driver.apply(lease);
		return { withdrawn: report.withdrawn, records: h.provider.records.map((record) => record.content) };
	};
	return run();
}

describe('steering conformance', () => {
	const direct = createDirectDriver(steeringContext([steeringNode()]));
	for (const testCase of steeringConformanceCases({ driver: direct, expectedKind: 'direct' }))
		test(`direct: ${testCase.name}`, testCase.run);

	const dns = dnsDriver();
	const subject: SteeringConformanceSubject = {
		driver: dns.driver,
		expectedKind: 'dns-failover',
		writes: () => dns.provider.writes,
		apply: async () => {
			await dns.driver.apply({ epoch: 1, holds: () => true });
		},
		lastHealthy: lastHealthyScenario,
	};
	for (const testCase of steeringConformanceCases(subject)) test(`dns-failover: ${testCase.name}`, testCase.run);

	test('SteeringService returns direct and the registered dns-failover driver', () => {
		const service = new SteeringService({} as CoreContext, { ...STEERING_DRIVER_FACTORIES, 'dns-failover': () => dns.driver });
		expect(service.driver('direct').kind).toBe('direct');
		expect(service.driver('dns-failover')).toBe(dns.driver);
		expect(() => service.driver('vip')).toThrow('not implemented');
	});
});
