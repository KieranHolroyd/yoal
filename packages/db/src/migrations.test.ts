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

	test('0121 backfills existing endpoints as primary and allows a pool row beside one', () => {
		const sqlite = new Database(':memory:', { create: true, strict: true });
		sqlite.run('CREATE TABLE yoal_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
		for (const migration of migrations) {
			if (Number(migration.id.slice(0, 4)) > 120) continue;
			sqlite.run(migration.sql);
			sqlite.run('INSERT INTO yoal_migrations (id, applied_at) VALUES (?, ?)', [migration.id, 1]);
		}
		sqlite.run(
			`INSERT INTO service_endpoints (id, consumer_node_id, service_kind, service_id, local_port, upstream_node_id, upstream_port, created_at, updated_at)
			 VALUES ('sep_old', 'nod_a', 'database', 'db_1', 21000, 'nod_b', 15432, 1, 1)`,
		);
		const ran = migrate(sqlite);
		expect(ran).toContain('0121_service_endpoint_roles.sql');
		expect(sqlite.query('SELECT role, version FROM service_endpoints WHERE id = ?').get('sep_old')).toEqual({
			role: 'primary',
			version: 0,
		});
		sqlite.run(
			`INSERT INTO service_endpoints (id, consumer_node_id, service_kind, service_id, role, local_port, upstream_node_id, upstream_port, version, created_at, updated_at)
			 VALUES ('sep_pool', 'nod_a', 'database', 'db_1', 'pool', 21001, 'nod_b', 6432, 0, 1, 1)`,
		);
		expect(sqlite.query('SELECT COUNT(*) AS n FROM service_endpoints').get()).toEqual({ n: 2 });
		sqlite.close();
	});

	test('apply on a fresh database', () => {
		const sqlite = new Database(':memory:', { create: true, strict: true });
		const ran = migrate(sqlite);
		for (const id of wave1) expect(ran).toContain(id);
		const names = tables(sqlite);
		for (const table of ['node_ca', 'node_ca_certificates', 'release_command_runs', 'deployment_canaries']) expect(names.has(table)).toBe(true);
		expect(columns(sqlite, 'backup_targets')).toEqual(expect.arrayContaining(['store_kind', 'store_options_json', 'immutable_retention_days']));
		// W7 certificates (0123): a durable reissue request and the fingerprint each node reports.
		expect(columns(sqlite, 'ingress_certificates')).toContain('reissue_requested_at');
		expect(columns(sqlite, 'nodes')).toContain('certificate_fingerprint');
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

		expect(migrate(sqlite)).toEqual([...wave1, '0122_ingress_certificates.sql', '0123_ingress_drift.sql', '0124_shared_certificates.sql', '0125_control_epoch.sql', '0126_replica_durability.sql', '0127_replica_rewind.sql', '0128_sync_switchover_rewind.sql', '0129_db_failover_policy.sql', '0130_drills_slo.sql', '0131_node_drills.sql', '0132_regions.sql', '0133_attachment_gateway_marker.sql', '0134_ha_drills.sql', '0135_join_token_roles.sql', '0136_region_promotion_break_glass.sql', '0137_cloud_shells.sql', '0138_cloud_shell_message.sql', '0139_cloud_shell_settings.sql', '0140_overlay_mesh.sql', '0141_database_public_access.sql', '0142_logs_explorer.sql']);

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

describe('HA Wave 4 migrations 0129–0130 (docs/build-plan/HA-WAVE-4.md)', () => {
	const tables = (sqlite: Database) =>
		new Set(sqlite.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
	const columns = (sqlite: Database, table: string) =>
		sqlite.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name);

	test('are additive: manual failover, drill evidence and SLO objects', () => {
		const sqlite = new Database(':memory:', { create: true, strict: true });
		migrate(sqlite);
		expect(columns(sqlite, 'databases')).toEqual(
			expect.arrayContaining(['failover_mode', 'accept_data_loss', 'auto_armed_at', 'last_failover_drill_at', 'failover_evidence_json']),
		);
		expect(columns(sqlite, 'database_failovers')).toEqual(expect.arrayContaining(['promotion_source', 'evidence_json']));
		expect(tables(sqlite).has('database_failover_drills')).toBe(true);
		expect(tables(sqlite).has('slo_objects')).toBe(true);

		sqlite.run(
			`INSERT INTO databases (id, org_id, name, version, node_id, host_port, memory_mb, owner_secret, monitor_secret, created_by, created_at, updated_at)
			 VALUES ('db_1', 'org_1', 'main', '16', 'nod_1', 5432, 256, 'owner', 'monitor', 'user_1', 1, 1)`,
		);
		expect(
			sqlite
				.query<{ failover_mode: string; accept_data_loss: number; auto_armed_at: number | null; failover_evidence_json: string }, []>(
					"SELECT failover_mode, accept_data_loss, auto_armed_at, failover_evidence_json FROM databases WHERE id = 'db_1'",
				)
				.get(),
		).toEqual({ failover_mode: 'manual', accept_data_loss: 0, auto_armed_at: null, failover_evidence_json: '{}' });
		expect(() => sqlite.run("UPDATE databases SET failover_mode = 'sometimes' WHERE id = 'db_1'")).toThrow();

		sqlite.run(
			`INSERT INTO database_failover_drills (id, database_id, status, started_at, created_by, created_at)
			 VALUES ('drl_1', 'db_1', 'passed', 1, 'user_1', 1)`,
		);
		expect(
			sqlite
				.query<{ status: string; arbiter_tested: number; time_to_writable_ms: number | null }, []>(
					"SELECT status, arbiter_tested, time_to_writable_ms FROM database_failover_drills WHERE id = 'drl_1'",
				)
				.get(),
		).toEqual({ status: 'passed', arbiter_tested: 0, time_to_writable_ms: null });
		expect(() => sqlite.run("UPDATE database_failover_drills SET status = 'unknown' WHERE id = 'drl_1'")).toThrow();

		const insertSlo = (id: string, name: string, target: number) =>
			sqlite.run(
				`INSERT INTO slo_objects (id, org_id, project_id, name, indicator, target, window_seconds, created_by, created_at, updated_at)
				 VALUES (?, 'org_1', 'prj_1', ?, 'http_availability', ?, 2592000, 'user_1', 1, 1)`,
				[id, name, target],
			);
		insertSlo('slo_1', 'availability', 0.999);
		expect(() => insertSlo('slo_2', 'availability', 0.99)).toThrow();
		expect(() => insertSlo('slo_3', 'no-budget', 1)).toThrow();
		sqlite.close();
	});

	test('upgrades a populated 0128 database without changing existing rows', () => {
		const sqlite = new Database(':memory:', { create: true, strict: true });
		sqlite.run('CREATE TABLE yoal_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
		for (const migration of migrations) {
			if (Number(migration.id.slice(0, 4)) > 128) continue;
			sqlite.run(migration.sql);
			sqlite.run('INSERT INTO yoal_migrations (id, applied_at) VALUES (?, ?)', [migration.id, 1]);
		}
		sqlite.run(
			`INSERT INTO databases (id, org_id, name, version, node_id, host_port, memory_mb, owner_secret, monitor_secret, created_by, created_at, updated_at)
			 VALUES ('db_old', 'org_1', 'old', '16', 'nod_1', 5432, 256, 'owner', 'monitor', 'user_1', 1, 1)`,
		);
		sqlite.run(
			`INSERT INTO database_failovers (id, database_id, from_node_id, to_node_id, generation, status, started_at)
			 VALUES ('dbf_old', 'db_old', 'nod_1', 'nod_2', 1, 'completed', 1)`,
		);

		expect(migrate(sqlite)).toEqual(['0129_db_failover_policy.sql', '0130_drills_slo.sql', '0131_node_drills.sql', '0132_regions.sql', '0133_attachment_gateway_marker.sql', '0134_ha_drills.sql', '0135_join_token_roles.sql', '0136_region_promotion_break_glass.sql', '0137_cloud_shells.sql', '0138_cloud_shell_message.sql', '0139_cloud_shell_settings.sql', '0140_overlay_mesh.sql', '0141_database_public_access.sql', '0142_logs_explorer.sql']);

		expect(
			sqlite
				.query<{ failover_mode: string; accept_data_loss: number; auto_armed_at: number | null; last_failover_drill_at: number | null; failover_evidence_json: string }, []>(
					"SELECT failover_mode, accept_data_loss, auto_armed_at, last_failover_drill_at, failover_evidence_json FROM databases WHERE id = 'db_old'",
				)
				.get(),
		).toEqual({
			failover_mode: 'manual',
			accept_data_loss: 0,
			auto_armed_at: null,
			last_failover_drill_at: null,
			failover_evidence_json: '{}',
		});
		expect(
			sqlite
				.query<{ promotion_source: string; evidence_json: string }, []>(
					"SELECT promotion_source, evidence_json FROM database_failovers WHERE id = 'dbf_old'",
				)
				.get(),
		).toEqual({ promotion_source: 'manual', evidence_json: '{}' });

		sqlite.run(
			`INSERT INTO database_failover_drills (id, database_id, status, started_at, created_by, created_at)
			 VALUES ('drl_old', 'db_old', 'passed', 1, 'user_1', 1)`,
		);
		expect(
			sqlite
				.query<{ drill_database_id: string | null; durability: string; time_to_writable_ms: number | null; lost_commits: number | null; generation: number }, []>(
					"SELECT drill_database_id, durability, time_to_writable_ms, lost_commits, generation FROM database_failover_drills WHERE id = 'drl_old'",
				)
				.get(),
		).toEqual({ drill_database_id: null, durability: 'async', time_to_writable_ms: null, lost_commits: null, generation: 0 });
		expect(() => sqlite.run("UPDATE database_failover_drills SET time_to_writable_ms = -1 WHERE id = 'drl_old'")).toThrow();
		expect(() => sqlite.run("UPDATE database_failover_drills SET lost_commits = -1 WHERE id = 'drl_old'")).toThrow();
		expect(() => sqlite.run("UPDATE database_failover_drills SET durability = 'sync-ish' WHERE id = 'drl_old'")).toThrow();
		expect(() => sqlite.run("UPDATE database_failover_drills SET generation = -1 WHERE id = 'drl_old'")).toThrow();
		sqlite.close();
	});
	test('0133 keeps every app that already uses the endpoint gateway on it, and marks nothing else', () => {
		const sqlite = new Database(':memory:', { create: true, strict: true });
		sqlite.run('CREATE TABLE yoal_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
		for (const migration of migrations) {
			if (Number(migration.id.slice(0, 4)) >= 133) continue;
			sqlite.run(migration.sql);
			sqlite.run('INSERT INTO yoal_migrations (id, applied_at) VALUES (?, ?)', [migration.id, 1]);
		}
		const workload = (id: string, project: string, runtime: string, node: string) =>
			sqlite.run(
				`INSERT INTO workloads (id, org_id, project_id, deployment_id, node_id, runtime, spec_json, memory_mb, created_at, updated_at)
				 VALUES (?, 'org_1', ?, 'dep', ?, ?, '{}', 128, 1, 1)`,
				[id, project, node, runtime],
			);
		const attach = (project: string, database: string) =>
			sqlite.run(
				`INSERT INTO database_attachments (id, org_id, database_id, project_id, created_by, created_at) VALUES (?, 'org_1', ?, ?, 'u', 1)`,
				[`att_${project}`, database, project],
			);
		const endpoint = (consumer: string, database: string, role: string, upstream: string, port: number) =>
			sqlite.run(
				`INSERT INTO service_endpoints (id, consumer_node_id, service_kind, service_id, role, local_port, upstream_node_id, upstream_port, version, created_at, updated_at)
				 VALUES (?, ?, 'database', ?, ?, ?, ?, 5432, 0, 1, 1)`,
				[`sep_${consumer}_${database}_${role}`, consumer, database, role, port, upstream],
			);
		// Same-node gateway endpoint, a remote container, a remote process app (C2, no gateway), and a
		// same-node app with no endpoint (connects directly).
		workload('w_same', 'p_same', 'container', 'n1');
		attach('p_same', 'db1');
		endpoint('n1', 'db1', 'primary', 'n1', 21000);
		// A replica served reads on main, so p_same already has <P>_READ_* through this row.
		endpoint('n1', 'db1', 'read', 'n9', 23000);
		workload('w_box', 'p_box', 'container', 'n2');
		attach('p_box', 'db2');
		endpoint('n2', 'db2', 'primary', 'n3', 21000);
		workload('w_proc', 'p_proc', 'process', 'n4');
		attach('p_proc', 'db2');
		endpoint('n4', 'db2', 'primary', 'n3', 21000);
		workload('w_direct', 'p_direct', 'container', 'n3');
		attach('p_direct', 'db2');
		expect(migrate(sqlite)).toEqual(['0133_attachment_gateway_marker.sql', '0134_ha_drills.sql', '0135_join_token_roles.sql', '0136_region_promotion_break_glass.sql', '0137_cloud_shells.sql', '0138_cloud_shell_message.sql', '0139_cloud_shell_settings.sql', '0140_overlay_mesh.sql', '0141_database_public_access.sql', '0142_logs_explorer.sql']);
		const marked = sqlite
			.query<{ id: string }, []>('SELECT id FROM workloads WHERE endpoints_gateway = 1 ORDER BY id')
			.all()
			.map((row) => row.id);
		expect(marked).toEqual(['w_box', 'w_same']);
		// Only the attachment that already had read variables keeps them; nobody gains them here.
		expect(
			sqlite
				.query<{ project_id: string }, []>('SELECT project_id FROM database_attachments WHERE read_endpoint = 1 ORDER BY project_id')
				.all()
				.map((row) => row.project_id),
		).toEqual(['p_same']);
		expect(sqlite.query<{ k: string | null }, []>('SELECT upstreams_key AS k FROM service_endpoints LIMIT 1').get()!.k).toBeNull();
		sqlite.close();
	});
});

describe('HA Wave 5 migration 0132 (docs/build-plan/HA-WAVE-5.md)', () => {
	const columns = (sqlite: Database, table: string) =>
		sqlite.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name);
	const insertNode = (sqlite: Database, id: string) =>
		sqlite.run(
			`INSERT INTO nodes (id, name, mode, status, token_hash, created_at, updated_at) VALUES (?, ?, 'worker', 'online', 'hash', 1, 1)`,
			[id, id],
		);
	const insertDatabase = (sqlite: Database, id: string) =>
		sqlite.run(
			`INSERT INTO databases (id, org_id, name, version, node_id, host_port, memory_mb, owner_secret, monitor_secret, created_by, created_at, updated_at)
			 VALUES (?, 'org_1', ?, '16', 'nod_1', 5432, 256, 'owner', 'monitor', 'user_1', 1, 1)`,
			[id, id],
		);
	const insert = (sqlite: Database, table: string, row: Record<string, unknown>) =>
		sqlite.run(
			`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`,
			Object.values(row) as never[],
		);
	const promotion = (sqlite: Database, id: string, fields: Record<string, unknown> = {}) =>
		insert(sqlite, 'region_promotions', {
			id,
			to_region: 'ukwest',
			from_region: 'uksouth',
			plan_hash: 'a'.repeat(64),
			accept_data_loss: 1,
			reason: 'uksouth is down',
			confirmed_by: 'user_1',
			confirmed_at: 1,
			started_at: 1,
			...fields,
		});
	const step = (sqlite: Database, promotionId: string, position: number, fields: Record<string, unknown> = {}) =>
		insert(sqlite, 'region_promotion_steps', {
			promotion_id: promotionId,
			position,
			step: 'databases',
			kind: 'database',
			resource_id: `db_${position}`,
			name: `db-${position}`,
			expected_generation: 7,
			...fields,
		});

	test('is the reserved file, right after 0131', () => {
		const ids = migrations.map((migration) => migration.id);
		expect(ids.indexOf('0132_regions.sql')).toBe(ids.indexOf('0131_node_drills.sql') + 1);
	});

	test('applies on a fresh database', () => {
		const sqlite = new Database(':memory:', { create: true, strict: true });
		migrate(sqlite);
		expect(columns(sqlite, 'nodes')).toContain('region');
		expect(columns(sqlite, 'databases')).toContain('standby_region');
		expect(columns(sqlite, 'control_state')).toContain('feature_flags_json');
		insertNode(sqlite, 'nod_1');
		insertDatabase(sqlite, 'db_1');
		expect(sqlite.query<{ region: string }, []>("SELECT region FROM nodes WHERE id = 'nod_1'").get()).toEqual({ region: 'default' });
		expect(sqlite.query<{ standby_region: string | null }, []>("SELECT standby_region FROM databases WHERE id = 'db_1'").get()).toEqual({
			standby_region: null,
		});

		promotion(sqlite, 'rgp_1');
		expect(
			sqlite.query<{ stage: string; attempt: number; runner_id: string | null }, []>("SELECT stage, attempt, runner_id FROM region_promotions WHERE id = 'rgp_1'").get(),
		).toEqual({ stage: 'control-plane', attempt: 1, runner_id: null });
		// Stored only once confirmed, with data loss accepted.
		expect(() => promotion(sqlite, 'rgp_x', { accept_data_loss: 0 })).toThrow();
		expect(() => promotion(sqlite, 'rgp_y', { confirmed_at: null })).toThrow();
		// One open promotion at a time.
		expect(() => promotion(sqlite, 'rgp_2')).toThrow();
		// A terminal stage sets finished_at, and only a terminal stage does.
		expect(() => sqlite.run("UPDATE region_promotions SET stage = 'completed' WHERE id = 'rgp_1'")).toThrow();
		expect(() => sqlite.run("UPDATE region_promotions SET finished_at = 5 WHERE id = 'rgp_1'")).toThrow();
		expect(() => sqlite.run("UPDATE region_promotions SET stage = 'fencing' WHERE id = 'rgp_1'")).toThrow();

		// Each step carries its own fence, which only moves forward; one row per resource.
		step(sqlite, 'rgp_1', 0, { step: 'control-plane', kind: 'control-plane', resource_id: 'control-plane', expected_generation: 3, fenced_generation: 4, status: 'done' });
		step(sqlite, 'rgp_1', 1);
		step(sqlite, 'rgp_1', 2, { step: 'steering', kind: 'steering', resource_id: 'dns-failover', expected_generation: 4 });
		expect(() => sqlite.run("UPDATE region_promotion_steps SET fenced_generation = 7 WHERE promotion_id = 'rgp_1' AND position = 1")).toThrow();
		sqlite.run("UPDATE region_promotion_steps SET fenced_generation = 8, status = 'done' WHERE promotion_id = 'rgp_1' AND position = 1");
		expect(() => step(sqlite, 'rgp_1', 3, { resource_id: 'db_1' })).toThrow();
		expect(() => step(sqlite, 'rgp_1', 4, { status: 'sideways' })).toThrow();

		// The runner lease: a takeover is a conditional update on the old holder.
		sqlite.run("UPDATE region_promotions SET runner_id = 'cp-b', lease_expires_at = 100 WHERE id = 'rgp_1'");
		const takeover = sqlite.run(
			"UPDATE region_promotions SET runner_id = 'cp-c', lease_expires_at = 200, attempt = attempt + 1 WHERE id = 'rgp_1' AND runner_id = 'cp-b' AND lease_expires_at <= 150",
		);
		expect(takeover.changes).toBe(1);

		sqlite.run("UPDATE region_promotions SET stage = 'completed', finished_at = 3 WHERE id = 'rgp_1'");
		promotion(sqlite, 'rgp_2');
		sqlite.close();
	});

	test('upgrades a populated 0131 database: every node is in the default region, no database has a standby region', () => {
		const sqlite = new Database(':memory:', { create: true, strict: true });
		sqlite.run('CREATE TABLE yoal_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
		for (const migration of migrations) {
			if (Number(migration.id.slice(0, 4)) > 131) continue;
			sqlite.run(migration.sql);
			sqlite.run('INSERT INTO yoal_migrations (id, applied_at) VALUES (?, ?)', [migration.id, 1]);
		}
		insertNode(sqlite, 'nod_1');
		insertNode(sqlite, 'nod_2');
		sqlite.run("UPDATE nodes SET zone = 'uksouth-1' WHERE id = 'nod_2'");
		insertDatabase(sqlite, 'db_old');
		sqlite.run("INSERT INTO control_state (node_id, role, epoch, updated_at) VALUES ('nod_1', 'primary', 2, 1)");
		const before = sqlite.query<Record<string, unknown>, []>('SELECT * FROM nodes ORDER BY id').all();
		const databaseBefore = sqlite.query<Record<string, unknown>, []>('SELECT * FROM databases').all();
		const controlBefore = sqlite.query<Record<string, unknown>, []>('SELECT * FROM control_state').all();

		expect(migrate(sqlite)).toEqual(['0132_regions.sql', '0133_attachment_gateway_marker.sql', '0134_ha_drills.sql', '0135_join_token_roles.sql', '0136_region_promotion_break_glass.sql', '0137_cloud_shells.sql', '0138_cloud_shell_message.sql', '0139_cloud_shell_settings.sql', '0140_overlay_mesh.sql', '0141_database_public_access.sql', '0142_logs_explorer.sql']);

		const after = sqlite.query<Record<string, unknown>, []>('SELECT * FROM nodes ORDER BY id').all();
		expect(after).toEqual(before.map((row) => ({ ...row, region: 'default' })));
		expect(sqlite.query<Record<string, unknown>, []>('SELECT * FROM databases').all()).toEqual(
			databaseBefore.map((row) => ({ ...row, standby_region: null })),
		);
		expect(sqlite.query<Record<string, unknown>, []>('SELECT * FROM control_state').all()).toEqual(
			controlBefore.map((row) => ({ ...row, feature_flags_json: null })),
		);
		expect(sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM region_promotions').get()).toEqual({ count: 0 });
		// 0134 (Wave 5 lane B): an empty catalogue-drill table; a recorded result never claims a fake status.
		expect(columns(sqlite, 'ha_drills')).toEqual(expect.arrayContaining(['scenario', 'record_id', 'rto_ms', 'refused']));
		expect(() =>
			sqlite.run(
				"INSERT INTO ha_drills (id, scenario, resource_kind, resource_id, resource_name, status, created_by, created_at) VALUES ('h1', 'node-offline', 'node', 'n', 'n', 'ok', 'u', 1)",
			),
		).toThrow();
		// 0135: existing join tokens allow no roles.
		expect(columns(sqlite, 'node_join_tokens')).toContain('roles_json');
		sqlite.close();
	});
});

describe('cloud shell migration 0137 (D236)', () => {
	test('one shell per person and org, except shells whose disk is being deleted', () => {
		const sqlite = new Database(':memory:', { strict: true });
		migrate(sqlite);
		const insert = (id: string, user: string, status: string) =>
			sqlite.run(
				`INSERT INTO cloud_shells (id, org_id, user_id, node_id, status, disk_mb, created_at, updated_at)
				 VALUES (?, 'org_1', ?, 'nod_1', ?, 1024, 1, 1)`,
				[id, user, status],
			);
		insert('csh_a', 'u1', 'running');
		expect(() => insert('csh_b', 'u1', 'stopped')).toThrow();
		insert('csh_c', 'u2', 'stopped');
		// A reset keeps the old row as `deleting` until its node reports the disk gone.
		sqlite.run("UPDATE cloud_shells SET status = 'deleting' WHERE id = 'csh_a'");
		insert('csh_d', 'u1', 'starting');
		expect(() => insert('csh_e', 'u3', 'paused')).toThrow();
		expect(() => sqlite.run("INSERT INTO cloud_shells (id, org_id, user_id, status, disk_mb, created_at, updated_at) VALUES ('csh_f', 'o', 'u4', 'stopped', 0, 1, 1)")).toThrow();
		expect(sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM cloud_shells').get()).toEqual({ count: 3 });
		sqlite.close();
	});
});
