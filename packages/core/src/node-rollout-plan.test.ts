import { describe, expect, test } from 'bun:test';
import { nodeRolloutOptionsSchema, type NodeRolloutOptions } from '@yoal/contracts';
import {
	exposedGroups,
	planRollout,
	resolveRolloutOptions,
	type RolloutFacts,
	type RolloutFleetNode,
} from './node-rollout-plan.ts';

const node = (id: string, extra: Partial<RolloutFleetNode> = {}): RolloutFleetNode => ({
	id,
	name: id,
	zone: null,
	roles: ['compute', 'data'],
	online: true,
	agentVersion: '0.7.0',
	canUpdate: true,
	guarded: true,
	current: false,
	singleCopies: 0,
	...extra,
});

const options = (input: Partial<NodeRolloutOptions> = {}) =>
	resolveRolloutOptions(nodeRolloutOptionsSchema.parse(input));

const waves = (facts: RolloutFacts, input: Partial<NodeRolloutOptions> = {}) =>
	planRollout(facts, options(input)).waves.map((wave) => wave.nodeIds);

describe('fleet rollout planning (CLUSTERING §3.11)', () => {
	const five: RolloutFacts = { nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => node(id)), groups: [] };

	test('rolling goes one node at a time by default, in batches when asked', () => {
		expect(waves(five, { strategy: 'rolling' })).toEqual([['a'], ['b'], ['c'], ['d'], ['e']]);
		// A batch after the canary.
		expect(waves(five, { strategy: 'rolling', batchSize: 2 })).toEqual([['a'], ['b', 'c'], ['d', 'e']]);
		expect(waves(five, { strategy: 'rolling', batchSize: 2, canary: false })).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
	});

	test('parallel updates everything in one wave, unless a canary is asked for', () => {
		expect(waves(five, { strategy: 'parallel' })).toEqual([['a', 'b', 'c', 'd', 'e']]);
		expect(waves(five, { strategy: 'parallel', canary: true })).toEqual([['a'], ['b', 'c', 'd', 'e']]);
	});

	test('availability starts with a canary and caps waves at half the fleet', () => {
		const plan = planRollout(five, options({ strategy: 'availability' }));
		expect(plan.waves.map((wave) => wave.nodeIds)).toEqual([['a'], ['b', 'c'], ['d', 'e']]);
		expect(plan.waves[0]!.reason).toBe('canary');
	});

	test('availability never puts every member of a redundant group in one wave', () => {
		const facts: RolloutFacts = {
			nodes: [
				node('edge-1', { roles: ['ingress', 'compute'] }),
				node('edge-2', { roles: ['ingress', 'compute'] }),
				node('w1'),
				node('w2'),
				node('w3'),
				node('w4'),
			],
			groups: [
				{ key: 'ingress', nodeIds: ['edge-1', 'edge-2'] },
				{ key: 'workload:web', nodeIds: ['w1', 'w2'] },
				{ key: 'database:main', nodeIds: ['w3', 'w4'] },
			],
		};
		const plan = waves(facts, { strategy: 'availability' });
		for (const wave of plan) {
			const set = new Set(wave);
			expect(exposedGroups(set, facts)).toEqual([]);
		}
		expect(plan.flat().sort()).toEqual(['edge-1', 'edge-2', 'w1', 'w2', 'w3', 'w4']);
		// Ingress nodes go last, after the rest of the fleet has proven the release.
		expect(plan.at(-1)).toContain('edge-2');
	});

	test('a group whose other member is offline counts as exposed', () => {
		const facts: RolloutFacts = {
			nodes: [node('a'), node('b', { online: false })],
			groups: [{ key: 'workload:web', nodeIds: ['a', 'b'] }],
		};
		expect(exposedGroups(new Set(['a']), facts).map((group) => group.key)).toEqual(['workload:web']);
		// The control-plane host (current, not updated) still counts as a member keeping it up.
		const withHost: RolloutFacts = {
			nodes: [node('a'), node('host', { current: true })],
			groups: [{ key: 'ingress', nodeIds: ['a', 'host'] }],
		};
		expect(exposedGroups(new Set(['a']), withHost)).toEqual([]);
	});

	test('skips current, offline and pre-D99 nodes, and filters to the chosen nodes', () => {
		const facts: RolloutFacts = {
			nodes: [
				node('done', { current: true, agentVersion: '0.8.0' }),
				node('down', { online: false }),
				node('old', { canUpdate: false, agentVersion: '0.5.0' }),
				node('ok'),
				node('other'),
			],
			groups: [],
		};
		const plan = planRollout(facts, options({ strategy: 'rolling' }));
		expect(plan.current).toBe(1);
		expect(plan.skipped.map((entry) => entry.nodeId)).toEqual(['down', 'old']);
		expect(plan.skipped[1]!.reason).toMatch(/by hand once/);
		expect(plan.waves.map((wave) => wave.nodeIds)).toEqual([['ok'], ['other']]);
		expect(planRollout(facts, options({ strategy: 'rolling' }), new Set(['ok'])).waves).toEqual([
			{ nodeIds: ['ok'], reason: 'one at a time' },
		]);
	});

	test('warns about single copies, unguarded agents and parallel groups', () => {
		const facts: RolloutFacts = {
			nodes: [node('a', { singleCopies: 2, guarded: false }), node('b')],
			groups: [{ key: 'ingress', nodeIds: ['a', 'b'] }],
		};
		const parallel = planRollout(facts, options({ strategy: 'parallel' }));
		expect(parallel.warnings.join('\n')).toMatch(/Every node of ingress/);
		expect(parallel.warnings.join('\n')).toMatch(/2 workloads have a single copy/);
		expect(parallel.warnings.join('\n')).toMatch(/a runs an agent without the rollback guard/);
		expect(planRollout(facts, options({ strategy: 'parallel', drain: true })).warnings.join('\n')).not.toMatch(
			/single copy/,
		);
	});
});
