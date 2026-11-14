import { describe, expect, test } from 'bun:test';
import { planReplicas } from './replicas.ts';

const node = (id: string, zone: string, freeMemoryMb: number, status = 'online') => ({
	id,
	name: id,
	zone,
	status,
	freeMemoryMb,
});

describe('replica planner', () => {
	test('spreads copies across nodes by free memory', () => {
		const decision = planReplicas({
			count: 2,
			memoryMb: 256,
			spread: 'node',
			candidates: [node('a', 'cloud', 1024), node('b', 'home', 2048), node('c', 'home', 512)],
		});
		expect(decision.ok).toBe(true);
		if (decision.ok) expect(decision.plan.assignments.map((item) => item.nodeId)).toEqual(['b', 'a']);
	});

	test('zone spread refuses a second copy in one zone', () => {
		const decision = planReplicas({
			count: 2,
			memoryMb: 128,
			spread: 'zone',
			candidates: [node('a', 'home', 1024), node('b', 'home', 1024)],
		});
		expect(decision.ok).toBe(false);
		if (!decision.ok) expect(decision.message).toContain('Cannot place 2 copies');
	});

	test('refuses when a node lacks room and names it', () => {
		const decision = planReplicas({
			count: 2,
			memoryMb: 512,
			spread: 'node',
			candidates: [node('a', 'cloud', 1024), node('b', 'home', 128)],
		});
		expect(decision.ok).toBe(false);
		if (!decision.ok) expect(decision.message).toContain('only 128 MB free');
	});

	test('ignores offline nodes', () => {
		const decision = planReplicas({
			count: 1,
			memoryMb: 128,
			spread: 'node',
			candidates: [node('a', 'cloud', 1024, 'offline'), node('b', 'home', 512)],
		});
		expect(decision.ok).toBe(true);
		if (decision.ok) expect(decision.plan.assignments[0]!.nodeId).toBe('b');
	});

	test('existing copies keep their node and index; only the missing ones are placed', () => {
		const decision = planReplicas({
			count: 3,
			memoryMb: 256,
			spread: 'node',
			reason: 'scale',
			existing: [
				{ index: 0, nodeId: 'c' },
				{ index: 1, nodeId: 'a' },
			],
			candidates: [node('a', 'cloud', 1024), node('b', 'home', 2048), node('c', 'home', 512)],
		});
		expect(decision.ok).toBe(true);
		if (!decision.ok) return;
		expect(decision.plan.assignments.map((item) => [item.index, item.nodeId])).toEqual([[0, 'c'], [1, 'a'], [2, 'b']]);
		expect(decision.kept).toEqual([0, 1]);
		expect(decision.placed).toEqual([2]);
		expect(decision.plan.assignments[2]!.reason).toStartWith('scale');
	});

	test('a copy on an offline node is re-placed, and a scale-down keeps the lowest indices', () => {
		const replaced = planReplicas({
			count: 2,
			memoryMb: 128,
			spread: 'node',
			existing: [
				{ index: 0, nodeId: 'a' },
				{ index: 1, nodeId: 'gone' },
			],
			candidates: [node('a', 'cloud', 1024), node('b', 'home', 512), node('gone', 'home', 512, 'offline')],
		});
		expect(replaced.ok && replaced.plan.assignments.map((item) => [item.index, item.nodeId])).toEqual([[0, 'a'], [1, 'b']]);

		const fewer = planReplicas({
			count: 1,
			memoryMb: 128,
			spread: 'node',
			existing: [
				{ index: 1, nodeId: 'b' },
				{ index: 0, nodeId: 'a' },
			],
			candidates: [node('a', 'cloud', 1024), node('b', 'home', 512)],
		});
		expect(fewer.ok && fewer.plan.assignments.map((item) => item.index)).toEqual([0]);
	});

	test('workers spread first, then stack, so there can be more copies than nodes', () => {
		const decision = planReplicas({
			count: 5,
			memoryMb: 100,
			spread: 'node',
			stack: true,
			candidates: [node('a', 'cloud', 1000), node('b', 'home', 250)],
		});
		expect(decision.ok).toBe(true);
		if (!decision.ok) return;
		const perNode = decision.plan.assignments.reduce<Record<string, number>>((count, item) => ({ ...count, [item.nodeId]: (count[item.nodeId] ?? 0) + 1 }), {});
		// b has room for two; the rest land on a.
		expect(perNode).toEqual({ a: 3, b: 2 });
	});

	test('an HTTP app never puts two copies on one node, and says how many would fit', () => {
		const decision = planReplicas({
			count: 3,
			memoryMb: 100,
			spread: 'node',
			candidates: [node('a', 'cloud', 1000), node('b', 'home', 1000)],
		});
		expect(decision.ok).toBe(false);
		if (decision.ok) return;
		expect(decision.placeable).toBe(2);
		expect(decision.message).toContain('already holds a copy');
	});

	test('a refused plan leaves the caller\'s candidates untouched', () => {
		const candidates = [node('a', 'cloud', 300)];
		planReplicas({ count: 2, memoryMb: 200, spread: 'node', stack: true, candidates });
		expect(candidates[0]!.freeMemoryMb).toBe(300);
	});
});
