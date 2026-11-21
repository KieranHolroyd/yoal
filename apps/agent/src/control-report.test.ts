import { describe, expect, test } from 'bun:test';
import { readControlReport } from './control-report.ts';

function body(overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		role: 'standby',
		epoch: 7,
		canPromote: true,
		reason: 'following nod_a at epoch 7',
		lease: { holder: 'nod_a', expiresAt: '2026-11-20T20:41:12.000Z', released: false, skewMs: 4 },
		replication: { restored: true, lagSeconds: 0.4, position: 'ltx:9/2' },
		promotion: { reasons: [] },
		...overrides,
	};
}

function responds(payload: unknown, status = 200) {
	const calls: string[] = [];
	const fetchImpl = (async (input: string | URL | Request) => {
		calls.push(String(input));
		return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

describe('agent control heartbeat report (W9-SPEC §4.6)', () => {
	test('maps the local /readyz document to the heartbeat control field', async () => {
		const { fetchImpl, calls } = responds(body());
		const report = await readControlReport('http://localhost/readyz', { fetchImpl });
		expect(report).toEqual({
			role: 'standby',
			epoch: 7,
			leaseHolderNodeId: 'nod_a',
			leaseExpiresAt: '2026-11-20T20:41:12.000Z',
			canPromote: true,
			replicationLagSeconds: 0.4,
		});
		expect(calls).toEqual(['http://localhost/readyz']);
	});

	test('forwards the host\'s running flags, and drops a malformed set without dropping the report', async () => {
		const flags = { REGIONS: false, STEERING: true };
		const { fetchImpl } = responds(body({ featureFlags: flags }));
		expect(await readControlReport('http://localhost/readyz', { fetchImpl })).toMatchObject({ role: 'standby', featureFlags: flags });
		const bad = responds(body({ featureFlags: { REGIONS: 'yes' } }));
		const report = await readControlReport('http://localhost/readyz', { fetchImpl: bad.fetchImpl });
		expect(report).toMatchObject({ role: 'standby', epoch: 7 });
		expect(report).not.toHaveProperty('featureFlags');
	});

	test('a 503 standby document is still reported, so a joining or behind node is visible', async () => {
		const { fetchImpl } = responds(
			body({ ok: false, role: 'standby-behind', canPromote: false, replication: { restored: true, lagSeconds: 12 } }),
			503,
		);
		expect(await readControlReport('http://localhost/readyz', { fetchImpl })).toMatchObject({
			role: 'standby-behind',
			canPromote: false,
			replicationLagSeconds: 12,
		});
	});

	test('an unknown role, a missing epoch or an unreachable endpoint yields null (never a broken heartbeat)', async () => {
		for (const payload of [body({ role: 'emperor' }), body({ epoch: -1 }), body({ canPromote: 'yes' }), { ok: true }]) {
			const { fetchImpl } = responds(payload);
			expect(await readControlReport('http://localhost/readyz', { fetchImpl })).toBeNull();
		}
		const failing = (async () => {
			throw new Error('connection refused');
		}) as unknown as typeof fetch;
		expect(await readControlReport('http://localhost/readyz', { fetchImpl: failing })).toBeNull();
		const html = (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch;
		expect(await readControlReport('http://localhost/readyz', { fetchImpl: html })).toBeNull();
	});
});
