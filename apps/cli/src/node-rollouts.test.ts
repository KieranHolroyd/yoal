import { describe, expect, test } from 'bun:test';
import {
	formatRollout,
	formatRolloutList,
	formatRolloutPlan,
	resolveNode,
	rolloutChanges,
	rolloutExitCode,
	type RolloutNodeView,
	type RolloutPlanView,
	type RolloutView,
} from './node-rollouts.ts';

const options = { strategy: 'availability' as const, batchSize: 1, canary: true, drain: false, soakSeconds: 60, maxFailures: 0 };

function node(overrides: Partial<RolloutNodeView> = {}): RolloutNodeView {
	return {
		nodeId: 'nod_a',
		name: 'edge-b',
		wave: 0,
		state: 'pending',
		fromVersion: '0.8.0',
		version: '0.8.0',
		guarded: true,
		attempts: 0,
		error: null,
		startedAt: null,
		finishedAt: null,
		...overrides,
	};
}

function rolloutView(overrides: Partial<RolloutView> = {}): RolloutView {
	const nodes = overrides.nodes ?? [node(), node({ nodeId: 'nod_b', name: 'worker-1', wave: 1 })];
	return {
		id: 'nro_1',
		flowId: 'flw_1',
		status: 'running',
		phase: 'updating',
		detail: 'Updating edge-b.',
		targetVersion: '0.9.0',
		options,
		currentWave: 0,
		waves: 2,
		nodes,
		counts: {
			pending: nodes.filter((n) => n.state === 'pending').length,
			draining: 0,
			updating: nodes.filter((n) => n.state === 'updating').length,
			verifying: 0,
			done: nodes.filter((n) => n.state === 'done').length,
			failed: nodes.filter((n) => n.state === 'failed').length,
			skipped: 0,
		},
		failures: 0,
		error: null,
		trigger: 'manual',
		createdBy: 'usr_1',
		createdAt: '2026-11-14T10:00:00.000Z',
		updatedAt: '2026-11-14T10:01:00.000Z',
		finishedAt: null,
		...overrides,
	};
}

describe('plan', () => {
	test('lists each wave with its reason, groups and guard, then skipped nodes and warnings', () => {
		const plan: RolloutPlanView = {
			targetVersion: '0.9.0',
			strategy: 'availability',
			options,
			waves: [
				{
					index: 0,
					reason: 'canary',
					nodes: [{ id: 'nod_a', name: 'worker-1', zone: 'hel1', roles: ['compute'], agentVersion: '0.8.0', guarded: false, groups: [], singleCopies: 2 }],
				},
				{
					index: 1,
					reason: 'group limit',
					nodes: [{ id: 'nod_b', name: 'edge-b', zone: 'par1', roles: ['ingress', 'compute'], agentVersion: '0.8.0', guarded: true, groups: ['ingress'], singleCopies: 0 }],
				},
			],
			skipped: [{ nodeId: 'nod_c', name: 'mac-dev', reason: 'offline' }],
			current: 1,
			warnings: ['worker-1 has no rollback guard.'],
		};
		const text = formatRolloutPlan(plan);
		expect(text).toContain('Target 0.9.0 · availability · canary first · no drain · soak 60s · pause on the first failure');
		expect(text).toContain('2 nodes in 2 waves; 1 already on 0.9.0.');
		expect(text).toMatch(/1\s+canary\s+worker-1\s+hel1\s+compute\s+-\s+0\.8\.0\s+no rollback guard, 2 single-copy workloads/);
		expect(text).toMatch(/2\s+group limit\s+edge-b\s+par1\s+ingress,compute\s+ingress/);
		expect(text).toContain('Not updated:\n  mac-dev: offline');
		expect(text).toContain('Warnings:\n  ! worker-1 has no rollback guard.');
	});

	test('an empty plan says so', () => {
		const text = formatRolloutPlan({ targetVersion: '0.9.0', strategy: 'parallel', options: { ...options, strategy: 'parallel', canary: false }, waves: [], skipped: [], current: 3, warnings: [] });
		expect(text).toContain('Nothing to update. 3 nodes already on 0.9.0.');
		expect(text).not.toContain('WAVE');
	});
});

describe('status and list', () => {
	test('a paused rollout shows failed nodes and how to go on', () => {
		const view = rolloutView({
			status: 'paused',
			phase: 'paused',
			detail: 'Paused: 1 node failed.',
			nodes: [node({ state: 'failed', error: 'checksum mismatch', attempts: 1, guarded: false }), node({ nodeId: 'nod_b', name: 'worker-1', wave: 1 })],
		});
		const text = formatRollout(view);
		expect(text).toContain('Rollout nro_1  paused  → 0.9.0');
		expect(text).toMatch(/1\s+edge-b\s+failed\s+0\.8\.0\s+1\s+checksum mismatch; no rollback guard/);
		expect(text).toContain('yoal nodes rollout resume nro_1');
		expect(rolloutExitCode(view)).toBe(1);
		expect(rolloutExitCode({ ...view, status: 'succeeded' })).toBe(0);
	});

	test('list shows status, target, trigger and counts', () => {
		expect(formatRolloutList([])).toBe('No fleet updates yet.');
		const text = formatRolloutList([rolloutView({ trigger: 'auto', nodes: [node({ state: 'done' }), node({ nodeId: 'nod_b', name: 'w', state: 'failed' })] })]);
		expect(text).toMatch(/nro_1\s+running \(updating\)\s+0\.9\.0\s+availability\s+auto\s+2026-11-14 10:00:00Z\s+1\/2\s+1/);
	});
});

describe('following', () => {
	test('prints the wave, node and phase changes once each', () => {
		const first = rolloutView();
		expect(rolloutChanges(null, first)).toEqual(['Wave 1/2: edge-b', 'running (updating): Updating edge-b.']);
		const second = rolloutView({
			currentWave: 1,
			phase: 'soaking',
			detail: 'Soaking worker-1.',
			nodes: [node({ state: 'done', version: '0.9.0' }), node({ nodeId: 'nod_b', name: 'worker-1', wave: 1, state: 'updating' })],
		});
		expect(rolloutChanges(first, second)).toEqual([
			'Wave 2/2: worker-1',
			'  edge-b: done (0.9.0)',
			'  worker-1: updating',
			'running (soaking): Soaking worker-1.',
		]);
		expect(rolloutChanges(second, second)).toEqual([]);
	});
});

describe('resolveNode', () => {
	const nodes = [
		{ id: 'nod_1', name: 'edge' },
		{ id: 'nod_2', name: 'twin' },
		{ id: 'nod_3', name: 'twin' },
	];
	test('id first, then a unique name', () => {
		expect(resolveNode(nodes, 'nod_2').id).toBe('nod_2');
		expect(resolveNode(nodes, 'edge').id).toBe('nod_1');
		expect(() => resolveNode(nodes, 'twin')).toThrow(/2 nodes are named "twin"/);
		expect(() => resolveNode(nodes, 'nope')).toThrow(/No node "nope". Nodes: edge, twin, twin./);
	});
});
