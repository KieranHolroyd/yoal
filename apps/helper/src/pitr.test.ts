import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemdDriver, type CommandRunOptions, type CommandRunner, type RunResult } from './systemd.ts';
import {
	computePitrWindow,
	formatPitrTarget,
	parseArchiverStats,
	parseDataChecksums,
	parsePgBackRestInfo,
	parsePitrBackupType,
	parsePitrRepo,
	pitrPaths,
	pitrRepoEndpoint,
	renderPgBackRestConfig,
	renderPgBackRestKey,
	renderPgControldataArgs,
	renderPgPass,
	renderPgRewindArgs,
	renderPitrBackupArgs,
	renderPitrExecArgs,
	renderPitrRecoveryArgs,
	renderPitrRenameSql,
	renderPitrRestoreArgs,
	validatePitrStanza,
	validatePitrTargetTime,
	PITR_RESTORE_ROLE,
} from './pitr.ts';
import { renderDatabaseUnit } from './units.ts';
import { parseWorkload, postgresPitrImage } from './validate.ts';

const SHA = 'a'.repeat(64);
const SOURCE = 'db_abc123';
const TARGET = 'db_target456';
const PASSWORD = 'target-password-0123456789';
const repo = {
	kind: 's3' as const,
	endpoint: 'https://s3.example.test',
	bucket: 'yoal-pitr',
	region: 'us-east-1',
	pathPrefix: 'yoal/pitr',
	forcePathStyle: true,
	accessKeyId: 'access-key',
	secretAccessKey: 'secret-key-value',
};

// ------------------------------------------------------------------ pure renderers

describe('pgBackRest repository config', () => {
	test('reaches Postgres over the socket and spools on the data volume', () => {
		const config = renderPgBackRestConfig({ stanza: SOURCE, repo: parsePitrRepo(repo), pg1User: 'main_db' });
		expect(config).toContain('repo1-s3-bucket=yoal-pitr');
		expect(config).toContain('repo1-s3-endpoint=s3.example.test');
		expect(config).not.toContain('repo1-storage-port');
		expect(config).toContain('repo1-path=/yoal/pitr/db_abc123');
		expect(config).toContain('repo1-s3-uri-style=path');
		expect(config).toContain('spool-path=/data/pgbackrest-spool');
		expect(config).toContain('log-level-file=off');
		expect(config).toContain('[db_abc123]\npg1-path=/data/pgdata\npg1-socket-path=/var/run/postgresql\npg1-user=main_db');
		expect(config).not.toContain('pg1-host');
	});

	test('AWS S3 gets its regional host; a custom port becomes repo1-storage-port', () => {
		expect(pitrRepoEndpoint(parsePitrRepo({ ...repo, endpoint: null, region: 'eu-west-2' }))).toEqual({
			host: 's3.eu-west-2.amazonaws.com',
			port: null,
			tls: true,
		});
		const config = renderPgBackRestConfig({
			stanza: SOURCE,
			repo: parsePitrRepo({ ...repo, endpoint: 'https://minio.internal:9443', forcePathStyle: false }),
			pg1User: 'main_db',
		});
		expect(config).toContain('repo1-s3-endpoint=minio.internal');
		expect(config).toContain('repo1-storage-port=9443');
		expect(config).toContain('repo1-s3-uri-style=host');
	});

	test('refuses plain http, embedded credentials, a path in the endpoint and unsafe fields', () => {
		expect(() => parsePitrRepo({ ...repo, endpoint: 'http://s3.example.test' })).toThrow(/https/);
		expect(() => parsePitrRepo({ ...repo, endpoint: 'https://user:pass@s3.example.test' })).toThrow(
			/must not embed credentials/,
		);
		expect(() => parsePitrRepo({ ...repo, endpoint: 'https://s3.example.test/bucket' })).toThrow(/bare origin/);
		expect(() => parsePitrRepo({ ...repo, bucket: 'Bad Bucket' })).toThrow(/bucket/);
		expect(() => parsePitrRepo({ ...repo, pathPrefix: '../escape' })).toThrow(/pathPrefix/);
		expect(() => parsePitrRepo({ ...repo, region: 'us east' })).toThrow(/region/);
		expect(parsePitrRepo({ ...repo, pathPrefix: '' }).pathPrefix).toBe('');
		expect(() => validatePitrStanza('bad stanza')).toThrow();
		expect(() => parsePitrBackupType('snapshot')).toThrow();
		expect(() =>
			renderPgBackRestConfig({ stanza: SOURCE, repo: parsePitrRepo(repo), pg1User: 'x\npg1-path=/etc' }),
		).toThrow(/plain identifier/);
	});

	test('escapes pgpass fields', () => {
		expect(renderPgPass('user', 'pa:ss:word', 'db-abc', '5432')).toBe('db-abc:5432:*:user:pa\\:ss\\:word\n');
		expect(renderPgPass('user', 'pw')).toBe('*:*:*:user:pw\n');
	});

	test('the config directory stays inside the workload runtime dir', () => {
		expect(pitrPaths('/run/yoal-workloads', SOURCE)).toEqual({
			dir: '/run/yoal-workloads/db_abc123/pgbackrest',
			config: '/run/yoal-workloads/db_abc123/pgbackrest/pgbackrest.conf',
			pgpass: '/run/yoal-workloads/db_abc123/pgbackrest/pgpass',
			gcsKey: '/run/yoal-workloads/db_abc123/pgbackrest/gcs-key.json',
		});
	});

	test('Azure and GCS render the provider repository, not an S3 one', () => {
		const azure = parsePitrRepo({
			store: {
				kind: 'azure',
				account: 'devstoreaccount1',
				container: 'yoal-pitr',
				endpoint: 'http://127.0.0.1:10000/devstoreaccount1',
				pathPrefix: 'yoal/pitr',
			},
			storeCredentials: { kind: 'azure', accountKey: 'a'.repeat(32) },
		});
		const azureConfig = renderPgBackRestConfig({ stanza: SOURCE, repo: azure, pg1User: 'main_db' });
		expect(azureConfig).toContain('repo1-type=azure');
		expect(azureConfig).toContain('repo1-azure-account=devstoreaccount1');
		expect(azureConfig).toContain('repo1-azure-container=yoal-pitr');
		expect(azureConfig).toContain('repo1-azure-key-type=shared');
		expect(azureConfig).toContain('repo1-azure-endpoint=127.0.0.1');
		expect(azureConfig).toContain('repo1-storage-port=10000');
		expect(azureConfig).toContain('repo1-azure-uri-style=path');
		expect(azureConfig).toContain('repo1-storage-verify-tls=n');
		expect(azureConfig).not.toContain('repo1-s3-bucket');

		const serviceAccount = JSON.stringify({ client_email: 'backups@example.test', private_key: 'not-a-real-key' });
		const gcs = parsePitrRepo({
			store: { kind: 'gcs', bucket: 'yoal-pitr', endpoint: 'http://127.0.0.1:4443', pathPrefix: 'yoal/pitr' },
			storeCredentials: { kind: 'gcs', serviceAccountJson: serviceAccount },
		});
		const gcsConfig = renderPgBackRestConfig({ stanza: SOURCE, repo: gcs, pg1User: 'main_db' });
		expect(gcsConfig).toContain('repo1-type=gcs');
		expect(gcsConfig).toContain('repo1-gcs-bucket=yoal-pitr');
		expect(gcsConfig).toContain('repo1-gcs-key-type=service');
		expect(gcsConfig).toContain('repo1-gcs-key=/etc/pgbackrest/gcs-key.json');
		expect(gcsConfig).toContain('repo1-gcs-endpoint=127.0.0.1');
		expect(gcsConfig).toContain('repo1-storage-verify-tls=n');
		expect(renderPgBackRestKey(gcs)).toBe(serviceAccount);
		expect(renderPgBackRestKey(azure)).toBeNull();
		// A service-account key is a file, not an INI value: pretty-printed JSON is accepted.
		const pretty = JSON.stringify({ client_email: 'backups@example.test', private_key: 'not-a-real-key' }, null, 2);
		const parsedPretty = parsePitrRepo({
			store: { kind: 'gcs', bucket: 'yoal-pitr', endpoint: null, pathPrefix: '' },
			storeCredentials: { kind: 'gcs', serviceAccountJson: pretty },
		});
		expect(renderPgBackRestKey(parsedPretty)).toBe(pretty);
	});

	test('refuses a store without its credentials or with a mismatched kind', () => {
		expect(() =>
			parsePitrRepo({
				store: { kind: 'gcs', bucket: 'yoal-pitr', endpoint: null, pathPrefix: '' },
				storeCredentials: { kind: 'azure', accountKey: 'a'.repeat(32) },
			}),
		).toThrow(/another kind/);
		expect(() =>
			parsePitrRepo({
				store: { kind: 'azure', account: 'Bad', container: 'yoal-pitr', endpoint: null, pathPrefix: '' },
				storeCredentials: { kind: 'azure', accountKey: 'a'.repeat(32) },
			}),
		).toThrow(/account/);
		expect(() =>
			parsePitrRepo({
				store: { kind: 'gcs', bucket: 'yoal-pitr', endpoint: null, pathPrefix: '' },
				storeCredentials: { kind: 'gcs', serviceAccountJson: '{"client_email":"x"}' },
			}),
		).toThrow(/private_key/);
	});
});

