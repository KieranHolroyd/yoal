import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, externalProberReportSchema, sloObjectInputSchema } from '@yoal/contracts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';

/**
 * Wave 4 foundation: the policy reads are honest, every prerequisite is a named refusal, and every
 * lane-owned write fails loudly instead of pretending it was recorded
 * (docs/build-plan/HA-WAVE-4.md).
 */
const dir = mkdtempSync(join(tmpdir(), 'yoal-w4-foundation-'));
const opened = createDb({ path: ':memory:' });
const clock = Date.parse('2026-11-21T10:00:00Z');
const DAY_MS = 86_400_000;
const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		now: () => clock,
		features: { ...DEFAULT_FEATURES, SLO_OBJECTS: true, EXTERNAL_PROBER: true },
	},
});
const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

const node = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'data').token, name: 'data' });
opened.sqlite.run('UPDATE nodes SET capabilities_json = ?, status = ?, zone = ? WHERE id = ?', ['["db-member","db-member-self-fencing"]', 'online', 'a', node.nodeId]);
const database = core.databases.create(principal, { name: 'main', placement: node.nodeId });
const project = await core.projects.create(principal, {
	name: 'App',
	slug: 'app',
	runtime: 'static',
	placement: 'edge',
	productionAccess: 'public',
	previewAccess: 'platform',
});

const extraNodes: string[] = [];
let sequence = 0;

function setFeature(name: keyof typeof DEFAULT_FEATURES, value: boolean): void {
	(core.ctx.config.features as Record<string, boolean>)[name] = value;
}

function reset(): void {
	opened.sqlite.run('DELETE FROM database_failover_drills');
	opened.sqlite.run('DELETE FROM database_failovers');
	opened.sqlite.run('DELETE FROM database_replicas');
	for (const id of extraNodes) opened.sqlite.run('DELETE FROM nodes WHERE id = ?', [id]);
	extraNodes.length = 0;
	opened.sqlite.run('UPDATE nodes SET capabilities_json = ?, status = ?, zone = ? WHERE id = ?', ['["db-member","db-member-self-fencing"]', 'online', 'a', node.nodeId]);
	opened.sqlite.run(
		`UPDATE databases SET engine_name = 'postgres', durability = 'async', durability_effective = 'async',
		 accept_data_loss = 0, failover_mode = 'manual', sync_state = 'steady', last_failover_drill_at = NULL,
		 failover_evidence_json = '{}', auto_armed_at = NULL WHERE id = ?`,
		[database.id],
	);
	setFeature('DB_AUTO_PROMOTE', false);
}

function addDataNode(zone: string, capable = true): string {
	const joined = core.nodes.join({ token: core.nodes.createJoinToken(principal, `data-${++sequence}`).token, name: `data-${sequence}` });
	opened.sqlite.run('UPDATE nodes SET zone = ?, status = ?, capabilities_json = ? WHERE id = ?', [
		zone,
		'online',
		capable ? '["db-member","db-member-self-fencing"]' : '[]',
		joined.nodeId,
	]);
	extraNodes.push(joined.nodeId);
	return joined.nodeId;
}

function addReplica(nodeId: string, status = 'streaming'): void {
	opened.sqlite.run(
		`INSERT INTO database_replicas (id, database_id, node_id, status, slot, primary_generation, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 0, 1, 1)`,
		[`dbr_${++sequence}`, database.id, nodeId, status, `slot_${sequence}`],
	);
}

