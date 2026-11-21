import { REPLICA_UPSTREAM_DIR } from './replication.ts';
import { ValidationError } from './validate.ts';

/**
 * pgBackRest data path for PITR (docs/PITR.md). Pure renderers, parsers and validators only; the
 * `SystemdDriver` runs the fixed podman argv. Nothing here accepts a shell string.
 *
 * Everything runs the same image: a PITR-enabled database runs the Yoal-built Postgres image that
 * ships pgBackRest (`docker/postgres-pitr`, `postgresPitrImage`). Postgres itself runs
 * `archive-push` from `archive_command`; base backups, `info` and `pg_stat_archiver` reads are
 * `podman exec` into that running container (pgBackRest must share the host with Postgres and talks
 * to it over the Unix socket); a restore runs one-shot containers of the same image against the
 * target's data dir. pgBackRest therefore always writes and reads its repository with one version.
 */

/** Container paths. The helper mounts the per-database config directory here read-only. */
export const PITR_CONTAINER_CONFIG_DIR = '/etc/pgbackrest';
export const PITR_CONTAINER_CONFIG_PATH = `${PITR_CONTAINER_CONFIG_DIR}/pgbackrest.conf`;
export const PITR_CONTAINER_PGPASS_PATH = `${PITR_CONTAINER_CONFIG_DIR}/pgpass`;
/** Async archive-push/get queue. On the data volume (the root is read-only), beside `pgdata`. */
export const PITR_SPOOL_PATH = '/data/pgbackrest-spool';
/** The image's socket directory; the unit mounts a tmpfs there. */
export const PITR_PG_SOCKET_PATH = '/var/run/postgresql';
export const PITR_PGDATA = '/data/pgdata';
export const PITR_CONFIG_DIRNAME = 'pgbackrest';
export const PITR_CONFIG_FILENAME = 'pgbackrest.conf';
export const PITR_PGPASS_FILENAME = 'pgpass';
/** HA-PLAN W3/W10: a GCS service-account key is a 0400 file beside the config, never inline. */
export const PITR_GCS_KEY_FILENAME = 'gcs-key.json';
export const PITR_GCS_KEY_PATH = `${PITR_CONTAINER_CONFIG_DIR}/${PITR_GCS_KEY_FILENAME}`;
export const PITR_ARCHIVE_TIMEOUT_SECONDS = 60;
/** Weekly full and daily differential base backups, at 02:00 UTC. */
export const PITR_FULL_SCHEDULE = '0 2 * * 0';
export const PITR_DIFF_SCHEDULE = '0 2 * * 1-6';
export const PITR_RETENTION_FULL = 4;
export const PITR_RETENTION_DIFF = 7;
/**
 * PITR containers run an init process as PID 1. pgBackRest's async archive-push/archive-get
 * forks a background process and exits; that orphan is reparented to PID 1. Were PID 1 the
 * postmaster, any non-zero exit of the orphan (a stanza not created yet, an S3 blip) is an
 * "untracked child process" to Postgres, which then kills every backend and runs crash recovery
 * (reproduced on the 18-1 image under Docker; gone with `--init`).
 */
export const PITR_NEEDS_INIT = true;

/** A temporary superuser the restore creates to rename the owner role, then drops. */
export const PITR_RESTORE_ROLE = 'yoal_pitr_restore';

/**
 * A validated repository. `s3` keeps the shape every node has parsed since PITR shipped; `azure`
 * and `gcs` are HA-PLAN W3/W10 and only exist on an install whose node declares
 * `object-store-kinds`. The helper parses the store shape itself and never accepts a raw target.
 */
export type PitrRepoConfig = PitrS3RepoConfig | PitrAzureRepoConfig | PitrGcsRepoConfig;

export interface PitrS3RepoConfig {
	kind: 's3';
	endpoint: string | null;
	bucket: string;
	region: string;
	pathPrefix: string;
	forcePathStyle: boolean;
	accessKeyId: string;
	secretAccessKey: string;
}

export interface PitrAzureRepoConfig {
	kind: 'azure';
	account: string;
	container: string;
	/** Null means `blob.core.windows.net`; an `http://` endpoint is an emulator (Azurite). */
	endpoint: string | null;
	pathPrefix: string;
	keyType: 'shared' | 'sas';
	key: string;
}

export interface PitrGcsRepoConfig {
	kind: 'gcs';
	bucket: string;
	/** Null means `storage.googleapis.com`; an `http://` endpoint is an emulator. */
	endpoint: string | null;
	pathPrefix: string;
	/** The service-account JSON, written as a 0400 file beside the config. */
	serviceAccountJson: string;
}

export const PITR_STANZA_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_PATTERN = /^[a-z0-9-]{1,63}$/;
const PREFIX_PATTERN = /^[A-Za-z0-9._/-]*$/;
const ACCESS_KEY_PATTERN = /^[^\s\r\n]{3,128}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const PASSWORD_PATTERN = /^[A-Za-z0-9_-]{16,200}$/;

export function validatePitrStanza(value: unknown, label = 'pitr.stanza'): string {
	if (typeof value !== 'string' || !PITR_STANZA_PATTERN.test(value))
		throw new ValidationError(`${label} must match ${PITR_STANZA_PATTERN}`);
	return value;
}

