import { describe, expect, test } from 'bun:test';
import { createHandler, memoryStore } from '../../checker/app/server.ts';
import { FEATURE_FLAGS } from '../../../../packages/contracts/src/features.ts';
import {
	EMPTY_ENV_HASH,
	attachmentFeatureGate,
	checkerVerdict,
	compareUnits,
	envHashOrNull,
	failedRequestsVerdict,
	featureGate,
	judgeReleaseOnce,
	optInFlagState,
	parseListeners,
	promotionBaseline,
	releasePhaseDecision,
	releaseRunObservations,
	singletonRows,
	spreadRefusalVerdict,
	unitsSettled,
	windowsOverlap,
	type ReleaseRunRow,
} from './judge.ts';
import type { CheckerSummary } from './report.ts';
import type { UnitInfo } from './app.ts';

const summary = (overrides: Partial<CheckerSummary> = {}): CheckerSummary => ({
	requests: 100,
	failedRequests: 0,
	failedByStatus: {},
	longestWriteGapMs: 100,
	acknowledgedWrites: 50,
	lostAcknowledgedWrites: 0,
	duplicateSingletonRuns: 0,
	invariants: { I4: 'pass', I6: 'pass' },
	failedInvariants: [],
	notObservedInvariants: [],
	...overrides,
});

const unit = (copy: string, overrides: Partial<UnitInfo> = {}): UnitInfo => ({
	copy,
	node: 'lab-b',
	unit: `yoal-workload-${copy}.service`,
	activeState: 'active',
	invocationId: `inv-${copy}`,
	startedMonotonicUs: 1,
	mainPid: 10,
	envHash: `hash-${copy}`,
	envFiles: ['/run/yoal/env'],
	...overrides,
});

describe('item 2: the release command run the platform recorded', () => {
	test('reads the checker app’s /singletons body ({ runs }), not a `singletons` key', async () => {
		const app = createHandler(memoryStore(), { node: 'lab-c', copy: 'c1' });
		await app(new Request('http://x/singleton?job=release:d-1&run=d-1'));
		const body = await (await app(new Request('http://x/singletons?job=release:d-1'))).json();
		// The expression rolling-deploy D used: always empty, so it always partitioned lab-b.
		const old = (Array.isArray(body) ? body : ((body as { singletons?: unknown[] }).singletons ?? [])) as unknown[];
		expect(old).toEqual([]);
		const rows = singletonRows(body);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.node).toBe('lab-c');
		expect(singletonRows([{ job: 'j', run: 'r', node: 'n', copy: 'c' }])).toHaveLength(1);
		expect(singletonRows({ singletons: [{ job: 'j', run: 'r', node: 'n', copy: 'c' }] })).toHaveLength(1);
		expect(singletonRows(null)).toEqual([]);
	});

	test('the partition must overlap the run, or I16 was not exercised', () => {
		expect(windowsOverlap([10, 20], [15, 30])).toBe(true);
		expect(windowsOverlap([10, 20], [20, 30])).toBe(true);
		expect(windowsOverlap([10, 20], [21, 30])).toBe(false);
		expect(windowsOverlap([10, null], [5, 9])).toBe(false);
		// An unfinished run is still running: it overlaps anything after its start.
		expect(windowsOverlap([10, null], [500, 600])).toBe(true);
	});

	const run = (overrides: Partial<ReleaseRunRow> = {}): ReleaseRunRow => ({
		id: 'rc_1',
		releaseId: 'dep_1',
		attempt: 1,
		status: 'succeeded',
		nodeName: 'lab-c',
		createdAt: 1_000,
		startedAt: 2_000,
		finishedAt: 50_000,
		exitCode: 0,
		...overrides,
	});

	test('the platform’s runs become release-command observations the checker reads (I16)', () => {
		const obs = releaseRunObservations([run()], { rolloutStartedAt: 60_000 });
		expect(obs).toEqual([
			{ t: 2_000, kind: 'release-command', node: 'lab-c', release: 'dep_1', event: 'start', copy: 'rc_1' },
			{ t: 50_000, kind: 'release-command', node: 'lab-c', release: 'dep_1', event: 'end', ok: true, copy: 'rc_1' },
			{ t: 60_000, kind: 'release-command', node: 'lab-c', release: 'dep_1', event: 'rollout-start' },
		]);
		// A queued run that never started is no start; a failed one ends not ok.
		expect(releaseRunObservations([run({ status: 'queued', startedAt: null, finishedAt: null })], {})).toEqual([]);
		expect(releaseRunObservations([run({ status: 'failed', exitCode: 1 })], {})[1]).toMatchObject({ event: 'end', ok: false });
	});

	test('judged once: one start on the platform, one in the app, I16 passes, and the partition overlapped', () => {
		const base = { runs: [run()], appRows: [{ job: 'release:d-1', run: 'd-1', node: 'lab-c', copy: 'c1', at: 2_100 }], marker: 'd-1', partition: [10_000, 100_000] as [number, number], rolloutStartedAt: 60_000 };
		expect(judgeReleaseOnce(base)).toMatchObject({ verdict: 'pass' });
		expect(judgeReleaseOnce({ ...base, runs: [run(), run({ id: 'rc_2', attempt: 2, startedAt: 70_000, finishedAt: 80_000 })] })).toMatchObject({ verdict: 'fail', reason: expect.stringMatching(/2 attempts started/) });
		expect(judgeReleaseOnce({ ...base, appRows: [...base.appRows, { ...base.appRows[0]!, copy: 'c2' }] })).toMatchObject({ verdict: 'fail', reason: expect.stringMatching(/I16/) });
		expect(judgeReleaseOnce({ ...base, partition: [60_000, 90_000] })).toMatchObject({ verdict: 'invalid', reason: expect.stringMatching(/did not overlap/) });
		expect(judgeReleaseOnce({ ...base, partition: null })).toMatchObject({ verdict: 'invalid' });
		expect(judgeReleaseOnce({ ...base, runs: [] })).toMatchObject({ verdict: 'fail', reason: expect.stringMatching(/no release command run/) });
		// A rollout that started before the command finished is an I16 failure.
		expect(judgeReleaseOnce({ ...base, rolloutStartedAt: 20_000 })).toMatchObject({ verdict: 'fail', reason: expect.stringMatching(/I16/) });
	});
});

