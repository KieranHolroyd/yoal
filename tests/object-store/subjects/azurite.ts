import { AzureObjectStore } from '../../../packages/core/src/object-store/azure.ts';
import type { ConformanceSubject } from '../../../packages/core/src/object-store/conformance.ts';
import { AZURITE_ACCOUNT, AZURITE_ACCOUNT_KEY } from '../emulators.ts';

export const AZURITE_CONTAINER = 'yoal-conformance';

/** Azurite path-style: `http://127.0.0.1:<port>` needs the account appended to the path. */
function pathStyle(endpoint: string): string {
	const url = new URL(endpoint);
	return url.pathname === '/' || url.pathname === '' ? `${endpoint.replace(/\/+$/, '')}/${AZURITE_ACCOUNT}` : endpoint;
}

/** Azurite through the production `AzureObjectStore` (Shared Key, path-style endpoint). */
export async function azuriteSubject(endpoint: string): Promise<ConformanceSubject> {
	const open = (options: { prefix?: string; endpoint?: string; timeoutMs?: number } = {}) =>
		new AzureObjectStore({
			endpoint: pathStyle(options.endpoint ?? endpoint),
			account: AZURITE_ACCOUNT,
			container: AZURITE_CONTAINER,
			prefix: options.prefix,
			accountKey: AZURITE_ACCOUNT_KEY,
			timeoutMs: options.timeoutMs,
		});
	const store = open();
	await store.ensureContainer();
	return {
		name: 'azurite (azure)',
		open,
		// A SAS signs the URL; Put Blob still requires `x-ms-blob-type`, which the uploader sends.
		presign: { putHeaders: { 'x-ms-blob-type': 'BlockBlob' } },
		immutable: undefined,
	};
}