function addDrill(overrides: Partial<{
	status: string;
	durability: string;
	finishedAt: number | null;
	timeToWritableMs: number | null;
	lostCommits: number | null;
	arbiterTested: number;
	arbiterTestedAt: number | null;
}> = {}): string {
	const id = `drl_${++sequence}`;
	const drill = {
		status: 'passed',
		durability: 'async',
		finishedAt: clock,
		timeToWritableMs: 21_000,
		lostCommits: 0,
		arbiterTested: 1,
		arbiterTestedAt: clock,
		...overrides,
	};
	opened.sqlite.run(
		`INSERT INTO database_failover_drills
		 (id, database_id, drill_database_id, status, durability, started_at, finished_at, time_to_writable_ms,
		  lost_commits, generation, arbiter_tested, arbiter_tested_at, created_by, created_at)
		 VALUES (?, ?, 'db_disposable', ?, ?, ?, ?, ?, ?, 0, ?, ?, 'user_1', 1)`,
		[
			id,
			database.id,
			drill.status,
			drill.durability,
			clock - 1_000,
			drill.finishedAt,
			drill.timeToWritableMs,
			drill.lostCommits,
			drill.arbiterTested,
			drill.arbiterTestedAt,
		],
	);
	return id;
}

function addSwitchover(): void {
	opened.sqlite.run(
		`INSERT INTO database_failovers (id, database_id, from_node_id, to_node_id, generation, status, kind, switchover_step, started_at)
		 VALUES (?, ?, ?, ?, 0, 'pending', 'switchover', 'drain', 1)`,
		[`dbf_${++sequence}`, database.id, node.nodeId, node.nodeId],
	);
}

function refusalCodes(): string[] {
	return core.failoverPolicies.refusals(principal, 'main').map((refusal) => refusal.code);
}

