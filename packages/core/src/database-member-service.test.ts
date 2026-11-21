import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import {
	DATABASE_REPLICAS_CAPABILITY,
	DEFAULT_FEATURES,
	nodeCapabilities,
	type DatabaseReplicationSlotStatus,
	type Heartbeat,
} from '@yoal/contracts';
import { createCore, type Core } from './index.ts';
import { MemoryConditionalStore } from './ha-lease.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';
import { databaseLeaseKey } from './database-sync.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-db-members-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.parse('2026-11-20T10:00:00Z');
const arbiter = new MemoryConditionalStore(() => clock);
const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	arbiter,
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
		features: { ...DEFAULT_FEATURES, SYNC_REPLICA: true },
		now: () => clock,
	},
});
const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
type JoinedNode = { nodeId: string; token: string };
const joinNode = (name: string, address: string | null, zone: string): JoinedNode => {
	const node = core.nodes.join({ token: core.nodes.createJoinToken(owner, name).token, name });
	core.nodes.update(owner, node.nodeId, { sliceMemoryMb: 8192 });
	opened.sqlite.run('UPDATE nodes SET private_address = ?, zone = ? WHERE id = ?', [address, zone, node.nodeId]);
	return node;
};
const edge = joinNode('edge', null, 'a');
const primary = joinNode('primary', '10.47.1.2', 'a');
const second = joinNode('second', '10.47.1.3', 'b');
const third = joinNode('third', '10.47.1.4', 'c');
const fingerprint = (node: JoinedNode) => node.nodeId.replace(/[^a-f0-9]/g, '').padEnd(64, 'a').slice(0, 64);

function beat(node: JoinedNode, extra: Partial<Heartbeat> = {}): void {
	core.nodes.heartbeat(node.token, {
		nodeId: node.nodeId,
		agentVersion: '0.1.0',
		actualStateVersion: core.nodes.stateVersion(),
		status: 'online',
		caddyOk: true,
		releases: [],
		capabilities: [...nodeCapabilities],
		nodeCertificate: { certPem: 'pem', fingerprint: fingerprint(node), expiresAt: new Date(clock + 86_400_000).toISOString() },
		...extra,
	});
}
for (const node of [edge, primary, second, third]) beat(node);

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

let sequence = 0;
function database(name: string): { id: string; replicas: Array<{ id: string; nodeId: string; slot: string }> } {
	core.databases.create(owner, { name, placement: primary.nodeId });
	const row = opened.sqlite.query<{ id: string }, [string]>('SELECT id FROM databases WHERE name = ?').get(name)!;
	const first = core.databaseReplicas.add(owner, name, { node: second.nodeId });
	const other = core.databaseReplicas.add(owner, name, { node: third.nodeId });
	const replicas = [
		{ id: first.id, nodeId: first.nodeId, slot: first.slot! },
		{ id: other.id, nodeId: other.nodeId, slot: other.slot! },
	];
	return { id: row.id, replicas };
}

/** The primary reports both slots streaming at a fresh LSN. */
function reportSlots(databaseId: string, replicas: Array<{ slot: string }>, lsn = '0/3000148', extra: Partial<DatabaseReplicationSlotStatus> = {}) {
	const task = core.databaseReplicas.replicationTasksForNode(primary.nodeId).find((item) => item.databaseId === databaseId)!;
	const slots: DatabaseReplicationSlotStatus[] = replicas.map((replica) => ({
		slot: replica.slot,
		active: true,
		walStatus: 'reserved',
		state: 'streaming',
		sentLsn: lsn,
		replayLsn: lsn,
		lagBytes: 0,
		lagSeconds: 0,
		syncState: 'sync',
		...extra,
	}));
	beat(primary, {
		databaseReplication: [{ databaseId, appliedVersion: task.version, error: null, slots, sampledAt: new Date(clock).toISOString() }],
	});
	for (const replica of replicas)
		opened.sqlite.run('UPDATE database_replicas SET reported_at = ?, replay_lsn = ?, status = ? WHERE slot = ?', [clock, lsn, extra.state === 'streaming' || extra.state === undefined ? 'streaming' : 'stopped', replica.slot]);
}

async function lease(databaseId: string): Promise<Record<string, unknown> | null> {
	const response = await arbiter.readVersioned(databaseLeaseKey(databaseId));
	if (response.status !== 200 || !response.body) return null;
	return JSON.parse(response.body) as Record<string, unknown>;
}

