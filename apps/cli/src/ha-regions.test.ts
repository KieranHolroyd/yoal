import { describe, expect, test } from 'bun:test';
import { formatRegionPlan, formatRegions, type RegionPromotionPlanView, type RegionsView } from './ha.ts';

const plan: RegionPromotionPlanView = {
	toRegion: 'ukwest',
	fromRegion: 'uksouth',
	planHash: 'a'.repeat(64),
	maxLagSeconds: 4,
	blockers: [],
	liveLeases: ['the control-plane lease is held by a1 until 2026-11-21T10:00:20.000Z'],
	steps: [
		{ position: 0, step: 'control-plane', kind: 'control-plane', resourceId: 'control-plane', name: 'control plane on b1', targetNodeId: 'n_b1', expectedGeneration: 5, fencedGeneration: null, status: 'pending', lagBytes: null, lagSeconds: null, startedAt: null, finishedAt: null, message: null },
		{ position: 1, step: 'databases', kind: 'database', resourceId: 'db_1', name: 'orders', targetNodeId: 'n_b1', expectedGeneration: 0, fencedGeneration: null, status: 'pending', lagBytes: 4096, lagSeconds: 4, startedAt: null, finishedAt: null, message: null },
		{ position: 2, step: 'steering', kind: 'steering', resourceId: 'direct', name: 'steering: direct', targetNodeId: null, expectedGeneration: 5, fencedGeneration: null, status: 'pending', lagBytes: null, lagSeconds: null, startedAt: null, finishedAt: null, message: null },
	],
};

describe('yoal ha region', () => {
	test('the plan names each step, its fence, the data loss and what still holds a lease', () => {
		const text = formatRegionPlan(plan);
		expect(text).toContain('Promote region ukwest (traffic and writes move from uksouth)');
		expect(text).toContain('control plane on b1');
		expect(text).toContain('at 5');
		expect(text).toContain('Data loss: writes in the last 4 s');
		expect(text).toContain(`Plan hash: ${'a'.repeat(64)}`);
		expect(text).toContain('Still held by uksouth: the control-plane lease is held by a1');
	});

	test('the regions table, and the flag-off line', () => {
		const view: RegionsView = {
			enabled: true,
			regions: [
				{ name: 'uksouth', zones: ['uks-1', 'uks-2'], nodes: [{ id: 'a', name: 'a1', zone: 'uks-1', online: false, roles: ['data'] }], primary: false, databases: { primaries: 2, standbys: 0 } },
				{ name: 'ukwest', zones: ['ukw-1'], nodes: [{ id: 'b', name: 'b1', zone: 'ukw-1', online: true, roles: ['data'] }], primary: true, databases: { primaries: 0, standbys: 1 } },
			],
			conflicts: [],
			active: null,
			recent: [],
			notes: [],
		};
		const text = formatRegions(view);
		expect(text).toMatch(/uksouth\s+uks-1, uks-2\s+a1\s+0\/1\s+2\s+0/);
		expect(text).toMatch(/ukwest\s+ukw-1\s+b1\s+1\/1\s+0\s+1\s+primary/);
		expect(formatRegions({ ...view, enabled: false })).toContain('Regions are off');
	});
});
