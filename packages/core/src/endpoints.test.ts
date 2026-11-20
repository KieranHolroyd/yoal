import { describe, expect, test } from 'bun:test';
import { planReadEndpoints, planServiceEndpoints } from './endpoints.ts';

const db = {
	kind: 'database' as const,
	serviceId: 'db_1',
	upstreamNodeId: 'nod_b',
	upstreamPort: 15432,
	address: '10.47.1.2',
};

describe('service endpoint planning', () => {
	test('allocates a stable loopback port for a cross-node service', () => {
		const plan = planServiceEndpoints('nod_a', [db], []);
		expect(plan.endpoints).toEqual([
			expect.objectContaining({
				id: 'sep_nod_a_database_db_1',
				localPort: 21_000,
				upstream: { nodeId: 'nod_b', address: '10.47.1.2', port: 15_432 },
			}),
		]);
	});

	test('reuses the port when the provider moves', () => {
		const first = planServiceEndpoints('nod_a', [db], []);
		const moved = planServiceEndpoints('nod_a', [{ ...db, upstreamNodeId: 'nod_c', address: '10.47.1.3' }], [
			{ kind: 'database', serviceId: 'db_1', localPort: first.endpoints[0]!.localPort },
		]);
		expect(moved.endpoints[0]).toMatchObject({ localPort: 21_000, upstream: { nodeId: 'nod_c' } });
	});

	test('same-node attachments get no endpoint', () => {
		expect(planServiceEndpoints('nod_a', [{ ...db, upstreamNodeId: 'nod_a' }], []).endpoints).toEqual([]);
	});

	test('removes an endpoint whose attachment went away', () => {
		const plan = planServiceEndpoints('nod_a', [], [{ kind: 'database', serviceId: 'db_1', localPort: 21_000 }]);
		expect(plan.endpoints).toEqual([]);
		expect(plan.removed).toEqual(['database:db_1:primary']);
	});

	test('does not reuse a port held by another service', () => {
		const plan = planServiceEndpoints('nod_a', [db, { ...db, serviceId: 'db_2' }], []);
		expect(plan.endpoints.map((endpoint) => endpoint.localPort)).toEqual([21_000, 21_001]);
	});

	test('a new service planned before a kept one never takes the kept port', () => {
		// db_2 already owns 21000; db_new comes first in the list and must not be handed 21000.
		const plan = planServiceEndpoints('nod_a', [{ ...db, serviceId: 'db_new' }, { ...db, serviceId: 'db_2' }], [
			{ kind: 'database', serviceId: 'db_2', localPort: 21_000 },
		]);
		const ports = Object.fromEntries(plan.endpoints.map((endpoint) => [endpoint.serviceId, endpoint.localPort]));
		expect(ports).toEqual({ db_new: 21_001, db_2: 21_000 });
	});

	test('two projects attached to one service share a single endpoint', () => {
		const plan = planServiceEndpoints('nod_a', [db, { ...db }], []);
		expect(plan.endpoints).toHaveLength(1);
	});

	test('with the gateway a same-node attachment gets an endpoint too (H24)', () => {
		const plan = planServiceEndpoints('nod_a', [{ ...db, upstreamNodeId: 'nod_a' }], [], undefined, { includeSameNode: true });
		expect(plan.endpoints).toHaveLength(1);
		expect(plan.endpoints[0]!.localPort).toBe(21_000);
		expect(plan.endpoints[0]!.upstream.nodeId).toBe('nod_a');
	});

	test('pool and primary endpoints are separate and both stable', () => {
		const plan = planServiceEndpoints('nod_a', [db, { ...db, role: 'pool', upstreamPort: 6_432 }], []);
		expect(plan.endpoints).toHaveLength(2);
		expect(plan.endpoints.map((endpoint) => [endpoint.role ?? 'primary', endpoint.localPort])).toEqual([
			['primary', 21_000],
			['pool', 21_001],
		]);
		const moved = planServiceEndpoints(
			'nod_a',
			[db, { ...db, role: 'pool', upstreamPort: 6_432 }],
			[{ kind: 'database', serviceId: 'db_1', localPort: 21_000, role: 'primary' }, { kind: 'database', serviceId: 'db_1', localPort: 21_001, role: 'pool' }],
		);
		expect(moved.endpoints.map((endpoint) => endpoint.localPort)).toEqual([21_000, 21_001]);
	});

	test('read endpoints allocate from the read range and keep their port', () => {
		const first = planReadEndpoints('nod_a', [{ serviceId: 'db_1', upstreamNodeId: 'nod_b', upstreamPort: 15_432 }], []);
		expect(first.endpoints[0]).toMatchObject({ serviceId: 'db_1', localPort: 23_000 });
		const moved = planReadEndpoints(
			'nod_a',
			[{ serviceId: 'db_1', upstreamNodeId: 'nod_c', upstreamPort: 15_432 }],
			[{ serviceId: 'db_1', localPort: 23_000 }],
		);
		expect(moved.endpoints[0]).toMatchObject({ localPort: 23_000, upstreamNodeId: 'nod_c' });
	});
});