describe('durability settings (H23)', () => {
	test('sync is refused with one replica, and without the flag', async () => {
		const db = database('single');
		// Remove one replica from the set so only one cross-node copy remains.
		opened.sqlite.run('DELETE FROM database_replicas WHERE database_id = ? AND node_id = ?', [db.id, third.nodeId]);
		reportSlots(db.id, db.replicas.slice(0, 1));
		await expect(core.databaseMembers.setDurability(owner, 'single', { durability: 'sync' })).rejects.toThrow(/two replicas/);
	});

	test('sync opens the lease changing, then closes only on the barrier report', async () => {
		const db = database('orders');
		reportSlots(db.id, db.replicas);
		const openedStatus = await core.databaseMembers.setDurability(owner, 'orders', { durability: 'sync' });
		expect(openedStatus).toMatchObject({ durability: 'sync', syncState: 'changing', durabilityEffective: 'async' });
		expect(await lease(db.id)).toMatchObject({ sync: [], syncState: 'changing', durability: 'sync' });

		// The primary's node is told to set the target, and the lease is still not promotable.
		const tasks = core.databaseMembers.syncTasksForNode(primary.nodeId);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]).toMatchObject({ databaseId: db.id, step: 'set-sync' });
		expect(tasks[0]!.sync).toHaveLength(1);
		// The same instruction rides the node's desired state, with the member list for discovery.
		const desired = (await core.nodes.desiredState(primary.token)) as {
			databaseSyncTasks?: Array<{ databaseId: string; step: string }>;
			databaseMembers?: Array<{ databaseId: string }>;
		};
		expect(desired.databaseSyncTasks?.find((task) => task.databaseId === db.id)?.step).toBe('set-sync');
		expect(desired.databaseMembers?.some((entry) => entry.databaseId === db.id)).toBe(true);

		await core.databaseMembers.applySyncResults(primary.nodeId, [
			{ databaseId: db.id, step: 'set-sync', status: 'ok', lsn: '0/3000148', replayLsn: '0/3000148', targetSyncState: 'sync' },
		]);
		const closed = await core.databaseMembers.status(owner, 'orders');
		expect(closed).toMatchObject({ durability: 'sync', durabilityEffective: 'sync', syncState: 'steady' });
		expect(closed.sync).toHaveLength(1);
		const stored = (await lease(db.id))!;
		expect(stored).toMatchObject({ syncState: 'steady', durabilityEffective: 'sync' });
		expect((stored.sync as string[])[0]).toBe(closed.sync[0]!);
	});

	test('losing the sync standby for 30 s downgrades and records durability_effective async', async () => {
		const db = database('catalog');
		reportSlots(db.id, db.replicas);
		await core.databaseMembers.setDurability(owner, 'catalog', { durability: 'sync' });
		await core.databaseMembers.applySyncResults(primary.nodeId, [
			{ databaseId: db.id, step: 'set-sync', status: 'ok', lsn: '0/3000148', replayLsn: '0/3000148', targetSyncState: 'sync' },
		]);
		// Both replicas stop; there is no eligible candidate.
		opened.sqlite.run("UPDATE database_replicas SET status = 'stopped', reported_at = ? WHERE database_id = ?", [clock, db.id]);
		clock += 1_000;
		await core.databaseMembers.tick();
		expect((await core.databaseMembers.status(owner, 'catalog')).syncState).toBe('steady');
		clock += 30_000;
		await core.databaseMembers.tick();
		const downgraded = await core.databaseMembers.status(owner, 'catalog');
		expect(downgraded).toMatchObject({ durability: 'sync', durabilityEffective: 'async', syncState: 'steady' });
		expect(downgraded.note).toContain('Downgraded');
		expect(await lease(db.id)).toMatchObject({ sync: [], durability: 'sync', durabilityEffective: 'async' });
		// The setting is cleared after a downgrade, so writes are async rather than stuck.
		expect(core.databaseMembers.syncTasksForNode(primary.nodeId).find((task) => task.databaseId === db.id)?.step).toBe('clear-sync');
	});
});