/** Derive the stanza from a validated database id; never from the wire. */
export function pitrStanzaFor(databaseId: string): string {
	return databaseId.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Read the stanza back from a rendered pgBackRest config (`[global]` is not a stanza). The helper
 * uses it for `status`/`restore` so a config written for a replica workload (which carries the
 * database's stanza) is never re-derived from the replica's own workload id.
 */
export function parsePitrStanza(config: string): string | null {
	for (const line of config.split('\n')) {
		const match = /^\[([^\]]+)\]\s*$/.exec(line.trim());
		if (!match || match[1] === 'global') continue;
		return validatePitrStanza(match[1]);
	}
	return null;
}

function clean(value: unknown, label: string, max: number): string {
	if (typeof value !== 'string') throw new ValidationError(`${label} must be a string`);
	const trimmed = value.trim();
	if (!trimmed) throw new ValidationError(`${label} must not be empty`);
	if (trimmed.length > max) throw new ValidationError(`${label} must be at most ${max} characters`);
	if (/[\r\n\0]/.test(trimmed)) throw new ValidationError(`${label} must not contain line breaks`);
	return trimmed;
}

const AZURE_ACCOUNT_PATTERN = /^[a-z0-9]{3,24}$/;
const AZURE_CONTAINER_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const GCS_BUCKET_PATTERN = /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/;

/** An endpoint origin; `allowHttp` is only for Azure/GCS emulators, never for S3. */
function parseRepoEndpoint(value: unknown, label: string, allowHttp: boolean): string | null {
	if (value === undefined || value === null) return null;
	const endpoint = clean(value, `${label}.endpoint`, 300);
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new ValidationError(`${label}.endpoint must be an ${allowHttp ? 'http(s)' : 'https'} URL`);
	}
	if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:'))
		throw new ValidationError(
			`${label}.endpoint must use ${allowHttp ? 'https (or http for an emulator)' : 'https (pgBackRest has no plain-HTTP S3 client)'}`,
		);
	if (url.username || url.password) throw new ValidationError(`${label}.endpoint must not embed credentials`);
	if (url.search || url.hash) throw new ValidationError(`${label}.endpoint must not contain a query or fragment`);
	return url.toString();
}

function parseRepoPathPrefix(value: unknown, label: string): string {
	const raw = value === undefined ? '' : value;
	if (typeof raw !== 'string') throw new ValidationError(`${label}.pathPrefix must be a string`);
	const pathPrefix = raw.trim().replace(/^\/+|\/+$/g, '');
	if (!PREFIX_PATTERN.test(pathPrefix))
		throw new ValidationError(`${label}.pathPrefix contains unsupported characters`);
	if (pathPrefix && pathPrefix.split('/').some((part) => part === '.' || part === '..' || part === ''))
		throw new ValidationError(`${label}.pathPrefix must be normalized`);
	return pathPrefix;
}

function parseObjectStoreRepo(record: Record<string, unknown>, label: string): PitrAzureRepoConfig | PitrGcsRepoConfig {
	const store = record.store;
	if (typeof store !== 'object' || store === null || Array.isArray(store))
		throw new ValidationError(`${label}.store must be an object`);
	const target = store as Record<string, unknown>;
	const credentials = record.storeCredentials;
	if (typeof credentials !== 'object' || credentials === null || Array.isArray(credentials))
		throw new ValidationError(`${label}.storeCredentials must be an object`);
	const creds = credentials as Record<string, unknown>;
	if (target.kind !== 'azure' && target.kind !== 'gcs')
		throw new ValidationError(`${label}.store.kind must be "azure" or "gcs"`);
	if (creds.kind !== target.kind)
		throw new ValidationError(`${label}.storeCredentials are for another kind of store`);
	const pathPrefix = parseRepoPathPrefix(target.pathPrefix, `${label}.store`);
	const endpoint = parseRepoEndpoint(target.endpoint, `${label}.store`, true);

	if (target.kind === 'azure') {
		const account = clean(target.account, `${label}.store.account`, 24);
		if (!AZURE_ACCOUNT_PATTERN.test(account))
			throw new ValidationError(`${label}.store.account must be 3-24 lowercase letters and digits`);
		const container = clean(target.container, `${label}.store.container`, 63);
		if (!AZURE_CONTAINER_PATTERN.test(container) || container.includes('--'))
			throw new ValidationError(`${label}.store.container is not a valid Azure container name`);
		// Azurite's service endpoint carries the account as a path (`/devstoreaccount1`). It is the
		// only path accepted: pgBackRest derives the account prefix itself in path style.
		if (endpoint) {
			const url = new URL(endpoint);
			const trimmed = url.pathname.replace(/^\/+|\/+$/g, '');
			if (trimmed !== '' && trimmed !== account)
				throw new ValidationError(`${label}.store.endpoint must be an origin or end with the account name`);
		}
		const accountKey = creds.accountKey === undefined ? null : clean(creds.accountKey, `${label}.storeCredentials.accountKey`, 512);
		const sasToken = creds.sasToken === undefined ? null : clean(creds.sasToken, `${label}.storeCredentials.sasToken`, 2048);
		if ((accountKey === null) === (sasToken === null))
			throw new ValidationError(`${label}.storeCredentials need exactly one of accountKey or sasToken`);
		return {
			kind: 'azure',
			account,
			container,
			endpoint,
			pathPrefix,
			keyType: accountKey ? 'shared' : 'sas',
			key: (accountKey ?? sasToken)!,
		};
	}

	const bucket = clean(target.bucket, `${label}.store.bucket`, 63);
	if (!GCS_BUCKET_PATTERN.test(bucket) || bucket.startsWith('goog') || bucket.includes('google'))
		throw new ValidationError(`${label}.store.bucket is not a valid GCS bucket name`);
	if (endpoint) {
		const url = new URL(endpoint);
		if (url.pathname !== '' && url.pathname !== '/')
			throw new ValidationError(`${label}.store.endpoint must be a bare origin`);
	}
	const serviceAccountJson = creds.serviceAccountJson;
	if (typeof serviceAccountJson !== 'string' || serviceAccountJson.length < 20 || serviceAccountJson.length > 16_384)
		throw new ValidationError(`${label}.storeCredentials.serviceAccountJson must be a service-account key (20-16384 characters)`);
	try {
		const key = JSON.parse(serviceAccountJson) as Record<string, unknown>;
		if (typeof key.client_email !== 'string' || typeof key.private_key !== 'string')
			throw new Error('missing fields');
	} catch {
		throw new ValidationError(
			`${label}.storeCredentials.serviceAccountJson must be a service-account key with client_email and private_key`,
		);
	}
	return { kind: 'gcs', bucket, endpoint, pathPrefix, serviceAccountJson };
}