function fullyEligible(): void {
	addDataNode('a');
	addDataNode('b');
	const replicaNode = extraNodes[0]!;
	addReplica(replicaNode, 'streaming');
	opened.sqlite.run(
		`UPDATE databases SET durability = 'sync', durability_effective = 'sync', accept_data_loss = 0,
		 failover_mode = 'auto', sync_state = 'steady' WHERE id = ?`,
		[database.id],
	);
	addDrill({ durability: 'sync', timeToWritableMs: 21_000, lostCommits: 0 });
	setFeature('DB_AUTO_PROMOTE', true);
	// `active` is the controller's predicate (F2): the controller must be enabled and a handler
	// installed, exactly as the W11 install path would do after proving self-fencing.
	core.cluster.update(principal, { failover: { enabled: true } });
	core.failover.registerDatabaseHandler({ run: () => ({ status: 'done' }) });
}

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('database failover policy', () => {
	beforeEach(reset);

	test('defaults to manual and explains every refusal without pretending auto is recorded', () => {
		const view = core.failoverPolicies.view(principal, 'main');
		expect(view.failoverMode).toBe('manual');
		expect(view.acceptDataLoss).toBe(false);
		expect(view.autoArmedAt).toBeNull();
		expect(view.lastDrill).toBeNull();
		expect(view.armedEvidence).toBeNull();
		expect(view.active).toBe(false);
		const codes = view.refusals.map((refusal) => refusal.code);
		expect(codes).toContain('auto-promote-off');
		expect(codes).toContain('data-loss-not-accepted');
		expect(codes).toContain('too-few-data-nodes');
		expect(codes).toContain('no-cross-node-replica');
		expect(codes).toContain('no-drill');
		expect(refusalCodes()).toEqual(codes);
	});

	const refusalCases: Array<{ code: string; setup: () => void }> = [
		{ code: 'auto-promote-off', setup: () => {} },
		{ code: 'engine-unsupported', setup: () => opened.sqlite.run("UPDATE databases SET engine_name = 'mysql' WHERE id = ?", [database.id]) },
		{ code: 'data-loss-not-accepted', setup: () => {} },
		{
			code: 'data-loss-not-needed',
			setup: () => opened.sqlite.run("UPDATE databases SET durability = 'sync', durability_effective = 'sync', accept_data_loss = 1 WHERE id = ?", [database.id]),
		},
		{
			code: 'sync-downgraded',
			setup: () => opened.sqlite.run("UPDATE databases SET durability = 'sync', durability_effective = 'async' WHERE id = ?", [database.id]),
		},
		{ code: 'too-few-data-nodes', setup: () => {} },
		{ code: 'single-zone', setup: () => {
			addDataNode('a');
			addDataNode('a');
		} },
		{
			code: 'member-capability-missing',
			setup: () => opened.sqlite.run('UPDATE nodes SET capabilities_json = ? WHERE id = ?', ['[]', node.nodeId]),
		},
		{
			code: 'no-cross-node-replica',
			setup: () => {
				addDataNode('a');
				addDataNode('b');
			},
		},
		{ code: 'switchover-active', setup: addSwitchover },
		{
			code: 'sync-transition-open',
			setup: () => opened.sqlite.run("UPDATE databases SET sync_state = 'changing' WHERE id = ?", [database.id]),
		},
		{ code: 'no-drill', setup: () => {} },
		{ code: 'drill-running', setup: () => { addDrill({ status: 'running', finishedAt: null, timeToWritableMs: null, arbiterTested: 0, arbiterTestedAt: null }); } },
		{ code: 'drill-failed', setup: () => { addDrill({ status: 'failed' }); } },
		{ code: 'drill-unmeasured', setup: () => { addDrill({ finishedAt: clock, timeToWritableMs: null }); } },
		{ code: 'drill-too-slow', setup: () => { addDrill({ timeToWritableMs: 30_001 }); } },
		{ code: 'drill-lost-commits', setup: () => { addDrill({ durability: 'sync', lostCommits: 1 }); } },
		{ code: 'arbiter-untested', setup: () => { addDrill({ arbiterTested: 0, arbiterTestedAt: null }); } },
		{ code: 'drill-stale', setup: () => { addDrill({ finishedAt: clock - 31 * DAY_MS, arbiterTestedAt: clock - 31 * DAY_MS }); } },
	];
	for (const { code, setup } of refusalCases)
		test(`refuses ${code}`, () => {
			setup();
			expect(refusalCodes()).toContain(code);
		});

	test('a fully eligible policy is active and arming records it', async () => {
		fullyEligible();
		const view = core.failoverPolicies.view(principal, 'main');
		expect(view.refusals).toEqual([]);
		expect(view.active).toBe(true);
		expect(view.controllerEnabled).toBe(true);
		expect(view.controllerInstalled).toBe(true);
		expect(view.selfFencing).toBe(true);
		expect(view.lastDrill?.durability).toBe('sync');
		expect(view.lastDrill?.drillDatabaseId).toBe('db_disposable');
		expect(view.lastFailoverDrillAt).toBe(new Date(clock).toISOString());
		const armed = await core.failoverPolicies.arm(principal, 'main', { confirm: true, acceptDataLoss: false });
		expect(armed.failoverMode).toBe('auto');
		expect(armed.autoArmedAt).toBe(new Date(clock).toISOString());
		expect(armed.armedEvidence).toMatchObject({ drillId: view.evidence.drillId, dataNodeCount: 3, autoPromoteEnabled: true });
	});

	test('active is false while the failover controller is disabled (F2)', async () => {
		fullyEligible();
		core.cluster.update(principal, { failover: { enabled: false } });
		const view = core.failoverPolicies.view(principal, 'main');
		expect(view.refusals).toEqual([]);
		expect(view.controllerEnabled).toBe(false);
		expect(view.active).toBe(false);
		// The per-database policy is still armed; only the controller is off.
		expect(view.failoverMode).toBe('auto');
	});

	test('a running latest attempt does not hide a fresh passed drill', () => {
		fullyEligible();
		addDrill({ status: 'running', finishedAt: null, timeToWritableMs: null, arbiterTested: 0, arbiterTestedAt: null });
		const view = core.failoverPolicies.view(principal, 'main');
		expect(view.lastDrill?.status).toBe('running');
		expect(view.evidence.drillId).not.toBe(view.lastDrill?.id);
		expect(view.refusals.map((refusal) => refusal.code)).toEqual(['drill-running']);
	});

	test('a member with no node row is refused as missing capability', () => {
		addReplica('nod_missing');
		const refusals = core.failoverPolicies.refusals(principal, 'main');
		expect(refusals.map((refusal) => refusal.code)).toContain('member-capability-missing');
		expect(refusals.find((refusal) => refusal.code === 'member-capability-missing')?.detail).toMatchObject({
			nodeIds: expect.arrayContaining(['nod_missing']),
		});
	});

	test('arming checks the refusal gates before the lane A stub', async () => {
		setFeature('DB_AUTO_PROMOTE', true);
		await expect(core.failoverPolicies.arm(principal, 'main', { confirm: true, acceptDataLoss: false })).rejects.toMatchObject({
			code: 'conflict',
			message: expect.stringContaining('cannot be armed'),
		});
	});

	test('arming, disarming and drilling refuse honestly', async () => {
		// DB_AUTO_PROMOTE is off, so arming is refused at the first gate.
		await expect(core.failoverPolicies.arm(principal, 'main', { confirm: true, acceptDataLoss: false })).rejects.toMatchObject({
			code: 'unavailable',
		});
		// Disarming is always safe and immediate.
		const disarmed = await core.failoverPolicies.disarm(principal, 'main');
		expect(disarmed.failoverMode).toBe('manual');
		// A drill needs the replica machine, which is off by default.
		await expect(core.failoverPolicies.drill(principal, 'main', { confirm: true })).rejects.toMatchObject({
			code: 'unavailable',
		});
	});
});