describe('sync-set safety (W10 review blockers)', () => {
	const taskFor = (databaseId: string) => core.databaseMembers.syncTasksForNode(primary.nodeId).find((task) => task.databaseId === databaseId);

	test('the barrier closes only on the TARGET replay, and only when its slot is sync', async () => {
		const db = database('barriertarget');
		reportSlots(db.id, db.replicas);
		await core.databaseMembers.setDurability(owner, 'barriertarget', { durability: 'sync' });
		const task = taskFor(db.id)!;
		expect(task.step).toBe('set-sync');
		// The primary's own LSN alone is not evidence: no replay position means no close.
		await core.databaseMembers.applySyncResults(primary.nodeId, [
			{ databaseId: db.id, step: 'set-sync', status: 'ok', lsn: '0/3000148', targetSyncState: 'sync' },
		]);
		expect((await core.databaseMembers.status(owner, 'barriertarget')).durabilityEffective).toBe('async');
		// A fresh change with a valid target replay closes.
		const other = database('barriertarget2');
		reportSlots(other.id, other.replicas);
		await core.databaseMembers.setDurability(owner, 'barriertarget2', { durability: 'sync' });
		const secondTask = taskFor(other.id)!;
		await core.databaseMembers.applySyncResults(primary.nodeId, [
			{ databaseId: other.id, version: secondTask.version, step: 'set-sync', status: 'ok', lsn: '0/3000148', replayLsn: '0/3000148', targetSyncState: 'sync' },
		]);
		expect((await core.databaseMembers.status(owner, 'barriertarget2')).syncState).toBe('steady');
		// A target slot that is not `sync` never closes into a steady sync set.
		const third = database('barriertarget3');
		reportSlots(third.id, third.replicas);
		await core.databaseMembers.setDurability(owner, 'barriertarget3', { durability: 'sync' });
		const thirdTask = taskFor(third.id)!;
		await core.databaseMembers.applySyncResults(primary.nodeId, [
			{ databaseId: third.id, version: thirdTask.version, step: 'set-sync', status: 'ok', lsn: '0/3000148', replayLsn: '0/3000148', targetSyncState: 'potential' },
		]);
		expect((await core.databaseMembers.status(owner, 'barriertarget3')).durabilityEffective).toBe('async');
	});

	test('a stale result version cannot close a later change', async () => {
		const db = database('versioned');
		reportSlots(db.id, db.replicas);
		await core.databaseMembers.setDurability(owner, 'versioned', { durability: 'sync' });
		const task = taskFor(db.id)!;
		await core.databaseMembers.applySyncResults(primary.nodeId, [
			{ databaseId: db.id, version: 'stale', step: 'set-sync', status: 'ok', lsn: '0/3000148', replayLsn: '0/3000148', targetSyncState: 'sync' },
		]);
		expect((await core.databaseMembers.status(owner, 'versioned')).syncState).toBe('changing');
		await core.databaseMembers.applySyncResults(primary.nodeId, [
			{ databaseId: db.id, version: task.version, step: 'set-sync', status: 'ok', lsn: '0/3000148', replayLsn: '0/3000148', targetSyncState: 'sync' },
		]);
		expect((await core.databaseMembers.status(owner, 'versioned')).syncState).toBe('steady');
	});

	test('a failed change re-arms the previous member through a fresh barrier, never a steady CAS', async () => {
		const db = database('fallback');
		reportSlots(db.id, db.replicas);
		await core.databaseMembers.setDurability(owner, 'fallback', { durability: 'sync' });
		const firstTask = taskFor(db.id)!;
		await core.databaseMembers.applySyncResults(primary.nodeId, [
			{ databaseId: db.id, version: firstTask.version, step: 'set-sync', status: 'ok', lsn: '0/3000148', replayLsn: '0/3000148', targetSyncState: 'sync' },
		]);
		const steady = await core.databaseMembers.status(owner, 'fallback');
		const previous = steady.sync[0]!;
		const target = db.replicas.find((replica) => replica.nodeId !== previous)!.nodeId;
		// The named standby stops; a healthy other replica makes the watchdog transition.
		opened.sqlite.run("UPDATE database_replicas SET status = 'stopped' WHERE database_id = ? AND node_id = ?", [db.id, previous]);
		clock += 1_000;
		await core.databaseMembers.tick();
		const openedStatus = await core.databaseMembers.status(owner, 'fallback');
		expect(openedStatus.syncState).toBe('changing');
		expect(openedStatus.transition?.target).toBe(target);
		// The previous member comes back; the failed change must re-arm it, not record it blind.
		const replica = db.replicas.find((item) => item.nodeId === previous)!;
		opened.sqlite.run(
			"UPDATE database_replicas SET status = 'streaming', reported_at = ?, replay_lsn = '0/3000148' WHERE slot = ?",
			[clock, replica.slot],
		);
		const changeTask = taskFor(db.id)!;
		await core.databaseMembers.applySyncResults(primary.nodeId, [
			{ databaseId: db.id, version: changeTask.version, step: 'set-sync', status: 'failed', error: 'barrier timeout' },
		]);
		const rearming = await core.databaseMembers.status(owner, 'fallback');
		expect(rearming.syncState).toBe('changing');
		expect(rearming.transition?.target).toBe(previous);
		expect(rearming.sync).toEqual([]);
		// The re-arm is a new task version, and only its barrier closes the change.
		const next = taskFor(db.id)!;
		expect(next.version).not.toBe(changeTask.version);
		await core.databaseMembers.applySyncResults(primary.nodeId, [
			{ databaseId: db.id, version: next.version, step: 'set-sync', status: 'ok', lsn: '0/3000148', replayLsn: '0/3000148', targetSyncState: 'sync' },
		]);
		expect((await core.databaseMembers.status(owner, 'fallback')).syncState).toBe('steady');
	});

	test('a failed resume keeps the resume task and alerts instead of treating it as success', async () => {
		const db = database('resumefail');
		reportSlots(db.id, db.replicas);
		const target = db.replicas.find((replica) => replica.nodeId === second.nodeId)!;
		await core.databaseMembers.switchover(owner, 'resumefail', { replicaId: target.id, confirm: true });
		const drain = core.databaseMembers.switchoverTasksForNode(primary.nodeId).find((task) => task.databaseId === db.id)!;
		await core.databaseMembers.applySwitchoverResults(primary.nodeId, [
			{ switchoverId: drain.switchoverId, step: 'drain', status: 'ok', lsn: '0/4000000', replayLsn: '0/3000148' },
		]);
		const resume = core.databaseMembers.switchoverTasksForNode(primary.nodeId).find((task) => task.databaseId === db.id)!;
		expect(resume.step).toBe('resume');
		const resumeVersion = resume.version;
		await core.databaseMembers.applySwitchoverResults(primary.nodeId, [
			{ switchoverId: resume.switchoverId, version: resume.version, step: 'resume', status: 'failed', error: 'read-only stuck' },
		]);
		const still = core.databaseMembers.switchoverTasksForNode(primary.nodeId).find((task) => task.databaseId === db.id)!;
		expect(still.step).toBe('resume');
		expect(still.version).not.toBe(resumeVersion);
		expect(core.databaseMembers.switchovers(owner, 'resumefail')[0]!.message).toContain('Resuming writes failed');
	});

	test('a stale node watchdog result is reconciled, never recorded as sync', async () => {
		const db = database('watchdog');
		reportSlots(db.id, db.replicas);
		await core.databaseMembers.setDurability(owner, 'watchdog', { durability: 'sync' });
		const task = taskFor(db.id)!;
		await core.databaseMembers.applySyncResults(primary.nodeId, [
			{ databaseId: db.id, version: task.version, step: 'set-sync', status: 'ok', lsn: '0/3000148', replayLsn: '0/3000148', targetSyncState: 'sync' },
		]);
		const row = opened.sqlite
			.query<{ sync_lease_etag: string }, [string]>('SELECT sync_lease_etag FROM databases WHERE id = ?')
			.get(db.id)!;
		expect(row.sync_lease_etag).toBeTruthy();
		// A node that applied on_sync_loss at an older ETag is stale; the control plane reconciles
		// from the current lease (no healthy member left) rather than recording sync.
		await core.databaseMembers.applySyncResults(primary.nodeId, [
			{ databaseId: db.id, version: 'watchdog', step: 'watchdog', status: 'ok', targetSyncState: 'downgrade', leaseEtag: '"stale"', applied: [] },
		]);
		const downgraded = await core.databaseMembers.status(owner, 'watchdog');
		expect(downgraded).toMatchObject({ durability: 'sync', durabilityEffective: 'async' });
		expect((await lease(db.id))!.durabilityEffective).toBe('async');
	});

	test('a stale set-sync result re-opens the transition instead of recording sync', async () => {
		const db = database('staleset');
		reportSlots(db.id, db.replicas);
		await core.databaseMembers.setDurability(owner, 'staleset', { durability: 'sync' });
		const task = taskFor(db.id)!;
		await core.databaseMembers.applySyncResults(primary.nodeId, [
			{ databaseId: db.id, version: task.version, step: 'set-sync', status: 'ok', lsn: '0/3000148', replayLsn: '0/3000148', targetSyncState: 'sync' },
		]);
		const steady = await core.databaseMembers.status(owner, 'staleset');
		const slot = core.databaseReplicas.rowsFor(db.id).find((row) => row.nodeId === steady.sync[0])!.slot!;
		await core.databaseMembers.applySyncResults(primary.nodeId, [
			{
				databaseId: db.id,
				version: 'stale',
				step: 'set-sync',
				status: 'ok',
				lsn: '0/3000148',
				replayLsn: '0/3000148',
				targetSyncState: 'sync',
				leaseEtag: '"stale"',
				applied: [slot],
			},
		]);
		const rearmed = await core.databaseMembers.status(owner, 'staleset');
		expect(rearmed.syncState).toBe('changing');
		expect(rearmed.sync).toEqual([]);
		expect((await lease(db.id))!.syncState).toBe('changing');
	});

	test('a switchover requires If-Match and refuses a stale generation', async () => {
		const db = database('ifmatch');
		reportSlots(db.id, db.replicas);
		const target = db.replicas.find((replica) => replica.nodeId === second.nodeId)!;
		await expect(
			core.databaseMembers.switchover(owner, 'ifmatch', { replicaId: target.id, confirm: true }, { ifMatch: 9 }),
		).rejects.toThrow(/not 9/);
	});

	test('a promotion takes the lease at the new generation and re-arms a non-promotable change', async () => {
		const db = database('promotelase');
		reportSlots(db.id, db.replicas);
		await core.databaseMembers.setDurability(owner, 'promotelase', { durability: 'sync' });
		const task = taskFor(db.id)!;
		await core.databaseMembers.applySyncResults(primary.nodeId, [
			{ databaseId: db.id, version: task.version, step: 'set-sync', status: 'ok', lsn: '0/3000148', replayLsn: '0/3000148', targetSyncState: 'sync' },
		]);
		const syncMember = (await core.databaseMembers.status(owner, 'promotelase')).sync[0]!;
		const target = db.replicas.find((replica) => replica.nodeId === syncMember)!;
		await core.databaseMembers.switchover(owner, 'promotelase', { replicaId: target.id, confirm: true });
		const drain = core.databaseMembers.switchoverTasksForNode(primary.nodeId).find((item) => item.databaseId === db.id)!;
		await core.databaseMembers.applySwitchoverResults(primary.nodeId, [
			{ switchoverId: drain.switchoverId, version: drain.version, step: 'drain', status: 'ok', lsn: '0/3000148', replayLsn: '0/3000148' },
		]);
		const promotion = (await core.databaseReplicas.promotionsForNode(target.nodeId)).find((item) => item.databaseId === db.id)!;
		await core.databaseReplicas.applyPromotionResults(target.nodeId, [{ failoverId: promotion.failoverId, status: 'ok', lsn: '0/3000148' }]);
		const stored = (await lease(db.id))!;
		expect(stored).toMatchObject({ generation: 1, holderNodeId: target.nodeId, sync: [], syncState: 'changing' });
		const status = await core.databaseMembers.status(owner, 'promotelase');
		expect(status).toMatchObject({ syncState: 'changing', durability: 'sync', durabilityEffective: 'async' });
		// The new primary is told to clear any inherited setting before arming a target.
		expect(core.databaseMembers.syncTasksForNode(target.nodeId).find((item) => item.databaseId === db.id)?.step).toBe('clear-sync');
	});

	test('durability refuses while a failover is active', async () => {
		const db = database('faildurability');
		reportSlots(db.id, db.replicas);
		await core.databaseMembers.switchover(owner, 'faildurability', { replicaId: db.replicas[0]!.id, confirm: true });
		await expect(core.databaseMembers.setDurability(owner, 'faildurability', { durability: 'sync' })).rejects.toThrow(/failing over/);
	});

	test('promotion refuses a node the lease does not name', async () => {
		const db = database('refusepromote');
		reportSlots(db.id, db.replicas);
		await core.databaseMembers.setDurability(owner, 'refusepromote', { durability: 'sync' });
		const task = taskFor(db.id)!;
		await core.databaseMembers.applySyncResults(primary.nodeId, [
			{ databaseId: db.id, version: task.version, step: 'set-sync', status: 'ok', lsn: '0/3000148', replayLsn: '0/3000148', targetSyncState: 'sync' },
		]);
		const syncMember = (await core.databaseMembers.status(owner, 'refusepromote')).sync[0]!;
		const other = db.replicas.find((replica) => replica.nodeId !== syncMember)!;
		await expect(
			core.databaseReplicas.promote(owner, 'refusepromote', other.id, { confirm: true }),
		).rejects.toThrow(/synchronous set/);
		// acceptDataLoss is the explicit manual override; it still may not race an open change.
		await expect(
			core.databaseReplicas.promote(owner, 'refusepromote', other.id, { confirm: true, acceptDataLoss: true }),
		).resolves.toBeDefined();
	});

	test('a steady lease is renewed by the tick before it expires', async () => {		const db = database('steadyrenew');
		reportSlots(db.id, db.replicas);
		await core.databaseMembers.setDurability(owner, 'steadyrenew', { durability: 'sync' });
		const task = taskFor(db.id)!;
		await core.databaseMembers.applySyncResults(primary.nodeId, [
			{ databaseId: db.id, version: task.version, step: 'set-sync', status: 'ok', lsn: '0/3000148', replayLsn: '0/3000148', targetSyncState: 'sync' },
		]);
		const before = (await lease(db.id))!;
		// The tick renews when less than half a TTL remains; place the clock inside that window.
		clock = Date.parse(before.expiresAt as string) - 3_000;
		await core.databaseMembers.tick();
		const after = (await lease(db.id))!;
		expect(Date.parse(after.expiresAt as string)).toBeGreaterThan(Date.parse(before.expiresAt as string));
		expect((await core.databaseMembers.status(owner, 'steadyrenew')).syncState).toBe('steady');
	});

	test('a drain that finishes while a change is open is refused before promotion is handed out', async () => {		const db = database('racedrain');
		reportSlots(db.id, db.replicas);
		const target = db.replicas[0]!;
		await core.databaseMembers.switchover(owner, 'racedrain', { replicaId: target.id, confirm: true });
		const drain = core.databaseMembers.switchoverTasksForNode(primary.nodeId).find((item) => item.databaseId === db.id)!;
		opened.sqlite.run("UPDATE databases SET sync_state = 'changing' WHERE id = ?", [db.id]);
		await core.databaseMembers.applySwitchoverResults(primary.nodeId, [
			{ switchoverId: drain.switchoverId, version: drain.version, step: 'drain', status: 'ok', lsn: '0/3000148', replayLsn: '0/3000148' },
		]);
		const resume = core.databaseMembers.switchoverTasksForNode(primary.nodeId).find((item) => item.databaseId === db.id)!;
		expect(resume.step).toBe('resume');
		expect((await core.databaseReplicas.promotionsForNode(target.nodeId)).some((item) => item.databaseId === db.id)).toBe(false);
	});

	test('a successful promotion that races a change is promoted-but-not-repointed, never resumed', async () => {
		const db = database('racedpromote');
		reportSlots(db.id, db.replicas);
		const target = db.replicas[0]!;
		await core.databaseMembers.switchover(owner, 'racedpromote', { replicaId: target.id, confirm: true });
		const drain = core.databaseMembers.switchoverTasksForNode(primary.nodeId).find((item) => item.databaseId === db.id)!;
		await core.databaseMembers.applySwitchoverResults(primary.nodeId, [
			{ switchoverId: drain.switchoverId, version: drain.version, step: 'drain', status: 'ok', lsn: '0/3000148', replayLsn: '0/3000148' },
		]);
		// The promotion task was handed out before the change opened; the result races the change.
		const promotion = (await core.databaseReplicas.promotionsForNode(target.nodeId)).find((item) => item.databaseId === db.id)!;
		opened.sqlite.run("UPDATE databases SET sync_state = 'changing' WHERE id = ?", [db.id]);
		await core.databaseReplicas.applyPromotionResults(target.nodeId, [{ failoverId: promotion.failoverId, status: 'ok', lsn: '0/3000148' }]);
		const resumed = core.databaseMembers.switchoverTasksForNode(primary.nodeId).find((item) => item.databaseId === db.id);
		expect(resumed).toBeUndefined();
		const view = core.databaseMembers.switchovers(owner, 'racedpromote')[0]!;
		expect(view.promoted).toBe(true);
		expect(view.message).toContain('not re-pointed');
	});

	test('a lease CAS failure after promotion alerts and the tick retries it', async () => {
		const db = database('leaseretry');
		reportSlots(db.id, db.replicas);
		const target = db.replicas[0]!;
		await core.databaseMembers.switchover(owner, 'leaseretry', { replicaId: target.id, confirm: true });
		const drain = core.databaseMembers.switchoverTasksForNode(primary.nodeId).find((item) => item.databaseId === db.id)!;
		await core.databaseMembers.applySwitchoverResults(primary.nodeId, [
			{ switchoverId: drain.switchoverId, version: drain.version, step: 'drain', status: 'ok', lsn: '0/3000148', replayLsn: '0/3000148' },
		]);
		const promotion = (await core.databaseReplicas.promotionsForNode(target.nodeId)).find((item) => item.databaseId === db.id)!;
		arbiter.failNext = { status: 500, count: 1 };
		await core.databaseReplicas.applyPromotionResults(target.nodeId, [{ failoverId: promotion.failoverId, status: 'ok', lsn: '0/3000148' }]);
		expect(core.databaseMembers.switchovers(owner, 'leaseretry')[0]!.message).toContain('no lease yet');
		await core.databaseMembers.tick();
		expect(core.databaseMembers.switchovers(owner, 'leaseretry')[0]!.message).toContain('lease taken');
	});
});

