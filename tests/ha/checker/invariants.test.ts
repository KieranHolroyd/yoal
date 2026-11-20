import { describe, expect, test } from 'bun:test';
import { CHECKS, duplicateSingletonRuns } from './invariants.ts';
import type { CheckerLog, RequestRecord, SingletonRun } from './log.ts';
import { type Observation, parseObservations } from './observations.ts';
import { INVARIANT_IDS, type InvariantId, reportSchema } from './report.ts';
import { longestWriteGapMs, summarize } from './summarize.ts';

const T0 = Date.parse('2026-11-20T10:00:00Z');
const s = (seconds: number) => T0 + seconds * 1000;

function obs(t: number, kind: Observation['kind'], node: string, fields: Record<string, unknown> = {}): Observation {
	return { t: s(t), kind, node, ...fields } as Observation;
}

let ids = 0;
function req(kind: RequestRecord['kind'], n: number, start: number, status = 200, extra: Partial<RequestRecord> = {}): RequestRecord {
	return { id: ids++, kind, n, startedAt: s(start), endedAt: s(start) + 20, status, ...(kind !== 'write' && status === 200 ? { match: true } : {}), ...extra };
}

function log(requests: RequestRecord[] = [], singletonRuns: SingletonRun[] = []): CheckerLog {
	return { seed: 1, writer: 'chk-1', startedAt: s(0), endedAt: s(120), requests, singletonRuns };
}

