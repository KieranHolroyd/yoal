import { describe, expect, test } from 'bun:test';
import { evaluateCandidate, type DatabaseLease } from '@yoal/contracts';
import { planReplicas, type ReplicaCandidate } from './replicas.ts';
import {
	crossRegionPromotionRefusal,
	partitionByPrimaryRegion,
	pickStandbyNode,
	planDatabaseReplicaNodes,
	regionPlanHash,
	regionSteeringSet,
	syncTargetRefusal,
	type StandbyCandidate,
} from './regions.ts';

/**
 * Pure region rules (HA-PLAN H26, W13) with fake nodes in two regions: uksouth (zones uks-1, uks-2)
 * and ukwest (zones ukw-1, ukw-2).
 */
const node = (id: string, zone: string, region: string, extra: Partial<ReplicaCandidate> = {}): ReplicaCandidate => ({
	id,
	name: id,
	zone,
	region,
	status: 'online',
	freeMemoryMb: 4096,
	...extra,
});
const fleet = (): ReplicaCandidate[] => [
	node('a1', 'uks-1', 'uksouth'),
	node('a2', 'uks-2', 'uksouth'),
	node('b1', 'ukw-1', 'ukwest'),
	node('b2', 'ukw-2', 'ukwest'),
];

describe('spread: region', () => {
	test('places copies across regions, never two in one region', () => {
		const decision = planReplicas({ count: 2, memoryMb: 256, spread: 'region', regions: true, candidates: fleet() });
		expect(decision.ok).toBe(true);
		if (!decision.ok) return;
		const regions = decision.plan.assignments.map((copy) => fleet().find((item) => item.id === copy.nodeId)!.region);
		expect(new Set(regions)).toEqual(new Set(['uksouth', 'ukwest']));
	});

	test('a third copy is refused with the region that already holds one', () => {
		const decision = planReplicas({ count: 3, memoryMb: 256, spread: 'region', regions: true, candidates: fleet() });
		expect(decision.ok).toBe(false);
		if (decision.ok) return;
		expect(decision.message).toContain('with region spread');
		expect(decision.refusals.map((refusal) => refusal.reason)).toEqual(
			expect.arrayContaining([expect.stringMatching(/^region (uksouth|ukwest) already holds a copy$/)]),
		);
	});

	test('existing copies keep their node and count against their region', () => {
		const decision = planReplicas({ count: 2, memoryMb: 256, spread: 'region', regions: true, candidates: fleet(), existing: [{ index: 0, nodeId: 'a2' }] });
		expect(decision.ok && decision.plan.assignments.map((copy) => copy.nodeId)[1]).toMatch(/^b[12]$/);
	});

	test('REGIONS off: a stored spread: region is placed as zone (two copies may share a region)', () => {
		const decision = planReplicas({ count: 3, memoryMb: 256, spread: 'region', regions: false, candidates: fleet() });
		expect(decision.ok).toBe(true);
	});

	test('database replicas: the primary and existing replicas count as copies', () => {
		const planned = planDatabaseReplicaNodes({
			primaryNodeId: 'a1',
			replicaNodeIds: [],
			replicas: 1,
			memoryMb: 512,
			spread: 'region',
			regions: true,
			candidates: fleet(),
		});
		expect(planned.ok && planned.nodeIds.length === 1 && planned.nodeIds[0]!.startsWith('b')).toBe(true);
		const zone = planDatabaseReplicaNodes({ primaryNodeId: 'a1', replicaNodeIds: [], replicas: 1, memoryMb: 512, spread: 'zone', regions: true, candidates: fleet() });
		expect(zone.ok && zone.nodeIds[0] !== 'a1').toBe(true);
		const tooMany = planDatabaseReplicaNodes({ primaryNodeId: 'a1', replicaNodeIds: ['b1'], replicas: 2, memoryMb: 512, spread: 'region', regions: true, candidates: fleet() });
		expect(tooMany.ok).toBe(false);
	});
});