/** Validate the structured repository config handed to the helper over the privileged socket. */
export function parsePitrRepo(value: unknown, label = 'pitr.repo'): PitrRepoConfig {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new ValidationError(`${label} must be an object`);
	const record = value as Record<string, unknown>;
	if (record.store !== undefined) return parseObjectStoreRepo(record, label);
	if (record.kind !== 's3') throw new ValidationError(`${label}.kind must be "s3"`);

	const bucket = clean(record.bucket, `${label}.bucket`, 63);
	if (!BUCKET_PATTERN.test(bucket)) throw new ValidationError(`${label}.bucket is not a valid bucket name`);
	const region = clean(record.region, `${label}.region`, 63);
	if (!REGION_PATTERN.test(region)) throw new ValidationError(`${label}.region is not a valid region`);
	const endpoint = parseRepoEndpoint(record.endpoint, label, false);
	if (endpoint) {
		const url = new URL(endpoint);
		if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
			throw new ValidationError(`${label}.endpoint must be a bare origin (put the path in pathPrefix)`);
	}
	const pathPrefix = parseRepoPathPrefix(record.pathPrefix, label);

	if (typeof record.forcePathStyle !== 'boolean')
		throw new ValidationError(`${label}.forcePathStyle must be a boolean`);

	const accessKeyId = clean(record.accessKeyId, `${label}.accessKeyId`, 128);
	if (!ACCESS_KEY_PATTERN.test(accessKeyId))
		throw new ValidationError(`${label}.accessKeyId must not contain whitespace`);
	const secretAccessKey = clean(record.secretAccessKey, `${label}.secretAccessKey`, 512);

	return {
		kind: 's3',
		endpoint,
		bucket,
		region,
		pathPrefix,
		forcePathStyle: record.forcePathStyle,
		accessKeyId,
		secretAccessKey,
	};
}

/**
 * The endpoint host and (non-default) port pgBackRest connects to. A null endpoint is the
 * backend's default: AWS S3 for the region, `blob.core.windows.net`, or `storage.googleapis.com`.
 */
export function pitrRepoEndpoint(repo: PitrRepoConfig): { host: string; port: number | null; tls: boolean } {
	if (repo.kind === 's3') {
		if (!repo.endpoint) return { host: `s3.${repo.region}.amazonaws.com`, port: null, tls: true };
		const url = new URL(repo.endpoint);
		return { host: url.hostname, port: url.port ? Number(url.port) : null, tls: url.protocol === 'https:' };
	}
	if (!repo.endpoint)
		return {
			host: repo.kind === 'azure' ? 'blob.core.windows.net' : 'storage.googleapis.com',
			port: null,
			tls: true,
		};
	const url = new URL(repo.endpoint);
	return { host: url.hostname, port: url.port ? Number(url.port) : null, tls: url.protocol === 'https:' };
}


/**
 * A restore target cannot be in the future or outside the repository retention window. The helper
 * checks this again even though the control plane validated it: the privileged side trusts no
 * value it did not parse itself.
 */
export function validatePitrTargetTime(
	value: unknown,
	now: number,
	retentionDays = PITR_RETENTION_FULL * 7 + PITR_RETENTION_DIFF,
): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)
		throw new ValidationError('pitr.targetTime must be a positive epoch-millisecond timestamp');
	if (value > now) throw new ValidationError('pitr.targetTime is in the future');
	const oldest = now - retentionDays * 86_400_000;
	if (value < oldest)
		throw new ValidationError(`pitr.targetTime is older than the ${retentionDays}-day retention window`);
	return value;
}

