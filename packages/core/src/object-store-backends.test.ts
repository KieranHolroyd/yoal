import { describe, expect, test } from 'bun:test';
import { AzureObjectStore } from './object-store/azure.ts';
import { GcsObjectStore } from './object-store/gcs.ts';
import { createObjectStore } from './object-store-factory.ts';

/**
 * The factory and the two W3 backends without a network. The behaviour of every operation is
 * proved by the conformance suite (`object-store/conformance.test.ts` against memory, and
 * `bun tests/object-store/conformance.e2e.ts` against Azurite and fake-gcs-server); this file pins
 * the mapping from a stored target to a backend and the presign shape.
 */

const azureTarget = {
	kind: 'azure' as const,
	account: 'acct1',
	container: 'yoal',
	endpoint: null,
	pathPrefix: 'yoal/backups',
	immutability: null,
};
const gcsTarget = {
	kind: 'gcs' as const,
	bucket: 'yoal-ha',
	endpoint: null,
	pathPrefix: 'yoal/backups',
	immutability: null,
};

describe('object-store factory (W3)', () => {
	test('an Azure target builds the Blob backend with the account endpoint', () => {
		const store = createObjectStore(azureTarget, { kind: 'azure', accountKey: 'k'.repeat(32) });
		expect(store).toBeInstanceOf(AzureObjectStore);
		expect(store.kind).toBe('azure');
	});

	test('a GCS target builds the JSON API backend', () => {
		const store = createObjectStore(gcsTarget, {
			kind: 'gcs',
			serviceAccountJson: JSON.stringify({ client_email: 'a@b', private_key: 'not-a-real-key' }),
		});
		expect(store).toBeInstanceOf(GcsObjectStore);
		expect(store.kind).toBe('gcs');
	});

	test('credentials for another kind are refused', () => {
		expect(() => createObjectStore(azureTarget, { kind: 'gcs', serviceAccountJson: '{}' })).toThrow('credentials are for gcs');
	});

	test('Azure Blob needs exactly one credential', () => {
		expect(() => new AzureObjectStore({ endpoint: 'http://127.0.0.1:10000/devstoreaccount1', account: 'devstoreaccount1', container: 'yoal' })).toThrow(
			'exactly one',
		);
		expect(
			() =>
				new AzureObjectStore({
					endpoint: 'http://127.0.0.1:10000/devstoreaccount1',
					account: 'devstoreaccount1',
					container: 'yoal',
					accountKey: 'a'.repeat(32),
					sasToken: 'sv=2021-12-02&sig=x',
				}),
		).toThrow('exactly one');
	});

	test('an Azure service SAS carries a blob resource, an expiry and a signature', async () => {
		const store = new AzureObjectStore({
			endpoint: 'https://acct1.blob.core.windows.net',
			account: 'acct1',
			container: 'yoal',
			accountKey: Buffer.from('not-a-real-azure-key').toString('base64'),
		});
		const put = new URL(await store.presignPut('releases/a.zip', 300));
		expect(put.pathname).toBe('/yoal/releases/a.zip');
		expect(put.searchParams.get('sr')).toBe('b');
		expect(put.searchParams.get('sp')).toBe('w');
		expect(put.searchParams.get('sv')).toBe('2021-12-02');
		expect(put.searchParams.get('se')).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
		expect(put.searchParams.get('sig')).toBeTruthy();
		const get = new URL(await store.presignGet('releases/a.zip', 60));
		expect(get.searchParams.get('sp')).toBe('r');
	});

	test('a supplied SAS is reused rather than re-signed', async () => {
		const store = new AzureObjectStore({
			endpoint: 'https://acct1.blob.core.windows.net',
			account: 'acct1',
			container: 'yoal',
			sasToken: '?sv=2021-12-02&sr=c&sp=rw&sig=abc',
		});
		const url = new URL(await store.presignGet('a.txt', 300));
		expect(url.searchParams.get('sr')).toBe('c');
		expect(url.searchParams.get('sig')).toBe('abc');
	});

	test('an anonymous GCS store cannot presign (a signature needs a key), and says so', () => {
		const store = new GcsObjectStore({ bucket: 'yoal-ha', anonymous: true });
		expect(() => store.presignGet('a.txt', 60)).toThrow('service-account key');
	});
});
