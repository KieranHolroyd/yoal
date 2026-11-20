import * as z from 'zod';
import { bucketNameSchema } from './object-storage.ts';
import { SLUG_PATTERN } from './slugs.ts';
import { azureAccountSchema, azureContainerSchema, gcsBucketSchema, objectStoreTargetSchema } from './object-store-target.ts';

/**
 * Backup targets (plan 05, docs/BACKUPS.md).
 *
 * A target is where platform and managed-data backups are written: a local directory or any
 * S3-compatible bucket (R2, RustFS, MinIO, Garage, Backblaze, Wasabi). The platform stores one
 * default plus optional per-org overrides; resolution is resource → org → platform → local.
 *
 * Secrets live in the target row, sealed with the org key. They are write-only to every surface:
 * `BackupTargetView` has no secret field, and only create/update accept credentials. A one-time
 * `BackupTargetCredentials` reveal is a separate, audited action — it is not a view.
 */

export const BACKUP_TARGET_ID_PREFIX = 'bt_';

/**
 * `azure` and `gcs` (HA-PLAN W3) are API kinds only. In the database they are rows with
 * `kind = 's3'` (an object store; the 0019 CHECK allows only `local`/`s3`) and `store_kind` set
 * (0120), so no table rebuild was needed. Each is refused while its `OBJECT_STORE_*` flag is off.
 */
export const backupTargetKinds = ['local', 's3', 'azure', 'gcs'] as const;
export type BackupTargetKind = (typeof backupTargetKinds)[number];

export const backupTargetStatuses = ['pending', 'ok', 'failed'] as const;
export type BackupTargetStatus = (typeof backupTargetStatuses)[number];

export const backupTargetNameSchema = z
	.string()
	.trim()
	.min(3)
	.max(40)
	.regex(SLUG_PATTERN, 'Use lowercase letters, digits and single hyphens; start and end with a letter or digit.')
	.refine((name) => !name.includes('--'), 'Double hyphens are not allowed.');

/** A local target must be an absolute, normalized path the `yoal` user can own. */
export const backupTargetLocalPathSchema = z
	.string()
	.trim()
	.min(2)
	.max(300)
	.refine((value) => value.startsWith('/'), 'Use an absolute path, such as /var/lib/yoal/backups.')
	.refine((value) => value !== '/' && !value.endsWith('/'), 'Use a directory below "/", without a trailing slash.')
	.refine((value) => /^[A-Za-z0-9._/-]+$/.test(value), 'Use only letters, digits, ".", "_", "-" and "/".')
	.refine(
		(value) => !value.split('/').some((part, index) => (index > 0 && part === '') || part === '.' || part === '..'),
		'Use a normalized path, without "//", "." or "..".',
	);

/** `https://…` or `http://…` only; credentials never belong in the URL. */
export const backupTargetEndpointSchema = z
	.string()
	.trim()
	.max(300)
	.url()
	.refine((value) => {
		try {
			const url = new URL(value);
			return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
		} catch {
			return false;
		}
	}, 'Use an http(s) endpoint without a username or password.');

/**
 * Prefix under which backups are written. Relative to the bucket/root, normalized, and without
 * a leading slash so a target can never escape it or collide with the bucket root.
 */
export const backupTargetPathPrefixSchema = z
	.string()
	.trim()
	.max(300)
	.refine((value) => !value.startsWith('/'), 'The path prefix is relative to the bucket/root.')
	.refine((value) => !value.endsWith('/'), 'Drop the trailing slash from the path prefix.')
	.refine((value) => /^[A-Za-z0-9._/-]*$/.test(value), 'Use only letters, digits, ".", "_", "-" and "/".')
	.refine(
		(value) => value === '' || !value.split('/').some((part) => part === '' || part === '.' || part === '..'),
		'The path prefix cannot contain empty, "." or ".." segments.',
	);

export const backupTargetRegionSchema = z
	.string()
	.trim()
	.min(1)
	.max(63)
	.regex(/^[a-z0-9-]+$/, 'Use a region like us-east-1.');

