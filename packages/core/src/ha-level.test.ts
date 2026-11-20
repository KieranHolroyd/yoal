import { describe, expect, test } from 'bun:test';
import { computeHaLevel, type HaLevelInput } from './ha-level.ts';

/**
 * HA-PLAN G24 / CLUSTERING §8.1: the level describes where things run now. These tests pin the
 * ladder, the stateful ceiling at L2 and the blockers that name the next step.
 */

const input = (overrides: Partial<HaLevelInput>): HaLevelInput => ({
	kind: 'workload',
	copies: 1,
	nodes: 1,
	zones: 1,
	verifiedBackup: false,
	http: true,
	pinned: false,
	...overrides,
});

describe('computeHaLevel', () => {
	test('one copy on one node is L0 and names the second copy', () => {
		expect(computeHaLevel(input({}))).toEqual({ level: 'L0', blockers: ['add a second copy on another node'] });
	});

	test('a verified backup lifts a single copy to L1', () => {
		expect(computeHaLevel(input({ verifiedBackup: true }))).toEqual({ level: 'L1', blockers: ['add a second copy on another node'] });
	});

	test('copies on two nodes but one zone are L2 and name the zone', () => {
		expect(computeHaLevel(input({ copies: 3, nodes: 3, zones: 1 }))).toEqual({ level: 'L2', blockers: ['add a copy in another zone'] });
	});

	test('copies in two zones are L3 with no blockers', () => {
		expect(computeHaLevel(input({ copies: 3, nodes: 3, zones: 2 }))).toEqual({ level: 'L3', blockers: [] });
	});

	test('a pinned workload cannot pass L1, even spread across zones', () => {
		expect(computeHaLevel(input({ copies: 3, nodes: 3, zones: 3, pinned: true, verifiedBackup: true }))).toEqual({
			level: 'L1',
			blockers: ['pinned to one node'],
		});
	});

	test('a database with a replica elsewhere is L2, never L3', () => {
		expect(computeHaLevel(input({ kind: 'database', copies: 2, nodes: 2, zones: 2 }))).toEqual({
			level: 'L2',
			blockers: ['a database with replicas is L2; L3 is for stateless copies'],
		});
	});

	test('an unbacked single database is L0 and names both gaps', () => {
		expect(computeHaLevel(input({ kind: 'database' }))).toEqual({
			level: 'L0',
			blockers: ['no verified backup', 'add a replica on another node'],
		});
	});

	test('a backed-up single database is L1 and still needs a replica', () => {
		expect(computeHaLevel(input({ kind: 'database', verifiedBackup: true }))).toEqual({
			level: 'L1',
			blockers: ['add a replica on another node'],
		});
	});

	test('storage follows the same ladder', () => {
		expect(computeHaLevel(input({ kind: 'storage', copies: 2, nodes: 2, zones: 2, verifiedBackup: true }))).toEqual({
			level: 'L2',
			blockers: ['a storage with replicas is L2; L3 is for stateless copies'],
		});
	});
});