describe('restore target', () => {
	const now = Date.parse('2026-11-05T12:00:00Z');

	test('accepts a past timestamp inside the retention window', () => {
		expect(validatePitrTargetTime(now - 60_000, now, 35)).toBe(now - 60_000);
	});

	test('rejects a future or expired timestamp', () => {
		expect(() => validatePitrTargetTime(now + 1, now, 35)).toThrow(/future/);
		expect(() => validatePitrTargetTime(now - 36 * 86_400_000, now, 35)).toThrow(/retention/);
	});

	test('formats the target the way pgBackRest parses it, never ISO T…Z', () => {
		expect(formatPitrTarget(Date.parse('2026-11-05T09:30:00.123Z'))).toBe('2026-11-05 09:30:00.123+00');
	});
});

describe('fixed pgBackRest argv', () => {
	test('backups and status run inside the database container', () => {
		const [create, backup] = renderPitrBackupArgs(SOURCE, 'diff');
		expect(create).toEqual(['--stanza=db_abc123', 'stanza-create']);
		expect(backup).toEqual(['--stanza=db_abc123', '--type=diff', 'backup']);
		expect(renderPitrExecArgs({ podmanPath: '/usr/bin/podman', workloadId: SOURCE, args: backup! })).toEqual([
			'/usr/bin/podman',
			'exec',
			'--env',
			'PGPASSFILE=/etc/pgbackrest/pgpass',
			'yoal-workload-db_abc123',
			'pgbackrest',
			'--config=/etc/pgbackrest/pgbackrest.conf',
			'--stanza=db_abc123',
			'--type=diff',
			'backup',
		]);
	});

	const oneShot = {
		podmanPath: '/usr/bin/podman',
		image: 'ghcr.io/kieranholroyd/yoal-postgres-pitr:18-1',
		targetId: TARGET,
		targetDataDir: `/var/lib/yoal-workloads/${TARGET}`,
		configDir: `/run/yoal-workloads/${SOURCE}/pgbackrest`,
	};

	test('a restore is a one-shot of the PITR image with the shared config dir', () => {
		const args = renderPitrRestoreArgs({ ...oneShot, stanza: SOURCE, targetTime: Date.parse('2026-11-05T09:30:00Z') });
		expect(args.slice(0, 5)).toEqual(['/usr/bin/podman', 'run', '--rm', '--name', `yoal-pitr-restore-${TARGET}`]);
		expect(args).toContain(`/var/lib/yoal-workloads/${TARGET}:/data:Z`);
		// The source's own container mounts the same directory: a shared label, never private.
		expect(args).toContain(`/run/yoal-workloads/${SOURCE}/pgbackrest:/etc/pgbackrest:ro,z`);
		expect(args).toContain('--read-only');
		expect(args.slice(-6)).toEqual([
			'--stanza=db_abc123',
			'--pg1-path=/data/pgdata',
			'--type=time',
			'--target=2026-11-05 09:30:00.000+00',
			'--target-action=promote',
			'restore',
		]);
	});

	test('recovery runs Postgres without TCP or archiving', () => {
		const args = renderPitrRecoveryArgs(oneShot);
		expect(args.slice(0, 6)).toEqual(['/usr/bin/podman', 'run', '--detach', '--init', '--name', `yoal-pitr-recover-${TARGET}`]);
		expect(args.slice(-5)).toEqual(['postgres', '-c', 'listen_addresses=', '-c', 'archive_mode=off']);
		expect(args).toContain('/var/run/postgresql:rw,size=8m,mode=1777');
	});
});