const accessKeyIdSchema = z
	.string()
	.trim()
	.min(3)
	.max(128)
	.refine((value) => !/\s/.test(value), 'Access key ids cannot contain whitespace.');

const secretAccessKeySchema = z
	.string()
	.min(8)
	.max(512)
	.refine((value) => !/[\r\n]/.test(value), 'Secret access keys cannot contain line breaks.');

const localTargetCreateSchema = z
	.strictObject({
		name: backupTargetNameSchema,
		kind: z.literal('local'),
		/** Directory the control plane/agent owns; files are written 0600. */
		path: backupTargetLocalPathSchema,
		/** Write-only targets keep PutObject/ListBucket and hold no delete permission. */
		writeOnly: z.boolean().default(false),
	})
	.describe('A directory on the control-plane host.');

const s3TargetCreateSchema = z
	.strictObject({
		name: backupTargetNameSchema,
		kind: z.literal('s3'),
		/** Omit for AWS S3; required for R2/RustFS/MinIO/Garage and other compatible endpoints. */
		endpoint: backupTargetEndpointSchema.optional(),
		bucket: bucketNameSchema,
		region: backupTargetRegionSchema.default('us-east-1'),
		pathPrefix: backupTargetPathPrefixSchema.default('yoal/backups'),
		/** RustFS, MinIO and most self-hosted endpoints need path-style addressing. */
		forcePathStyle: z.boolean().default(true),
		accessKeyId: accessKeyIdSchema,
		secretAccessKey: secretAccessKeySchema,
		/** No DeleteObject; retention GC uses a separate privileged path. */
		writeOnly: z.boolean().default(false),
		/** Bucket object lock keeps artifacts immutable for the retention period. */
		objectLock: z.boolean().default(false),
	})
	.describe('An S3-compatible bucket.');

const azureTargetCreateSchema = z
	.strictObject({
		name: backupTargetNameSchema,
		kind: z.literal('azure'),
		account: azureAccountSchema,
		container: azureContainerSchema,
		/** Omit for Azure; set for Azurite or a sovereign cloud. */
		endpoint: backupTargetEndpointSchema.optional(),
		pathPrefix: backupTargetPathPrefixSchema.default('yoal/backups'),
		/** The storage account's shared key, or a container-scoped SAS token (exactly one). */
		accountKey: z.string().min(16).max(512).optional(),
		sasToken: z.string().min(16).max(2048).optional(),
		writeOnly: z.boolean().default(false),
		/** A container immutability policy keeps artifacts immutable for the retention period. */
		immutable: z.boolean().default(false),
	})
	.refine((input) => (input.accountKey === undefined) !== (input.sasToken === undefined), {
		message: 'Give either an account key or a SAS token.',
		path: ['accountKey'],
	})
	.describe('An Azure Blob Storage container (YOAL_FEATURE_OBJECT_STORE_AZURE).');

const gcsTargetCreateSchema = z
	.strictObject({
		name: backupTargetNameSchema,
		kind: z.literal('gcs'),
		bucket: gcsBucketSchema,
		/** Omit for Google Cloud; set for an emulator. */
		endpoint: backupTargetEndpointSchema.optional(),
		pathPrefix: backupTargetPathPrefixSchema.default('yoal/backups'),
		/** A service-account key file (JSON). */
		serviceAccountJson: z.string().min(20).max(16_384),
		writeOnly: z.boolean().default(false),
		/** A bucket retention policy keeps artifacts immutable for the retention period. */
		immutable: z.boolean().default(false),
	})
	.describe('A Google Cloud Storage bucket (YOAL_FEATURE_OBJECT_STORE_GCS).');

/** Create a target. Credentials are accepted here and sealed; they never reappear in a view. */
export const backupTargetCreateSchema = z.discriminatedUnion('kind', [
	localTargetCreateSchema,
	s3TargetCreateSchema,
	azureTargetCreateSchema,
	gcsTargetCreateSchema,
]);
export type BackupTargetCreate = z.input<typeof backupTargetCreateSchema>;

