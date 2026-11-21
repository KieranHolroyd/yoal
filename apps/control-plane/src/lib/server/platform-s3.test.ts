import { describe, expect, test } from 'bun:test';
import { s3StoreConfigured } from './s3-store.js';

/**
 * The platform's S3 store (`YOAL_OBJECT_STORE=r2`) on any S3 endpoint: `install.sh --object-store
 * s3://` writes an endpoint and region and no account id, which only derives an R2 endpoint.
 */
describe('platform S3 store', () => {
	const keys = { R2_BUCKET: 'yoal', R2_ACCESS_KEY_ID: 'AK', R2_SECRET_ACCESS_KEY: 'SK' };
	test('an explicit endpoint stands in for the R2 account id', () => {
		expect(s3StoreConfigured({ ...keys, R2_ENDPOINT: 'https://s3.eu-west-2.amazonaws.com' })).toBe(true);
		expect(s3StoreConfigured({ ...keys, R2_ACCOUNT_ID: 'acc' })).toBe(true);
		expect(s3StoreConfigured(keys)).toBe(false);
		expect(s3StoreConfigured({ ...keys, R2_ENDPOINT: 'https://x', R2_BUCKET: '' })).toBe(false);
	});
});