describe('handing the restored cluster to the new database', () => {
	const input = {
		sourceUser: 'orders',
		sourceDatabase: 'orders',
		targetUser: 'orders_pitr',
		targetDatabase: 'orders_pitr',
		targetPassword: PASSWORD,
	};

	test('renames the owner and database through a temporary superuser, then drops it', () => {
		const steps = renderPitrRenameSql(input);
		expect(steps.map((step) => step.user)).toEqual(['orders', PITR_RESTORE_ROLE, 'orders_pitr']);
		expect(steps[0]!.sql).toBe(`CREATE ROLE "${PITR_RESTORE_ROLE}" WITH LOGIN SUPERUSER;\n`);
		expect(steps[1]!.sql).toContain('ALTER ROLE "orders" RENAME TO "orders_pitr";');
		expect(steps[1]!.sql).toContain(`ALTER ROLE "orders_pitr" WITH PASSWORD '${PASSWORD}';`);
		expect(steps[1]!.sql).toContain('ALTER DATABASE "orders" RENAME TO "orders_pitr";');
		expect(steps[1]!.sql).toContain('ALTER SYSTEM RESET restore_command;');
		expect(steps[2]!.sql).toBe(`DROP ROLE "${PITR_RESTORE_ROLE}";\n`);
	});

	test('refuses anything that could break out of a quoted identifier or literal', () => {
		expect(() => renderPitrRenameSql({ ...input, targetUser: 'x"; DROP ROLE y; --' })).toThrow(/identifier/);
		expect(() => renderPitrRenameSql({ ...input, targetPassword: "short'" })).toThrow(/password/);
		expect(() => renderPitrRenameSql({ ...input, targetUser: PITR_RESTORE_ROLE })).toThrow(/reserved/);
	});
});

describe('recoverable window', () => {
	const info = JSON.stringify([
		{
			name: SOURCE,
			status: { code: 0, message: 'ok' },
			backup: [
				{ type: 'diff', timestamp: { start: 1_762_400_000, stop: 1_762_400_300 } },
				{ type: 'full', timestamp: { start: 1_762_000_000, stop: 1_762_000_600 } },
			],
		},
		{ name: 'other', status: { code: 0 }, backup: [{ type: 'full', timestamp: { stop: 1 } }] },
	]);

	test('reads the oldest and newest retained backups of this stanza only', () => {
		expect(parsePgBackRestInfo(info, SOURCE)).toEqual({
			statusCode: 0,
			statusMessage: 'ok',
			backupCount: 2,
			oldestBackupStopAt: 1_762_000_600_000,
			newestBackupStopAt: 1_762_400_300_000,
			newestBackupType: 'diff',
		});
		expect(parsePgBackRestInfo('not json', SOURCE).backupCount).toBe(0);
		expect(parsePgBackRestInfo(info, 'missing').statusCode).toBeNull();
	});

	test('parses pg_stat_archiver output', () => {
		expect(parseArchiverStats('1762400400000|0\n')).toEqual({ lastArchivedAt: 1_762_400_400_000, lastFailedAt: null });
		expect(parseArchiverStats('garbage')).toBeNull();
	});

	test('opens at the oldest backup and closes at the last archived WAL', () => {
		const summary = parsePgBackRestInfo(info, SOURCE);
		expect(computePitrWindow(summary, { lastArchivedAt: 1_762_400_400_000, lastFailedAt: null })).toEqual({
			recoverableFrom: 1_762_000_600_000,
			recoverableTo: 1_762_400_400_000,
			archiveStatus: 'ok',
		});
		// A failure newer than the last success is `failing`; the window still ends at the success.
		expect(
			computePitrWindow(summary, { lastArchivedAt: 1_762_400_400_000, lastFailedAt: 1_762_400_500_000 }),
		).toMatchObject({ recoverableTo: 1_762_400_400_000, archiveStatus: 'failing' });
		// No archiver read: the newest backup's stop is still covered.
		expect(computePitrWindow(summary, null)).toMatchObject({ recoverableTo: 1_762_400_300_000, archiveStatus: 'unknown' });
		expect(computePitrWindow(parsePgBackRestInfo('[]', SOURCE), null)).toEqual({
			recoverableFrom: null,
			recoverableTo: null,
			archiveStatus: 'unknown',
		});
	});
});

// ------------------------------------------------------------------ image and unit

function databaseWorkload(database: Record<string, unknown>, image: string, id = SOURCE) {
	return parseWorkload({
		id,
		projectId: id,
		projectSlug: 'main-db',
		deploymentId: id,
		runtime: 'container',
		status: 'running',
		release: null,
		image,
		upstream: '127.0.0.1:15432',
		memoryMb: 256,
		cpus: 1,
		port: 15432,
		healthPath: '/',
		socketActivation: false,
		activationVersion: SHA,
		env: {},
		secrets: [],
		dataSizeMb: null,
		database,
	});
}

describe('PITR image', () => {
	const pitr = { stanza: SOURCE, archiveTimeoutSeconds: 60 };

	test('a PITR database must run the Yoal-built pgBackRest image', () => {
		expect(postgresPitrImage('18')).toBe('ghcr.io/kieranholroyd/yoal-postgres-pitr:18-1');
		expect(
			databaseWorkload({ engine: 'postgres', version: '18', pitr }, postgresPitrImage('18')).database?.pitr,
		).toEqual(pitr);
		expect(() =>
			databaseWorkload({ engine: 'postgres', version: '18', pitr }, 'docker.io/pgvector/pgvector:0.8.7-pg18-trixie'),
		).toThrow(/yoal-postgres-pitr/);
	});

	test('16/17 and the D126 variants have no PITR build', () => {
		expect(() => postgresPitrImage('17')).toThrow(/no pgBackRest image/);
		expect(() =>
			databaseWorkload({ engine: 'postgres', version: '17', pitr }, 'docker.io/library/postgres:17-alpine'),
		).toThrow(/only supported for standard postgres 18/);
		expect(() =>
			databaseWorkload(
				{ engine: 'postgres', version: '18', variant: 'postgis', pitr },
				'ghcr.io/kieranholroyd/yoal-postgres:18-postgis-1',
			),
		).toThrow(/only supported for standard postgres 18/);
	});
});

