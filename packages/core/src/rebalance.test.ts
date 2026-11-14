import { describe, expect, test } from 'bun:test';
import { planRebalance, type BalanceNode, type BalanceUnit } from './rebalance.ts';

const node = (id: string, reservedMb: number, over: Partial<BalanceNode> = {}): BalanceNode => ({
	id,
	name: id,
	zone: id,
	eligible: true,
	capacityMb: 1000,
	reservedMb,
	cpuCapacityMillis: null,
	reservedCpuMillis: 0,
	...over,
});

const unit = (id: string, nodeId: string, memoryMb: number, over: Partial<BalanceUnit> = {}): BalanceUnit => ({
	id,
	label: id,
	nodeId,
	memoryMb,
	cpuMillis: 0,
	blocker: null,
	avoidNodeIds: [],
	avoidZones: [],
	allowedNodeIds: null,
	...over,
});

describe('spread rebalance', () => {
	test('moves work off the full node until the gap is under the threshold', () => {
		const plan = planRebalance({
			strategy: 'spread',
			thresholdPercent: 20,
			maxMoves: 5,
			nodes: [node('a', 800), node('b', 0)],
			units: [unit('u1', 'a', 200), unit('u2', 'a', 200), unit('u3', 'a', 200), unit('u4', 'a', 200)],
		});
		expect(plan.gapBefore).toBe(80);
		expect(plan.moves.every((move) => move.fromNodeId === 'a' && move.toNodeId === 'b')).toBe(true);
		expect(plan.gapAfter).toBeLessThanOrEqual(20);
		expect(plan.moves).toHaveLength(2);
	});

	test('a balanced fleet plans nothing', () => {
		const plan = planRebalance({
			strategy: 'spread',
			thresholdPercent: 25,
			maxMoves: 5,
			nodes: [node('a', 500), node('b', 400)],
			units: [unit('u1', 'a', 500), unit('u2', 'b', 400)],
		});
		expect(plan.moves).toEqual([]);
		expect(plan.summary).toContain('balanced');
	});

	test('never moves a pinned unit, and says so', () => {
		const plan = planRebalance({
			strategy: 'spread',
			thresholdPercent: 10,
			maxMoves: 5,
			nodes: [node('a', 800), node('b', 0)],
			units: [unit('u1', 'a', 800, { blocker: 'has an app volume' })],
		});
		expect(plan.moves).toEqual([]);
		expect(plan.summary).toContain('pinned');
	});

	test('keeps sibling copies apart and respects capacity, CPU and the move cap', () => {
		const plan = planRebalance({
			strategy: 'spread',
			thresholdPercent: 5,
			maxMoves: 1,
			nodes: [
				node('a', 900),
				node('b', 100),
				node('c', 100, { cpuCapacityMillis: 1000, reservedCpuMillis: 900 }),
				node('d', 0, { eligible: false }),
			],
			units: [
				unit('copy', 'a', 300, { avoidNodeIds: ['b'], cpuMillis: 500 }),
				unit('free', 'a', 300),
				unit('other', 'a', 300),
			],
		});
		expect(plan.moves).toHaveLength(1);
		// `copy` may not join its sibling on b and does not fit c's CPU, so a free unit moves.
		expect(plan.moves[0]!.unitId).not.toBe('copy');
		expect(plan.moves[0]!.toNodeId).not.toBe('d');
	});

	test('does not swap which node is the full one', () => {
		const plan = planRebalance({
			strategy: 'spread',
			thresholdPercent: 10,
			maxMoves: 5,
			nodes: [node('a', 600), node('b', 0)],
			units: [unit('big', 'a', 600)],
		});
		expect(plan.moves).toEqual([]);
	});
});

describe('pack rebalance', () => {
	test('empties the lightest node onto the fullest that fits', () => {
		const plan = planRebalance({
			strategy: 'pack',
			thresholdPercent: 25,
			maxMoves: 5,
			nodes: [node('a', 600), node('b', 300), node('c', 100)],
			units: [unit('a1', 'a', 600), unit('b1', 'b', 300), unit('c1', 'c', 100)],
		});
		expect(plan.freedNodeIds).toContain('c');
		expect(plan.moves[0]).toMatchObject({ unitId: 'c1', fromNodeId: 'c', toNodeId: 'a' });
	});

	test('a node with a pinned unit is left whole', () => {
		const plan = planRebalance({
			strategy: 'pack',
			thresholdPercent: 25,
			maxMoves: 5,
			nodes: [node('a', 900), node('c', 200)],
			units: [unit('a1', 'a', 900), unit('c1', 'c', 100, { blocker: 'pinned' }), unit('c2', 'c', 100)],
		});
		// c holds a pinned unit, so it is not emptied; a does not fit on c, so it stays too.
		expect(plan.moves).toEqual([]);
		expect(plan.freedNodeIds).toEqual([]);
	});

	test('a node is emptied whole or not at all', () => {
		const plan = planRebalance({
			strategy: 'pack',
			thresholdPercent: 25,
			maxMoves: 5,
			nodes: [node('a', 800), node('c', 400)],
			units: [unit('a1', 'a', 800), unit('c1', 'c', 200), unit('c2', 'c', 200)],
		});
		// Only one of c's two units fits on a; moving it alone would free nothing.
		expect(plan.moves).toEqual([]);
	});
});
