import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import {
	DEFAULT_FEATURES,
	nodeCapabilities,
	postgresPitrImage,
	type DatabaseReplicationSlotStatus,
	type Heartbeat,
} from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

/**
 * HA-PLAN W10 lane C: PITR with replicas, the stanza following a promotion, a backup from a
 * replica and the old primary re-attaching by `pg_rewind` instead of a full rebuild.
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-db-rewind-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.parse('2026-11-20T10:00:00Z');

const repo = {
	kind: 's3' as const,
	endpoint: 'https://s3.example.test',
	bucket: 'yoal-pitr',
	region: 'us-east-1',
	pathPrefix: 'yoal/pitr',
	forcePathStyle: true,
	accessKeyId: 'access-key',
	secretAccessKey: 'super-secret-key',
};

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
		features: { ...DEFAULT_FEATURES, PITR: true, PITR_REWIND: true },
		pitrRepository: repo,
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
type JoinedNode = { nodeId: string; token: string };

function joinNode(name: string, address: string | null): JoinedNode {
	const node = core.nodes.join({ token: core.nodes.createJoinToken(owner, name).token, name });
	core.nodes.update(owner, node.nodeId, { sliceMemoryMb: 8192 });
	if (address) opened.sqlite.run('UPDATE nodes SET private_address = ? WHERE id = ?', [address, node.nodeId]);
	return node;
}

const primary = joinNode('primary', '10.48.1.2');
const second = joinNode('second', '10.48.1.3');
const third = joinNode('third', '10.48.1.4');

function fingerprint(node: JoinedNode): string {
	return node.nodeId.replace(/[^a-f0-9]/g, '').padEnd(64, 'a').slice(0, 64);
}

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

for (const node of [primary, second, third]) beat(node);

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

function slotSample(slot: string): DatabaseReplicationSlotStatus {
	return {
		slot,
		active: true,
		walStatus: 'reserved',
		state: 'streaming',
		sentLsn: '0/3000148',
		replayLsn: '0/3000148',
		lagBytes: 0,
		lagSeconds: 0,
		syncState: 'async',
	};
}

/** The primary's node reports one slot sample (the replica's connection). */
function report(node: JoinedNode, databaseId: string, slots: DatabaseReplicationSlotStatus[]): void {
	const task = core.databaseReplicas.replicationTasksForNode(node.nodeId).find((item) => item.databaseId === databaseId);
	if (!task) throw new Error('no replication task');
	beat(node, {
		databaseReplication: [{ databaseId, appliedVersion: task.version, error: null, slots, sampledAt: new Date(clock).toISOString() }],
	});
}

