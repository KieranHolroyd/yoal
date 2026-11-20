import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocsLibrary, type BundledDocs } from './docs.ts';
import { newerVersion, resolveDocsSource, type DocsSourceDeps } from './docs-source.ts';

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

function platform(version: string, options: { fail?: 'info' | 'bundle'; missing?: boolean } = {}) {
	const calls = { info: 0, bundle: 0 };
	const client = {
		docsInfo: async () => {
			calls.info++;
			if (options.fail === 'info') throw new Error('unreachable');
			return options.missing ? null : { version, fingerprint: `fp-${version}` };
		},
		docsBundle: async () => {
			calls.bundle++;
			if (options.fail === 'bundle') throw new Error('boom');
			return { version, fingerprint: `fp-${version}`, bundle: served };
		},
	};
	return { calls, deps: (cacheDir = dir): DocsSourceDeps => ({ connect: async () => ({ url: 'https://control.test', client }), cacheDir, bundled: () => bundled, bundledVersion: '0.15.3' }) };
}

describe('yoal docs source (HA-PLAN F5)', () => {
	test('not logged in, or --bundled: the bundled docs, no network, no notice', async () => {
		const none = await resolveDocsSource({}, { connect: async () => null, bundled: () => bundled, bundledVersion: '0.15.3' });
		expect(none).toMatchObject({ kind: 'bundled', docsVersion: '0.15.3', notice: null, platform: null });
		const { calls, deps } = platform('0.16.0');
		expect((await resolveDocsSource({ bundledOnly: true }, deps())).kind).toBe('bundled');
		expect(calls.info).toBe(0);
	});

	test('the same platform version reads the bundled docs without fetching them', async () => {
		const { calls, deps } = platform('0.15.3');
		const source = await resolveDocsSource({}, deps());
		expect(source).toMatchObject({ kind: 'bundled', platform: { version: '0.15.3' }, notice: null });
		expect(calls.bundle).toBe(0);
	});

	test("a different platform version reads that platform's docs, then serves them from the cache", async () => {
		const cache = join(dir, 'cache-a');
		const { calls, deps } = platform('0.16.0');
		const first = await resolveDocsSource({}, deps(cache));
		expect(first).toMatchObject({ kind: 'platform', docsVersion: '0.16.0', notice: null });
		expect(first.library.read('self-hosting/clustering').markdown).toContain('new text');
		expect(readdirSync(cache)).toEqual(['fp-0160.json.gz']);
		const second = await resolveDocsSource({}, deps(cache));
		expect(second.kind).toBe('platform');
		expect(calls.bundle).toBe(1);
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

	test('compares versions', () => {
		expect(newerVersion('0.16.0', '0.15.3')).toBe(true);
		expect(newerVersion('0.15.3', '0.15.3')).toBe(false);
		expect(newerVersion('0.15.10', '0.15.9')).toBe(true);
		expect(newerVersion('1.0.0', '1.0.0-rc.1')).toBe(true);
		expect(newerVersion('0.15.2', '0.15.3')).toBe(false);
		expect(newerVersion('garbage', '0.15.3')).toBe(false);
	});
});