/**
 * `--target` for `restore --type=time`. pgBackRest picks the backup set to restore from by parsing
 * this value itself, and its parser only understands `YYYY-MM-DD HH:MM:SS[.mmm][+/-TZ]`; an ISO
 * `T…Z` string silently falls back to the latest backup, which is newer than an older target and
 * makes recovery fail. Postgres accepts the same string for `recovery_target_time`.
 */
export function formatPitrTarget(epochMs: number): string {
	const iso = new Date(epochMs).toISOString(); // 2026-11-05T09:30:00.000Z
	return `${iso.slice(0, 10)} ${iso.slice(11, 23)}+00`;
}

export type PitrBaseBackupType = 'full' | 'diff' | 'incr';

export function parsePitrBackupType(value: unknown): PitrBaseBackupType {
	if (value !== 'full' && value !== 'diff' && value !== 'incr')
		throw new ValidationError('pitr.type must be full, diff or incr');
	return value;
}

export interface PgBackRestConfigOptions {
	stanza: string;
	repo: PitrRepoConfig;
	/** The database owner: a superuser that pgBackRest connects as over the Unix socket. */
	pg1User: string;
}

/**
 * pgBackRest INI. `repo1-path` is scoped by stanza so databases cannot read each other's WAL.
 * Postgres is reached over the container's Unix socket (pgBackRest must run beside Postgres), the
 * async spool lives on the data volume because the root filesystem is read-only, and file logging
 * is off so a busy archive cannot fill the 64 MB `/tmp`: warnings reach the journal via stderr.
 * `repo1-cipher-type=none` is deliberate: the repository lives in an encrypted-at-rest bucket and
 * the control plane does not hold a second key that a restore runbook would have to recover.
 *
 * A non-S3 repository uses pgBackRest's own Azure/GCS client (HA-PLAN W3): the same config works
 * from the primary, a replica and a restore one-shot, so a stanza follows the primary across a
 * promotion with no rewrite. Emulator endpoints stay plain HTTP and skip TLS verification.
 */
export function renderPgBackRestConfig(options: PgBackRestConfigOptions): string {
	const { repo } = options;
	validatePitrStanza(options.stanza);
	if (!IDENTIFIER_PATTERN.test(options.pg1User)) throw new ValidationError('pitr pg1-user must be a plain identifier');
	const repoPath = [repo.pathPrefix, options.stanza].filter(Boolean).join('/');
	const endpoint = pitrRepoEndpoint(repo);
	const repoLines: string[] =
		repo.kind === 's3'
			? [
					'repo1-type=s3',
					`repo1-s3-bucket=${repo.bucket}`,
					`repo1-s3-endpoint=${endpoint.host}`,
					...(endpoint.port ? [`repo1-storage-port=${endpoint.port}`] : []),
					`repo1-s3-region=${repo.region}`,
					`repo1-s3-key=${repo.accessKeyId}`,
					`repo1-s3-key-secret=${repo.secretAccessKey}`,
					`repo1-s3-uri-style=${repo.forcePathStyle ? 'path' : 'host'}`,
				]
			: repo.kind === 'azure'
				? [
						'repo1-type=azure',
						`repo1-azure-account=${repo.account}`,
						`repo1-azure-container=${repo.container}`,
						`repo1-azure-key-type=${repo.keyType}`,
						`repo1-azure-key=${repo.key}`,
						...(repo.endpoint
							? [
									`repo1-azure-endpoint=${endpoint.host}`,
									...(endpoint.port ? [`repo1-storage-port=${endpoint.port}`] : []),
									'repo1-azure-uri-style=path',
									...(endpoint.tls ? [] : ['repo1-storage-verify-tls=n']),
								]
							: []),
					]
				: [
						'repo1-type=gcs',
						`repo1-gcs-bucket=${repo.bucket}`,
						'repo1-gcs-key-type=service',
						`repo1-gcs-key=${PITR_GCS_KEY_PATH}`,
						...(repo.endpoint
							? [
									`repo1-gcs-endpoint=${endpoint.host}`,
									...(endpoint.port ? [`repo1-storage-port=${endpoint.port}`] : []),
									...(endpoint.tls ? [] : ['repo1-storage-verify-tls=n']),
								]
							: []),
					];
	const lines = [
		'# Generated by yoal-helper (docs/PITR.md). Do not edit; changes are overwritten.',
		'[global]',
		...repoLines,
		`repo1-path=/${repoPath}`,
		'repo1-retention-full-type=count',
		`repo1-retention-full=${PITR_RETENTION_FULL}`,
		`repo1-retention-diff=${PITR_RETENTION_DIFF}`,
		'repo1-cipher-type=none',
		'archive-async=y',
		// Past this, pgBackRest drops queued WAL rather than fill the data volume; the archive then
		// reports failing and the next full backup restores a continuous window (docs/PITR.md).
		'archive-push-queue-max=1GiB',
		`spool-path=${PITR_SPOOL_PATH}`,
		'compress-type=zst',
		'compress-level=3',
		'process-max=2',
		'start-fast=y',
		'log-level-console=warn',
		'log-level-stderr=warn',
		'log-level-file=off',
		'lock-path=/tmp/pgbackrest-lock',
		'',
		`[${options.stanza}]`,
		`pg1-path=${PITR_PGDATA}`,
		`pg1-socket-path=${PITR_PG_SOCKET_PATH}`,
		`pg1-user=${options.pg1User}`,
		'',
	];
	return lines.join('\n');
}

