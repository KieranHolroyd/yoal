import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DocsLibrary, type BundledDocs } from './docs.ts';
import { BUNDLED_DOCS_FINGERPRINT, isBundle, newerVersion, resolveDocsSource, type DocsSourceDeps } from './docs-source.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-docs-source-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const page = (slug: string, body: string) => ({
	slug,
	title: slug,
	description: '',
	sections: [{ anchor: '', heading: '', depth: 0, markdown: body }],
});
const bundled = new DocsLibrary({ sections: [{ id: 'self-hosting', title: 'Self-hosting', pages: [page('self-hosting/clustering', 'old text')] }] });
const served: BundledDocs = { sections: [{ id: 'self-hosting', title: 'Self-hosting', pages: [page('self-hosting/clustering', 'new text')] }] };
const BUNDLED_FP = 'bundledfp';

function platform(version: string, options: { fail?: 'info' | 'bundle'; missing?: boolean; fingerprint?: string | null; bundle?: unknown } = {}) {
	const calls = { info: 0, bundle: 0 };
	const fingerprint = options.fingerprint === undefined ? `fp${version.replace(/\D/g, '')}` : options.fingerprint;
	const client = {
		docsInfo: async () => {
			calls.info++;
			if (options.fail === 'info') throw new Error('unreachable');
			return options.missing ? null : { version, fingerprint: `db-${version}`, bundleFingerprint: fingerprint };
		},
		docsBundle: async () => {
			calls.bundle++;
			if (options.fail === 'bundle') throw new Error('boom');
			return { version, fingerprint: fingerprint ?? '', bundle: options.bundle ?? served };
		},
	};
	return {
		calls,
		deps: (cacheDir = dir): DocsSourceDeps => ({
			connect: async () => ({ url: 'https://control.test', client }),
			cacheDir,
			bundled: () => bundled,
			bundledVersion: '0.15.3',
			bundledFingerprint: BUNDLED_FP,
		}),
	};
}

describe('yoal docs source (HA-PLAN F5)', () => {
	test('the CLI knows its own bundle fingerprint', () => {
		expect(BUNDLED_DOCS_FINGERPRINT).toMatch(/^[0-9a-f]{16}$/);
	});

	test('not logged in, or --bundled: the bundled docs, no network, no notice', async () => {
		const none = await resolveDocsSource({}, { connect: async () => null, bundled: () => bundled, bundledVersion: '0.15.3' });
		expect(none).toMatchObject({ kind: 'bundled', docsVersion: '0.15.3', notice: null, platform: null });
		const { calls, deps } = platform('0.16.0');
		expect((await resolveDocsSource({ bundledOnly: true }, deps())).kind).toBe('bundled');
		expect(calls.info).toBe(0);
	});

	test('the same docs (by fingerprint) read the bundle without fetching, whatever the version', async () => {
		const { calls, deps } = platform('0.16.0', { fingerprint: BUNDLED_FP });
		expect(await resolveDocsSource({}, deps())).toMatchObject({ kind: 'bundled', platform: { version: '0.16.0' }, notice: null });
		expect(calls.bundle).toBe(0);
	});

	test('the same version with different docs (a branch build) reads the platform docs', async () => {
		const { calls, deps } = platform('0.15.3', { fingerprint: 'branchfp' });
		const source = await resolveDocsSource({}, deps(join(dir, 'cache-branch')));
		expect(source.kind).toBe('platform');
		expect(source.library.read('self-hosting/clustering').markdown).toContain('new text');
		expect(calls.bundle).toBe(1);
	});

	test('a platform without bundleFingerprint is compared by version', async () => {
		const same = platform('0.15.3', { fingerprint: null });
		expect((await resolveDocsSource({}, same.deps())).kind).toBe('bundled');
		expect(same.calls.bundle).toBe(0);
	});

	test("different docs are fetched once, then served from the cache", async () => {
		const cache = join(dir, 'cache-a');
		const { calls, deps } = platform('0.16.0');
		const first = await resolveDocsSource({}, deps(cache));
		expect(first).toMatchObject({ kind: 'platform', docsVersion: '0.16.0', notice: null });
		expect(first.library.read('self-hosting/clustering').markdown).toContain('new text');
		expect(readdirSync(cache)).toEqual(['fp0160.json.gz']);
		expect((await resolveDocsSource({}, deps(cache))).kind).toBe('platform');
		expect(calls.bundle).toBe(1);
	});

	test('a cache file with the wrong shape is dropped and fetched again', async () => {
		const cache = join(dir, 'cache-bad');
		mkdirSync(cache, { recursive: true });
		writeFileSync(join(cache, 'fp0170.json.gz'), gzipSync(JSON.stringify({ sections: [{ id: 'x', title: 'X', pages: [{ slug: 'a' }] }] })));
		const { calls, deps } = platform('0.17.0');
		const source = await resolveDocsSource({}, deps(cache));
		expect(source.kind).toBe('platform');
		expect(calls.bundle).toBe(1);
		expect(source.library.read('self-hosting/clustering').markdown).toContain('new text');
	});

	test('a malformed bundle from the platform is never used or cached', async () => {
		const cache = join(dir, 'cache-junk');
		const { deps } = platform('0.18.0', { bundle: { sections: [{ id: 's', title: 'S', pages: [{ slug: 'p', title: 'P', description: '' }] }] } });
		const source = await resolveDocsSource({}, deps(cache));
		expect(source.kind).toBe('bundled');
		expect(source.notice).toContain('newer than the docs bundled');
		expect(() => readdirSync(cache)).toThrow();
	});

	test('warns when the platform is newer and its docs cannot be fetched', async () => {
		const { deps } = platform('0.16.0', { fail: 'bundle' });
		const source = await resolveDocsSource({}, deps(join(dir, 'cache-b')));
		expect(source.kind).toBe('bundled');
		expect(source.notice).toContain('newer than the docs bundled');
		expect(source.library.read('self-hosting/clustering').markdown).toContain('old text');
	});

	test('an unreachable platform falls back with a notice; an older platform without the endpoint quietly', async () => {
		expect((await resolveDocsSource({}, platform('0.16.0', { fail: 'info' }).deps())).notice).toContain('Could not reach');
		expect(await resolveDocsSource({}, platform('0.14.0', { missing: true }).deps())).toMatchObject({ kind: 'bundled', notice: null });
	});

	test('checks bundle shape in depth', () => {
		expect(isBundle(served)).toBe(true);
		expect(isBundle({ sections: [{ id: 'a', title: 'A', pages: [{ slug: 'p', title: 'P', description: '', sections: [{ anchor: '', heading: '', depth: '0', markdown: '' }] }] }] })).toBe(false);
		expect(isBundle(null)).toBe(false);
	});

	test('compares versions', () => {
		expect(newerVersion('0.16.0', '0.15.3')).toBe(true);
		expect(newerVersion('0.15.3', '0.15.3')).toBe(false);
		expect(newerVersion('0.15.10', '0.15.9')).toBe(true);
		expect(newerVersion('1.0.0', '1.0.0-rc.1')).toBe(true);
		expect(newerVersion('0.15.2', '0.15.3')).toBe(false);
		expect(newerVersion('garbage', '0.15.3')).toBe(false);
	});
});
