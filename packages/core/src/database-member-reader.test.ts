import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES } from '@yoal/contracts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { MemoryConditionalStore } from './ha-lease.ts';
import { ObjectStoreDatabaseLeaseStore } from './database-sync.ts';
import { buildPrincipal } from './orgs.ts';

/**
 * W11 control-plane reader and consumer discovery (W11-SPEC §6/§7): the reader reconciles a
 * promotion that happened with it down, never lowers a generation, and alerts on an invalid
 * promotion or two primaries; consumers fail closed on no target or a same-generation tie.
 */
const dir = mkdtempSync(join(tmpdir(), 'yoal-w4-reader-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.parse('2026-11-21T10:00:00Z');
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
		features: { ...DEFAULT_FEATURES, SYNC_REPLICA: true },
	},
});
const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const primary = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'primary').token, name: 'primary' });
opened.sqlite.run("UPDATE nodes SET status = 'online', capabilities_json = '[\"db-member\"]' WHERE id = ?", [primary.nodeId]);
const database = core.databases.create(principal, { name: 'main', placement: primary.nodeId });
const extraNodes: string[] = [];
let sequence = 0;

function addNode(): string {
	const joined = core.nodes.join({ token: core.nodes.createJoinToken(principal, `data-${++sequence}`).token, name: `data-${sequence}` });
	opened.sqlite.run("UPDATE nodes SET status = 'online', capabilities_json = '[\"db-member\"]' WHERE id = ?", [joined.nodeId]);
	extraNodes.push(joined.nodeId);
	return joined.nodeId;
}

function addReplica(nodeId: string, hostPort: number): string {
	const id = `dbr_${++sequence}`;
	opened.sqlite.run(
		`INSERT INTO database_replicas (id, database_id, node_id, status, slot, primary_generation, host_port, replay_lsn, reported_at, created_at, updated_at)
		 VALUES (?, ?, ?, 'streaming', ?, 0, ?, '0/200', ?, 1, 1)`,
		[id, database.id, nodeId, `slot_${sequence}`, hostPort, clock],
	);
	return id;
}

function report(nodeId: string, role: string, generation: number, lsn: string | null = '0/200'): void {
	opened.sqlite.run(
		`INSERT INTO database_member_status
		 (database_id, node_id, role, generation, epoch, streaming, in_recovery, lsn, durability_effective, sync_state,
		  read_only, fenced, lease_generation, lease_epoch, observed_at)
		 VALUES (?, ?, ?, ?, 0, 1, 0, ?, 'sync', 'steady', 0, 0, ?, 0, ?)
		 ON CONFLICT(database_id, node_id) DO UPDATE SET role = excluded.role, generation = excluded.generation,
		 lsn = excluded.lsn, observed_at = excluded.observed_at`,
		[database.id, nodeId, role, generation, lsn, generation, clock],
	);
}

function row(): { nodeId: string; generation: number } {
	const value = opened.sqlite
		.query<{ node_id: string; primary_generation: number }, [string]>('SELECT node_id, primary_generation FROM databases WHERE id = ?')
		.get(database.id)!;
	return { nodeId: value.node_id, generation: value.primary_generation };
}

function auditActions(): string[] {
	return opened.sqlite
		.query<{ action: string }, []>('SELECT action FROM audit_log ORDER BY rowid')
		.all()
		.map((entry) => entry.action);
}