describe('PITR with replicas (PITR_REWIND on)', () => {
	test('a replica of a PITR database runs the PITR image and stanza; backups stay on the primary', async () => {
		const db = core.databases.create(owner, { name: 'orders', version: '18', placement: primary.nodeId });
		core.databases.setPitrPolicy(owner, 'orders', { enabled: true });
		const replica = core.databaseReplicas.add(owner, 'orders', { node: second.nodeId });
		report(primary, db.id, [slotSample(replica.slot!)]);

		const replicaState = await core.nodes.desiredState(second.token);
		const workload = replicaState.workloads.find((item) => item.id === replica.workloadId)!;
		expect(workload.image).toBe(postgresPitrImage('18'));
		expect(workload.database).toMatchObject({
			engine: 'postgres',
			replica: { slot: replica.slot },
			pitr: { stanza: db.id },
			pgRewind: true,
		});
		// The primary gets checksums and hint logging (new and existing clusters respectively).
		const primaryState = await core.nodes.desiredState(primary.token);
		const primaryWorkload = primaryState.workloads.find((item) => item.id === db.id)!;
		expect(primaryWorkload.env.POSTGRES_INITDB_ARGS).toBe('--data-checksums');
		expect(primaryWorkload.database).toMatchObject({ pgRewind: true, pitr: { stanza: db.id } });
		expect(primaryWorkload.image).toBe(postgresPitrImage('18'));

		// The first full backup stays on the primary even though a streaming replica exists:
		// pgBackRest's single-host config cannot back up from a standby (`pg1`/`pg2` is deferred).
		const primaryTasks = await core.databases.pitrTasksForNode(primary.nodeId);
		const backup = primaryTasks.find((task) => task.action === 'basebackup')!;
		expect(backup).toMatchObject({ databaseId: db.id, stanza: db.id });
		expect(backup.workloadId).toBeUndefined();
		expect((await core.databases.pitrTasksForNode(second.nodeId)).some((task) => task.action === 'basebackup')).toBe(false);
		expect(() => core.databases.pitrActivation(third.nodeId, backup.id)).toThrow(/another node/);
		expect(() => core.databases.pitrActivation(second.nodeId, backup.id)).toThrow(/another node/);
		const activation = core.databases.pitrActivation(primary.nodeId, backup.id);
		expect(activation).toMatchObject({ databaseId: db.id, stanza: db.id, action: 'basebackup' });
		// The node gets credentials; every credential-free surface stays clean.
		expect(JSON.stringify(core.databases.pitrStatus(owner, 'orders'))).not.toContain(repo.secretAccessKey);
	});

	test('the stanza follows a promotion, and the old primary rewinds onto it', async () => {
		const db = core.databases.get(owner, 'orders');
		const replica = core.databaseReplicas.list(owner, 'orders').find((row) => row.nodeId === second.nodeId)!;
		report(primary, db.id, [slotSample(replica.slot!)]);
		const started = core.databaseReplicas.promote(owner, 'orders', replica.id, { confirm: true }, { ifMatch: 0 });
		beat(primary, { workloads: [] });
		expect(core.databaseReplicas.promotionsForNode(second.nodeId)).toHaveLength(1);
		beat(second, { databaseReplicaPromotionResults: [{ failoverId: started.id, status: 'ok', lsn: '0/5000000' }] });

		// The database now runs on the old replica's node; its PITR row and stanza are unchanged.
		expect(core.databases.get(owner, 'orders').nodeId).toBe(second.nodeId);
		expect(core.databases.pitrStatus(owner, 'orders')).toMatchObject({ stanza: db.id, enabled: true });
		const state = await core.nodes.desiredState(second.token);
		const newPrimary = state.workloads.find((item) => item.id === db.id)!;
		expect(newPrimary.image).toBe(postgresPitrImage('18'));
		expect(newPrimary.database).toMatchObject({ pitr: { stanza: db.id }, pgRewind: true });

		// The old primary's node gets a replica that adopts the old data dir: no purge, a rewind task.
		const rewind = core.databaseReplicas.list(owner, 'orders').find((row) => row.nodeId === primary.nodeId)!;
		expect(rewind).toMatchObject({
			status: 'pending',
			rewind: { fromDatabaseId: db.id, doneAt: null, fallback: false, error: null },
		});
		// Until the new primary applies its replication task (slot + pg_rewind grants), the rewind
		// task is withheld; otherwise pg_rewind would fail and fall back for no reason.
		expect(core.databaseReplicas.rewindsForNode(primary.nodeId)).toEqual([]);
		report(second, db.id, []);
		const oldState = await core.nodes.desiredState(primary.token);
		expect(oldState.databasePurges).not.toContain(db.id);
		expect(oldState.databaseReplicaRewinds).toEqual([
			{ databaseId: db.id, replicaId: rewind.id, replicaWorkloadId: rewind.workloadId, walLogHints: true },
		]);
		// It is not in desired state until the rewind reports, so no basebackup races the adoption.
		expect(oldState.workloads.some((item) => item.id === rewind.workloadId)).toBe(false);
		const activation = core.databaseReplicas.rewindActivation(primary.nodeId, rewind.id);
		expect(activation).toMatchObject({ databaseId: db.id, replicaId: rewind.id, user: 'orders' });
		expect(activation.password.length).toBeGreaterThanOrEqual(8);
		expect(() => core.databaseReplicas.rewindActivation(second.nodeId, rewind.id)).toThrow(/another node/);

		// A successful rewind releases the workload; a rebuild fallback does the same.
		beat(primary, {
			databaseReplicaRewindResults: [{ replicaId: rewind.id, status: 'ok', rewound: true }],
		});
		const adopted = core.databaseReplicas.list(owner, 'orders').find((row) => row.id === rewind.id)!;
		expect(adopted.rewind?.doneAt).not.toBeNull();
		expect((await core.nodes.desiredState(primary.token)).workloads.some((item) => item.id === rewind.workloadId)).toBe(true);
		expect((await core.nodes.desiredState(primary.token)).databaseReplicaRewinds).toBeUndefined();

		// Restore selection uses the window the new primary reports, after the promotion. Finish the
		// pending base backup (it queues a status check), then report a post-promotion window.
		const pendingBackup = (await core.databases.pitrTasksForNode(second.nodeId)).find((task) => task.action === 'basebackup')!;
		core.databases.applyPitrResults(second.nodeId, [
			{
				taskId: pendingBackup.id,
				action: 'basebackup',
				databaseId: db.id,
				targetDatabaseId: null,
				status: 'ok',
				baseBackupType: 'full',
			},
		]);
		const pendingStatus = (await core.databases.pitrTasksForNode(second.nodeId)).find((task) => task.action === 'status')!;
		const from = clock - 10 * 60_000;
		const to = clock + 5 * 60_000;
		core.databases.applyPitrResults(second.nodeId, [
			{
				taskId: pendingStatus.id,
				action: 'status',
				databaseId: db.id,
				targetDatabaseId: null,
				status: 'ok',
				archiveStatus: 'ok',
				window: {
					recoverableFrom: from,
					recoverableTo: to,
					backupCount: 1,
					newestBackupAt: from,
					newestBackupType: 'full',
					lastArchivedAt: to,
					repoMessage: null,
				},
			},
		]);
		const targetTime = new Date(clock - 60_000).toISOString();
		const restored = core.databases.restoreToTimestamp(owner, 'orders', { name: 'orders-after-promote', targetTime });
		expect(restored.nodeId).toBe(second.nodeId);
		expect(core.databases.pitrStatus(owner, 'orders').lastRestoreDatabaseId).toBe(restored.id);
		expect((await core.databases.pitrTasksForNode(second.nodeId)).find((task) => task.action === 'restore')).toMatchObject({
			databaseId: db.id,
			targetDatabaseId: restored.id,
		});
	});

	test('a fallback marks the replica for a rebuild and still releases it', async () => {
		const db = core.databases.create(owner, { name: 'fallback', version: '18', placement: primary.nodeId });
		core.databases.setPitrPolicy(owner, 'fallback', { enabled: true });
		const replica = core.databaseReplicas.add(owner, 'fallback', { node: third.nodeId });
		report(primary, db.id, [slotSample(replica.slot!)]);
		const started = core.databaseReplicas.promote(owner, 'fallback', replica.id, { confirm: true });
		beat(primary, { workloads: [] });
		beat(third, { databaseReplicaPromotionResults: [{ failoverId: started.id, status: 'ok', lsn: null }] });
		beat(third, { workloads: [{ id: db.id, status: 'running', restarts: 0 }] });
		report(third, db.id, []);
		const rewind = core.databaseReplicas.list(owner, 'fallback').find((row) => row.nodeId === primary.nodeId)!;
		beat(primary, {
			databaseReplicaRewindResults: [
				{ replicaId: rewind.id, status: 'fallback', rewound: false, reason: 'The old primary has neither data checksums nor wal_log_hints=on.' },
			],
		});
		const row = core.databaseReplicas.list(owner, 'fallback').find((item) => item.id === rewind.id)!;
		expect(row.rewind).toMatchObject({ fallback: true, doneAt: expect.any(String) });
		expect(row.message).toContain('Rebuilding instead of rewinding');
		expect((await core.nodes.desiredState(primary.token)).workloads.some((item) => item.id === rewind.workloadId)).toBe(true);
	});

	test('a failed rewind marks the row for removal and purge, and a fresh replica is rebuilt', async () => {
		const db = core.databases.create(owner, { name: 'rewind-fails', version: '18', placement: primary.nodeId });
		core.databases.setPitrPolicy(owner, 'rewind-fails', { enabled: true });
		const replica = core.databaseReplicas.add(owner, 'rewind-fails', { node: third.nodeId });
		report(primary, db.id, [slotSample(replica.slot!)]);
		const started = core.databaseReplicas.promote(owner, 'rewind-fails', replica.id, { confirm: true });
		beat(primary, { workloads: [] });
		beat(third, { databaseReplicaPromotionResults: [{ failoverId: started.id, status: 'ok', lsn: null }] });
		beat(third, { workloads: [{ id: db.id, status: 'running', restarts: 0 }] });
		report(third, db.id, []);
		const rewind = core.databaseReplicas.list(owner, 'rewind-fails').find((row) => row.nodeId === primary.nodeId)!;
		expect(rewind.rewind).toMatchObject({ doneAt: null, error: null });
		// While the rewind is in flight the old dir is kept (not purged).
		expect((await core.nodes.desiredState(primary.token)).databasePurges).not.toContain(db.id);

		beat(primary, {
			databaseReplicaRewindResults: [
				{ replicaId: rewind.id, status: 'failed', rewound: false, error: 'could not connect to server' },
			],
		});
		const failed = core.databaseReplicas.list(owner, 'rewind-fails').find((row) => row.id === rewind.id)!;
		expect(failed.removing).toBe(true);
		expect(failed.rewind?.error).toContain('could not connect');
		expect(failed.message).toContain('fresh replica is rebuilt');
		// No pending rewind task and the old primary's dir is now purgeable.
		expect(core.databaseReplicas.rewindsForNode(primary.nodeId)).toEqual([]);
		const state = await core.nodes.desiredState(primary.token);
		expect(state.databaseReplicaRewinds).toBeUndefined();
		expect(state.databasePurges).toContain(db.id);
		expect(state.databasePurges).toContain(rewind.workloadId);

		// The node confirms both purges: a new, ordinary replica is rebuilt on that node.
		core.databaseReplicas.applyPurged(primary.nodeId, [db.id, rewind.workloadId]);
		const rebuilt = core.databaseReplicas.list(owner, 'rewind-fails').find((row) => row.nodeId === primary.nodeId)!;
		expect(rebuilt.id).not.toBe(rewind.id);
		expect(rebuilt.rewind).toBeNull();
	});

	test('db-member is accepted as the W10 capability on a mixed fleet', () => {
		const row = opened.sqlite
			.query<{ capabilities_json: string }, [string]>('SELECT capabilities_json FROM nodes WHERE id = ?')
			.get(third.nodeId)!;
		const original = row.capabilities_json;
		const mixed = [...JSON.parse(original).filter((item: string) => item !== 'pitr-rewind'), 'db-member'];
		opened.sqlite.run('UPDATE nodes SET capabilities_json = ? WHERE id = ?', [JSON.stringify(mixed), third.nodeId]);
		try {
			expect(core.databases.pitrRewindForNode(third.nodeId)).toBe(true);
		} finally {
			opened.sqlite.run('UPDATE nodes SET capabilities_json = ? WHERE id = ?', [original, third.nodeId]);
		}
	});
});