describe('item 1: scenarios that need a flag skip only when it is off', () => {
	test('featureGate names the flags that are off; an unreadable platform counts as off', () => {
		expect(featureGate({ RELEASE_PHASE: true }, ['RELEASE_PHASE'])).toEqual({ on: true, off: [] });
		expect(featureGate({ RELEASE_PHASE: false }, ['RELEASE_PHASE'])).toEqual({ on: false, off: ['RELEASE_PHASE'] });
		expect(featureGate(null, ['A', 'B'])).toEqual({ on: false, off: ['A', 'B'] });
	});

	test('a container app needs SERVICE_ENDPOINTS and ENDPOINTS_GATEWAY; a process app SERVICE_ENDPOINTS', () => {
		expect(attachmentFeatureGate('container', { SERVICE_ENDPOINTS: true, ENDPOINTS_GATEWAY: false }).off).toEqual(['ENDPOINTS_GATEWAY']);
		expect(attachmentFeatureGate('process', { SERVICE_ENDPOINTS: true, ENDPOINTS_GATEWAY: false }).on).toBe(true);
	});

	test('a refused spread is a skip only with the flag off; with it on it is a failure', () => {
		const off = spreadRefusalVerdict('container', featureGate({ ENDPOINTS_GATEWAY: false, SERVICE_ENDPOINTS: true }, ['SERVICE_ENDPOINTS', 'ENDPOINTS_GATEWAY']), 'nope');
		expect(off.verdict).toBe('skip');
		expect(off.reason).toContain('lab.ts up --feature ENDPOINTS_GATEWAY=1');
		expect(off.reason).not.toContain('databases.ts:3636');
		const on = spreadRefusalVerdict('container', { on: true, off: [] }, 'nope');
		expect(on.verdict).toBe('fail');
		expect(on.reason).toContain('nope');
	});

	test('the release phase runs C and D when RELEASE_PHASE is on, and a lost field is then a failure', () => {
		const off = releasePhaseDecision({ flagOn: false, putStatus: 400, keepsRelease: false, keepsReadiness: false });
		expect(off.run).toBe(false);
		expect(off.verdict).toBe('skip');
		expect(off.reason).toContain('RELEASE_PHASE is off');
		expect(off.reason).toContain('lab.ts up --feature RELEASE_PHASE=1');
		expect(off.reason).not.toContain('is not built');
		expect(releasePhaseDecision({ flagOn: true, putStatus: 200, keepsRelease: true, keepsReadiness: true })).toMatchObject({ run: true, verdict: 'pass' });
		expect(releasePhaseDecision({ flagOn: true, putStatus: 200, keepsRelease: false, keepsReadiness: true })).toMatchObject({ run: false, verdict: 'fail', reason: expect.stringContaining('`release`') });
		expect(releasePhaseDecision({ flagOn: true, putStatus: 422, keepsRelease: false, keepsReadiness: false })).toMatchObject({ run: false, verdict: 'fail', reason: expect.stringContaining('422') });
	});
});

