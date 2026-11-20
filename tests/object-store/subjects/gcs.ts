import { GcsObjectStore } from '../../../packages/core/src/object-store/gcs.ts';
import type { ConformanceSubject } from '../../../packages/core/src/object-store/conformance.ts';

export const GCS_BUCKET = 'yoal-conformance';

/** fake-gcs-server through the production `GcsObjectStore` (anonymous; it does not verify tokens). */
export async function gcsSubject(endpoint: string): Promise<ConformanceSubject> {
	const open = (options: { prefix?: string; endpoint?: string; timeoutMs?: number } = {}) =>
		new GcsObjectStore({
			endpoint: options.endpoint ?? endpoint,
			bucket: GCS_BUCKET,
			prefix: options.prefix,
			anonymous: true,
			timeoutMs: options.timeoutMs,
		});
	await open().ensureBucket();
	return {
		name: 'fake-gcs-server (gcs)',
		open,
		// fake-gcs-server does not implement the XML API's V4 signature; presigning is a real-GCS path.
		presign: false,
		immutable: undefined,
	};
}
