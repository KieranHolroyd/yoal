import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES } from '@yoal/contracts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';

/**
 * Arming, disarming and drills (W11-SPEC §3/§12): every refusal is a named contract, the write is
 * audited, and a drill records a real promotion measurement instead of a fake pass.
 */
const dir = mkdtempSync(join(tmpdir(), 'yoal-w4-policy-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.parse('2026-11-21T10:00:00Z');
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
		features: { ...DEFAULT_FEATURES },
	},
});
const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const node = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'data').token, name: 'data' });
opened.sqlite.run('UPDATE nodes SET capabilities_json = ?, status = ?, zone = ? WHERE id = ?', ['["db-member"]', 'online', 'a', node.nodeId]);
const database = core.databases.create(principal, { name: 'main', placement: node.nodeId });
const extraNodes: string[] = [];
let sequence = 0;

function feature(name: keyof typeof DEFAULT_FEATURES, value: boolean): void {
	(core.ctx.config.features as Record<string, boolean>)[name] = value;
}

function reset(): void {
	opened.sqlite.run('DELETE FROM database_failover_drills');
	opened.sqlite.run('DELETE FROM database_failovers');
	opened.sqlite.run('DELETE FROM database_replicas');
	opened.sqlite.run('DELETE FROM audit_log');
	for (const id of extraNodes) opened.sqlite.run('DELETE FROM nodes WHERE id = ?', [id]);
	extraNodes.length = 0;
	opened.sqlite.run('UPDATE nodes SET capabilities_json = ?, status = ?, zone = ? WHERE id = ?', ['["db-member"]', 'online', 'a', node.nodeId]);
	opened.sqlite.run(
		`UPDATE databases SET engine_name = 'postgres', durability = 'async', durability_effective = 'async',
		 accept_data_loss = 0, failover_mode = 'manual', sync_state = 'steady', last_failover_drill_at = NULL,
		 failover_evidence_json = '{}', auto_armed_at = NULL, sync_lease_etag = NULL, sync_lease_expires_at = NULL
		 WHERE id = ?`,
		[database.id],
	);
	feature('DB_AUTO_PROMOTE', false);
	feature('SYNC_REPLICA', false);
	clock = Date.parse('2026-11-21T10:00:00Z');
}

function addDataNode(zone = 'a'): string {
	const joined = core.nodes.join({ token: core.nodes.createJoinToken(principal, `data-${++sequence}`).token, name: `data-${sequence}` });
	opened.sqlite.run('UPDATE nodes SET zone = ?, status = ?, capabilities_json = ? WHERE id = ?', [
		zone,
		'online',
		'["db-member","database-replicas"]',
		joined.nodeId,
	]);
	extraNodes.push(joined.nodeId);
	return joined.nodeId;
}

function addReplica(nodeId: string, status = 'streaming', replayLsn = '0/100'): string {
	const id = `dbr_${++sequence}`;
	opened.sqlite.run(
		`INSERT INTO database_replicas (id, database_id, node_id, status, slot, primary_generation, replay_lsn, reported_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 0, ?, ?, 1, 1)`,
		[id, database.id, nodeId, status, `slot_${sequence}`, replayLsn, clock],
	);
	return id;
}

function addDrill(overrides: Partial<{ status: string; finishedAt: number | null; timeToWritableMs: number | null; lostCommits: number | null; arbiterTested: number }> = {}): string {
	const id = `drl_${++sequence}`;
	const drill = {
		status: 'passed',
		finishedAt: clock,
		timeToWritableMs: 21_000,
		lostCommits: 0,
		arbiterTested: 1,
		...overrides,
	};
	opened.sqlite.run(
		`INSERT INTO database_failover_drills
		 (id, database_id, drill_database_id, status, durability, started_at, finished_at, time_to_writable_ms,
		  lost_commits, generation, arbiter_tested, arbiter_tested_at, created_by, created_at)
		 VALUES (?, ?, 'db_disposable', ?, 'async', ?, ?, ?, ?, 0, ?, ?, 'user_1', 1)`,
		[id, database.id, drill.status, clock - 1_000, drill.finishedAt, drill.timeToWritableMs, drill.lostCommits, drill.arbiterTested, drill.arbiterTested === 1 ? clock : null],
	);
	return id;
}

