import { describe, expect, test } from 'bun:test';
import type { SteeringDriver } from '@yoal/contracts';
import { describeSteeringConformance, steeringContext, steeringNode } from '../conformance.ts';
import { steeringConformanceCases } from '../conformance-cases.ts';
import type { SteeringDriverContext, SteeringNode } from '../types.ts';
import {
	VipDriver,
	VIP_INSTANCE,
	type VipControl,
	type VipControlStatus,
	type VipNodeState,
} from './driver.ts';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const config = {
	address: '192.0.2.100',
	interface: 'eth0',
	routerId: 51,
	authPass: 's3cr3t',
	advertInterval: 1,
	instance: VIP_INSTANCE,
};

class FakeControl implements VipControl {
	readonly states = new Map<string, VipNodeState>();
	readonly running = new Set<string>();
	readonly stopped: string[] = [];
	readonly unavailable = new Set<string>();
	writes = 0;
	failConfigure: string | null = null;

	available(nodeId: string): boolean {
		return !this.unavailable.has(nodeId);
	}

	async configure(nodeId: string, state: VipNodeState): Promise<{ changed: boolean }> {
		this.writes += 1;
		if (this.failConfigure === nodeId) throw new Error(`configure failed for ${nodeId}`);
		this.states.set(nodeId, state);
		return { changed: true };
	}

	async start(nodeId: string): Promise<void> {
		this.writes += 1;
		this.running.add(nodeId);
	}

	async stop(nodeId: string): Promise<void> {
		this.writes += 1;
		this.running.delete(nodeId);
		this.stopped.push(nodeId);
	}

	async status(nodeId: string): Promise<VipControlStatus> {
		return {
			running: this.running.has(nodeId),
			interface: this.states.get(nodeId)?.interface ?? null,
			virtualAddress: this.states.get(nodeId)?.virtualAddress ?? null,
			addressPresent: this.states.get(nodeId)?.state === 'MASTER' && this.running.has(nodeId),
		};
	}
}

function fleet(overrides: Array<Partial<SteeringNode>> = [{}, {}, {}]): SteeringNode[] {
	return overrides.map((entry, index) =>
		steeringNode({
			id: `node-${index + 1}`,
			name: `node-${index + 1}`,
			zone: String.fromCharCode(97 + index),
			address: `10.0.0.${index + 1}`,
			...entry,
		}),
	);
}

function addressOf(node: SteeringNode): string | null {
	const suffix = Number(node.id.replace('node-', ''));
	return Number.isInteger(suffix) && suffix > 0 ? `10.0.0.${suffix}` : null;
}

function create(context: SteeringDriverContext, overrides: { preferredNodeId?: string | null; control?: FakeControl; config?: typeof config | null } = {}): {
	driver: VipDriver;
	control: FakeControl;
} {
	const control = overrides.control ?? new FakeControl();
	const driver = new VipDriver(context, {
		config: overrides.config === undefined ? config : overrides.config,
		control,
		addressOf,
		preferredNodeId: overrides.preferredNodeId ?? null,
	});
	return { driver, control };
}

describeSteeringConformance('vip', {
	create: (context) => create(context).driver,
});