/** Three histories per invariant: a planted violation, a clean run, and nothing relevant. */
const CASES: Record<InvariantId, { violation: () => [CheckerLog, Observation[]]; clean: () => [CheckerLog, Observation[]] }> = {
	I1: {
		violation: () => [
			log(),
			[
				obs(1, 'lease', 'a', { epoch: 3, holds: true }),
				obs(40, 'lease', 'b', { epoch: 4, holds: true }), // a never stopped: two holders
				obs(45, 'lease', 'a', { epoch: 3, holds: false }),
			],
		],
		clean: () => [
			log(),
			[
				obs(1, 'lease', 'a', { epoch: 3, holds: true }),
				obs(20, 'lease', 'a', { epoch: 3, holds: false }),
				obs(40, 'lease', 'b', { epoch: 4, holds: true }),
				obs(41, 'write-attempt', 'b', { target: 'control', epoch: 4, accepted: true }),
			],
		],
	},
	I2: {
		violation: () => [
			log(),
			[obs(1, 'epoch', 'c', { epoch: 5, source: 'agent' }), obs(9, 'epoch', 'c', { epoch: 4, source: 'agent' })],
		],
		clean: () => [
			log(),
			[
				obs(1, 'lease', 'arbiter', { epoch: 5, holder: 'a' }),
				obs(2, 'epoch', 'c', { epoch: 5 }),
				obs(50, 'lease', 'arbiter', { epoch: 6, holder: 'b' }),
				obs(51, 'epoch', 'c', { epoch: 6 }),
			],
		],
	},
	I3: {
		violation: () => [
			log(),
			[
				obs(1, 'db-role', 'a', { database: 'app', generation: 2, role: 'primary', acceptingWrites: true }),
				obs(30, 'db-role', 'b', { database: 'app', generation: 2, role: 'primary', acceptingWrites: true }),
			],
		],
		clean: () => [
			log(),
			[
				obs(1, 'db-role', 'a', { database: 'app', generation: 2, role: 'primary', acceptingWrites: true }),
				obs(25, 'db-role', 'a', { database: 'app', generation: 2, role: 'fenced' }),
				obs(30, 'db-role', 'b', { database: 'app', generation: 3, role: 'primary', acceptingWrites: true, promotion: 'auto' }),
			],
		],
	},
	I4: {
		violation: () => [
			log([], [
				{ job: 'nightly', run: '2026-11-20T10:00', node: 'a', copy: 'a:1', at: s(1) },
				{ job: 'nightly', run: '2026-11-20T10:00', node: 'b', copy: 'b:1', at: s(2) },
			]),
			[],
		],
		clean: () => [
			log([], [
				{ job: 'nightly', run: '2026-11-20T10:00', node: 'a', copy: 'a:1', at: s(1) },
				{ job: 'nightly', run: '2026-11-20T10:01', node: 'b', copy: 'b:1', at: s(61) },
			]),
			[obs(1, 'singleton', 'a', { job: 'nightly', run: '2026-11-20T10:00' })],
		],
	},
	I5: {
		violation: () => [
			log(),
			[obs(1, 'mount', 'a', { volume: 'uploads', mode: 'rw' }), obs(30, 'mount', 'b', { volume: 'uploads', mode: 'rw' })],
		],
		clean: () => [
			log(),
			[
				obs(1, 'mount', 'a', { volume: 'uploads', mode: 'rw' }),
				obs(29, 'mount', 'a', { volume: 'uploads', mode: 'none' }),
				obs(30, 'mount', 'b', { volume: 'uploads', mode: 'rw' }),
				obs(31, 'write-attempt', 'b', { target: 'volume', volume: 'uploads', accepted: true }),
			],
		],
	},
	I6: {
		violation: () => [log([req('write', 1, 1), req('write', 2, 2), req('verify', 1, 121), req('verify', 2, 121, 404)]), []],
		clean: () => [log([req('write', 1, 1), req('write', 2, 2, 503), req('read', 1, 3), req('verify', 1, 121)]), []],
	},
	I7: {
		violation: () => [
			log(),
			[
				obs(1, 'fence', 'a', { component: 'control', fenced: true }),
				obs(5, 'write-attempt', 'a', { target: 'control', accepted: true }),
			],
		],
		clean: () => [
			log(),
			[
				obs(1, 'fence', 'a', { component: 'control', fenced: true }),
				obs(5, 'write-attempt', 'a', { target: 'control', accepted: false }),
				obs(60, 'fence', 'a', { component: 'control', fenced: false }),
				obs(61, 'write-attempt', 'a', { target: 'control', accepted: true }),
			],
		],
	},
	I11: {
		violation: () => [
			log([req('write', 1, 5), req('write', 2, 15, 502), req('write', 3, 25)]),
			[obs(10, 'fault', 'ctl', { fault: 'control-down', state: 'start' }), obs(20, 'fault', 'ctl', { fault: 'control-down', state: 'end' })],
		],
		clean: () => [
			log([req('write', 1, 5), req('write', 2, 15), req('write', 3, 25, 502)]),
			[obs(10, 'fault', 'ctl', { fault: 'control-down', state: 'start' }), obs(20, 'fault', 'ctl', { fault: 'control-down', state: 'end' })],
		],
	},
	I12: {
		violation: () => [
			log(),
			[
				obs(1, 'lease', 'arbiter', { scope: 'database', database: 'app', epoch: 2, holder: 'a', syncSet: ['b'] }),
				obs(40, 'db-role', 'c', { database: 'app', generation: 3, role: 'primary', promotion: 'auto' }),
			],
		],
		clean: () => [
			log(),
			[
				obs(1, 'lease', 'arbiter', { scope: 'database', database: 'app', epoch: 2, holder: 'a', syncSet: ['b'] }),
				obs(40, 'db-role', 'b', { database: 'app', generation: 3, role: 'primary', promotion: 'auto' }),
				obs(90, 'db-role', 'c', { database: 'app', generation: 4, role: 'primary', promotion: 'manual' }),
			],
		],
	},
	I13: {
		violation: () => [
			log(),
			[
				obs(1, 'lease', 'a', { scope: 'database', database: 'app', holds: true, ttlMs: 30_000 }),
				obs(10, 'lease', 'a', { scope: 'database', database: 'app', holds: false }),
				obs(45, 'write-attempt', 'a', { target: 'database', database: 'app', accepted: true }),
			],
		],
		clean: () => [
			log(),
			[
				obs(1, 'lease', 'a', { scope: 'database', database: 'app', holds: true, ttlMs: 30_000 }),
				obs(20, 'write-attempt', 'a', { target: 'database', database: 'app', accepted: true }),
				obs(25, 'lease', 'a', { scope: 'database', database: 'app', holds: true }),
				obs(50, 'db-role', 'a', { database: 'app', role: 'primary', acceptingWrites: true }),
				obs(70, 'write-attempt', 'a', { target: 'database', database: 'app', accepted: false }),
			],
		],
	},
	I14: {
		violation: () => [
			log(),
			[obs(1, 'ingress', 'a', { ready: false, inRotation: false }), obs(2, 'ingress', 'a', { inRotation: true })],
		],
		clean: () => [
			log(),
			[
				obs(1, 'ingress', 'a', { ready: false, inRotation: false }),
				obs(2, 'route', 'a', { converged: true }),
				obs(3, 'ingress', 'a', { ready: true }),
				obs(8, 'ingress', 'a', { inRotation: true }),
			],
		],
	},
	I15: {
		violation: () => [
			log([req('write', 1, 31, 200, { copy: 'web-1' })]),
			[obs(1, 'route', 'a', { copy: 'web-1', event: 'added' }), obs(30, 'route', 'a', { copy: 'web-1', event: 'removed' }), obs(40, 'route', 'a', { copy: 'web-1', event: 'stopped' })],
		],
		clean: () => [
			log([req('write', 1, 29, 200, { copy: 'web-1' }), req('write', 2, 31, 200, { copy: 'web-2' })]),
			[obs(1, 'route', 'a', { copy: 'web-1', event: 'added' }), obs(30, 'route', 'a', { copy: 'web-1', event: 'removed' }), obs(40, 'route', 'a', { copy: 'web-1', event: 'stopped' })],
		],
	},
	I16: {
		violation: () => [
			log(),
			[
				obs(1, 'release-command', 'a', { release: 'r7', event: 'start' }),
				obs(9, 'release-command', 'a', { release: 'r7', event: 'end', ok: false }),
				obs(10, 'release-command', 'ctl', { release: 'r7', event: 'rollout-start' }),
			],
		],
		clean: () => [
			log([], [{ job: 'release:r8', run: '1', node: 'a', copy: 'a:1', at: s(1) }]),
			[
				obs(1, 'release-command', 'a', { release: 'r8', event: 'start' }),
				obs(9, 'release-command', 'a', { release: 'r8', event: 'end', ok: true }),
				obs(10, 'release-command', 'ctl', { release: 'r8', event: 'rollout-start' }),
			],
		],
	},
};