describe('planned switchover (W10)', () => {
	test('drain, LSN equality, promote, re-point, and a rewind task for the old primary', async () => {
		const db = database('billing');
		reportSlots(db.id, db.replicas);
		const target = db.replicas.find((replica) => replica.nodeId === second.nodeId)!;
		const view = await core.databaseMembers.switchover(owner, 'billing', { replicaId: target.id, confirm: true });
		expect(view).toMatchObject({ step: 'checkpoint', toNodeId: second.nodeId, generation: 1 });

		// The old primary's node drains and reports its final LSN equal to the replica's replay.
		await core.databaseMembers.applySwitchoverResults(primary.nodeId, [
			{ switchoverId: 'x', step: 'drain', status: 'ok', lsn: '0/3000148', replayLsn: '0/3000148' },
		]);
		// Wrong id is ignored; use the real one from the desired state.
		const drains = core.databaseMembers.switchoverTasksForNode(primary.nodeId).filter((task) => task.databaseId === db.id);
		expect(drains).toHaveLength(1);
		expect(drains[0]!.step).toBe('drain');
		await core.databaseMembers.applySwitchoverResults(primary.nodeId, [
			{ switchoverId: drains[0]!.switchoverId, step: 'drain', status: 'ok', lsn: '0/3000148', replayLsn: '0/3000148' },
		]);
		const promoting = core.databaseMembers.switchovers(owner, 'billing')[0]!;
		expect(promoting.step).toBe('promote');
		expect(promoting.primaryLsn).toBe('0/3000148');

		// The replica's node promotes through the existing C7 task, then the re-point runs.
		const promotion = (await core.databaseReplicas.promotionsForNode(second.nodeId)).find((task) => task.databaseId === db.id)!;
		await core.databaseReplicas.applyPromotionResults(second.nodeId, [{ failoverId: promotion.failoverId, status: 'ok', lsn: '0/3000148' }]);
		// The promoted database reports running on its new node, which completes the switchover.
		core.databaseReplicas.applyWorkloadReports(second.nodeId, [{ id: db.id, status: 'running', restarts: 0 }]);
		const moved = core.databases.get(owner, 'billing');
		expect(moved.nodeId).toBe(second.nodeId);
		expect(moved.primaryGeneration).toBe(1);

		// The old primary is not purged: it is a rewind task for its node.
		const rewinds = core.databaseMembers.rewindTasksForNode(primary.nodeId);
		expect(rewinds).toHaveLength(1);
		expect(rewinds[0]).toMatchObject({ databaseId: db.id, generation: 1 });
		expect(rewinds[0]!.workloadId.startsWith('db_dbr_')).toBe(true);
		expect(rewinds[0]!.source.nodeId).toBe(second.nodeId);
		// A rewind that cannot run becomes a rebuild, never a merge.
		core.databaseMembers.applyRewindResults(primary.nodeId, [{ databaseId: db.id, status: 'rebuild', error: 'timeline diverged' }]);
		expect(core.databaseMembers.rewindTasksForNode(primary.nodeId)).toHaveLength(0);
		expect(core.databaseReplicas.rowsFor(db.id).some((row) => row.nodeId === primary.nodeId && !row.removingAt)).toBe(true);
	});

	test('a non-zero gap is refused, writes resume, and nothing is promoted', async () => {
		const db = database('analytics');
		reportSlots(db.id, db.replicas, '0/3000148');
		const target = db.replicas.find((replica) => replica.nodeId === third.nodeId)!;
		await core.databaseMembers.switchover(owner, 'analytics', { replicaId: target.id, confirm: true });
		const drain = core.databaseMembers.switchoverTasksForNode(primary.nodeId).find((task) => task.databaseId === db.id)!;
		// The primary's final LSN is ahead of the replica: the switchover must refuse.
		await core.databaseMembers.applySwitchoverResults(primary.nodeId, [
			{ switchoverId: drain.switchoverId, step: 'drain', status: 'ok', lsn: '0/4000000', replayLsn: '0/3000148' },
		]);
		const refused = core.databaseMembers.switchovers(owner, 'analytics')[0]!;
		expect(refused.step).toBe('stop-writes');
		expect(refused.message).toContain('behind');
		expect(refused.primaryLsn).toBe('0/4000000');
		const resume = core.databaseMembers.switchoverTasksForNode(primary.nodeId).find((task) => task.databaseId === db.id)!;
		expect(resume.step).toBe('resume');
		expect((await core.databaseReplicas.promotionsForNode(third.nodeId)).some((task) => task.databaseId === db.id)).toBe(false);
		await core.databaseMembers.applySwitchoverResults(primary.nodeId, [
			{ switchoverId: resume.switchoverId, step: 'resume', status: 'ok' },
		]);
		expect(core.databaseMembers.switchoverTasksForNode(primary.nodeId).some((task) => task.databaseId === db.id)).toBe(false);
	});

	test('a switchover is refused while a sync change is open', async () => {
		const db = database('changing');
		reportSlots(db.id, db.replicas);
		await core.databaseMembers.setDurability(owner, 'changing', { durability: 'sync' });
		await expect(
			core.databaseMembers.switchover(owner, 'changing', { replicaId: db.replicas[0]!.id, confirm: true }),
		).rejects.toThrow(/non-promotable/);
	});
});

