import * as z from 'zod';
import { bucketNameSchema } from './object-storage.ts';
import type { FeatureFlags } from './features.ts';

/**
 * Object-store targets (HA-PLAN W3, G17; docs/build-plan/HA-WAVE-1.md lane E).
 *
 * One credential-free description of "a bucket somewhere", used by backup targets, the PITR
 * repository, the platform store and (Wave 3) the arbiter. Three backends: `s3` (AWS, R2, MinIO,
 * RustFS, Garage, …), `azure` (Blob Storage; Azurite through `endpoint`) and `gcs` (Google Cloud
 * Storage; an emulator through `endpoint`).
 *
 * Credentials are never part of a target. They are accepted once on create or rotate as an
 * `ObjectStoreCredentials` value and stored the way each surface already stores them: sealed
 * columns on `backup_targets` (`access_key_sealed`, `secret_sealed`), and keys in `yoal.env` for
 * the platform store (`PLATFORM_OBJECT_STORE_ENV`). Views and desired state never carry them.
 *
 * Anything stored before this file existed has no `kind` and is an S3 target with today's
 * behaviour (`parseStoredObjectStoreTarget`).
 */

export const objectStoreKinds = ['s3', 'azure', 'gcs'] as const;
export type ObjectStoreTargetKind = (typeof objectStoreKinds)[number];

/**
 * The agent capability that says a build's helper renders `azure` and `gcs` repositories
 * (pgBackRest `repo1-type`, Litestream). A non-`s3` target is never handed to a node without it,
 * and is sent in a shape an older agent cannot parse (`databasePitrStoreActivationSchema`): an
 * older agent drops unknown keys and would otherwise write an S3 config.
 */
export const OBJECT_STORE_KINDS_CAPABILITY = 'object-store-kinds';

/** The opt-in flag each non-`s3` backend needs; `s3` needs none. */
export const OBJECT_STORE_KIND_FLAGS = {
	azure: 'OBJECT_STORE_AZURE',
	gcs: 'OBJECT_STORE_GCS',
} as const satisfies Partial<Record<ObjectStoreTargetKind, keyof FeatureFlags>>;

/** The S3 region when none is given: what R2 expects and what the platform store hard-codes today. */
export const DEFAULT_OBJECT_STORE_REGION = 'auto';

/** `https://…` or `http://…` (emulators), no credentials, no query. */
export const objectStoreEndpointSchema = z
	.string()
	.trim()
	.max(300)
	.refine((value) => {
		try {
			const url = new URL(value);
			return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && !url.search && !url.hash;
		} catch {
			return false;
		}
	}, 'Use an http(s) endpoint without a username, password or query.');

export const objectStoreRegionSchema = z
	.string()
	.trim()
	.min(1)
	.max(63)
	.regex(/^[a-z0-9-]+$/, 'Use a region like us-east-1, or auto.');

/** Relative to the bucket or container, normalized, no leading or trailing slash. */
export const objectStorePathPrefixSchema = z
	.string()
	.trim()
	.max(300)
	.refine((value) => /^[A-Za-z0-9._/-]*$/.test(value), 'Use only letters, digits, ".", "_", "-" and "/".')
	.refine(
		(value) => value === '' || !value.split('/').some((part) => part === '' || part === '.' || part === '..'),
		'The path prefix cannot start or end with "/", or contain empty, "." or ".." segments.',
	);

/** Azure storage account names: 3–24 lowercase letters and digits. */
export const azureAccountSchema = z
	.string()
	.trim()
	.regex(/^[a-z0-9]{3,24}$/, 'Azure storage account names are 3–24 lowercase letters and digits.');

/** Azure container names: 3–63 lowercase letters, digits and single hyphens. */
export const azureContainerSchema = z
	.string()
	.trim()
	.min(3)
	.max(63)
	.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Azure container names use lowercase letters, digits and hyphens.')
	.refine((name) => !name.includes('--'), 'Double hyphens are not allowed in container names.');

/** GCS bucket names: 3–63 characters of lowercase letters, digits, `-`, `_` and `.` (no dotted 222-char form). */
export const gcsBucketSchema = z
	.string()
	.trim()
	.min(3)
	.max(63)
	.regex(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/, 'GCS bucket names use lowercase letters, digits, "-", "_" and ".".')
	.refine((name) => !name.startsWith('goog') && !name.includes('google'), 'GCS bucket names cannot start with "goog" or contain "google".');

/**
 * Write-once retention on the target, recorded per target (W3). The mechanism follows the kind:
 * S3 object lock, an Azure immutability policy, a GCS bucket retention policy. Null means the
 * target is not immutable. `retentionDays` null means "whatever the bucket's default is".
 */
export const objectStoreImmutabilitySchema = z
	.object({
		retentionDays: z.number().int().min(1).max(36_500).nullable().default(null),
	})
	.nullable()
	.default(null);
export type ObjectStoreImmutability = z.infer<typeof objectStoreImmutabilitySchema>;

export const objectStoreImmutabilityMechanisms = {
	s3: 's3-object-lock',
	azure: 'azure-immutability-policy',
	gcs: 'gcs-retention-policy',
} as const satisfies Record<ObjectStoreTargetKind, string>;

