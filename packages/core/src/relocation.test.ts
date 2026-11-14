import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, type AppVolumeTaskResult, type WorkloadStatus } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

/** Moving an app together with its app volumes (docs/SCALING.md §7). */

const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });
const GIB = 1024 ** 3;
const stats = { cpuPercent: 1, memoryBytes: GIB, memoryTotalBytes: 8 * GIB, diskUsedBytes: 10 * GIB, diskTotalBytes: 100 * GIB, diskFreeBytes: 90 * GIB, uptimeSeconds: 1, load1: 0, certs: [] };

async function fleet() {
	const names = ['edge', 'a', 'b'];
	const dir = mkdtempSync(join(tmpdir(), 'yoal-relocate-'));
	const opened = createDb({ path: ':memory:' });
	const clock = { now: Date.UTC(2026, 10, 14) };
	const core = createCore({
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
			now: () => clock.now,
			features: { ...DEFAULT_FEATURES, APP_VOLUMES: true, BACKUPS_RESTORE: true },
		},
	});
	const node: Record<string, { id: string; token: string }> = {};
	const beat = (name: string, extra: { workloads?: Array<{ id: string; status: WorkloadStatus; restarts: number }>; appVolumeTaskResults?: AppVolumeTaskResult[] } = {}) =>
		core.nodes.heartbeat(node[name]!.token, {
			nodeId: node[name]!.id,
			agentVersion: '0.1.0',
			actualStateVersion: core.projects.stateVersion(),
			status: 'online',
			caddyOk: true,
			capabilities: ['app-volumes'],
			stats,
			releases: [],
			...extra,
		});
	for (const name of names) {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(principal, name).token, name });
		node[name] = { id: joined.nodeId, token: joined.token };
		opened.sqlite.run('UPDATE nodes SET public_address = ?, slice_memory_mb = 1024 WHERE id = ?', [`${name}.internal:8080`, joined.nodeId]);
		beat(name);
	}
	const project = () => core.projects.requireRow(principal, 'vault');
	await core.projects.create(principal, { name: 'vault', slug: 'vault', runtime: 'process', placement: 'auto', productionAccess: 'public', previewAccess: 'platform' });
	core.workloads.setSpec(principal, project(), { runtime: 'process', command: ['bun', 'run', 'start'], port: 3000, memoryMb: 256, cpus: 1, healthPath: '/', socketActivation: false, env: {}, secrets: [] });
	await core.uploads.deployInline(principal, project(), [file('index.js', 'x')], { promote: true });
	const workload = core.workloads.view(project())!;
	const nameOf = (id: string) => names.find((name) => node[name]!.id === id)!;
	const from = nameOf(workload.nodeId!);
	const to = from === 'a' ? 'b' : 'a';
	const original = core.appVolumes.create(principal, project(), { name: 'data', sizeMb: 100 });
	core.appVolumes.attach(principal, project(), 'data', { workload: 'vault', mountPath: '/var/lib/app' });
	beat(from, { workloads: [{ id: workload.id, status: 'running', restarts: 0 }] });
	const desired = async (name: string) => (await core.nodes.desiredState(node[name]!.token)).workloads.find((entry) => entry.projectSlug === 'vault');
	const tasks = async (name: string) => (await core.nodes.desiredState(node[name]!.token)).appVolumeTasks ?? [];
	const view = () => core.relocations.latest(principal, project())!;
	const placed = () => nameOf(core.workloads.view(project())!.nodeId!);
	return { core, sqlite: opened.sqlite, clock, node, beat, project, workload, from, to, original, desired, tasks, view, placed };
}

