import { AwsClient } from 'aws4fetch';
import { S3ObjectStore } from '../../../packages/core/src/object-store.ts';
import type { ConformanceSubject } from '../../../packages/core/src/object-store/conformance.ts';
import { MINIO_ACCESS_KEY, MINIO_SECRET_KEY } from '../emulators.ts';

export const MINIO_BUCKET = 'yoal-conformance';
export const MINIO_LOCK_BUCKET = 'yoal-conformance-lock';

async function ensureBucket(endpoint: string, bucket: string, objectLock: boolean): Promise<void> {
	const client = new AwsClient({ accessKeyId: MINIO_ACCESS_KEY, secretAccessKey: MINIO_SECRET_KEY, service: 's3', region: 'us-east-1' });
	const response = await client.fetch(`${endpoint}/${bucket}`, {
		method: 'PUT',
		headers: objectLock ? { 'x-amz-bucket-object-lock-enabled': 'true' } : {},
	});
	const text = await response.text();
	if (!response.ok && !/BucketAlreadyOwnedByYou/.test(text)) throw new Error(`create bucket ${bucket}: ${response.status} ${text}`);
}

/** MinIO through the production `S3ObjectStore`, as an R2-style install configures it (path-style). */
export async function minioSubject(endpoint: string): Promise<ConformanceSubject> {
	await ensureBucket(endpoint, MINIO_BUCKET, false);
	await ensureBucket(endpoint, MINIO_LOCK_BUCKET, true);
	const open = (bucket: string, options: { prefix?: string; endpoint?: string; timeoutMs?: number } = {}) =>
		new S3ObjectStore({
			endpoint: options.endpoint ?? endpoint,
			bucket,
			region: 'us-east-1',
			forcePathStyle: true,
			prefix: options.prefix,
			accessKeyId: MINIO_ACCESS_KEY,
			secretAccessKey: MINIO_SECRET_KEY,
			timeoutMs: options.timeoutMs,
		});
	return {
		name: 'minio (s3)',
		open: (options) => open(MINIO_BUCKET, options),
		presign: true,
		immutable: { open: () => open(MINIO_LOCK_BUCKET, { prefix: 'conformance' }), expectObjectLock: true },
	};
}