export const s3ObjectStoreTargetSchema = z.object({
	kind: z.literal('s3'),
	/** Null means AWS S3 for `region`; required for R2, MinIO, RustFS, Garage and other endpoints. */
	endpoint: objectStoreEndpointSchema.nullable().default(null),
	region: objectStoreRegionSchema.default(DEFAULT_OBJECT_STORE_REGION),
	bucket: bucketNameSchema,
	pathPrefix: objectStorePathPrefixSchema.default(''),
	/** Path-style addressing (`endpoint/bucket/key`); RustFS, MinIO and most self-hosted stores need it. */
	pathStyle: z.boolean().default(true),
	immutability: objectStoreImmutabilitySchema,
});

export const azureObjectStoreTargetSchema = z.object({
	kind: z.literal('azure'),
	account: azureAccountSchema,
	container: azureContainerSchema,
	/** Null means `https://<account>.blob.core.windows.net`; set for Azurite or a sovereign cloud. */
	endpoint: objectStoreEndpointSchema.nullable().default(null),
	pathPrefix: objectStorePathPrefixSchema.default(''),
	immutability: objectStoreImmutabilitySchema,
});

export const gcsObjectStoreTargetSchema = z.object({
	kind: z.literal('gcs'),
	bucket: gcsBucketSchema,
	/** Null means `https://storage.googleapis.com`; set for an emulator (fake-gcs-server). */
	endpoint: objectStoreEndpointSchema.nullable().default(null),
	pathPrefix: objectStorePathPrefixSchema.default(''),
	immutability: objectStoreImmutabilitySchema,
});

/** A credential-free object-store target. Safe for views, audit args and desired state. */
export const objectStoreTargetSchema = z.discriminatedUnion('kind', [
	s3ObjectStoreTargetSchema,
	azureObjectStoreTargetSchema,
	gcsObjectStoreTargetSchema,
]);
export type ObjectStoreTarget = z.infer<typeof objectStoreTargetSchema>;
export type ObjectStoreTargetInput = z.input<typeof objectStoreTargetSchema>;

const singleLine = (label: string, min: number, max: number) =>
	z
		.string()
		.min(min)
		.max(max)
		.refine((value) => !/[\r\n\0]/.test(value), `${label} cannot contain line breaks.`);

/**
 * Write-only credentials for a target. Accepted on create and rotate, sealed at once, never
 * returned by a view and never placed in desired state (HA-PLAN §10).
 */
export const objectStoreCredentialsSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('s3'),
		accessKeyId: singleLine('Access key ids', 3, 128).refine((value) => !/\s/.test(value), 'Access key ids cannot contain whitespace.'),
		secretAccessKey: singleLine('Secret access keys', 8, 512),
	}),
	z
		.strictObject({
			kind: z.literal('azure'),
			/** The storage account's shared key (base64). */
			accountKey: singleLine('Account keys', 16, 512).optional(),
			/** A SAS token scoped to the container, instead of the account key. */
			sasToken: singleLine('SAS tokens', 16, 2048).optional(),
		})
		.refine((value) => (value.accountKey === undefined) !== (value.sasToken === undefined), 'Give either an account key or a SAS token.'),
	z.strictObject({
		kind: z.literal('gcs'),
		/** A service-account key file (JSON). Workload identity on GCE is Wave 3. */
		serviceAccountJson: z
			.string()
			.min(20)
			.max(16_384)
			.refine((value) => {
				try {
					const parsed = JSON.parse(value) as Record<string, unknown>;
					return typeof parsed.client_email === 'string' && typeof parsed.private_key === 'string';
				} catch {
					return false;
				}
			}, 'Give a service-account key file (JSON with client_email and private_key).'),
	}),
]);
export type ObjectStoreCredentials = z.infer<typeof objectStoreCredentialsSchema>;

/**
 * Read a stored target. A value without `kind` predates this file and is an S3 target in the
 * shape backup targets and the platform store used (`forcePathStyle`, `objectLock`): it keeps
 * today's behaviour, region included.
 */
export function parseStoredObjectStoreTarget(raw: unknown): ObjectStoreTarget {
	if (raw && typeof raw === 'object' && !Array.isArray(raw) && !('kind' in raw)) {
		const legacy = raw as {
			endpoint?: string | null;
			region?: string | null;
			bucket?: string;
			pathPrefix?: string;
			forcePathStyle?: boolean;
			objectLock?: boolean;
		};
		return objectStoreTargetSchema.parse({
			kind: 's3',
			endpoint: legacy.endpoint ?? null,
			region: legacy.region ?? DEFAULT_OBJECT_STORE_REGION,
			bucket: legacy.bucket,
			pathPrefix: legacy.pathPrefix ?? '',
			pathStyle: legacy.forcePathStyle ?? true,
			immutability: legacy.objectLock ? { retentionDays: null } : null,
		});
	}
	return objectStoreTargetSchema.parse(raw);
}

/** Why `kind` cannot be used on this install, or null. `s3` is always allowed. */
export function objectStoreKindIssue(kind: ObjectStoreTargetKind, features: Pick<FeatureFlags, 'OBJECT_STORE_AZURE' | 'OBJECT_STORE_GCS'>): string | null {
	if (kind === 's3') return null;
	const flag = OBJECT_STORE_KIND_FLAGS[kind];
	if (features[flag]) return null;
	const name = kind === 'azure' ? 'Azure Blob Storage' : 'Google Cloud Storage';
	return `${name} targets are not enabled on this platform (YOAL_FEATURE_${flag}).`;
}