describe('item 3: attachments-three-nodes', () => {
	test('an empty input’s hash (no env file read) is unreadable, never a baseline', () => {
		const empty = new Bun.CryptoHasher('sha256').update('').digest('hex').slice(0, 16);
		expect(EMPTY_ENV_HASH).toBe(empty);
		expect(envHashOrNull(`${empty}\n`)).toBeNull();
		expect(envHashOrNull('')).toBeNull();
		expect(envHashOrNull('0123456789abcdef\n')).toBe('0123456789abcdef');
		expect(promotionBaseline([unit('a', { envHash: null })], 1)).toMatchObject({ verdict: 'fail' });
		expect(promotionBaseline([unit('a')], 2)).toMatchObject({ verdict: 'fail' });
		expect(promotionBaseline([unit('a'), unit('b')], 2)).toMatchObject({ verdict: 'pass' });
	});

	test('both after-snapshots are compared with the baseline', () => {
		const before = new Map([['a', unit('a')], ['b', unit('b')]]);
		const sameAfter = new Map([['a', unit('a')], ['b', unit('b')]]);
		expect(compareUnits(before, [sameAfter, sameAfter])).toEqual({ envChanged: [], restarted: [] });
		const late = new Map([['a', unit('a')], ['b', unit('b', { invocationId: 'inv-b2', envHash: 'other' })]]);
		expect(compareUnits(before, [sameAfter, late])).toEqual({ envChanged: ['b@lab-b (after checker)'], restarted: ['b@lab-b (after checker)'] });
		const gone = new Map([['a', unit('a')]]);
		expect(compareUnits(before, [gone, sameAfter]).restarted).toEqual(['b@lab-b (moved or gone, after promotion)']);
		// An unreadable env hash after is a change, not a pass.
		const unreadable = new Map([['a', unit('a', { envHash: null })], ['b', unit('b')]]);
		expect(compareUnits(before, [unreadable]).envChanged).toEqual(['a@lab-b (after promotion)']);
	});

	test('copies have settled when two reads agree on every unit', () => {
		const a = [unit('a'), unit('b')];
		expect(unitsSettled(a, [unit('a'), unit('b')])).toBe(true);
		expect(unitsSettled(a, [unit('a'), unit('b', { invocationId: 'x' })])).toBe(false);
		expect(unitsSettled(a, [unit('a')])).toBe(false);
		expect(unitsSettled([unit('a', { invocationId: null })], [unit('a', { invocationId: null })])).toBe(false);
	});

	test('the positive control reads endpoint listeners from ss', () => {
		const ss = [
			'LISTEN 0      4096       127.0.0.1:21003      0.0.0.0:*',
			'LISTEN 0      4096      10.88.0.1:21003      0.0.0.0:*',
			'LISTEN 0      4096       127.0.0.1:8080       0.0.0.0:*',
			'LISTEN 0      4096           [::1]:23001         [::]:*',
			'LISTEN 0      4096               *:15432            *:*',
		].join('\n');
		expect(parseListeners(ss, [[21000, 21999], [23000, 23999]])).toEqual([
			{ address: '127.0.0.1', port: 21003 },
			{ address: '10.88.0.1', port: 21003 },
			{ address: '::1', port: 23001 },
		]);
		expect(parseListeners(ss, [[15432, 16431]])).toEqual([{ address: '*', port: 15432 }]);
	});
});