describe('moving an app with its data', () => {
	test('an ordinary move is refused, with the way forward', async () => {
		const f = await fleet();
		expect(() => f.core.scheduling.move(principal, 'vault', {})).toThrow(/app volumes live on this node.*Move it with its data/);
	});

	test('stops the app, copies the volume across, then switches the app and its data together', async () => {
		const f = await fleet();
		const started = f.core.relocations.start(principal, 'vault', { node: f.to });
		expect(started).toMatchObject({ phase: 'stopping', active: true, from: { name: f.from }, to: { name: f.to } });
		expect((await f.desired(f.from))?.status).toBe('stopped');
		// A deploy would fight the move.
		expect(() => f.core.workloads.plan(principal, f.project())).toThrow('moves to another node with its data');

		// Nothing is copied while the app might still be writing.
		await f.core.failover.tick();
		expect(f.view().phase).toBe('stopping');
		f.beat(f.from, { workloads: [] });
		await f.core.failover.tick();
		expect(f.view()).toMatchObject({ phase: 'snapshotting', volumes: [{ name: 'data', state: 'snapshotting' }] });

		const [snapshot] = await f.tasks(f.from);
		expect(snapshot).toMatchObject({ action: 'snapshot', quiesce: false, volume: { id: f.original.id } });
		f.beat(f.from, { appVolumeTaskResults: [{ taskId: snapshot!.id, action: 'snapshot', snapshotId: snapshot!.snapshotId, volumeId: f.original.id, status: 'ok', sizeBytes: 1234, sha256: 'a'.repeat(64) }] });
		await f.core.failover.tick();
		expect(f.view()).toMatchObject({ phase: 'restoring', volumes: [{ state: 'restoring' }] });
		// Still on the source, still stopped: the source is untouched until the copy is proven.
		expect(f.placed()).toBe(f.from);

		const [restore] = await f.tasks(f.to);
		expect(restore).toMatchObject({ action: 'restore', checksum: 'a'.repeat(64) });
		expect(restore!.volume.id).not.toBe(f.original.id);
		f.beat(f.to, { appVolumeTaskResults: [{ taskId: restore!.id, action: 'restore', snapshotId: restore!.snapshotId, volumeId: restore!.volume.id, status: 'ok' }] });
		await f.core.failover.tick();

		expect(f.view()).toMatchObject({ phase: 'done', active: false, volumes: [{ name: 'data', state: 'restored' }] });
		expect(f.placed()).toBe(f.to);
		// The app starts on the target with the same volume name mounted at the same path.
		const arrived = await f.desired(f.to);
		expect(arrived).toMatchObject({ status: 'running' });
		expect(arrived?.volumes).toMatchObject([{ id: restore!.volume.id, mountPath: '/var/lib/app' }]);
		expect(await f.desired(f.from)).toBeUndefined();
		const data = f.core.appVolumes.get(principal, f.project(), 'data');
		expect(data).toMatchObject({ id: restore!.volume.id, nodeId: f.node[f.to]!.id, status: 'ready' });
		// The old copy is kept in the trash, not destroyed.
		const old = f.sqlite.query<{ name: string; deleted_at: number | null; purge_at: number | null }, [string]>('SELECT name, deleted_at, purge_at FROM app_volumes WHERE id = ?').get(f.original.id)!;
		expect(old.deleted_at).not.toBeNull();
		expect(old.purge_at).toBeGreaterThan(f.clock.now);
		expect(old.name).toStartWith('data-moved-');
	});

	test('a failed copy changes nothing: the app starts again where it was', async () => {
		const f = await fleet();
		f.core.relocations.start(principal, 'vault', {});
		f.beat(f.from, { workloads: [] });
		await f.core.failover.tick();
		const [snapshot] = await f.tasks(f.from);
		f.beat(f.from, { appVolumeTaskResults: [{ taskId: snapshot!.id, action: 'snapshot', snapshotId: snapshot!.snapshotId, volumeId: f.original.id, status: 'failed', error: 'disk read error' }] });
		await f.core.failover.tick();

		expect(f.view()).toMatchObject({ phase: 'failed', active: false });
		expect(f.view().error).toContain('disk read error');
		expect(f.placed()).toBe(f.from);
		expect((await f.desired(f.from))?.status).toBe('running');
		expect(f.core.appVolumes.get(principal, f.project(), 'data')).toMatchObject({ id: f.original.id, status: 'ready' });
	});

	test('a failed restore removes the half-made copy and leaves the source serving', async () => {
		const f = await fleet();
		f.core.relocations.start(principal, 'vault', {});
		f.beat(f.from, { workloads: [] });
		await f.core.failover.tick();
		const [snapshot] = await f.tasks(f.from);
		f.beat(f.from, { appVolumeTaskResults: [{ taskId: snapshot!.id, action: 'snapshot', snapshotId: snapshot!.snapshotId, volumeId: f.original.id, status: 'ok', sizeBytes: 1, sha256: 'b'.repeat(64) }] });
		await f.core.failover.tick();
		const target = f.view().to.name;
		const [restore] = await f.tasks(target);
		f.beat(target, { appVolumeTaskResults: [{ taskId: restore!.id, action: 'restore', snapshotId: restore!.snapshotId, volumeId: restore!.volume.id, status: 'failed', error: 'checksum mismatch' }] });
		await f.core.failover.tick();

		expect(f.view().phase).toBe('failed');
		expect(f.view().error).toContain('Restoring volume "data"');
		expect(f.placed()).toBe(f.from);
		expect((await f.desired(f.from))?.status).toBe('running');
		expect(f.core.appVolumes.list(principal, f.project()).map((volume) => volume.name)).toEqual(['data']);
	});

	test('a move can be cancelled before the switch, and a source that never stops times out', async () => {
		const f = await fleet();
		f.core.relocations.start(principal, 'vault', {});
		expect(f.core.relocations.cancel(principal, 'vault')).toMatchObject({ phase: 'cancelled' });
		expect((await f.desired(f.from))?.status).toBe('running');

		f.core.relocations.start(principal, 'vault', {});
		f.clock.now += 11 * 60_000;
		await f.core.failover.tick();
		expect(f.view()).toMatchObject({ phase: 'failed' });
		expect(f.view().error).toContain('did not stop the app within 10 minutes');
	});
});
