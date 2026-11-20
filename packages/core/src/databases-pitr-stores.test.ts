import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import {
	DEFAULT_FEATURES,
	OBJECT_STORE_KINDS_CAPABILITY,
	databasePitrActivationSchema,
	databasePitrAnyActivationSchema,
	databasePitrStoreRepoSchema,
	type DatabasePitrRepository,
	type FeatureFlags,
} from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

/**
 * HA-PLAN W3: a PITR repository on Azure or GCS must never reach an agent that would write it as
 * an S3 config (an older agent drops unknown keys, and a null endpoint means AWS S3). Such a
 * repository is sent without `repo`, so `databasePitrActivationSchema` (the parser every agent
 * built before W3 runs, apps/agent/src/database-pitr.ts) fails closed, and PITR is refused on a
 * node without `object-store-kinds`.
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-w1-pitr-stores-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

const azureRepo: DatabasePitrRepository = databasePitrStoreRepoSchema.parse({
	store: { kind: 'azure', account: 'acct1', container: 'pitr', pathPrefix: 'yoal/pitr' },
	storeCredentials: { kind: 'azure', accountKey: 'azure-account-key-0123456789' },
});

function makeCore(features: Partial<FeatureFlags>, pitrRepository: DatabasePitrRepository) {
	const opened = createDb({ path: ':memory:' });
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
			features: { ...DEFAULT_FEATURES, PITR: true, ...features },
			pitrRepository,
		},
	});
	const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
	const capabilities = (list: string[]) =>
		opened.sqlite.run('UPDATE nodes SET capabilities_json = ? WHERE id = ?', [JSON.stringify(list), joined.nodeId]);
	return { core, joined, capabilities, close: () => opened.sqlite.close() };
}

describe('PITR on Azure or GCS (W3)', () => {
	test('refused while OBJECT_STORE_AZURE is off', () => {
		const { core, capabilities, close } = makeCore({}, azureRepo);
		capabilities([OBJECT_STORE_KINDS_CAPABILITY]);
		core.databases.create(owner, { name: 'main-db', version: '18' });
		expect(() => core.databases.setPitrPolicy(owner, 'main-db', { enabled: true })).toThrow('YOAL_FEATURE_OBJECT_STORE_AZURE');
		close();
	});

	test('refused on a node without object-store-kinds, naming the node', () => {
		const { core, capabilities, close } = makeCore({ OBJECT_STORE_AZURE: true }, azureRepo);
		capabilities(['jobs']);
		core.databases.create(owner, { name: 'main-db', version: '18' });
		expect(() => core.databases.setPitrPolicy(owner, 'main-db', { enabled: true })).toThrow(
			'"object-store-kinds"; update edge first',
		);
		// Turning it off is never refused.
		expect(() => core.databases.setPitrPolicy(owner, 'main-db', { enabled: false })).not.toThrow();
		close();
	});

	test('the activation leaves repo out, so an agent built before W3 fails closed', async () => {
		const { core, joined, capabilities, close } = makeCore({ OBJECT_STORE_AZURE: true }, azureRepo);
		capabilities([OBJECT_STORE_KINDS_CAPABILITY]);
		core.databases.create(owner, { name: 'main-db', version: '18' });
		const status = core.databases.setPitrPolicy(owner, 'main-db', { enabled: true });
		// The view is credential-free and names the real store.
		expect(status.repo.store).toMatchObject({ kind: 'azure', account: 'acct1', container: 'pitr' });
		expect(JSON.stringify(status)).not.toContain('azure-account-key');
		const state = await core.nodes.desiredState(joined.token);
		const task = state.databasePitrTasks[0]!;
		const activation = core.databases.pitrActivation(joined.nodeId, task.id) as Record<string, unknown>;
		expect('repo' in activation).toBe(false);
		expect(activation.store).toMatchObject({ kind: 'azure' });
		expect(activation.storeCredentials).toMatchObject({ kind: 'azure', accountKey: 'azure-account-key-0123456789' });
		// What every agent before W3 runs: the parse throws, so it never writes an S3 config.
		expect(databasePitrActivationSchema.safeParse(JSON.parse(JSON.stringify(activation))).success).toBe(false);
		// A W3 agent reads it.
		expect(databasePitrAnyActivationSchema.parse(JSON.parse(JSON.stringify(activation)))).toMatchObject({ store: { kind: 'azure' } });
		// A node that lost the capability (downgraded agent) is refused the activation.
		capabilities(['jobs']);
		expect(() => core.databases.pitrActivation(joined.nodeId, task.id)).toThrow('object-store-kinds');
		close();
	});

	test('an S3 repository is unchanged: repo present, readable by every agent', async () => {
		const s3 = {
			kind: 's3' as const,
			endpoint: 'https://s3.example.test',
			bucket: 'yoal-pitr',
			region: 'us-east-1',
			pathPrefix: 'yoal/pitr',
			forcePathStyle: true,
			accessKeyId: 'access-key',
			secretAccessKey: 'super-secret-key',
		};
		const { core, joined, close } = makeCore({}, s3);
		core.databases.create(owner, { name: 'main-db', version: '18' });
		const status = core.databases.setPitrPolicy(owner, 'main-db', { enabled: true });
		expect('store' in status.repo).toBe(false);
		const state = await core.nodes.desiredState(joined.token);
		const activation = core.databases.pitrActivation(joined.nodeId, state.databasePitrTasks[0]!.id);
		expect(databasePitrActivationSchema.parse(activation).repo).toEqual(s3);
		close();
	});
});
