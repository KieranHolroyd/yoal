import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, migrations, platformDbPath } from './index.ts';

describe('platform database file', () => {
	test('uses the legacy skiff.db when it is the only file', () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-db-path-'));
		try {
			const legacy = join(dir, 'skiff.db');
			new Database(legacy, { create: true, strict: true }).close();
			expect(platformDbPath(dir)).toBe(legacy);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('prefers a populated skiff.db over an empty yoal.db from a failed upgrade', () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-db-path-'));
		try {
			const current = join(dir, 'yoal.db');
			const legacy = join(dir, 'skiff.db');
			const empty = new Database(current, { create: true, strict: true });
			empty.run('CREATE TABLE user (id TEXT PRIMARY KEY)');
			empty.close();
			const populated = new Database(legacy, { create: true, strict: true });
			populated.run('CREATE TABLE user (id TEXT PRIMARY KEY)');
			populated.run("INSERT INTO user (id) VALUES ('user_1')");
			populated.close();

			expect(platformDbPath(dir)).toBe(legacy);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('keeps yoal.db when it is set up, or when there is no legacy database', () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-db-path-'));
		try {
			const current = join(dir, 'yoal.db');
			const legacy = join(dir, 'skiff.db');
			for (const path of [current, legacy]) {
				const db = new Database(path, { create: true, strict: true });
				db.run('CREATE TABLE user (id TEXT PRIMARY KEY)');
				db.run("INSERT INTO user (id) VALUES ('user_1')");
				db.close();
			}
			expect(platformDbPath(dir)).toBe(current);
			rmSync(legacy);
			expect(platformDbPath(dir)).toBe(current);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * The Skiff → Yoal rename must not replay the migration stream on an existing install: most
 * migrations are non-idempotent `ALTER TABLE`s, so a fresh ledger answers every page with a 500.
 */
describe('legacy migration ledger', () => {
	test('renames skiff_migrations instead of rerunning every migration', () => {
		const sqlite = new Database(':memory:', { create: true, strict: true });
		sqlite.run('CREATE TABLE skiff_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
		for (const migration of migrations)
			sqlite.run('INSERT INTO skiff_migrations (id, applied_at) VALUES (?, ?)', [
				migration.id,
				Date.now()
			]);

		const ran = migrate(sqlite);

		expect(ran).toEqual([]);
		expect(
			sqlite.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'yoal_migrations'").get()
		).toBeTruthy();
		expect(
			sqlite.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'skiff_migrations'").get()
		).toBeNull();
		expect(sqlite.query('SELECT count(*) AS n FROM yoal_migrations').get()).toEqual({
			n: migrations.length
		});
		sqlite.close();
	});

	test('merges a legacy ledger when an empty yoal_migrations already exists', () => {
		const sqlite = new Database(':memory:', { create: true, strict: true });
		sqlite.run('CREATE TABLE skiff_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
		for (const migration of migrations)
			sqlite.run('INSERT INTO skiff_migrations (id, applied_at) VALUES (?, ?)', [
				migration.id,
				Date.now()
			]);
		sqlite.run('CREATE TABLE yoal_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');

		expect(migrate(sqlite)).toEqual([]);
		expect(sqlite.query('SELECT count(*) AS n FROM yoal_migrations').get()).toEqual({
			n: migrations.length
		});
		sqlite.close();
	});
});

/**
 * A v2 install that ran the promotion migration while it was numbered 0003 must not fail when the
 * renamed 0004 is embedded: ALTER TABLE would otherwise be a duplicate-column error.
 */
describe('0023 org networks upgrade', () => {
	test('backfills built-in credentials and keeps existing attachments working', () => {
		const sqlite = new Database(':memory:', { create: true, strict: true });
		sqlite.run('CREATE TABLE yoal_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
		const apply = (id: string) => {
			const migration = migrations.find((entry) => entry.id === id);
			if (!migration) throw new Error(`missing migration ${id}`);
			sqlite.run(migration.sql);
			sqlite.run('INSERT INTO yoal_migrations (id, applied_at) VALUES (?, ?)', [id, Date.now()]);
		};
		for (const migration of migrations) {
			if (Number(migration.id.slice(0, 4)) <= 18) apply(migration.id);
		}
		sqlite.run(
			`INSERT INTO databases
			 (id, org_id, name, version, node_id, host_port, memory_mb, owner_secret, monitor_secret, created_by, created_at, updated_at)
			 VALUES ('db_old', 'org_1', 'old-db', '17', 'nod_1', 15432, 256, 'owner-sealed', 'monitor-sealed', 'user_1', 1, 1)`,
		);
		sqlite.run(
			`INSERT INTO database_attachments (id, org_id, database_id, project_id, created_by, created_at)
			 VALUES ('dba_old', 'org_1', 'db_old', 'prj_1', 'user_1', 1)`,
		);

		apply('0022_org_networks.sql');

		const credentials = sqlite
			.query<{ role: string; username: string; secret_sealed: string }, []>(
				"SELECT role, username, secret_sealed FROM database_credentials WHERE database_id = 'db_old' ORDER BY role",
			)
			.all();
		expect(credentials).toEqual([
			{ role: 'monitor', username: 'yoal_monitor', secret_sealed: 'monitor-sealed' },
			{ role: 'owner', username: 'old_db', secret_sealed: 'owner-sealed' },
		]);
		const attachment = sqlite
			.query<{ credential_id: string | null }, []>(
				"SELECT credential_id FROM database_attachments WHERE id = 'dba_old'",
			)
			.get();
		expect(attachment?.credential_id).toBeNull();
		expect(
			sqlite.query<{ name: string }, []>('PRAGMA table_info(storage_attachments)').all().some((row) => row.name === 'credential_id'),
		).toBe(true);
		sqlite.close();
	});
});

describe('migration aliases', () => {
	test('records a renamed migration as applied instead of rerunning it', () => {
		const sqlite = new Database(':memory:', { create: true, strict: true });
		sqlite.run('CREATE TABLE yoal_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');

		const apply = (id: string) => {
			const migration = migrations.find((entry) => entry.id === id);
			if (!migration) throw new Error(`missing migration ${id}`);
			sqlite.run(migration.sql);
			sqlite.run('INSERT INTO yoal_migrations (id, applied_at) VALUES (?, ?)', [id, Date.now()]);
		};

		apply('0001_init.sql');
		apply('0002_cli_login_codes.sql');
		// The pre-rename id, with the same schema change, already recorded.
		const promoted = migrations.find((entry) => entry.id === '0004_deployment_promoted_at.sql')!;
		sqlite.run(promoted.sql);
		sqlite.run("INSERT INTO yoal_migrations (id, applied_at) VALUES ('0003_deployment_promoted_at.sql', ?)", [Date.now()]);

		expect(() => migrate(sqlite)).not.toThrow();
		const ids = sqlite
			.query<{ id: string }, []>('SELECT id FROM yoal_migrations ORDER BY id')
			.all()
			.map((row) => row.id);
		expect(ids).toContain('0004_deployment_promoted_at.sql');
		expect(ids).toContain('0003_v2_backend.sql');
		const columns = sqlite
			.query<{ name: string }, []>('PRAGMA table_info(deployments)')
			.all()
			.filter((row) => row.name === 'promoted_at');
		expect(columns).toHaveLength(1);
		sqlite.close();
	});

	/**
	 * The D126 variant migration was published locally as `0053_database_variant.sql` and later
	 * renumbered (now 0055) when `0053_backup_locations.sql` took that prefix. The ALTER is not
	 * idempotent, so a database that ran the old id must record the new one instead of rerunning it.
	 */
	test('records the Postgres variant migration after it moved from 0053', () => {
		const sqlite = new Database(':memory:', { create: true, strict: true });
		sqlite.run('CREATE TABLE yoal_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');

		const apply = (migration: { id: string; sql: string }) => {
			sqlite.run(migration.sql);
			sqlite.run('INSERT INTO yoal_migrations (id, applied_at) VALUES (?, ?)', [
				migration.id,
				Date.now(),
			]);
		};

		const variant = migrations.find((entry) => entry.id === '0055_database_variant.sql')!;
		for (const migration of migrations) {
			if (migration.id === variant.id) continue;
			apply(migration);
		}
		// The old file had the same ALTER and is what the database already ran.
		sqlite.run(variant.sql);
		sqlite.run("INSERT INTO yoal_migrations (id, applied_at) VALUES ('0053_database_variant.sql', ?)", [
			Date.now(),
		]);

		expect(() => migrate(sqlite)).not.toThrow();
		const ids = sqlite
			.query<{ id: string }, []>('SELECT id FROM yoal_migrations ORDER BY id')
			.all()
			.map((row) => row.id);
		expect(ids).toContain('0055_database_variant.sql');
		const columns = sqlite
			.query<{ name: string }, []>('PRAGMA table_info(databases)')
			.all()
			.filter((row) => row.name === 'variant');
		expect(columns).toHaveLength(1);
		sqlite.close();
	});
});

describe('HA Wave 1 migrations 0118–0121 (docs/build-plan/HA-WAVE-1.md)', () => {
	const wave1 = [
		'0118_node_ca.sql',
		'0119_release_phase.sql',
		'0120_object_store_kinds.sql',
		// Lane B's reserved spare: endpoint roles (H24).
		'0121_service_endpoint_roles.sql',
	];
	const tables = (sqlite: Database) =>
		new Set(sqlite.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
	const columns = (sqlite: Database, table: string) =>
		sqlite.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name);

	test('are the reserved files, in order, right after 0117', () => {
		const ids = migrations.map((migration) => migration.id);
		const at = ids.indexOf('0117_kubernetes_k5_k6.sql');
		expect(ids.slice(at + 1, at + 1 + wave1.length)).toEqual(wave1);
	});

	test('apply on a fresh database', () => {
		const sqlite = new Database(':memory:', { create: true, strict: true });
		const ran = migrate(sqlite);
		for (const id of wave1) expect(ran).toContain(id);
		const names = tables(sqlite);
		for (const table of ['node_ca', 'node_ca_certificates', 'release_command_runs', 'deployment_canaries']) expect(names.has(table)).toBe(true);
		expect(columns(sqlite, 'backup_targets')).toEqual(expect.arrayContaining(['store_kind', 'store_options_json', 'immutable_retention_days']));
		expect(migrate(sqlite)).toEqual([]);
		sqlite.close();
	});

	test('apply on a database at 0117 and backfill existing object-store targets as s3', () => {
		const sqlite = new Database(':memory:', { create: true, strict: true });
		sqlite.run('CREATE TABLE yoal_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
		for (const migration of migrations) {
			if (Number(migration.id.slice(0, 4)) > 117) continue;
			sqlite.run(migration.sql);
			sqlite.run('INSERT INTO yoal_migrations (id, applied_at) VALUES (?, ?)', [migration.id, 1]);
		}
		expect(tables(sqlite).has('node_ca')).toBe(false);
		sqlite.run(
			`INSERT INTO backup_targets (id, org_id, name, kind, endpoint, bucket, region, path_prefix, access_key_sealed, secret_sealed, object_lock, created_at, updated_at)
			 VALUES ('bt_s3', NULL, 'r2-main', 's3', 'https://acc.r2.cloudflarestorage.com', 'yoal', 'auto', 'yoal/backups', 'ak', 'sk', 1, 1, 1)`,
		);
		sqlite.run(
			`INSERT INTO backup_targets (id, org_id, name, kind, path, created_at, updated_at)
			 VALUES ('bt_local', 'org_1', 'local-main', 'local', '/var/lib/yoal/backups', 1, 1)`,
		);

		expect(migrate(sqlite)).toEqual(wave1);

		const rows = sqlite
			.query<{ id: string; kind: string; store_kind: string | null; store_options_json: string; object_lock: number; immutable_retention_days: number | null; secret_sealed: string | null }, []>(
				'SELECT id, kind, store_kind, store_options_json, object_lock, immutable_retention_days, secret_sealed FROM backup_targets ORDER BY id',
			)
			.all();
		expect(rows).toEqual([
			{ id: 'bt_local', kind: 'local', store_kind: null, store_options_json: '{}', object_lock: 0, immutable_retention_days: null, secret_sealed: null },
			{ id: 'bt_s3', kind: 's3', store_kind: 's3', store_options_json: '{}', object_lock: 1, immutable_retention_days: null, secret_sealed: 'sk' },
		]);
		expect(() => sqlite.run("UPDATE backup_targets SET store_kind = 'ftp' WHERE id = 'bt_s3'")).toThrow();
		sqlite.close();
	});

	test('release_command_runs is the I16 run lease: one live attempt and one success per release', () => {
		const sqlite = new Database(':memory:', { create: true, strict: true });
		migrate(sqlite);
		const insert = (id: string, attempt: number, status: string) =>
			sqlite.run(
				`INSERT INTO release_command_runs (id, release_id, org_id, project_id, workload_id, attempt, status, command_json, timeout_seconds, created_at, updated_at)
				 VALUES (?, 'dep_1', 'org_1', 'prj_1', 'wl_1', ?, ?, '["bin/migrate"]', 600, 1, 1)`,
				[id, attempt, status],
			);
		insert('rc_1', 1, 'running');
		expect(() => insert('rc_2', 2, 'queued')).toThrow();
		sqlite.run("UPDATE release_command_runs SET status = 'failed' WHERE id = 'rc_1'");
		insert('rc_2', 2, 'queued');
		expect(() => insert('rc_dup', 2, 'failed')).toThrow();
		sqlite.run("UPDATE release_command_runs SET status = 'succeeded' WHERE id = 'rc_2'");
		// After a success no attempt may be queued or start again (reviewer's I16 hole).
		expect(() => insert('rc_after_q', 3, 'queued')).toThrow();
		expect(() => insert('rc_after_r', 3, 'running')).toThrow();
		insert('rc_3', 3, 'failed');
		expect(() => sqlite.run("UPDATE release_command_runs SET status = 'succeeded' WHERE id = 'rc_3'")).toThrow();
		expect(() => sqlite.run("UPDATE release_command_runs SET status = 'queued' WHERE id = 'rc_3'")).toThrow();
		expect(() => insert('rc_4', 4, 'pending')).toThrow();
		sqlite.close();
	});

	test('node_ca allows one active CA', () => {
		const sqlite = new Database(':memory:', { create: true, strict: true });
		migrate(sqlite);
		const insert = (id: string, state: string) =>
			sqlite.run(
				`INSERT INTO node_ca (id, state, cert_pem, key_sealed, fingerprint, subject, not_before, not_after, created_at, updated_at)
				 VALUES (?, ?, 'pem', 'sealed', ?, 'CN=Yoal install CA', 1, 2, 1, 1)`,
				[id, state, `fp-${id}`],
			);
		insert('ca_1', 'active');
		expect(() => insert('ca_2', 'active')).toThrow();
		insert('ca_2', 'previous');
		sqlite.close();
	});
});

describe('node_ca_certificates (reviewer item 9)', () => {
	test('one live leaf per node and public key; a revoked one does not block a re-issue', () => {
		const sqlite = new Database(':memory:', { create: true, strict: true });
		migrate(sqlite);
		const issue = (serial: string, nodeId: string, key: string) =>
			sqlite.run(
				`INSERT INTO node_ca_certificates (serial, ca_id, node_id, cert_pem, public_key_sha256, not_before, not_after, created_at)
				 VALUES (?, 'ca_1', ?, 'pem', ?, 1, 2, 1)`,
				[serial, nodeId, key],
			);
		issue('aa01', 'nod_1', 'k1');
		expect(() => issue('aa02', 'nod_1', 'k1')).toThrow();
		issue('aa03', 'nod_1', 'k2');
		issue('aa04', 'nod_2', 'k1');
		sqlite.run("UPDATE node_ca_certificates SET revoked_at = 5 WHERE serial = 'aa01'");
		issue('aa05', 'nod_1', 'k1');
		sqlite.close();
	});
});
