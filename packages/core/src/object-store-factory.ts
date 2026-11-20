import {
	DEFAULT_OBJECT_STORE_REGION,
	type ObjectStoreCredentials,
	type ObjectStoreTarget,
} from '@yoal/contracts';
import { S3ObjectStore, type ObjectStore } from './object-store.ts';
import { AzureObjectStore } from './object-store/azure.ts';
import { GcsObjectStore } from './object-store/gcs.ts';

/**
 * One `ObjectStore` from a target and its credentials (HA-PLAN W3, G17). Every surface that opens
 * a configured bucket — the platform store, backup targets, PITR and (Wave 3) the arbiter — goes
 * through here, so a backend is configured once and behaves the same everywhere.
 *
 * Unreachable for `azure` and `gcs` while `OBJECT_STORE_AZURE` / `OBJECT_STORE_GCS` are off: every
 * caller refuses those kinds first (`objectStoreKindIssue`).
 */
export interface ObjectStoreFactoryOptions {
	/** Test seam; production uses the global fetch. */
	fetch?: typeof fetch;
	/** Per-request timeout override (ms); the backend default is 15 s. */
	timeoutMs?: number;
}

export function createObjectStore(
	target: ObjectStoreTarget,
	credentials: ObjectStoreCredentials,
	options: ObjectStoreFactoryOptions = {},
): ObjectStore {
	if (credentials.kind !== target.kind)
		throw new Error(`object-store credentials are for ${credentials.kind}, the target is ${target.kind}`);
	switch (target.kind) {
		case 's3':
			return createS3ObjectStore(target, credentials as Extract<ObjectStoreCredentials, { kind: 's3' }>, options);
		case 'azure':
			return createAzureObjectStore(target, credentials as Extract<ObjectStoreCredentials, { kind: 'azure' }>, options);
		case 'gcs':
			return createGcsObjectStore(target, credentials as Extract<ObjectStoreCredentials, { kind: 'gcs' }>, options);
	}
}

/** S3 (AWS, R2, MinIO, RustFS, Garage). `region` and `pathStyle` are the W3 additive options. */
export function createS3ObjectStore(
	target: Extract<ObjectStoreTarget, { kind: 's3' }>,
	credentials: Extract<ObjectStoreCredentials, { kind: 's3' }>,
	options: ObjectStoreFactoryOptions = {},
): S3ObjectStore {
	const region = target.region || DEFAULT_OBJECT_STORE_REGION;
	return new S3ObjectStore({
		endpoint: target.endpoint ?? `https://s3.${region === 'auto' ? 'us-east-1' : region}.amazonaws.com`,
		bucket: target.bucket,
		region,
		forcePathStyle: target.pathStyle,
		prefix: target.pathPrefix || undefined,
		accessKeyId: credentials.accessKeyId,
		secretAccessKey: credentials.secretAccessKey,
		timeoutMs: options.timeoutMs,
		fetch: options.fetch,
	});
}

/** Azure Blob Storage (Azurite through `target.endpoint`). */
export function createAzureObjectStore(
	target: Extract<ObjectStoreTarget, { kind: 'azure' }>,
	credentials: Extract<ObjectStoreCredentials, { kind: 'azure' }>,
	options: ObjectStoreFactoryOptions = {},
): AzureObjectStore {
	return new AzureObjectStore({
		endpoint: target.endpoint ?? `https://${target.account}.blob.core.windows.net`,
		account: target.account,
		container: target.container,
		prefix: target.pathPrefix || undefined,
		accountKey: credentials.accountKey,
		sasToken: credentials.sasToken,
		timeoutMs: options.timeoutMs,
		fetch: options.fetch,
	});
}

/** Google Cloud Storage (fake-gcs-server through `target.endpoint`). */
export function createGcsObjectStore(
	target: Extract<ObjectStoreTarget, { kind: 'gcs' }>,
	credentials: Extract<ObjectStoreCredentials, { kind: 'gcs' }>,
	options: ObjectStoreFactoryOptions = {},
): GcsObjectStore {
	return new GcsObjectStore({
		bucket: target.bucket,
		endpoint: target.endpoint ?? undefined,
		prefix: target.pathPrefix || undefined,
		serviceAccountJson: credentials.serviceAccountJson,
		timeoutMs: options.timeoutMs,
		fetch: options.fetch,
	});
}