beforeEach(() => {
	opened.sqlite.run('DELETE FROM database_member_status');
	opened.sqlite.run('DELETE FROM database_failovers');
	opened.sqlite.run('DELETE FROM database_replicas');
	opened.sqlite.run('DELETE FROM audit_log');
	for (const id of extraNodes) opened.sqlite.run('DELETE FROM nodes WHERE id = ?', [id]);
	extraNodes.length = 0;
	opened.sqlite.run("UPDATE nodes SET status = 'online', capabilities_json = '[\"db-member\"]' WHERE id = ?", [primary.nodeId]);
	opened.sqlite.run(
		"UPDATE databases SET node_id = ?, primary_generation = 0, status = 'running', message = NULL, durability = 'async', durability_effective = 'async', failover_mode = 'manual', accept_data_loss = 0, auto_armed_at = NULL WHERE id = ?",
		[primary.nodeId, database.id],
	);
	(core.ctx as { arbiter: unknown }).arbiter = null;
	clock = Date.parse('2026-11-21T10:00:00Z');
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('desired state', () => {
	test('the failover policy is omitted for a manual database and present only for an armed one', () => {
		const a = addNode();
		addReplica(a, 5433);
		expect(core.databaseMembers.membersDesired(database.id)?.failover).toBeUndefined();
		(core.ctx.config.features as Record<string, boolean>).DB_AUTO_PROMOTE = true;
		opened.sqlite.run(
			"UPDATE databases SET failover_mode = 'auto', accept_data_loss = 1, auto_armed_at = ?, durability = 'async', durability_effective = 'async' WHERE id = ?",
			[clock, database.id],
		);
		expect(core.databaseMembers.membersDesired(database.id)?.failover).toEqual({
			mode: 'auto',
			acceptDataLoss: true,
			autoArmedAt: new Date(clock).toISOString(),
		});
	});
});

describe('consumer discovery', () => {
	test('picks the primary at the highest generation', async () => {
		const a = addNode();
		report(primary.nodeId, 'fenced', 0);
		report(a, 'primary', 1);
		expect(await core.databaseMembers.consumerTarget(database.id)).toMatchObject({ target: a, generation: 1, reason: 'ok' });
	});

	test('fails closed when no member answers primary', async () => {
		report(primary.nodeId, 'fenced', 0);
		report(addNode(), 'streaming', 0);
		expect(await core.databaseMembers.consumerTarget(database.id)).toMatchObject({ target: null, reason: 'no-primary', twoPrimaries: false });
	});

	test('fails closed and flags two primaries at one generation', async () => {
		const a = addNode();
		const b = addNode();
		report(a, 'primary', 1);
		report(b, 'primary', 1);
		expect(await core.databaseMembers.consumerTarget(database.id)).toMatchObject({
			target: null,
			generation: 1,
			reason: 'two-primaries',
			twoPrimaries: true,
		});
	});

	test('ignores a stale report', async () => {
		const a = addNode();
		report(a, 'primary', 1);
		clock += 600_000;
		expect(await core.databaseMembers.consumerTarget(database.id)).toMatchObject({ target: null, reason: 'no-answer' });
	});
});

describe('the promotion reader', () => {
	test('reconciles a promotion that happened while the control plane was down', async () => {
		const a = addNode();
		const replicaId = addReplica(a, 5433);
		report(primary.nodeId, 'fenced', 0);
		report(a, 'primary', 1, '0/300');
		expect(await core.databaseMembers.reconcilePromotions()).toBe(1);
		expect(row()).toEqual({ nodeId: a, generation: 1 });
		const failover = opened.sqlite
			.query<{ status: string; promotion_source: string; evidence_json: string }, []>('SELECT status, promotion_source, evidence_json FROM database_failovers')
			.get();
		expect(failover).toMatchObject({ status: 'completed', promotion_source: 'auto' });
		expect(JSON.parse(failover?.evidence_json ?? '{}')).toMatchObject({ reconciled: true });
		// The promoted replica row is consumed and the others are rebuilt.
		expect(opened.sqlite.query<{ count: number }, [string]>('SELECT count(*) AS count FROM database_replicas WHERE id = ?').get(replicaId)?.count).toBe(0);
		expect(auditActions()).toContain('database.failover.reconciled');
	});

	test('never lowers a generation', async () => {
		const a = addNode();
		addReplica(a, 5433);
		opened.sqlite.run('UPDATE databases SET primary_generation = 3 WHERE id = ?', [database.id]);
		report(a, 'primary', 2);
		expect(await core.databaseMembers.reconcilePromotions()).toBe(0);
		expect(row()).toMatchObject({ generation: 3, nodeId: primary.nodeId });
	});

	test('detects two primaries at one generation without moving the row', async () => {
		const a = addNode();
		const b = addNode();
		addReplica(a, 5433);
		addReplica(b, 5434);
		report(a, 'primary', 1);
		report(b, 'primary', 1);
		expect(await core.databaseMembers.reconcilePromotions()).toBe(0);
		expect(row()).toMatchObject({ generation: 0, nodeId: primary.nodeId });
	});

	test('refuses an ineligible promotion and pages', async () => {
		const a = addNode();
		addReplica(a, 5433);
		const store = new MemoryConditionalStore();
		(core.ctx as { arbiter: unknown }).arbiter = store;
		const leases = new ObjectStoreDatabaseLeaseStore(store);
		// The acquired lease names `b` in its sync set, not the reporter `a`.
		await leases.compareAndSwap(database.id, null, {
			generation: 1,
			holderNodeId: a,
			expiresAt: new Date(clock + 15_000).toISOString(),
			sync: [primary.nodeId],
			syncState: 'steady',
			durability: 'sync',
			durabilityEffective: 'sync',
			syncSetAt: null,
		});
		report(a, 'primary', 1);
		expect(await core.databaseMembers.reconcilePromotions()).toBe(0);
		expect(row()).toMatchObject({ generation: 0, nodeId: primary.nodeId });
		expect(auditActions()).toContain('database.failover.invalid');
	});

	test('a promotion with no replica row to move onto is not applied', async () => {
		const a = addNode();
		report(a, 'primary', 1);
		expect(await core.databaseMembers.reconcilePromotions()).toBe(0);
		expect(row()).toMatchObject({ generation: 0, nodeId: primary.nodeId });
	});
});