describe('archive settings in the Postgres unit', () => {
	test('renders WAL archiving, the shared config dir mount and the escaped WAL placeholder', () => {
		const unit = renderDatabaseUnit({
			workload: databaseWorkload(
				{ engine: 'postgres', version: '18', pitr: { stanza: SOURCE, archiveTimeoutSeconds: 60 } },
				postgresPitrImage('18'),
			),
			envFile: `/run/yoal-workloads/${SOURCE}/env`,
			dataDir: `/var/lib/yoal-workloads/${SOURCE}`,
			pitr: { stanza: SOURCE, configDir: `/run/yoal-workloads/${SOURCE}/pgbackrest`, archiveTimeoutSeconds: 60 },
		});
		expect(unit).toContain('Image=ghcr.io/kieranholroyd/yoal-postgres-pitr:18-1');
		expect(unit).toContain('archive_mode=on');
		expect(unit).toContain('wal_level=replica');
		expect(unit).toContain('archive_timeout=60');
		// systemd would expand %p, so the unit must escape it for Postgres/the archive command.
		expect(unit).toContain('archive-push %%p');
		expect(unit).toContain(`Volume=/run/yoal-workloads/${SOURCE}/pgbackrest:/etc/pgbackrest:ro,z`);
		expect(unit).not.toContain('pgbackrest.conf:ro');
		// Postgres must not be PID 1: it would treat pgBackRest's orphaned async archiver as a crash.
		expect(unit).toContain('RunInit=true');
	});

	test('a replica of a PITR database archives once promoted, and renders hint logging', () => {
		const replicaId = 'db_dbr_fedcba9876543210fedcba9876543210';
		const unit = renderDatabaseUnit({
			workload: databaseWorkload(
				{
					engine: 'postgres',
					version: '18',
					pitr: { stanza: SOURCE, archiveTimeoutSeconds: 60 },
					replica: { slot: `yoal_${replicaId}` },
					pgRewind: true,
				},
				postgresPitrImage('18'),
				replicaId,
			),
			envFile: `/run/yoal-workloads/${replicaId}/env`,
			dataDir: `/var/lib/yoal-workloads/${replicaId}`,
			pitr: { stanza: SOURCE, configDir: `/run/yoal-workloads/${replicaId}/pgbackrest`, archiveTimeoutSeconds: 60 },
			replica: {
				linkDir: `/var/lib/yoal/agent/replication/${replicaId}`,
				scriptPath: `/run/yoal-workloads/${replicaId}/replica-start.sh`,
			},
		});
		expect(unit).toContain(`ContainerName=yoal-workload-${replicaId}`);
		expect(unit).toContain('Image=ghcr.io/kieranholroyd/yoal-postgres-pitr:18-1');
		expect(unit).toContain('archive_mode=on');
		expect(unit).toContain('wal_log_hints=on');
		expect(unit).toContain('primary_slot_name=');
		expect(unit).toContain(`Volume=/run/yoal-workloads/${replicaId}/pgbackrest:/etc/pgbackrest:ro,z`);
		expect(unit).toContain('/run/yoal-upstream:ro,z');
	});

	test('leaves a non-PITR database unchanged', () => {
		const unit = renderDatabaseUnit({
			workload: databaseWorkload({ engine: 'postgres', version: '17' }, 'docker.io/library/postgres:17-alpine'),
			envFile: `/run/yoal-workloads/${SOURCE}/env`,
			dataDir: `/var/lib/yoal-workloads/${SOURCE}`,
		});
		expect(unit).not.toContain('archive_mode');
		expect(unit).not.toContain('pgbackrest');
		expect(unit).not.toContain('RunInit');
	});
});

// ------------------------------------------------------------------ driver verbs

type Responder = (argv: string[], options?: CommandRunOptions) => RunResult | undefined | Promise<RunResult | undefined>;

class ScriptedRunner implements CommandRunner {
	calls: Array<{ argv: string[]; options?: CommandRunOptions }> = [];
	constructor(private readonly respond: Responder = () => undefined) {}
	async run(argv: string[], options?: CommandRunOptions): Promise<RunResult> {
		this.calls.push({ argv, ...(options ? { options } : {}) });
		return (await this.respond(argv, options)) ?? { code: 0, stdout: '', stderr: '' };
	}
	podman(): string[][] {
		return this.calls.map((call) => call.argv).filter((argv) => argv[0] === '/usr/bin/podman');
	}
}

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(respond?: Responder) {
	const root = await fs.mkdtemp(join(tmpdir(), 'yoal-pitr-helper-'));
	roots.push(root);
	const runtimeDir = join(root, 'run');
	const stateDir = join(root, 'state');
	for (const [id, user] of [
		[SOURCE, 'main_db'],
		[TARGET, 'main_db_pitr'],
	] as const) {
		await fs.mkdir(join(runtimeDir, id), { recursive: true });
		await fs.mkdir(join(stateDir, id, 'pgdata'), { recursive: true });
		await fs.writeFile(
			join(runtimeDir, id, 'env'),
			`POSTGRES_USER=${user}\nPOSTGRES_PASSWORD=${id === TARGET ? PASSWORD : 'source-password-0123456789'}\nPOSTGRES_DB=${user}\nPGDATA=/data/pgdata\n`,
			{ mode: 0o400 },
		);
	}
	await fs.writeFile(join(stateDir, SOURCE, 'pgdata', 'PG_VERSION'), '18\n');
	await fs.writeFile(join(stateDir, TARGET, 'pgdata', 'stale'), 'old cluster');
	const runner = new ScriptedRunner(respond);
	const chowns: Array<[string, number, number]> = [];
	const driver = new SystemdDriver({
		runner,
		chown: async (path, uid, gid) => {
			chowns.push([path, uid, gid]);
		},
		unitDir: join(root, 'units'),
		quadletDir: join(root, 'quadlet'),
		runtimeDir,
		stateDir,
		replicationDir: join(root, 'replication'),
		volumeRegistryFile: join(root, 'volumes.json'),
		releaseDirs: [join(root, 'releases')],
		bunPath: '/usr/local/bin/bun',
		podmanPath: '/usr/bin/podman',
		restorePollMs: 0,
	});
	return { root, runtimeDir, stateDir, runner, driver, chowns };
}