describe('vip driver (H18)', () => {
	test('probes Yoal, writes keepalived and preserves the native client address', () => {
		const { driver } = create(steeringContext(fleet()));
		expect(driver.capabilities).toEqual({ probes: 'yoal', writes: true, preservesClientIp: 'native' });
	});

	test('preflight refuses a bad floating address or a node without a transport', () => {
		const bad = create(steeringContext(fleet()), { config: { ...config, address: 'not-an-ip' } }).driver.preflight();
		expect(bad.some((finding) => finding.nodeId === null && finding.reason.includes('not an IP'))).toBe(true);

		const control = new FakeControl();
		control.unavailable.add('node-2');
		const missing = create(steeringContext(fleet()), { control }).driver.preflight();
		expect(missing).toContainEqual({ nodeId: 'node-2', reason: expect.stringContaining('no helper transport') });
	});

	test('preflight refuses a VIP that is also a node address', () => {
		const findings = create(steeringContext(fleet()), { config: { ...config, address: '10.0.0.2' } }).driver.preflight();
		expect(findings.some((finding) => finding.nodeId === 'node-2' && finding.reason.includes('also node-2'))).toBe(true);
	});

	test('one master at 150 and every other serving node at 100', async () => {
		const { driver, control } = create(steeringContext(fleet()));
		await driver.desired();
		expect(control.running.size).toBe(3);
		const master = [...control.states.entries()].filter(([, state]) => state.state === 'MASTER');
		expect(master).toHaveLength(1);
		expect(master[0]![1].priority).toBe(150);
		expect(master[0]![1].virtualAddress).toBe(config.address);
		for (const [, state] of control.states) {
			if (state.state === 'BACKUP') expect(state.priority).toBe(100);
			expect(state.unicastPeers).toHaveLength(2);
			expect(state.authPass).toBe('s3cr3t');
		}
	});

	test('a preferred node holds the address while it is healthy', async () => {
		const { driver, control } = create(steeringContext(fleet()), { preferredNodeId: 'node-2' });
		await driver.desired();
		expect(control.states.get('node-2')?.state).toBe('MASTER');
		expect(control.states.get('node-1')?.state).toBe('BACKUP');
	});

	test('a failing node is stopped and the address stays with the preferred healthy node', async () => {
		let nodes = fleet();
		const settings = Object.freeze({} as never);
		const context: SteeringDriverContext = {
			now: () => NOW,
			nodes: () => nodes,
			settings: () => settings,
		};
		const { driver, control } = create(context, { preferredNodeId: 'node-2' });
		await driver.desired();
		nodes = fleet([{}, { status: 'offline' }, {}]);
		await driver.desired();
		expect(control.stopped).toEqual(['node-2']);
		expect(control.states.get('node-1')?.state).toBe('MASTER');
	});

	test('never removes the last healthy ingress and never exposes the VRRP secret', async () => {
		let nodes = fleet();
		const context: SteeringDriverContext = { now: () => NOW, nodes: () => nodes, settings: () => ({}) as never };
		const { driver, control } = create(context);
		await driver.desired();
		nodes = fleet([{}, { status: 'offline' }, { status: 'offline' }]);
		await driver.desired();
		expect(control.stopped).toEqual(['node-2', 'node-3']);
		nodes = fleet([{ status: 'offline' }, { status: 'offline' }, { status: 'offline' }]);
		await driver.desired();
		const report = driver.report();
		expect(report.withdrawn).toEqual([]);
		expect(report.records).toEqual(['node-1']);
		const observed = JSON.stringify(await driver.observe());
		expect(observed).not.toContain('s3cr3t');
	});

	test('a configure failure stops the pass before a withdrawal', async () => {
		let nodes = fleet();
		const context: SteeringDriverContext = { now: () => NOW, nodes: () => nodes, settings: () => ({}) as never };
		const { driver, control } = create(context);
		await driver.desired();
		control.failConfigure = 'node-1';
		nodes = fleet([{}, { status: 'offline' }, { status: 'offline' }]);
		await driver.desired();
		// The last healthy node is kept in the intended set, and no stop is issued after the failure.
		expect(driver.report().withdrawn).toEqual([]);
		expect(driver.report().error).toContain('configure failed');
		expect(control.stopped).toEqual([]);
	});

	test('two applies in a row write nothing the second time', async () => {
		const { driver, control } = create(steeringContext(fleet()));
		await driver.desired();
		const writes = control.writes;
		await driver.desired();
		expect(control.writes).toBe(writes);
	});

	test('the shared conformance cases pass, including the VRRP-address extra', async () => {
		const { driver, control } = create(steeringContext(fleet()));
		const cases = steeringConformanceCases({
			driver: driver as SteeringDriver,
			expectedKind: 'vip',
			writes: () => control.writes,
			apply: () => driver.desired(),
			lastHealthy: async () => {
				const { driver: last, control: lastControl } = create(steeringContext(fleet([{ status: 'offline' }, { status: 'offline' }, { status: 'offline' }])));
				await last.desired();
				return { withdrawn: last.report().withdrawn, records: lastControl.states.size ? last.report().records : [] };
			},
			extraCases: [
				{
					name: 'configures exactly one floating VRRP address',
					run: async () => {
						await driver.desired();
						for (const [, state] of control.states) expect(state.virtualAddress).toBe(config.address);
					},
				},
			],
		});
		for (const testCase of cases) await testCase.run();
	});
});