describe('checker invariants (CLUSTERING §19.1 I1–I7, HA-PLAN §1.3 I11–I16)', () => {
	for (const id of INVARIANT_IDS) {
		const c = CASES[id];
		test(`${id}: a planted violation fails`, () => {
			const [l, o] = c.violation();
			const result = CHECKS[id]({ log: l, observations: o });
			expect(result.status).toBe('fail');
			expect(result.evidence.length).toBeGreaterThan(0);
		});
		test(`${id}: a clean history passes`, () => {
			const [l, o] = c.clean();
			const result = CHECKS[id]({ log: l, observations: o });
			expect(result).toMatchObject({ status: 'pass' });
		});
		test(`${id}: an empty history is not-observed, never pass`, () => {
			expect(CHECKS[id]({ log: log(), observations: [] }).status).toBe('not-observed');
		});
	}

	test('I6 forgives a loss only inside the stated RPO before a promotion', () => {
		const l = log([req('write', 1, 10), req('verify', 1, 121, 404)]);
		const promotion = [obs(10.5, 'db-role', 'b', { database: 'app', role: 'primary', promotion: 'auto', generation: 3 })];
		expect(CHECKS.I6({ log: l, observations: promotion }).status).toBe('fail');
		expect(CHECKS.I6({ log: l, observations: promotion, options: { rpoMs: 1_000 } }).status).toBe('pass');
	});

	test('I6 fails a row that reads back with different content, and one never verified', () => {
		expect(CHECKS.I6({ log: log([req('write', 1, 1), req('verify', 1, 121, 200, { match: false })]), observations: [] }).status).toBe('fail');
		expect(CHECKS.I6({ log: log([req('write', 1, 1), req('verify', 1, 121, 503)]), observations: [] }).status).toBe('fail');
	});

	test('I11 does not blame the control plane for a request that failed during another fault', () => {
		const l = log([req('write', 1, 15, 502)]);
		const o = [
			obs(10, 'fault', 'ctl', { fault: 'control-down', state: 'start' }),
			obs(12, 'fault', 'b', { fault: 'partition', state: 'start' }),
			obs(18, 'fault', 'b', { fault: 'partition', state: 'end' }),
			obs(20, 'fault', 'ctl', { fault: 'control-down', state: 'end' }),
		];
		expect(CHECKS.I11({ log: l, observations: o }).status).toBe('not-observed');
	});
});

describe('checker report', () => {
	test('summarize produces a schema-valid report with the run numbers', () => {
		const l = log([
			req('write', 1, 1),
			req('write', 2, 2, 0, { error: 'timeout' }),
			req('write', 3, 50),
			req('read', 1, 3),
			req('read', 3, 51, 502),
			req('verify', 1, 121),
			req('verify', 3, 121, 404),
		]);
		const report = summarize(l, []);
		expect(reportSchema.safeParse(report).success).toBe(true);
		expect(report).toMatchObject({
			seed: 1,
			requests: 5,
			failedRequests: 2,
			failedByStatus: { timeout: 1, '502': 1 },
			acknowledgedWrites: 2,
			lostAcknowledgedWrites: 1,
			duplicateSingletonRuns: 0,
		});
		expect(report.longestWriteGapMs).toBe(longestWriteGapMs(l));
		expect(report.longestWriteGapMs).toBe(70_000 - 20); // 50.02 s → 120 s
		expect(report.invariants.I6.status).toBe('fail');
		expect(report.invariants.I1.status).toBe('not-observed');
	});

	test('duplicate singleton runs count extra starts, without summing the app and the observations', () => {
		const runs = [
			{ job: 'j', run: '1', at: s(1) },
			{ job: 'j', run: '1', at: s(2) },
			{ job: 'j', run: '2', at: s(3) },
		];
		const o = [obs(1, 'singleton', 'a', { job: 'j', run: '1' }), obs(2, 'singleton', 'b', { job: 'j', run: '1' })];
		expect(duplicateSingletonRuns(log([], runs), o)).toBe(1);
	});

	test('the observation parser keeps valid lines, reports bad ones and tolerates a torn last line', () => {
		const text = [
			JSON.stringify({ t: s(2), kind: 'lease', node: 'a', holds: true }),
			JSON.stringify({ t: s(1), kind: 'epoch', node: 'a', epoch: 1 }),
			JSON.stringify({ t: s(3), kind: 'nonsense', node: 'a' }),
			'{"t": 1, "kind": "lea',
		].join('\n');
		const parsed = parseObservations(text);
		expect(parsed.observations.map((o) => o.kind)).toEqual(['epoch', 'lease']);
		expect(parsed.errors).toHaveLength(1);
	});
});
