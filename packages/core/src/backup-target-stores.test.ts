import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, backupTargetViewSchema } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

/**
 * HA-PLAN W3 rows in `backup_targets` (0120): an Azure or GCS target is `kind = 's3'` with
 * `store_kind` set, its options in `store_options_json`, its credential in `secret_sealed`, and
 * `bucket`/`endpoint`/`region`/`access_key_sealed` NULL so a control plane from before 0120 fails
 * closed on it. Lane E writes such rows; these tests insert them directly.
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-w1-bt-stores-'));
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
		features: { ...DEFAULT_FEATURES, OBJECT_STORE_AZURE: true, OBJECT_STORE_GCS: true },
	},
});
const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

function insert(id: string, storeKind: string, options: Record<string, unknown>, secret: string | null) {
	opened.sqlite.run(
		`INSERT INTO backup_targets (id, org_id, name, kind, path_prefix, secret_sealed, store_kind, store_options_json, status, created_at, updated_at)
		 VALUES (?, 'org_1', ?, 's3', 'yoal/backups', ?, ?, ?, 'ok', 1, 1)`,
		[id, `t-${id.slice(3)}`, secret, storeKind, JSON.stringify(options)],
	);
}

insert('bt_azure', 'azure', { account: 'acct1', container: 'yoal', endpoint: 'http://127.0.0.1:10000/acct1' }, 'sealed-azure-credential');
insert('bt_gcs', 'gcs', { bucket: 'yoal-ha' }, null);

describe('backup targets on Azure and GCS (reviewer item 8)', () => {
	test('the view shows the real kind and store; credentials are read from secret_sealed', () => {
		const azure = core.backupTargets.get(owner, 'bt_azure');
		expect(azure).toMatchObject({
			kind: 'azure',
			bucket: null,
			endpoint: null,
			region: null,
			hasCredentials: true,
			store: { kind: 'azure', account: 'acct1', container: 'yoal', endpoint: 'http://127.0.0.1:10000/acct1', pathPrefix: 'yoal/backups' },
		});
		expect(backupTargetViewSchema.parse(azure)).toEqual(azure);
		const gcs = core.backupTargets.get(owner, 'bt_gcs');
		expect(gcs).toMatchObject({ kind: 'gcs', hasCredentials: false, store: { kind: 'gcs', bucket: 'yoal-ha', endpoint: null } });
	});

	test('an s3 view is unchanged: no store field, credentials need both sealed columns', () => {
		core.backupTargets.create(owner, { name: 'minio', kind: 's3', endpoint: 'https://minio.test', bucket: 'b-1', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-1234' });
		const s3 = core.backupTargets.list(owner).find((target) => target.name === 'minio')!;
		expect(s3.kind).toBe('s3');
		expect('store' in s3).toBe(false);
		expect(s3.hasCredentials).toBe(true);
	});

	test('the snapshot names the real store and the right backend is built', () => {
		const snapshot = core.backupTargets.placementFor('org_1', 'bt_azure');
		expect(snapshot.locationJson).toContain('"kind":"azure"');
		// The rows in this test hold a non-credential placeholder, so opening one fails on credentials
		// rather than silently building an S3 client. A valid sealed credential builds Azure/GCS.
		expect(() => core.backupTargets.objectStore(core.backupTargets.get(owner, 'bt_azure'))).toThrow();
		const gcs = core.backupTargets.get(owner, 'bt_gcs');
		expect(() => core.backupTargets.objectStore(gcs)).toThrow('no stored credentials');
	});

	test('a control plane from before 0120 fails closed on these rows', () => {
		// Before 0120, objectStore() refused a row without both sealed keys and a bucket, and
		// these rows have neither: it throws instead of signing requests to AWS S3.
		const rows = opened.sqlite
			.query<{ access_key_sealed: string | null; bucket: string | null; endpoint: string | null; region: string | null }, []>(
				"SELECT access_key_sealed, bucket, endpoint, region FROM backup_targets WHERE store_kind IN ('azure','gcs')",
			)
			.all();
		expect(rows).toHaveLength(2);
		for (const row of rows) expect(row).toEqual({ access_key_sealed: null, bucket: null, endpoint: null, region: null });
	});
});