/** The extra 0400 file a GCS repository needs (its service-account key); null for S3 and Azure. */
export function renderPgBackRestKey(repo: PitrRepoConfig): string | null {
	return repo.kind === 'gcs' ? repo.serviceAccountJson : null;
}

// ---------------------------------------------------------------- pg_rewind (HA-PLAN W10)

/** One-shot container that rewinds an old primary's data dir against the new primary. */
export function pgRewindContainerName(replicaId: string): string {
	return `yoal-rewind-${replicaId}`;
}

/**
 * Written beside the adopted `pgdata` only by a successful `pg_rewind` (never by a rebuild). The
 * helper reads it to make a re-run idempotent, instead of inferring success from `PG_VERSION`:
 * a fallback rebuild that then bootstrapped a fresh directory has a `PG_VERSION` too, and reporting
 * that as a successful rewind hid the rebuild from the control plane.
 */
export const PITR_REWIND_MARKER_FILENAME = 'yoal-rewind.json';

export interface PitrRewindMarker {
	databaseId: string;
	replicaId: string;
	rewoundAt: string;
}

export function renderPitrRewindMarker(marker: PitrRewindMarker): string {
	return `${JSON.stringify(marker)}\n`;
}

/** The marker path for a replica's data-dir root (`<state>/<replica id>`). */
export function pitrRewindMarkerPath(replicaRoot: string): string {
	return `${replicaRoot}/${PITR_REWIND_MARKER_FILENAME}`;
}

const PG_REWIND_TRANSPORT_PATTERNS = [
	/could not connect/i,
	/connection (?:to server )?(?:refused|failed|closed)/i,
	/server closed the connection/i,
	/could not receive data/i,
	/timed out|timeout expired/i,
	/no route to host/i,
	/network is unreachable/i,
	/broken pipe|unexpected eof/i,
	/(?:ssl|tls|certificate) (?:error|failure|handshake)/i,
];

/**
 * Classify a failed `pg_rewind` by its stderr. A transport failure (the new primary was
 * unreachable, a TLS/socket error) is worth retrying before throwing away the diverged directory;
 * everything else (no common ancestor, different systems, hint logging off) is a rebuild.
 */
export function pgRewindFailureKind(stderr: string): 'transport' | 'rebuild' {
	return PG_REWIND_TRANSPORT_PATTERNS.some((pattern) => pattern.test(stderr)) ? 'transport' : 'rebuild';
}

/** Three attempts in total (the first run plus two retries) before the rebuild fallback. */
export const PG_REWIND_TRANSPORT_ATTEMPTS = 3;

/**
 * `--source-server` for `pg_rewind`: the same agent-served link socket a replica streams through,
 * so the old primary's node reaches the new primary over the same pinned mTLS path and never needs
 * a new listener.
 */
export function pgRewindSourceServer(user: string): string {
	if (!IDENTIFIER_PATTERN.test(user)) throw new ValidationError('pg_rewind source user must be a plain identifier');
	return `host=${REPLICA_UPSTREAM_DIR} port=5432 user=${user} dbname=postgres connect_timeout=10`;
}

/**
 * `pg_controldata` reads the target cluster without starting it. `pg_rewind` can only run when the
 * target has data checksums (new databases get them) or `wal_log_hints=on`; anything else takes the
 * rebuild path.
 */
export function parseDataChecksums(stdout: string): boolean {
	const match = /^Data page checksum version:\s*(\d+)\s*$/m.exec(stdout);
	return match ? Number(match[1]) > 0 : false;
}

export function renderPgControldataArgs(options: {
	podmanPath: string;
	image: string;
	replicaId: string;
	/** Host directory of the old primary's data dir root (`<…>/<databaseId>`), mounted at /data. */
	targetRoot: string;
}): string[] {
	return [
		options.podmanPath,
		'run',
		'--rm',
		'--name',
		pgRewindContainerName(options.replicaId),
		'--user',
		'70:70',
		'--read-only',
		'--tmpfs',
		'/tmp:rw,size=64m',
		'--volume',
		`${options.targetRoot}:/data:ro`,
		'--entrypoint',
		'pg_controldata',
		options.image,
		PITR_PGDATA,
	];
}

/**
 * `pg_rewind` in a one-shot container of the PITR image. `--write-recovery-conf` writes
 * `standby.signal` and `primary_conninfo` from the source-server, so the adopted directory starts
 * as a standby; the replica unit also passes `primary_slot_name`. `PGPASSWORD` arrives through the
 * container environment, never argv.
 */