describe('helper PITR verbs', () => {
	test('configure writes 0400 files owned by uid 70 into the mounted directory and restarts nothing', async () => {
		const { runtimeDir, driver, runner, chowns } = await fixture();
		const configured = await driver.pitrConfigure(SOURCE, repo, SOURCE);
		const paths = pitrPaths(runtimeDir, SOURCE);
		expect(configured).toEqual({ stanza: SOURCE, configPath: paths.config });
		expect((await fs.stat(paths.dir)).mode & 0o777).toBe(0o700);
		expect((await fs.stat(paths.config)).mode & 0o777).toBe(0o400);
		expect((await fs.stat(paths.pgpass)).mode & 0o777).toBe(0o400);
		expect(await fs.readFile(paths.config, 'utf8')).toContain('pg1-user=main_db');
		expect(await fs.readFile(paths.pgpass, 'utf8')).toBe('*:*:*:main_db:source-password-0123456789\n');
		for (const path of [paths.dir, paths.config, paths.pgpass]) expect(chowns).toContainEqual([path, 70, 70]);
		expect(runner.calls).toHaveLength(0);
		// Idempotent: the agent calls it before every task.
		await driver.pitrConfigure(SOURCE, repo, SOURCE);
		expect(runner.calls).toHaveLength(0);
	});

	test('configure writes a GCS key file 0400 and removes it when the repository kind changes', async () => {
		const { driver, runtimeDir } = await fixture();
		const key = JSON.stringify({ client_email: 'backups@example.test', private_key: 'not-a-real-key' }, null, 2);
		const gcsRepo = {
			store: { kind: 'gcs' as const, bucket: 'yoal-pitr', endpoint: 'http://127.0.0.1:4443', pathPrefix: 'yoal/pitr' },
			storeCredentials: { kind: 'gcs' as const, serviceAccountJson: key },
		};
		await driver.pitrConfigure(SOURCE, gcsRepo, SOURCE);
		const paths = pitrPaths(runtimeDir, SOURCE);
		expect((await fs.stat(paths.gcsKey)).mode & 0o777).toBe(0o400);
		expect(await fs.readFile(paths.gcsKey, 'utf8')).toBe(key);
		expect(await fs.readFile(paths.config, 'utf8')).toContain('repo1-gcs-key=/etc/pgbackrest/gcs-key.json');
		await driver.pitrConfigure(SOURCE, repo, SOURCE);
		await expect(fs.stat(paths.gcsKey)).rejects.toThrow();
	});

	test('apply creates the config directory before the unit that mounts it', async () => {
		const { root, runtimeDir, driver, chowns } = await fixture();
		const workload = databaseWorkload(
			{ engine: 'postgres', version: '18', pitr: { stanza: SOURCE, archiveTimeoutSeconds: 60 } },
			postgresPitrImage('18'),
		);
		await driver.apply(workload, { workloadId: SOURCE, activationVersion: SHA, env: { POSTGRES_PASSWORD: 'pw' }, files: {} });
		const { dir } = pitrPaths(runtimeDir, SOURCE);
		expect((await fs.stat(dir)).isDirectory()).toBe(true);
		expect(chowns).toContainEqual([dir, 70, 70]);
		const quadlet = await fs.readFile(join(root, 'quadlet', `yoal-workload-${SOURCE}.container`), 'utf8');
		expect(quadlet).toContain(`Volume=${dir}:/etc/pgbackrest:ro,z`);
		expect(quadlet).toContain(`Image=${postgresPitrImage('18')}`);
	});

	test('a base backup is stanza-create then backup, via podman exec', async () => {
		const { driver, runner } = await fixture();
		await expect(driver.pitrBaseBackup(SOURCE, 'full', SOURCE)).rejects.toThrow(/configure PITR first/);
		await driver.pitrConfigure(SOURCE, repo, SOURCE);
		expect(await driver.pitrBaseBackup(SOURCE, 'diff', SOURCE)).toEqual({ stanza: SOURCE, type: 'diff' });
		const exec = runner.podman();
		expect(exec).toHaveLength(2);
		expect(exec[0]!.slice(0, 2)).toEqual(['/usr/bin/podman', 'exec']);
		expect(exec[0]!.at(-1)).toBe('stanza-create');
		expect(exec[1]!.slice(-2)).toEqual(['--type=diff', 'backup']);
	});

	test('a backup inside a replica uses the database stanza carried on the verb, not the replica id', async () => {
		const { runtimeDir, driver, runner } = await fixture();
		const replica = 'db_dbr_abc123';
		await fs.mkdir(join(runtimeDir, replica), { recursive: true });
		await fs.writeFile(
			join(runtimeDir, replica, 'env'),
			'POSTGRES_USER=main_db\nPOSTGRES_PASSWORD=replica-password-0123456789\nPOSTGRES_DB=main_db\nPGDATA=/data/pgdata\n',
			{ mode: 0o400 },
		);
		await driver.pitrConfigure(replica, repo, SOURCE);
		const config = await fs.readFile(pitrPaths(runtimeDir, replica).config, 'utf8');
		// The exact stanza in the rendered config, and never one derived from the replica workload id.
		expect(config).toContain(`\n[${SOURCE}]\n`);
		expect(config).not.toContain(`[${replica}]`);

		expect(await driver.pitrBaseBackup(replica, 'full', SOURCE)).toEqual({ stanza: SOURCE, type: 'full' });
		const argv = runner.podman();
		expect(argv).toHaveLength(2);
		for (const call of argv) expect(call).toContain(`--stanza=${SOURCE}`);
		expect(argv.join(' ')).not.toContain(`--stanza=${replica}`);
		// A status read uses the config's stanza too, so it reports the database's stanza.
		expect((await driver.pitrStatus(replica)).stanza).toBe(SOURCE);
	});

	test('a backup refuses a stanza the node config was not written for', async () => {
		const { driver, runner } = await fixture();
		await driver.pitrConfigure(SOURCE, repo, SOURCE);
		await expect(driver.pitrBaseBackup(SOURCE, 'full', 'db_other')).rejects.toThrow(/configured for stanza/);
		expect(runner.podman()).toHaveLength(0);
	});

	test('a failed backup reports pgBackRest stderr', async () => {
		const { driver } = await fixture((argv) =>
			argv.at(-1) === 'backup' ? { code: 82, stdout: '', stderr: 'ERROR: [082]: WAL segment was not archived' } : undefined,
		);
		await driver.pitrConfigure(SOURCE, repo, SOURCE);
		await expect(driver.pitrBaseBackup(SOURCE, 'full', SOURCE)).rejects.toThrow(/backup failed \(82\).*not archived/);
	});

	test('status reports the recoverable window without credentials', async () => {
		const info = JSON.stringify([
			{
				name: SOURCE,
				status: { code: 0, message: 'ok' },
				backup: [{ type: 'full', timestamp: { start: 1_762_000_000, stop: 1_762_000_600 } }],
			},
		]);
		const { driver, runner } = await fixture((argv) => {
			if (argv.at(-1) === 'info') return { code: 0, stdout: info, stderr: '' };
			if (argv.includes('psql')) return { code: 0, stdout: '1762400400000|0\n', stderr: '' };
			return undefined;
		});
		expect((await driver.pitrStatus(SOURCE)).configured).toBe(false);
		await driver.pitrConfigure(SOURCE, repo, SOURCE);
		const status = await driver.pitrStatus(SOURCE);
		expect(status).toEqual({
			configured: true,
			stanza: SOURCE,
			repo: { bucket: 'yoal-pitr', region: 'us-east-1', endpoint: 's3.example.test', path: '/yoal/pitr/db_abc123' },
			archiveStatus: 'ok',
			recoverableFrom: 1_762_000_600_000,
			recoverableTo: 1_762_400_400_000,
			backupCount: 1,
			newestBackupAt: 1_762_000_600_000,
			newestBackupType: 'full',
			lastArchivedAt: 1_762_400_400_000,
			lastFailedAt: null,
			repoMessage: null,
		});
		expect(JSON.stringify(status)).not.toContain('secret-key-value');
		const psql = runner.podman().find((argv) => argv.includes('psql'))!;
		expect(psql).toContain('yoal-workload-db_abc123');
		expect(psql.slice(psql.indexOf('-U'), psql.indexOf('-U') + 4)).toEqual(['-U', 'main_db', '-d', 'main_db']);
	});

	test('status without a config never derives a stanza from the workload id', async () => {
		const { driver } = await fixture();
		expect(await driver.pitrStatus('db_dbr_abc123')).toMatchObject({ configured: false, stanza: '' });
	});

	test('rejects an in-place or future restore target before touching the data dir', async () => {
		const { driver, runner, stateDir } = await fixture();
		await driver.pitrConfigure(SOURCE, repo, SOURCE);
		await expect(
			driver.pitrRestore(SOURCE, { targetDatabaseId: SOURCE, targetTime: Date.now() - 60_000 }),
		).rejects.toThrow(/different database/);
		await expect(
			driver.pitrRestore(SOURCE, { targetDatabaseId: TARGET, targetTime: Date.now() + 60_000 }),
		).rejects.toThrow(/future/);
		expect(runner.calls).toHaveLength(0);
		expect(await fs.readFile(join(stateDir, TARGET, 'pgdata', 'stale'), 'utf8')).toBe('old cluster');
	});

	test('restores into the target, promotes, hands it over and proves a password login', async () => {
		let driverRef: SystemdDriver | null = null;
		let applyDuringRestore: unknown = null;
		const { driver, runner, stateDir } = await fixture(async (argv) => {
			if (argv[1] === 'run' && argv.at(-1) === 'restore') {
				// The agent's reconcile must not restart the target while its data dir is replaced.
				applyDuringRestore = await driverRef!
					.apply(
						databaseWorkload({ engine: 'postgres', version: '18' }, 'docker.io/pgvector/pgvector:0.8.7-pg18-trixie', TARGET),
						{ workloadId: TARGET, activationVersion: SHA, env: {}, files: {} },
					)
					.catch((error: Error) => error.message);
				return undefined;
			}
			if (argv.includes('SELECT pg_is_in_recovery()')) return { code: 0, stdout: 'f\n', stderr: '' };
			if (argv.includes('SELECT 1')) return { code: 0, stdout: '1\n', stderr: '' };
			return undefined;
		});
		driverRef = driver;
		await driver.pitrConfigure(SOURCE, repo, SOURCE);
		const targetTime = Date.now() - 60_000;
		expect(await driver.pitrRestore(SOURCE, { targetDatabaseId: TARGET, targetTime })).toEqual({
			targetDatabaseId: TARGET,
			targetTime,
			verified: true,
		});
		expect(String(applyDuringRestore)).toMatch(/restore into db_target456 is in progress/);

		const argvs = runner.calls.map((call) => call.argv);
		const index = (predicate: (argv: string[]) => boolean) => argvs.findIndex(predicate);
		const stop = index((argv) => argv[1] === 'stop' && argv[2] === `yoal-workload-${TARGET}.service`);
		const restore = index((argv) => argv[1] === 'run' && argv.at(-1) === 'restore');
		const recover = index((argv) => argv[1] === 'run' && argv.includes('--detach'));
		const stopRecovery = index((argv) => argv[1] === 'stop' && argv.includes(`yoal-pitr-recover-${TARGET}`));
		const start = index((argv) => argv[1] === 'start' && argv[2] === `yoal-workload-${TARGET}.service`);
		expect(stop).toBeGreaterThanOrEqual(0);
		expect(stop).toBeLessThan(restore);
		expect(restore).toBeLessThan(recover);
		expect(recover).toBeLessThan(stopRecovery);
		expect(stopRecovery).toBeLessThan(start);
		// The one-shots run the source's PITR image, chosen from its PG_VERSION.
		expect(argvs[restore]).toContain('ghcr.io/kieranholroyd/yoal-postgres-pitr:18-1');
		expect(argvs[restore]).toContain('--target=' + formatPitrTarget(targetTime));

		// Rename steps go over stdin; the password never reaches argv.
		const sqlCalls = runner.calls.filter((call) => call.options?.stdin !== undefined);
		expect(sqlCalls.map((call) => call.argv[call.argv.indexOf('-U') + 1])).toEqual([
			'main_db',
			PITR_RESTORE_ROLE,
			'main_db_pitr',
		]);
		expect(sqlCalls[1]!.options!.stdin).toContain('ALTER DATABASE "main_db" RENAME TO "main_db_pitr";');
		expect(argvs.some((argv) => argv.join(' ').includes(PASSWORD))).toBe(false);
		const canary = runner.calls.find((call) => call.argv.includes('SELECT 1'))!;
		expect(canary.options?.env).toEqual({ PGPASSWORD: PASSWORD });

		// The stale cluster is gone; PGDATA and the spool exist for pgBackRest.
		expect((await fs.readdir(join(stateDir, TARGET))).sort()).toEqual(['pgbackrest-spool', 'pgdata']);
		expect(await fs.readdir(join(stateDir, TARGET, 'pgdata'))).toEqual([]);
		// One-shots are removed before the target starts again.
		expect(argvs.slice(start - 2, start)).toEqual([
			['/usr/bin/podman', 'rm', '--force', '--ignore', `yoal-pitr-restore-${TARGET}`],
			['/usr/bin/podman', 'rm', '--force', '--ignore', `yoal-pitr-recover-${TARGET}`],
		]);
	});

	test('recovery that stops early fails with its log and releases the target', async () => {
		const { driver, runner } = await fixture((argv) => {
			if (argv.includes('SELECT pg_is_in_recovery()')) return { code: 2, stdout: '', stderr: 'no such container' };
			if (argv[1] === 'inspect') return { code: 0, stdout: 'false\n', stderr: '' };
			if (argv[1] === 'logs')
				return { code: 0, stdout: '', stderr: 'FATAL:  recovery ended before configured recovery target was reached' };
			return undefined;
		});
		await driver.pitrConfigure(SOURCE, repo, SOURCE);
		await expect(
			driver.pitrRestore(SOURCE, { targetDatabaseId: TARGET, targetTime: Date.now() - 60_000 }),
		).rejects.toThrow(/Recovery stopped before reaching the target time: FATAL:  recovery ended/);
		const argvs = runner.calls.map((call) => call.argv);
		expect(argvs.some((argv) => argv[1] === 'start')).toBe(false);
		expect(argvs.slice(-2)).toEqual([
			['/usr/bin/podman', 'rm', '--force', '--ignore', `yoal-pitr-restore-${TARGET}`],
			['/usr/bin/podman', 'rm', '--force', '--ignore', `yoal-pitr-recover-${TARGET}`],
		]);
	});

	test('a source without a readable PG_VERSION is refused before anything is stopped', async () => {
		const { driver, runner, stateDir } = await fixture();
		await fs.rm(join(stateDir, SOURCE, 'pgdata', 'PG_VERSION'));
		await driver.pitrConfigure(SOURCE, repo, SOURCE);
		await expect(
			driver.pitrRestore(SOURCE, { targetDatabaseId: TARGET, targetTime: Date.now() - 60_000 }),
		).rejects.toThrow(/PG_VERSION/);
		expect(runner.calls).toHaveLength(0);
	});
});