describe('sync and automatic promotion stay inside a region', () => {
	test('a cross-region sync target is refused with both regions named', () => {
		expect(syncTargetRefusal({ name: 'a1', region: 'uksouth' }, { name: 'a2', region: 'uksouth' })).toBeNull();
		expect(syncTargetRefusal({ name: 'a1', region: 'uksouth' }, { name: 'b1', region: 'ukwest' })).toContain('b1 is in "ukwest"');
	});

	test('a replica outside the primary region is never an automatic candidate', () => {
		expect(crossRegionPromotionRefusal({ region: 'uksouth' }, { name: 'a2', region: 'uksouth' })).toBeNull();
		expect(crossRegionPromotionRefusal({ region: 'uksouth' }, { name: 'b1', region: 'ukwest' })).toContain('never promoted automatically');
		const byId = new Map(fleet().map((item) => [item.id, item]));
		const split = partitionByPrimaryRegion([{ nodeId: 'a2' }, { nodeId: 'b1' }, { nodeId: 'b2' }], 'a1', byId);
		expect(split.inRegion.map((row) => row.nodeId)).toEqual(['a2']);
		expect(split.refused.map((row) => row.replica.nodeId)).toEqual(['b1', 'b2']);
	});

	test('the W11 candidate rules refuse an unarmed member, which is what a standby-region node sees', () => {
		// `membersDesired` omits the policy for a node outside the primary region, so the agent passes
		// autoArmed: false (`desired.failover?.mode === 'auto'`). Every other condition holds here.
		const lease: DatabaseLease = {
			generation: 4,
			holderNodeId: 'a1',
			expiresAt: '2026-11-21T09:59:00.000Z',
			sync: [],
			syncState: 'steady',
			durability: 'async',
			durabilityEffective: 'async',
			syncSetAt: null,
		} as DatabaseLease;
		const evidence = {
			nodeId: 'b1',
			arbiterNow: Date.parse('2026-11-21T10:00:00Z'),
			lease,
			arbiterReachable: true,
			streaming: false,
			streamDownSince: Date.parse('2026-11-21T09:58:00Z'),
			acceptDataLoss: true,
			lastPrimaryAnswerAt: null,
			notice: null,
		};
		expect(evaluateCandidate({ ...evidence, autoArmed: true }).eligible).toBe(true);
		const standby = evaluateCandidate({ ...evidence, autoArmed: false });
		expect(standby.eligible).toBe(false);
		expect(standby.refusals.map((refusal) => refusal.code)).toEqual(['auto-not-armed']);
	});
});

describe('standby region node', () => {
	const candidate = (id: string, region: string, extra: Partial<StandbyCandidate> = {}): StandbyCandidate => ({
		id,
		name: id,
		zone: `${region}-1`,
		region,
		status: 'online',
		roles: ['compute', 'data'],
		overlay: true,
		replicaCapable: true,
		freeMemoryMb: 2048,
		...extra,
	});

	test('picks the data node with the most room in the region, and names why others cannot', () => {
		const picked = pickStandbyNode({
			region: 'ukwest',
			primaryNodeId: 'a1',
			memoryMb: 512,
			candidates: [
				candidate('a1', 'uksouth'),
				candidate('b1', 'ukwest', { freeMemoryMb: 1024 }),
				candidate('b2', 'ukwest', { freeMemoryMb: 4096 }),
				candidate('b3', 'ukwest', { roles: ['compute'] }),
				candidate('b4', 'ukwest', { replicaCapable: false }),
			],
		});
		expect(picked.node?.id).toBe('b2');
		expect(picked.reasons).toEqual(['b3: it has no data role', 'b4: its agent does not run database replicas']);
		expect(pickStandbyNode({ region: 'ukwest', primaryNodeId: 'a1', memoryMb: 512, candidates: [candidate('b1', 'ukwest', { status: 'offline' })] }).node).toBeNull();
	});
});

describe('promotion plan hash and stacked steering', () => {
	test('the plan hash moves when any generation moves', () => {
		const steps = [
			{ kind: 'control-plane' as const, resourceId: 'control-plane', expectedGeneration: 3 },
			{ kind: 'database' as const, resourceId: 'db_1', expectedGeneration: 7 },
		];
		const hash = regionPlanHash('ukwest', steps);
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
		expect(regionPlanHash('ukwest', steps)).toBe(hash);
		expect(regionPlanHash('ukwest', [steps[0]!, { ...steps[1]!, expectedGeneration: 8 }])).not.toBe(hash);
		expect(regionPlanHash('uksouth', steps)).not.toBe(hash);
	});

	test('drivers offer the active region, fall back across regions, and change nothing in one region', () => {
		const ingress = [
			{ id: 'a1', region: 'uksouth', status: 'online' },
			{ id: 'a2', region: 'uksouth', status: 'online' },
			{ id: 'b1', region: 'ukwest', status: 'online' },
		];
		expect(regionSteeringSet(ingress, null).map((row) => row.id)).toEqual(['a1', 'a2', 'b1']);
		expect(regionSteeringSet(ingress, 'uksouth').map((row) => row.id)).toEqual(['a1', 'a2']);
		expect(regionSteeringSet(ingress, 'ukwest').map((row) => row.id)).toEqual(['b1']);
		// Region A cut off: reads serve from B before anyone promotes it.
		const cut = ingress.map((row) => (row.region === 'uksouth' ? { ...row, status: 'offline' } : row));
		expect(regionSteeringSet(cut, 'uksouth').map((row) => row.id)).toEqual(['b1']);
		const oneRegion = ingress.map((row) => ({ ...row, region: 'default' }));
		expect(regionSteeringSet(oneRegion, 'default').map((row) => row.id)).toEqual(['a1', 'a2', 'b1']);
	});
});
