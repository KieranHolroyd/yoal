import { describe, expect, test } from 'bun:test';
import { DnsFailoverHealth, type DnsFailoverNode, type ProbeObservation } from './health.ts';

/**
 * Quorum and hold-down for `dns-failover` (CLUSTERING §7.2). Pure state, no provider and no
 * network: every case moves the clock explicitly.
 */

const T0 = 1_000_000;

function node(id: string, zone = 'z1'): DnsFailoverNode {
	return { id, name: id, zone, address: `10.0.0.${id === 'a' ? 1 : 2}`, status: 'online', offlineSince: null };
}

function report(nodeId: string, ok: boolean, at: number, observerId = 'primary', observerZone = 'control'): ProbeObservation {
	return { nodeId, observerId, observerZone, ok, at, reason: ok ? 'ok' : 'http-status' };
}

function health(): DnsFailoverHealth {
	const state = new DnsFailoverHealth({ holdDownMs: 45_000, readdHoldDownMs: 120_000, staleAfterMs: 10 * 60_000 });
	state.setPrimaryObserver('primary', 'control');
	return state;
}

describe('dns-failover hold-down', () => {
	test('a single witness waits for the doubled hold-down', () => {
		const state = health();
		state.observe(report('a', true, T0 - 20_000));
		state.observe(report('b', true, T0 - 20_000));
		state.observe(report('b', false, T0 + 1_000));
		expect(state.decision([node('a'), node('b')], ['a', 'b'], T0 + 46_000).remove).toEqual([]);
		const decision = state.decision([node('a'), node('b')], ['a', 'b'], T0 + 91_000);
		expect(decision.remove.map((removal) => removal.nodeId)).toEqual(['b']);
		expect(decision.remove[0]!.witness).toBe('single-witness');
		expect(decision.singleWitness).toBe(true);
	});

	test('a corroborating probe from another zone uses the base hold-down', () => {
		const state = health();
		state.observe(report('a', true, T0 - 20_000));
		state.observe(report('b', true, T0 - 20_000));
		state.observe(report('b', false, T0 + 1_000));
		state.observe(report('b', false, T0 + 40_000, 'b-observer', 'z2'));
		expect(state.decision([node('a'), node('b')], ['a', 'b'], T0 + 46_000).remove.map((removal) => removal.nodeId)).toEqual(['b']);
		expect(state.decision([node('a'), node('b')], ['a', 'b'], T0 + 46_000).remove[0]!.witness).toBe('quorum');
	});

	test('a probe from the same zone is not corroboration', () => {
		const state = health();
		state.observe(report('a', true, T0 - 20_000));
		state.observe(report('b', false, T0 + 1_000));
		state.observe(report('b', false, T0 + 40_000, 'same-zone', 'control'));
		expect(state.decision([node('a'), node('b')], ['a', 'b'], T0 + 46_000).remove).toEqual([]);
		expect(state.decision([node('a'), node('b')], ['a', 'b'], T0 + 91_000).remove[0]!.witness).toBe('single-witness');
	});

	test('a replicated offline status corroborates after two minutes', () => {
		const state = health();
		state.observe(report('a', true, T0 - 20_000));
		state.observe(report('b', false, T0 + 1_000));
		state.observeNodeStatus('b', T0);
		expect(state.decision([node('a'), node('b')], ['a', 'b'], T0 + 46_000).remove).toEqual([]);
		const decision = state.decision([node('a'), node('b')], ['a', 'b'], T0 + 121_000);
		expect(decision.remove.map((removal) => removal.nodeId)).toEqual(['b']);
		expect(decision.remove[0]!.witness).toBe('offline');
	});

	test('a success resets the failure streak', () => {
		const state = health();
		state.observe(report('a', true, T0 - 20_000));
		state.observe(report('b', false, T0 + 1_000));
		state.observe(report('b', false, T0 + 40_000, 'b-observer', 'z2'));
		state.observe(report('b', true, T0 + 50_000));
		state.observe(report('b', false, T0 + 60_000));
		state.observe(report('b', false, T0 + 70_000, 'b-observer', 'z2'));
		expect(state.decision([node('a'), node('b')], ['a', 'b'], T0 + 100_000).remove).toEqual([]);
		expect(state.decision([node('a'), node('b')], ['a', 'b'], T0 + 106_000).remove.map((removal) => removal.nodeId)).toEqual(['b']);
	});

	test('a success in the ten seconds before the first failure delays the streak', () => {
		const state = health();
		state.observe(report('a', true, T0 - 20_000));
		state.observe(report('b', false, T0 + 1_000));
		state.observe(report('b', true, T0 + 5_000));
		state.observe(report('b', false, T0 + 6_000));
		state.observe(report('b', false, T0 + 40_000, 'b-observer', 'z2'));
		// The streak starts at the success + 10 s grace, so 45 s of failure is not reached until 15 s + 45 s.
		expect(state.decision([node('a'), node('b')], ['a', 'b'], T0 + 55_000).remove).toEqual([]);
		expect(state.decision([node('a'), node('b')], ['a', 'b'], T0 + 61_000).remove.map((removal) => removal.nodeId)).toEqual(['b']);
	});
});

describe('dns-failover last healthy record', () => {
	test('never withdraws when every record is failing', () => {
		const state = health();
		state.observe(report('a', false, T0 + 1_000));
		state.observe(report('b', false, T0 + 1_000));
		state.observe(report('a', false, T0 + 50_000, 'a-observer', 'z2'));
		state.observe(report('b', false, T0 + 50_000, 'b-observer', 'z2'));
		const decision = state.decision([node('a'), node('b')], ['a', 'b'], T0 + 91_000);
		expect(decision.remove).toEqual([]);
		expect(decision.lastHealthyRefused.sort()).toEqual(['a', 'b']);
	});

	test('withdraws a failed node while one healthy record remains', () => {
		const state = health();
		state.observe(report('a', true, T0 - 20_000));
		state.observe(report('b', false, T0 + 1_000));
		state.observe(report('b', false, T0 + 50_000, 'b-observer', 'z2'));
		const decision = state.decision([node('a'), node('b')], ['a', 'b'], T0 + 91_000);
		expect(decision.remove.map((removal) => removal.nodeId)).toEqual(['b']);
		expect(decision.keep).toEqual(['a']);
	});
});

describe('dns-failover re-add and disagreement', () => {
	test('adds a recovered node only after the re-add hold-down', () => {
		const state = health();
		state.observe(report('a', true, T0 - 20_000));
		state.observe(report('b', false, T0 + 1_000));
		state.observe(report('a', true, T0 + 100_000));
		state.observe(report('b', true, T0 + 100_000));
		expect(state.decision([node('a'), node('b')], ['a'], T0 + 219_000).add).toEqual([]);
		expect(state.decision([node('a'), node('b')], ['a'], T0 + 221_000).add.map((addition) => addition.nodeId)).toEqual(['b']);
	});

	test('reports observers that disagree with the primary', () => {
		const state = health();
		state.observe(report('a', true, T0 - 20_000));
		state.observe(report('a', false, T0, 'b-observer', 'z2'));
		const decision = state.decision([node('a')], ['a'], T0 + 1_000);
		expect(decision.disagreements).toEqual([{ nodeId: 'a', observers: ['b-observer'] }]);
	});

	test('a stale report is not evidence', () => {
		const state = new DnsFailoverHealth({ staleAfterMs: 60_000 });
		state.setPrimaryObserver('primary', 'control');
		state.observe(report('a', true, T0));
		expect(state.decision([node('a')], ['a'], T0 + 61_000).healthy).toEqual([]);
	});
});