function eligibleAsync(): void {
	addDataNode('a');
	addDataNode('b');
	addReplica(extraNodes[0]!, 'streaming');
	opened.sqlite.run("UPDATE databases SET durability = 'async', durability_effective = 'async' WHERE id = ?", [database.id]);
	addDrill();
	feature('DB_AUTO_PROMOTE', true);
}

function auditActions(): string[] {
	return opened.sqlite
		.query<{ action: string }, []>('SELECT action FROM audit_log ORDER BY rowid')
		.all()
		.map((row) => row.action);
}

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('arming', () => {
	beforeEach(reset);

	test('refuses while the global flag is off without writing a policy', async () => {
		eligibleAsync();
		feature('DB_AUTO_PROMOTE', false);
		await expect(core.failoverPolicies.arm(principal, 'main', { confirm: true, acceptDataLoss: true })).rejects.toMatchObject({
			code: 'unavailable',
		});
		expect(core.failoverPolicies.view(principal, 'main').failoverMode).toBe('manual');
		expect(auditActions()).not.toContain('database.failover.arm');
	});

	test('refuses every unmet gate and names them all', async () => {
		feature('DB_AUTO_PROMOTE', true);
		await expect(core.failoverPolicies.arm(principal, 'main', { confirm: true, acceptDataLoss: true })).rejects.toMatchObject({
			code: 'conflict',
			message: expect.stringContaining('zones'),
		});
		expect(core.failoverPolicies.view(principal, 'main').failoverMode).toBe('manual');
	});

	test('an async database needs the operator acknowledgement', async () => {
		eligibleAsync();
		await expect(core.failoverPolicies.arm(principal, 'main', { confirm: true, acceptDataLoss: false })).rejects.toMatchObject({
			code: 'conflict',
			message: expect.stringContaining('acceptDataLoss'),
		});
		const armed = await core.failoverPolicies.arm(principal, 'main', { confirm: true, acceptDataLoss: true });
		expect(armed).toMatchObject({ failoverMode: 'auto', acceptDataLoss: true });
		expect(armed.armedEvidence).not.toBeNull();
		expect(auditActions()).toContain('database.failover.arm');
	});

	test('a sync database refuses acceptDataLoss and arms without it', async () => {
		eligibleAsync();
		opened.sqlite.run(
			"UPDATE databases SET durability = 'sync', durability_effective = 'sync', sync_lease_etag = 'etag' WHERE id = ?",
			[database.id],
		);
		await expect(core.failoverPolicies.arm(principal, 'main', { confirm: true, acceptDataLoss: true })).rejects.toMatchObject({
			code: 'conflict',
			message: expect.stringContaining('acceptDataLoss'),
		});
		const armed = await core.failoverPolicies.arm(principal, 'main', { confirm: true, acceptDataLoss: false });
		expect(armed.failoverMode).toBe('auto');
		expect(armed.acceptDataLoss).toBe(false);
	});

	test('arming refuses a no-drill policy', async () => {
		eligibleAsync();
		opened.sqlite.run('DELETE FROM database_failover_drills');
		await expect(core.failoverPolicies.arm(principal, 'main', { confirm: true, acceptDataLoss: true })).rejects.toMatchObject({
			code: 'conflict',
			message: expect.stringContaining('No failover drill'),
		});
	});

	test('arming can name an earlier passed drill', async () => {
		eligibleAsync();
		const older = addDrill({ finishedAt: clock - 10_000 });
		addDrill({ finishedAt: clock });
		const armed = await core.failoverPolicies.arm(principal, 'main', { confirm: true, acceptDataLoss: true, drillId: older });
		expect(armed.armedEvidence?.drillId).toBe(older);
	});

	test('arming refuses a named drill that did not pass', async () => {
		eligibleAsync();
		const failed = addDrill({ status: 'failed' });
		await expect(
			core.failoverPolicies.arm(principal, 'main', { confirm: true, acceptDataLoss: true, drillId: failed }),
		).rejects.toMatchObject({ code: 'conflict' });
	});
});

