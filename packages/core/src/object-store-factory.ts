import {
	DEFAULT_OBJECT_STORE_REGION,
	type ObjectStoreCredentials,
	type ObjectStoreTarget,
} from '@yoal/contracts';
import { S3ObjectStore, type ObjectStore } from './object-store.ts';

/**
 * One `ObjectStore` from a target and its credentials (HA-PLAN W3, G17). Owned by Wave 1 lane E,
 * which fills in `azure` and `gcs` and moves backup targets, PITR and the platform store onto it.
 * Unreachable for `azure` and `gcs` while `OBJECT_STORE_AZURE` / `OBJECT_STORE_GCS` are off:
 * every caller refuses those kinds first (`objectStoreKindIssue`).
 */
export interface ObjectStoreFactoryOptions {
	/** Test seam; production uses the global fetch. */
	fetch?: typeof fetch;
}

export function createObjectStore(
	target: ObjectStoreTarget,
	credentials: ObjectStoreCredentials,
	options: ObjectStoreFactoryOptions = {},
): ObjectStore {
	if (credentials.kind !== target.kind)
		throw new Error(`object-store credentials are for ${credentials.kind}, the target is ${target.kind}`);
	switch (target.kind) {
		case 's3': {
			if (credentials.kind !== 's3') throw new Error('unreachable');
			const region = target.region || DEFAULT_OBJECT_STORE_REGION;
			return new S3ObjectStore({
				endpoint: target.endpoint ?? `https://s3.${region === 'auto' ? 'us-east-1' : region}.amazonaws.com`,
				bucket: target.bucket,
				region,
				forcePathStyle: target.pathStyle,
				prefix: target.pathPrefix,
				accessKeyId: credentials.accessKeyId,
				secretAccessKey: credentials.secretAccessKey,
				fetch: options.fetch,
			});
		}
		case 'azure':
			return createAzureObjectStore(target, credentials as Extract<ObjectStoreCredentials, { kind: 'azure' }>, options);
		case 'gcs':
			return createGcsObjectStore(target, credentials as Extract<ObjectStoreCredentials, { kind: 'gcs' }>, options);
	}
}

/** Azure Blob Storage (Azurite through `target.endpoint`). Wave 1 lane E. */
export function createAzureObjectStore(
	_target: Extract<ObjectStoreTarget, { kind: 'azure' }>,
	_credentials: Extract<ObjectStoreCredentials, { kind: 'azure' }>,
	_options: ObjectStoreFactoryOptions = {},
): ObjectStore {
	throw new Error('not implemented (HA Wave 1 lane E): Azure Blob object store');
}

/** Google Cloud Storage (an emulator through `target.endpoint`). Wave 1 lane E. */
export function createGcsObjectStore(
	_target: Extract<ObjectStoreTarget, { kind: 'gcs' }>,
	_credentials: Extract<ObjectStoreCredentials, { kind: 'gcs' }>,
	_options: ObjectStoreFactoryOptions = {},
): ObjectStore {
	throw new Error('not implemented (HA Wave 1 lane E): GCS object store');
}