describe('PITR_REWIND off (unchanged)', () => {
	test('the off path keeps the old refusals and no rewind columns are populated', async () => {
		const off = createCore({
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
				features: { ...DEFAULT_FEATURES, PITR: true, PITR_REWIND: false },
				pitrRepository: repo,
			},
		});
		const node = off.nodes.join({ token: off.nodes.createJoinToken(owner, 'off-node').token, name: 'off-node' });
		off.nodes.update(owner, node.nodeId, { sliceMemoryMb: 8192 });
		opened.sqlite.run('UPDATE nodes SET private_address = ? WHERE id = ?', ['10.49.1.2', node.nodeId]);
		const other = off.nodes.join({ token: off.nodes.createJoinToken(owner, 'off-other').token, name: 'off-other' });
		off.nodes.update(owner, other.nodeId, { sliceMemoryMb: 8192 });
		opened.sqlite.run('UPDATE nodes SET private_address = ? WHERE id = ?', ['10.49.1.3', other.nodeId]);
		off.nodes.heartbeat(node.token, {
			nodeId: node.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: off.nodes.stateVersion(),
			status: 'online',
			caddyOk: true,
			releases: [],
			capabilities: [...nodeCapabilities],
			nodeCertificate: { certPem: 'pem', fingerprint: 'a'.repeat(64), expiresAt: new Date(clock + 86_400_000).toISOString() },
		});
		off.nodes.heartbeat(other.token, {
			nodeId: other.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: off.nodes.stateVersion(),
			status: 'online',
			caddyOk: true,
			releases: [],
			capabilities: [...nodeCapabilities],
			nodeCertificate: { certPem: 'pem', fingerprint: 'b'.repeat(64), expiresAt: new Date(clock + 86_400_000).toISOString() },
		});
		const db = off.databases.create(owner, { name: 'legacy', version: '18', placement: node.nodeId });
		off.databases.setPitrPolicy(owner, 'legacy', { enabled: true });
		expect(() => off.databaseReplicas.add(owner, 'legacy', { node: other.nodeId })).toThrow(/PITR_REWIND/);
		const legacyState = await off.nodes.desiredState(node.token);
		const legacy = legacyState.workloads.find((item) => item.id === db.id)!;
		expect(legacy.database?.pgRewind).toBeUndefined();
		expect(legacy.env.POSTGRES_INITDB_ARGS).toBeUndefined();
		// A database without PITR keeps ordinary replicas, with no rewind fields.
		off.databases.create(owner, { name: 'plain', version: '18', placement: node.nodeId });
		const plainReplica = off.databaseReplicas.add(owner, 'plain', { node: other.nodeId });
		expect(plainReplica.rewind).toBeNull();
		expect(db.id).toBeTruthy();
	});
});
