import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, migrations } from '@yoal/db';
import type { FeatureFlags } from '@yoal/contracts';
import { createCore, type Core } from './index.ts';
import { MemoryObjectStore } from './object-store/memory.ts';
import { CONTROL_LEASE_KEY } from './ha-lease.ts';
import { CONTROL_EPOCH_FILE } from './control-plane-service.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-control-service-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function flags(control: boolean): FeatureFlags {
	return new Proxy({} as FeatureFlags, {
		get: (_target, property) => (property === 'CONTROL_STANDBY' ? control : false),
	});
}

function open(options: { control: boolean; role?: 'primary' | 'standby'; objectStore?: MemoryObjectStore }): Core {
	const opened = createDb({ path: ':memory:' });
	return createCore({
		db: opened.db,
		sqlite: opened.sqlite,
		version: '0.16.3',
		config: {
			dataDir: join(dir, options.control ? (options.role ?? 'primary') : 'off'),
			platformOrigin: 'https://control.test',
			contentDomain: 'sites.test',
			objectStore: options.objectStore ?? new MemoryObjectStore({ now: () => Date.now() }),
			masterKey: new Uint8Array(32).fill(7),
			siteCookieSecret: 'site-cookie-secret-123',
			objectStoreSecret: 'object-secret-123',
			desiredAgentVersion: '0.16.3',
			controlNodeId: 'nod_a',
			...(options.role ? { controlRole: options.role } : {}),
			features: flags(options.control),
			now: () => Date.now(),
		},
	});
}

describe('ControlPlaneService (W9-SPEC §4)', () => {
	test('flag off: no timer, no store write, no file, and every surface is unchanged', async () => {
		const store = new MemoryObjectStore();
		const core = open({ control: false, objectStore: store });
		await core.controlPlane.start();
		expect(core.controlPlane.readyz()).toBeNull();
		expect(core.controlPlane.agentGate()).toBeNull();
		expect(core.controlPlane.writeGate('POST', '/api/v1/projects')).toBeNull();
		expect(core.controlPlane.mayRenewRunLease()).toBe(true);
		expect(await store.readVersioned(CONTROL_LEASE_KEY)).toMatchObject({ status: 404 });
		expect(() => readFileSync(join(dir, 'off', CONTROL_EPOCH_FILE))).toThrow();
	});

	test('a primary bootstraps the lease, persists the epoch and serves agents', async () => {
		const core = open({ control: true, role: 'primary' });
		await core.controlPlane.start();
		// Start owns a real interval; stop it before the assertions finish.
		core.controlPlane.stop();
		const readyz = core.controlPlane.readyz();
		expect(readyz?.status).toBe(200);
		expect(readyz?.body.role).toBe('primary');
		expect(readyz?.body.epoch).toBe(1);
		expect(core.controlPlane.lease()).toMatchObject({ epoch: 1, holderNodeId: 'nod_a' });
		expect(core.controlPlane.agentGate()).toBeNull();
		expect(core.controlPlane.mayRenewRunLease()).toBe(true);
		const epochFile = JSON.parse(readFileSync(join(dir, 'primary', CONTROL_EPOCH_FILE), 'utf8'));
		expect(epochFile.epoch).toBe(1);
		expect(core.controlPlane.status()).toEqual([
			expect.objectContaining({ nodeId: 'nod_a', role: 'primary', epoch: 1 }),
		]);
	});

	test('a standby follows, never bootstraps and returns 503 for agents', async () => {
		const store = new MemoryObjectStore();
		const primary = open({ control: true, role: 'primary', objectStore: store });
		await primary.controlPlane.start();
		primary.controlPlane.stop();
		const standbyDb = createDb({ path: ':memory:' });
		const standby = createCore({
			db: standbyDb.db,
			sqlite: standbyDb.sqlite,
			version: '0.16.3',
			config: {
				dataDir: join(dir, 'standby'),
				platformOrigin: 'https://control.test',
				contentDomain: 'sites.test',
				objectStore: store,
				masterKey: new Uint8Array(32).fill(7),
				siteCookieSecret: 'site-cookie-secret-123',
				objectStoreSecret: 'object-secret-123',
				desiredAgentVersion: '0.16.3',
				controlNodeId: 'nod_b',
				controlRole: 'standby',
				features: flags(true),
				now: () => Date.now(),
			},
		});
		await standby.controlPlane.start();
		standby.controlPlane.stop();
		expect(standby.controlPlane.snapshot()?.role).not.toBe('primary');
		const gate = standby.controlPlane.agentGate();
		expect(gate?.status).toBe(503);
		expect(gate?.headers['x-yoal-role']).not.toBe('primary');
		expect(standby.controlPlane.mayRenewRunLease()).toBe(false);
		// The standby did not create or overwrite the lease at another epoch.
		expect(await store.readVersioned(CONTROL_LEASE_KEY)).toMatchObject({ status: 200 });
	});

	test('the schema the migration check reads is present, so a primary can confirm', async () => {
		const opened = createDb({ path: ':memory:' });
		const applied = new Set(opened.sqlite.query<{ id: string }, []>('SELECT id FROM yoal_migrations').all().map((row) => row.id));
		expect(migrations.length).toBeGreaterThan(0);
		expect(migrations.every((migration) => applied.has(migration.id))).toBe(true);
	});
});