export function renderPgRewindArgs(options: {
	podmanPath: string;
	image: string;
	replicaId: string;
	targetRoot: string;
	linkDir: string;
	user: string;
}): string[] {
	return [
		options.podmanPath,
		'run',
		'--rm',
		'--name',
		pgRewindContainerName(options.replicaId),
		'--user',
		'70:70',
		'--read-only',
		'--tmpfs',
		'/tmp:rw,size=64m',
		'--volume',
		`${options.targetRoot}:/data:Z`,
		'--volume',
		`${options.linkDir}:${REPLICA_UPSTREAM_DIR}:ro,z`,
		'--env',
		'PGPASSWORD',
		'--entrypoint',
		'pg_rewind',
		options.image,
		`--target-pgdata=${PITR_PGDATA}`,
		`--source-server=${pgRewindSourceServer(options.user)}`,
		'--write-recovery-conf',
		'--progress',
	];
}

/** `~/.pgpass` format: host:port:database:user:password, with `:` and `\` escaped. */
export function renderPgPass(user: string, password: string, host = '*', port = '*', database = '*'): string {
	const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
	return `${escape(host)}:${escape(port)}:${escape(database)}:${escape(user)}:${escape(password)}\n`;
}

/**
 * The per-database config directory, always inside the 0700 runtime dir. The directory (not the
 * files) is bind-mounted, so an atomic rewrite of the config is visible to the running container
 * without a restart.
 */
export function pitrPaths(runtimeDir: string, id: string): { dir: string; config: string; pgpass: string; gcsKey: string } {
	const dir = `${runtimeDir}/${id}/${PITR_CONFIG_DIRNAME}`;
	return {
		dir,
		config: `${dir}/${PITR_CONFIG_FILENAME}`,
		pgpass: `${dir}/${PITR_PGPASS_FILENAME}`,
		gcsKey: `${dir}/${PITR_GCS_KEY_FILENAME}`,
	};
}

/** The database's own container, where base backups and status reads run. */
export function pitrContainerName(id: string): string {
	return `yoal-workload-${id}`;
}

/** The one-shot containers a restore runs against the target's data dir. */
export function pitrRestoreContainerName(targetId: string): string {
	return `yoal-pitr-restore-${targetId}`;
}
export function pitrRecoveryContainerName(targetId: string): string {
	return `yoal-pitr-recover-${targetId}`;
}

/**
 * `podman exec` of pgBackRest inside the running database container. `PGPASSFILE` covers a
 * pg_hba that asks for a password on the socket; the image's initdb trusts it.
 */
export function renderPitrExecArgs(options: { podmanPath: string; workloadId: string; args: string[] }): string[] {
	return [
		options.podmanPath,
		'exec',
		'--env',
		`PGPASSFILE=${PITR_CONTAINER_PGPASS_PATH}`,
		pitrContainerName(options.workloadId),
		'pgbackrest',
		`--config=${PITR_CONTAINER_CONFIG_PATH}`,
		...options.args,
	];
}

/** pgBackRest base backup argv (stanza-create first: it is idempotent and checks the cluster). */
export function renderPitrBackupArgs(stanza: string, type: PitrBaseBackupType): string[][] {
	return [
		[`--stanza=${stanza}`, 'stanza-create'],
		[`--stanza=${stanza}`, `--type=${type}`, 'backup'],
	];
}

/** Archive health: the archiver's own counters, as `archived|failed` epoch ms (0 = never). */
export const PITR_ARCHIVER_SQL =
	"SELECT coalesce((extract(epoch FROM last_archived_time) * 1000)::bigint, 0) || '|' || coalesce((extract(epoch FROM last_failed_time) * 1000)::bigint, 0) FROM pg_stat_archiver";

export function renderPitrArchiverArgs(options: { podmanPath: string; workloadId: string; user: string; database: string }): string[] {
	return [
		options.podmanPath,
		'exec',
		pitrContainerName(options.workloadId),
		'psql',
		'-h',
		PITR_PG_SOCKET_PATH,
		'-X',
		'-tA',
		'-U',
		options.user,
		'-d',
		options.database,
		'-c',
		PITR_ARCHIVER_SQL,
	];
}

export interface PitrOneShotOptions {
	podmanPath: string;
	image: string;
	targetId: string;
	/** Host data dir of the NEW database, mounted at /data. */
	targetDataDir: string;
	/** Host config directory of the SOURCE database (its stanza and repository). */
	configDir: string;
}

/**
 * Shared flags of the restore's one-shot containers: the engine uid, a read-only root, the
 * target's data dir and the source's config dir. The config dir is also mounted by the running
 * source, so it is relabelled shared (`z`); the target's data dir is private to this step.
 */
function oneShotMounts(options: PitrOneShotOptions): string[] {
	return [
		'--user',
		'70:70',
		'--read-only',
		'--tmpfs',
		'/tmp:rw,size=64m',
		'--volume',
		`${options.targetDataDir}:/data:Z`,
		'--volume',
		`${options.configDir}:${PITR_CONTAINER_CONFIG_DIR}:ro,z`,
	];
}

