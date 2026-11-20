import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IngressSecretsStore, ingressListeners } from './ingress.ts';
import { UsedTokenCache } from './verify.ts';

/** HA Wave 2 W6: node-side ingress listeners, secret custody and the persisted redeemed-token cache. */

const dir = mkdtempSync(join(tmpdir(), 'yoal-agent-ingress-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('ingress listeners (G5)', () => {
	test('a worker that gains the role keeps its private listener and adds the public one', () => {
		expect(new Set(ingressListeners(['10.47.1.2:8080'], [':443'], true))).toEqual(new Set(['10.47.1.2:8080', ':443']));
	});

	test('an existing edge keeps its TLS listener and drops the redirect port', () => {
		expect(ingressListeners([':443', ':80'], [':443'], true)).toEqual([':443']);
	});

	test('with no desired payload the old behaviour is unchanged', () => {
		expect(ingressListeners([':443', ':80'], undefined, true)).toEqual([':443']);
		expect(ingressListeners(['10.0.0.2:8080'], undefined, false)).toEqual(['10.0.0.2:8080']);
	});
});

describe('ingress secrets (G8)', () => {
	test('caches the activation 0600 and reads it after a restart', () => {
		const store = new IngressSecretsStore(join(dir, 'secrets'));
		const secrets = { accessJwtSecret: 'jwt-secret-value', siteCookieSecret: 'cookie-secret-value', cloudflareApiToken: null };
		store.save(secrets);
		expect(statSync(store.path).mode & 0o777).toBe(0o600);
		expect(readFileSync(store.path, 'utf8')).toContain('jwt-secret-value');
		expect(new IngressSecretsStore(join(dir, 'secrets')).load()).toEqual(secrets);
	});

	test('a missing or corrupt cache is null, never a crash', () => {
		expect(new IngressSecretsStore(join(dir, 'missing')).load()).toBeNull();
		const store = new IngressSecretsStore(join(dir, 'corrupt'));
		store.save({ accessJwtSecret: 'jwt-secret-value', siteCookieSecret: 'cookie-secret-value', cloudflareApiToken: null });
		writeFileSync(store.path, '{"accessJwtSecret":');
		expect(store.load()).toBeNull();
	});
});

describe('redeemed-token cache', () => {
	test('a redeemed id survives a new cache instance', () => {
		const file = join(dir, 'redeemed.json');
		const first = new UsedTokenCache({ file });
		expect(first.claim('jti_one', 2_000, 1_000)).toBe(true);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		const second = new UsedTokenCache({ file });
		expect(second.claim('jti_one', 2_000, 1_001)).toBe(false);
		expect(second.claim('jti_two', 2_000, 1_001)).toBe(true);
		expect(second.size).toBe(2);
	});

	test('the memory-only cache is unchanged', () => {
		const cache = new UsedTokenCache();
		expect(cache.claim('jti', 2_000, 1_000)).toBe(true);
		expect(cache.claim('jti', 2_000, 1_000)).toBe(false);
	});
});