describe('item 4: single-node-gate checks every opt-in flag', () => {
	test('every flag whose default is false, from the registry', () => {
		const state = optInFlagState({}, null);
		const optIn = Object.values(FEATURE_FLAGS).filter((flag) => !flag.default).map((flag) => flag.name);
		expect(Object.keys(state).sort()).toEqual([...optIn].sort());
		expect(optIn).toContain('ENDPOINTS_GATEWAY');
		expect(optIn).toContain('EXTERNAL_PROBER');
		expect(Object.values(state).every((value) => value === 'off')).toBe(true);
	});

	test('the platform’s resolved value wins; an env override counts when the platform is unreadable', () => {
		expect(optInFlagState({}, { ENDPOINTS_GATEWAY: true }).ENDPOINTS_GATEWAY).toBe('on');
		expect(optInFlagState({ STEERING: '1' }, null).STEERING).toBe('on');
		expect(optInFlagState({ STEERING: 'yes' }, { STEERING: false }).STEERING).toBe('off');
	});
});

describe('items 5 and 6: checker and failed requests', () => {
	test('I6 not observed is a failure, whatever else passed (7af9fe6f)', () => {
		expect(checkerVerdict(summary(), 0)).toMatchObject({ verdict: 'pass' });
		expect(checkerVerdict(summary({ invariants: { I6: 'not-observed' } }), 0)).toMatchObject({ verdict: 'fail', reason: expect.stringContaining('I6 was not-observed') });
		expect(checkerVerdict(summary({ invariants: {} }), 0)).toMatchObject({ verdict: 'fail', reason: expect.stringContaining('I6 was missing') });
		expect(checkerVerdict(summary({ failedInvariants: ['I4'], invariants: { I4: 'fail', I6: 'pass' } }), 1)).toMatchObject({ verdict: 'fail', reason: expect.stringContaining('I4') });
		expect(checkerVerdict(null, 2)).toMatchObject({ verdict: 'error' });
		expect(checkerVerdict(summary({ acknowledgedWrites: 0 }), 0, { requireWrites: true })).toMatchObject({ verdict: 'fail', reason: expect.stringContaining('no write was acknowledged') });
	});

	test('failed requests are judged on both targets; direct names the harness balancer', () => {
		expect(failedRequestsVerdict('edge', summary())).toMatchObject({ verdict: 'pass' });
		expect(failedRequestsVerdict('edge', summary({ failedRequests: 2 }))).toMatchObject({ verdict: 'fail' });
		const direct = failedRequestsVerdict('direct', summary({ failedRequests: 3, failedByStatus: { '504': 3 } }));
		expect(direct.verdict).toBe('fail');
		expect(direct.reason).toContain('harness balancer');
		// With a fault window, failures inside it are allowed only on direct (passive mark-down).
		const windows = { fault: { requests: 10, failed: 3, byStatus: { '504': 3 } }, outside: { requests: 90, failed: 0, byStatus: {} } };
		expect(failedRequestsVerdict('direct', summary({ failedRequests: 3 }), { windows, window: 'fault' })).toMatchObject({ verdict: 'pass' });
		expect(failedRequestsVerdict('edge', summary({ failedRequests: 3 }), { windows, window: 'fault' })).toMatchObject({ verdict: 'fail' });
		const outside = { ...windows, outside: { requests: 90, failed: 1, byStatus: { '502': 1 } } };
		expect(failedRequestsVerdict('direct', summary({ failedRequests: 4 }), { windows: outside, window: 'fault' })).toMatchObject({ verdict: 'fail', reason: expect.stringContaining('outside') });
	});
});