/** `pgbackrest restore --type=time` into the empty target data dir. */
export function renderPitrRestoreArgs(options: PitrOneShotOptions & { stanza: string; targetTime: number }): string[] {
	return [
		options.podmanPath,
		'run',
		'--rm',
		'--name',
		pitrRestoreContainerName(options.targetId),
		...oneShotMounts(options),
		'--entrypoint',
		'/usr/local/bin/pgbackrest',
		options.image,
		`--config=${PITR_CONTAINER_CONFIG_PATH}`,
		`--stanza=${options.stanza}`,
		`--pg1-path=${PITR_PGDATA}`,
		'--type=time',
		`--target=${formatPitrTarget(options.targetTime)}`,
		'--target-action=promote',
		'restore',
	];
}

/**
 * Replay WAL to the target in a detached one-shot Postgres (the image's entrypoint, so nss_wrapper
 * maps uid 70). TCP is off; `archive_mode` is off so the restored cluster never pushes WAL into
 * the source's stanza. `restore_command` (written by pgBackRest) reads the repository through the
 * same mounted config. The helper waits for promotion, then stops it cleanly. `--init` for the
 * same reason as `RunInit=true` on the database unit (`PITR_NEEDS_INIT`).
 */
export function renderPitrRecoveryArgs(options: PitrOneShotOptions): string[] {
	return [
		options.podmanPath,
		'run',
		'--detach',
		'--init',
		'--name',
		pitrRecoveryContainerName(options.targetId),
		...oneShotMounts(options),
		'--tmpfs',
		`${PITR_PG_SOCKET_PATH}:rw,size=8m,mode=1777`,
		'--env',
		`PGDATA=${PITR_PGDATA}`,
		'--entrypoint',
		'/usr/local/bin/docker-entrypoint.sh',
		options.image,
		'postgres',
		'-c',
		'listen_addresses=',
		'-c',
		'archive_mode=off',
	];
}

/** `psql` over the recovery container's socket; SQL arrives on stdin or as a fixed `-c`. */
export function renderPitrRecoveryPsqlArgs(options: {
	podmanPath: string;
	targetId: string;
	user: string;
	command?: string;
}): string[] {
	return [
		options.podmanPath,
		'exec',
		...(options.command ? [] : ['-i']),
		pitrRecoveryContainerName(options.targetId),
		'psql',
		'-h',
		PITR_PG_SOCKET_PATH,
		'-X',
		'-v',
		'ON_ERROR_STOP=1',
		'-tA',
		'-U',
		options.user,
		'-d',
		'postgres',
		...(options.command ? ['-c', options.command] : []),
	];
}

export interface PitrRenameInput {
	/** The source's owner role and database, carried over by the physical restore. */
	sourceUser: string;
	sourceDatabase: string;
	/** The new database's own credentials (its env file). */
	targetUser: string;
	targetDatabase: string;
	targetPassword: string;
}

/**
 * A physical restore brings the SOURCE's owner role, password and database name. The new database
 * was created with its own; make the cluster match them. Three steps because the connected session
 * user cannot be renamed: (1) as the source owner create a temporary superuser, (2) as that role
 * rename the owner and its database, set the target's password and clear the recovery settings
 * pgBackRest wrote to postgresql.auto.conf, (3) as the renamed owner drop the temporary role.
 * Every value is validated first, so nothing can break out of a quoted identifier or literal.
 */
export function renderPitrRenameSql(input: PitrRenameInput): Array<{ user: string; sql: string }> {
	for (const [label, value] of [
		['source user', input.sourceUser],
		['source database', input.sourceDatabase],
		['target user', input.targetUser],
		['target database', input.targetDatabase],
	] as const)
		if (!IDENTIFIER_PATTERN.test(value)) throw new ValidationError(`pitr ${label} must be a plain identifier`);
	if (!PASSWORD_PATTERN.test(input.targetPassword))
		throw new ValidationError('pitr target password must be base64url (16–200 characters)');
	if (input.targetUser === PITR_RESTORE_ROLE || input.sourceUser === PITR_RESTORE_ROLE)
		throw new ValidationError(`${PITR_RESTORE_ROLE} is reserved`);
	const ident = (value: string) => `"${value}"`;
	const rename: string[] = [];
	if (input.sourceUser !== input.targetUser)
		rename.push(`ALTER ROLE ${ident(input.sourceUser)} RENAME TO ${ident(input.targetUser)};`);
	rename.push(`ALTER ROLE ${ident(input.targetUser)} WITH PASSWORD '${input.targetPassword}';`);
	if (input.sourceDatabase !== input.targetDatabase)
		rename.push(`ALTER DATABASE ${ident(input.sourceDatabase)} RENAME TO ${ident(input.targetDatabase)};`);
	rename.push(
		'ALTER SYSTEM RESET restore_command;',
		'ALTER SYSTEM RESET recovery_target_time;',
		'ALTER SYSTEM RESET recovery_target_action;',
	);
	return [
		{ user: input.sourceUser, sql: `CREATE ROLE ${ident(PITR_RESTORE_ROLE)} WITH LOGIN SUPERUSER;\n` },
		{ user: PITR_RESTORE_ROLE, sql: `${rename.join('\n')}\n` },
		{ user: input.targetUser, sql: `DROP ROLE ${ident(PITR_RESTORE_ROLE)};\n` },
	];
}

// ------------------------------------------------------------------ recoverable window