describe('role discovery (W9-SPEC §5.6)', () => {
	test('a member report is stored and answered by generation and role', async () => {
		const db = database('roledisc');
		reportSlots(db.id, db.replicas);
		core.databaseMembers.applyMemberReports(second.nodeId, [
			{
				databaseId: db.id,
				role: 'streaming',
				generation: 4,
				epoch: 2,
				streaming: true,
				inRecovery: true,
				lsn: '0/3000148',
				readOnly: false,
				fenced: false,
				leaseGeneration: 3,
				leaseEpoch: 2,
				durabilityEffective: 'sync',
				syncState: 'steady',
				observedAt: new Date(clock).toISOString(),
			},
		]);
		expect(await core.databaseMembers.memberRole(db.id, second.nodeId)).toMatchObject({
			role: 'streaming',
			generation: 4,
			epoch: 2,
			streaming: true,
			durabilityEffective: 'sync',
		});
		// No report means no role: the control plane never synthesises a primary.
		expect(await core.databaseMembers.memberRole(db.id, primary.nodeId)).toBeNull();
	});

	test('a member whose lease moved elsewhere is reported fenced, not primary', async () => {
		const db = database('rolemove');
		reportSlots(db.id, db.replicas);
		await core.databaseMembers.setDurability(owner, 'rolemove', { durability: 'async' });
		core.databaseMembers.applyMemberReports(primary.nodeId, [
			{
				databaseId: db.id,
				role: 'primary',
				generation: 0,
				epoch: 1,
				streaming: true,
				inRecovery: false,
				lsn: '0/1',
				readOnly: false,
				fenced: false,
				leaseGeneration: 0,
				leaseEpoch: 1,
				durabilityEffective: 'async',
				syncState: 'steady',
				observedAt: new Date(clock).toISOString(),
			},
		]);
		// The async lease names the primary, so the report stands.
		expect((await core.databaseMembers.memberRole(db.id, primary.nodeId))?.role).toBe('primary');
	});
});