describe('W15 foundation', () => {
	test('SLO objects are created and evaluated; a blind telemetry store is a note', async () => {
		expect(core.slos.list(principal, project.slug)).toEqual([]);
		const created = await core.slos.upsert(
			principal,
			project.slug,
			sloObjectInputSchema.parse({ name: 'availability', indicator: 'http_availability', target: 0.999, windowSeconds: 86_400 }),
		);
		expect(created.id).toStartWith('slo_');
		expect(core.slos.list(principal, project.slug)).toHaveLength(1);
		const [evaluation] = await core.slos.evaluate(principal, project.slug);
		expect(evaluation!.sloId).toBe(created.id);
		// This fixture has no ClickHouse: the evaluation says so rather than inventing a healthy ratio.
		expect(evaluation!.note).toContain('telemetry');
		expect(evaluation!.errorBudget.consumed).toBe(0);
		core.slos.remove(principal, project.slug, created.id);
	});

	test('a registered prober posts with its token and a duplicate sequence is ignored', async () => {
		expect(core.externalProber.enabled()).toBe(true);
		const registration = core.externalProber.register(principal, { name: 'foundation', installId: null, intervalSeconds: 60 });
		expect(registration.token).toStartWith('yoalp_');
		const report = externalProberReportSchema.parse({
			proberId: registration.prober.proberId,
			sequence: 1,
			sentAt: new Date(clock).toISOString(),
			installId: null,
			targets: [{ target: 'https://app.test/healthz', kind: 'https', status: 'up', checkedAt: new Date(clock).toISOString() }],
		});
		expect((await core.externalProber.report(registration.token, report)).accepted).toBe(1);
		expect((await core.externalProber.report(registration.token, report)).accepted).toBe(0);
	});

	test('SLO and prober writes are refused while their flags are off', async () => {
		setFeature('SLO_OBJECTS', false);
		setFeature('EXTERNAL_PROBER', false);
		const input = sloObjectInputSchema.parse({ name: 'availability', indicator: 'http_availability', target: 0.999, windowSeconds: 86_400 });
		expect(core.slos.list(principal, project.slug)).toEqual([]);
		await expect(core.slos.upsert(principal, project.slug, input)).rejects.toMatchObject({ code: 'unavailable' });
		await expect(core.slos.evaluate(principal, project.slug)).rejects.toMatchObject({ code: 'unavailable' });
		expect(core.externalProber.enabled()).toBe(false);
		const report = externalProberReportSchema.parse({
			proberId: 'prb_1',
			sequence: 2,
			sentAt: new Date(clock).toISOString(),
			installId: null,
			targets: [{ target: 'https://app.test/healthz', kind: 'https', status: 'up', checkedAt: new Date(clock).toISOString() }],
		});
		await expect(core.externalProber.report('token', report)).rejects.toMatchObject({ code: 'unavailable' });
		setFeature('SLO_OBJECTS', true);
		setFeature('EXTERNAL_PROBER', true);
	});
});