describe('pg_rewind (HA-PLAN W10)', () => {
	const REPLICA = 'db_dbr_abc123';
	const PASSWORD = 'replication-password-0123456789';

	const controldata = (checksums: boolean): { code: number; stdout: string; stderr: string } => ({
		code: 0,
		stdout: `pg_control version number: 1300\nData page checksum version: ${checksums ? 1 : 0}\n`,
		stderr: '',
	});

	test('parses data checksums and renders the fixed pg_rewind argv', () => {
		expect(parseDataChecksums('Data page checksum version: 1\n')).toBe(true);
		expect(parseDataChecksums('Data page checksum version: 0\n')).toBe(false);
		expect(parseDataChecksums('garbage')).toBe(false);
		const args = renderPgRewindArgs({
			podmanPath: '/usr/bin/podman',
			image: postgresPitrImage('18'),
			replicaId: REPLICA,
			targetRoot: '/state/db_abc123',
			linkDir: '/var/lib/yoal/agent/replication/db_dbr_abc123',
			user: 'main_db',
		});
		expect(args).toContain('pg_rewind');
		expect(args).toContain('--target-pgdata=/data/pgdata');
		expect(args).toContain('--source-server=host=/run/yoal-upstream port=5432 user=main_db dbname=postgres connect_timeout=10');
		expect(args).toContain('--write-recovery-conf');
		expect(args).toContain('/var/lib/yoal/agent/replication/db_dbr_abc123:/run/yoal-upstream:ro,z');
		expect(args).not.toContain(PASSWORD);
		expect(args).not.toContain('pg_basebackup');
		expect(
			renderPgControldataArgs({
				podmanPath: '/usr/bin/podman',
				image: postgresPitrImage('18'),
				replicaId: REPLICA,
				targetRoot: '/state/db_abc123',
			}),
		).toContain('pg_controldata');
	});

	test('a successful rewind adopts the old data dir under the replica id', async () => {
		const { driver, runner, stateDir, root } = await fixture((argv) => {
			if (argv.includes('pg_controldata')) return controldata(true);
			return undefined;
		});
		await fs.mkdir(join(root, 'replication', REPLICA), { recursive: true });
		const result = await driver.rewindReplica(REPLICA, { databaseId: SOURCE, user: 'main_db', password: PASSWORD });
		expect(result).toEqual({ replicaId: REPLICA, rewound: true, fallback: null, reason: null });
		expect(await fs.lstat(join(stateDir, SOURCE)).catch(() => null)).toBeNull();
		expect(await fs.readFile(join(stateDir, REPLICA, 'pgdata', 'PG_VERSION'), 'utf8')).toBe('18\n');
		// Only a real rewind writes the adoption marker; `PG_VERSION` alone is not proof.
		const marker = JSON.parse(await fs.readFile(join(stateDir, REPLICA, 'yoal-rewind.json'), 'utf8')) as Record<string, unknown>;
		expect(marker).toMatchObject({ databaseId: SOURCE, replicaId: REPLICA });
		expect(typeof marker.rewoundAt).toBe('string');
		const rewind = runner.podman().find((argv) => argv.includes('pg_rewind'));
		expect(rewind).toBeDefined();
		expect(runner.calls.find((call) => call.argv.includes('pg_rewind'))?.options?.env).toEqual({ PGPASSWORD: PASSWORD });
		// Idempotent: a re-run sees the adopted directory and reports success again.
		expect(await driver.rewindReplica(REPLICA, { databaseId: SOURCE, user: 'main_db', password: PASSWORD })).toMatchObject({
			rewound: true,
		});
	});

	test('no checksums and no wal_log_hints falls back to a rebuild without running pg_rewind', async () => {
		const { driver, runner, stateDir } = await fixture((argv) => {
			if (argv.includes('pg_controldata')) return controldata(false);
			return undefined;
		});
		const result = await driver.rewindReplica(REPLICA, { databaseId: SOURCE, user: 'main_db', password: PASSWORD });
		expect(result).toMatchObject({ rewound: false, fallback: 'rebuild' });
		expect(result.reason).toMatch(/neither data checksums nor wal_log_hints/);
		expect(runner.podman().some((argv) => argv.includes('pg_rewind'))).toBe(false);
		expect(await fs.lstat(join(stateDir, SOURCE)).catch(() => null)).toBeNull();
	});

	test('wal_log_hints=on is enough for an old cluster without checksums', async () => {
		const { driver, stateDir } = await fixture((argv) => {
			if (argv.includes('pg_controldata')) return controldata(false);
			return undefined;
		});
		await fs.writeFile(join(stateDir, SOURCE, 'pgdata', 'postgresql.auto.conf'), "wal_log_hints = 'on'\n");
		expect(await driver.rewindReplica(REPLICA, { databaseId: SOURCE, user: 'main_db', password: PASSWORD })).toMatchObject({
			rewound: true,
		});
	});

	test('a failed pg_rewind deletes the old dir and reports the rebuild fallback', async () => {
		const { driver, runner, stateDir } = await fixture((argv) => {
			if (argv.includes('pg_controldata')) return controldata(true);
			if (argv.includes('pg_rewind'))
				return { code: 1, stdout: '', stderr: 'FATAL: source and target clusters are from different systems' };
			return undefined;
		});
		const result = await driver.rewindReplica(REPLICA, { databaseId: SOURCE, user: 'main_db', password: PASSWORD });
		expect(result).toMatchObject({ rewound: false, fallback: 'rebuild' });
		expect(result.reason).toMatch(/different systems/);
		expect(runner.podman().some((argv) => argv.includes('pg_rewind'))).toBe(true);
		expect(await fs.lstat(join(stateDir, SOURCE)).catch(() => null)).toBeNull();
	});

	test('a marker for another database or replica does not count as this adoption', async () => {
		const { driver, runner, stateDir } = await fixture((argv) => {
			if (argv.includes('pg_controldata')) return controldata(true);
			return undefined;
		});
		await fs.mkdir(join(stateDir, REPLICA), { recursive: true });
		await fs.writeFile(
			join(stateDir, REPLICA, 'yoal-rewind.json'),
			JSON.stringify({ databaseId: 'db_other', replicaId: REPLICA, rewoundAt: new Date().toISOString() }),
		);
		const result = await driver.rewindReplica(REPLICA, { databaseId: SOURCE, user: 'main_db', password: PASSWORD });
		expect(result).toMatchObject({ rewound: true, fallback: null });
		expect(runner.podman().some((argv) => argv.includes('pg_rewind'))).toBe(true);
		const marker = JSON.parse(await fs.readFile(join(stateDir, REPLICA, 'yoal-rewind.json'), 'utf8')) as Record<string, unknown>;
		expect(marker).toMatchObject({ databaseId: SOURCE, replicaId: REPLICA });
	});

	test('a PG_VERSION without the rewind marker is not reported as a successful rewind', async () => {
		const { driver, runner, stateDir } = await fixture();
		await fs.mkdir(join(stateDir, REPLICA, 'pgdata'), { recursive: true });
		await fs.writeFile(join(stateDir, REPLICA, 'pgdata', 'PG_VERSION'), '18\n');
		await fs.rm(join(stateDir, SOURCE), { recursive: true, force: true });
		const result = await driver.rewindReplica(REPLICA, { databaseId: SOURCE, user: 'main_db', password: PASSWORD });
		expect(result).toMatchObject({ rewound: false, fallback: 'rebuild' });
		expect(result.reason).toMatch(/no old primary data directory/);
		expect(runner.podman().some((argv) => argv.includes('pg_rewind'))).toBe(false);
	});

	test('a transport failure is retried before the rebuild fallback', async () => {
		let rewinds = 0;
		const { driver, runner, stateDir } = await fixture((argv) => {
			if (argv.includes('pg_controldata')) return controldata(true);
			if (argv.includes('pg_rewind')) {
				rewinds += 1;
				if (rewinds === 1)
					return { code: 1, stdout: '', stderr: 'FATAL: could not connect to server: Connection refused' };
			}
			return undefined;
		});
		const result = await driver.rewindReplica(REPLICA, { databaseId: SOURCE, user: 'main_db', password: PASSWORD });
		expect(result).toMatchObject({ rewound: true, fallback: null });
		expect(rewinds).toBe(2);
		expect(await fs.readFile(join(stateDir, REPLICA, 'pgdata', 'PG_VERSION'), 'utf8')).toBe('18\n');
	});

	test('a transport failure that never clears gives up after three attempts (two retries) and rebuilds', async () => {
		let rewinds = 0;
		const { driver, stateDir } = await fixture((argv) => {
			if (argv.includes('pg_controldata')) return controldata(true);
			if (argv.includes('pg_rewind')) {
				rewinds += 1;
				return { code: 1, stdout: '', stderr: 'FATAL: could not receive data from WAL stream: timeout expired' };
			}
			return undefined;
		});
		const result = await driver.rewindReplica(REPLICA, { databaseId: SOURCE, user: 'main_db', password: PASSWORD });
		expect(result).toMatchObject({ rewound: false, fallback: 'rebuild' });
		expect(result.reason).toMatch(/after 3 transport attempts \(2 retries\)/);
		expect(rewinds).toBe(3);
		expect(await fs.lstat(join(stateDir, SOURCE)).catch(() => null)).toBeNull();
		expect(await fs.lstat(join(stateDir, REPLICA)).catch(() => null)).toBeNull();
	});

	test('walLogHints from the control plane covers a runtime -c flag the config files cannot show', async () => {
		const { driver, runner } = await fixture((argv) => {
			if (argv.includes('pg_controldata')) return controldata(false);
			return undefined;
		});
		const result = await driver.rewindReplica(REPLICA, {
			databaseId: SOURCE,
			walLogHints: true,
			user: 'main_db',
			password: PASSWORD,
		});
		expect(result).toMatchObject({ rewound: true, fallback: null });
		expect(runner.podman().some((argv) => argv.includes('pg_rewind'))).toBe(true);
		await expect(
			driver.rewindReplica(REPLICA, { databaseId: SOURCE, walLogHints: 'yes', user: 'main_db', password: PASSWORD }),
		).rejects.toThrow(/walLogHints/);
	});

	test('a missing old primary reports the rebuild fallback without running anything', async () => {
		const { driver, runner } = await fixture();
		const result = await driver.rewindReplica(REPLICA, { databaseId: 'db_missing', user: 'main_db', password: PASSWORD });
		expect(result).toMatchObject({ rewound: false, fallback: 'rebuild' });
		expect(runner.podman()).toHaveLength(0);
	});
});