/**
 * Update a target in place. `kind` is immutable: create a new target and re-point schedules.
 * Omit a credential to keep the stored one; supply it to rotate.
 */
export const backupTargetUpdateSchema = z
	.strictObject({
		name: backupTargetNameSchema.optional(),
		path: backupTargetLocalPathSchema.optional(),
		endpoint: backupTargetEndpointSchema.nullable().optional(),
		bucket: bucketNameSchema.optional(),
		region: backupTargetRegionSchema.optional(),
		pathPrefix: backupTargetPathPrefixSchema.optional(),
		forcePathStyle: z.boolean().optional(),
		writeOnly: z.boolean().optional(),
		objectLock: z.boolean().optional(),
		accessKeyId: accessKeyIdSchema.optional(),
		secretAccessKey: secretAccessKeySchema.optional(),
	})
	.refine((input) => Object.keys(input).length > 0, 'Nothing to update.');
export type BackupTargetUpdate = z.infer<typeof backupTargetUpdateSchema>;

/** What `testConnection()` did and found. Null capability fields mean "not supported/unknown". */
export const backupTargetTestResultSchema = z
	.strictObject({
		ok: z.boolean(),
		checkedAt: z.string(),
		message: z.string().max(2000),
		/** Round-trip latency of the probe, when the target supports one. */
		latencyMs: z.number().int().nonnegative().nullable().default(null),
		versioning: z.boolean().nullable().default(null),
		objectLock: z.boolean().nullable().default(null),
	})
	.describe('Result of a target connection check; contains no credentials.');
export type BackupTargetTestResult = z.infer<typeof backupTargetTestResultSchema>;

/**
 * A target as every surface renders it. There is deliberately no `accessKeyId` or
 * `secretAccessKey` field: list/get/test responses never include credentials.
 */
export const backupTargetViewSchema = z
	.strictObject({
		id: z.string().min(1).max(100),
		/** Null means the platform default target. */
		orgId: z.string().nullable(),
		name: z.string(),
		kind: z.enum(backupTargetKinds),
		/** Local target directory; null for S3 targets. */
		path: z.string().nullable(),
		/** S3 endpoint; null means the AWS default for `region`. */
		endpoint: z.string().nullable(),
		bucket: z.string().nullable(),
		region: z.string().nullable(),
		pathPrefix: z.string(),
		forcePathStyle: z.boolean(),
		writeOnly: z.boolean(),
		objectLock: z.boolean(),
		/** Whether a sealed credential exists. Never the credential itself. */
		hasCredentials: z.boolean(),
		/**
		 * HA-PLAN W3: the target as a credential-free object-store target; null for `local`. Optional
		 * so views built before W3 still parse.
		 */
		store: objectStoreTargetSchema.nullable().optional(),
		status: z.enum(backupTargetStatuses),
		lastCheckedAt: z.string().nullable(),
		lastError: z.string().max(2000).nullable(),
		lastTest: backupTargetTestResultSchema.nullable(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.describe('Backup target view; secrets are never included.');
export type BackupTargetView = z.infer<typeof backupTargetViewSchema>;

/**
 * One-time credential reveal after create or rotate. This is an audited action, not a view:
 * the secret is returned once and never stored in a list/get response.
 */
export interface BackupTargetCredentials {
	targetId: string;
	name: string;
	kind: BackupTargetKind;
	accessKeyId: string;
	secretAccessKey: string;
	endpoint: string | null;
	bucket: string | null;
	region: string | null;
	note: string;
}

/** Resolution order for a resource that does not name a target explicitly (plan 05). */
export const backupTargetSources = ['resource', 'org', 'platform', 'local'] as const;
export type BackupTargetSource = (typeof backupTargetSources)[number];

export interface BackupTargetResolution {
	target: BackupTargetView;
	source: BackupTargetSource;
}