export interface PgBackRestInfoSummary {
	/** pgBackRest's stanza status: 0 ok, 2 no valid backups; anything else is a repository problem. */
	statusCode: number | null;
	statusMessage: string | null;
	backupCount: number;
	/** Stop time (epoch ms) of the oldest retained backup: the earliest consistent restore point. */
	oldestBackupStopAt: number | null;
	newestBackupStopAt: number | null;
	newestBackupType: PitrBaseBackupType | null;
}

/** Parse `pgbackrest info --output=json` for one stanza. Unknown shapes yield an empty summary. */
export function parsePgBackRestInfo(stdout: string, stanza: string): PgBackRestInfoSummary {
	const empty: PgBackRestInfoSummary = {
		statusCode: null,
		statusMessage: null,
		backupCount: 0,
		oldestBackupStopAt: null,
		newestBackupStopAt: null,
		newestBackupType: null,
	};
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return empty;
	}
	if (!Array.isArray(parsed)) return empty;
	const entry = parsed.find(
		(item): item is Record<string, unknown> =>
			typeof item === 'object' && item !== null && (item as Record<string, unknown>).name === stanza,
	);
	if (!entry) return empty;
	const status = (entry.status ?? {}) as Record<string, unknown>;
	const backups = (Array.isArray(entry.backup) ? entry.backup : [])
		.map((backup) => {
			const record = (backup ?? {}) as Record<string, unknown>;
			const timestamp = (record.timestamp ?? {}) as Record<string, unknown>;
			const stop = typeof timestamp.stop === 'number' ? timestamp.stop * 1000 : null;
			const type = record.type === 'full' || record.type === 'diff' || record.type === 'incr' ? record.type : null;
			return { stop, type };
		})
		.filter((backup): backup is { stop: number; type: PitrBaseBackupType | null } => backup.stop !== null)
		.sort((a, b) => a.stop - b.stop);
	return {
		statusCode: typeof status.code === 'number' ? status.code : null,
		statusMessage: typeof status.message === 'string' ? status.message : null,
		backupCount: backups.length,
		oldestBackupStopAt: backups[0]?.stop ?? null,
		newestBackupStopAt: backups.at(-1)?.stop ?? null,
		newestBackupType: backups.at(-1)?.type ?? null,
	};
}

export interface PitrArchiverStats {
	lastArchivedAt: number | null;
	lastFailedAt: number | null;
}

/** Parse `PITR_ARCHIVER_SQL` output (`archived|failed`, 0 meaning never). */
export function parseArchiverStats(stdout: string): PitrArchiverStats | null {
	const match = /^(\d+)\|(\d+)$/.exec(stdout.trim());
	if (!match) return null;
	const archived = Number(match[1]);
	const failed = Number(match[2]);
	return { lastArchivedAt: archived > 0 ? archived : null, lastFailedAt: failed > 0 ? failed : null };
}

export interface PitrWindow {
	/** Earliest restorable instant (epoch ms), or null when the repository holds no backup yet. */
	recoverableFrom: number | null;
	/** Latest restorable instant: the last archived WAL, never earlier than the newest backup. */
	recoverableTo: number | null;
	archiveStatus: 'ok' | 'failing' | 'unknown';
}

/**
 * The recoverable window. A time restore needs a backup that finished before the target and every
 * WAL segment from that backup to the target: the window opens at the oldest retained backup's
 * stop and closes at the archiver's last success (pgBackRest's `backup` waits for its own WAL, so
 * the newest backup's stop is always covered). The archive is `failing` when its last failure is
 * newer than its last success; a failing archive still reports the window up to the last success.
 */
export function computePitrWindow(info: PgBackRestInfoSummary, archiver: PitrArchiverStats | null): PitrWindow {
	let archiveStatus: PitrWindow['archiveStatus'] = 'unknown';
	if (archiver) {
		if (archiver.lastFailedAt !== null && archiver.lastFailedAt >= (archiver.lastArchivedAt ?? 0)) archiveStatus = 'failing';
		else if (archiver.lastArchivedAt !== null) archiveStatus = 'ok';
	}
	if (info.oldestBackupStopAt === null || info.newestBackupStopAt === null)
		return { recoverableFrom: null, recoverableTo: null, archiveStatus };
	const archivedTo = archiver?.lastArchivedAt ?? null;
	return {
		recoverableFrom: info.oldestBackupStopAt,
		recoverableTo: Math.max(info.newestBackupStopAt, archivedTo ?? 0),
		archiveStatus,
	};
}

/** What `pitr/status` returns: repository and archive state, never a credential. */
export interface HelperPitrStatus {
	configured: boolean;
	stanza: string;
	/** Read back from the generated config; `endpoint` is the bare host pgBackRest connects to. */
	repo: { bucket: string | null; region: string | null; endpoint: string | null; path: string | null };
	archiveStatus: PitrWindow['archiveStatus'];
	recoverableFrom: number | null;
	recoverableTo: number | null;
	backupCount: number;
	newestBackupAt: number | null;
	newestBackupType: PitrBaseBackupType | null;
	lastArchivedAt: number | null;
	lastFailedAt: number | null;
	/** pgBackRest's stanza status message when it reports a repository problem. */
	repoMessage: string | null;
}