describe('disarming', () => {
	beforeEach(reset);

	test('is immediate, accepts no confirmation, and keeps the database serving', async () => {
		eligibleAsync();
		await core.failoverPolicies.arm(principal, 'main', { confirm: true, acceptDataLoss: true });
		const view = await core.failoverPolicies.disarm(principal, 'main');
		expect(view).toMatchObject({ failoverMode: 'manual', autoArmedAt: null, armedEvidence: null });
		expect(auditActions()).toContain('database.failover.disarm');
		// No failover row and no fence intent were written.
		expect(opened.sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM database_failovers').get()?.count).toBe(0);
	});
});

describe('drills', () => {
	beforeEach(reset);

	test('need the replica machine and a promotable replica', async () => {
		await expect(core.failoverPolicies.drill(principal, 'main', { confirm: true })).rejects.toMatchObject({ code: 'unavailable' });
		feature('SYNC_REPLICA', true);
		await expect(core.failoverPolicies.drill(principal, 'main', { confirm: true })).rejects.toMatchObject({
			code: 'conflict',
			message: expect.stringContaining('No readable replica'),
		});
	});

	test('start the same promotion path and record a running drill', async () => {
		feature('SYNC_REPLICA', true);
		const replicaNode = addDataNode('b');
		addReplica(replicaNode, 'streaming', '0/200');
		opened.sqlite.run('UPDATE databases SET sync_lease_etag = ?, sync_lease_expires_at = ? WHERE id = ?', [
			'etag-1',
			clock,
			database.id,
		]);
		const drill = await core.failoverPolicies.drill(principal, 'main', { confirm: true, note: 'lab' });
		expect(drill.status).toBe('running');
		expect(drill.generation).toBe(1);
		expect(drill.toNodeId).toBe(replicaNode);
		const failover = opened.sqlite.query<{ promotion_source: string; evidence_json: string }, []>('SELECT promotion_source, evidence_json FROM database_failovers').get();
		expect(failover?.promotion_source).toBe('drill');
		expect(JSON.parse(failover?.evidence_json ?? '{}')).toMatchObject({ drillId: drill.id });
		expect(auditActions()).toEqual(expect.arrayContaining(['database.failover.drill.start', 'database.failover.promote']));
	});

	test('completion records the measurement and 0 lost commits for sync', async () => {
		feature('SYNC_REPLICA', true);
		const replicaNode = addDataNode('b');
		addReplica(replicaNode, 'streaming', '0/200');
		opened.sqlite.run(
			"UPDATE databases SET durability = 'sync', durability_effective = 'sync', sync_lease_etag = ?, sync_lease_expires_at = ? WHERE id = ?",
			['etag-1', clock, database.id],
		);
		// A drill simulates the primary's loss; keep its heartbeat fresh so the fence is confirmable.
		opened.sqlite.run('UPDATE nodes SET last_heartbeat_at = ? WHERE id = ?', [clock, node.nodeId]);
		const drill = await core.failoverPolicies.drill(principal, 'main', { confirm: true });
		// The measurement starts at the last lease write (expiry - 15 s).
		core.failoverPolicies.completeDrill(drill.id, { passed: true, writableAt: clock - 15_000 + 21_000 });
		const completed = core.failoverPolicies.view(principal, 'main').lastDrill!;
		expect(completed).toMatchObject({
			id: drill.id,
			status: 'passed',
			timeToWritableMs: 21_000,
			lostCommits: 0,
			arbiterTested: true,
		});
		expect(auditActions()).toContain('database.failover.drill.complete');
	});

	test('a slow completion is a failed drill, not a pass', async () => {
		feature('SYNC_REPLICA', true);
		const replicaNode = addDataNode('b');
		addReplica(replicaNode, 'streaming', '0/200');
		opened.sqlite.run('UPDATE databases SET sync_lease_etag = ?, sync_lease_expires_at = ? WHERE id = ?', [
			'etag-1',
			clock,
			database.id,
		]);
		const drill = await core.failoverPolicies.drill(principal, 'main', { confirm: true });
		core.failoverPolicies.completeDrill(drill.id, { passed: true, writableAt: clock - 15_000 + 30_001 });
		expect(core.failoverPolicies.view(principal, 'main').lastDrill).toMatchObject({
			status: 'failed',
			timeToWritableMs: 30_001,
		});
	});

	test('an unmeasured completion cannot arm', async () => {
		feature('SYNC_REPLICA', true);
		const replicaNode = addDataNode('b');
		addReplica(replicaNode, 'streaming', '0/200');
		const drill = await core.failoverPolicies.drill(principal, 'main', { confirm: true });
		core.failoverPolicies.completeDrill(drill.id, { passed: true, writableAt: null });
		expect(core.failoverPolicies.view(principal, 'main').lastDrill).toMatchObject({
			status: 'failed',
			timeToWritableMs: null,
		});
	});
});
