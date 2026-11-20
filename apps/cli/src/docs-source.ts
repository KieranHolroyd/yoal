import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ApiClient } from './api.ts';
import { configDirectory, resolveConfig } from './config.ts';
import { bundledDocsFingerprint, bundledDocsPlatformVersion } from './docs-bundle.ts' with { type: 'macro' };
import { bundledLibrary, DocsLibrary, type BundledDocs } from './docs.ts';

/**
 * Which docs `yoal docs` reads (HA-PLAN F5). The CLI ships with the docs of the platform it was
 * built from, and its own version number says nothing about which platform that was. When it is
 * logged in to a platform whose docs differ from the bundled ones (compared by content
 * fingerprint, not version, since a branch build keeps its release's version), it reads that
 * platform's docs (`GET /api/v1/docs/bundle`, cached by fingerprint) so `yoal docs read …`
 * matches what is running. Offline, not logged in, `--bundled`, or an older platform: the bundled docs, with a
 * warning when the platform is newer than them.
 */

export const BUNDLED_DOCS_PLATFORM_VERSION: string = bundledDocsPlatformVersion();
export const BUNDLED_DOCS_FINGERPRINT: string = bundledDocsFingerprint();

export interface DocsSource {
	library: DocsLibrary;
	/** `platform` when the docs came from the platform the CLI is logged in to. */
	kind: 'bundled' | 'platform';
	/** The platform version the docs describe. */
	docsVersion: string;
	/** The platform the CLI is logged in to, when it answered. */
	platform: { url: string; version: string } | null;
	/** A line for stderr, or null. */
	notice: string | null;
}

export interface DocsSourceDeps {
	/** The logged-in platform, or null when there is none. */
	connect?: () => Promise<{ url: string; client: Pick<ApiClient, 'docsInfo' | 'docsBundle'> } | null>;
	cacheDir?: string;
	bundled?: () => DocsLibrary;
	bundledVersion?: string;
	bundledFingerprint?: string;
}

const INFO_TIMEOUT_MS = 3_000;
const BUNDLE_TIMEOUT_MS = 15_000;

async function defaultConnect(): Promise<{ url: string; client: ApiClient } | null> {
	try {
		const config = await resolveConfig();
		return {
			url: config.url,
			client: new ApiClient({ baseUrl: config.url, token: config.token, origin: config.origin }),
		};
	} catch {
		return null; // not logged in: the bundled docs are the answer, quietly
	}
}

/** True when version `a` is newer than `b` (semver core plus "a release beats its prerelease"). */
export function newerVersion(a: string, b: string): boolean {
	const parse = (value: string) => /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/.exec(value.trim());
	const left = parse(a);
	const right = parse(b);
	if (!left || !right) return false;
	for (const index of [1, 2, 3]) {
		const diff = Number(left[index]) - Number(right[index]);
		if (diff !== 0) return diff > 0;
	}
	return !left[4] && Boolean(right[4]);
}

export async function resolveDocsSource(options: { bundledOnly?: boolean } = {}, deps: DocsSourceDeps = {}): Promise<DocsSource> {
	const bundled = deps.bundled ?? bundledLibrary;
	const bundledVersion = deps.bundledVersion ?? BUNDLED_DOCS_PLATFORM_VERSION;
	const bundledFingerprint = deps.bundledFingerprint ?? BUNDLED_DOCS_FINGERPRINT;
	const fallback = (notice: string | null, platform: DocsSource['platform'] = null): DocsSource => ({
		library: bundled(),
		kind: 'bundled',
		docsVersion: bundledVersion,
		platform,
		notice,
	});
	if (options.bundledOnly) return fallback(null);

	const connection = await (deps.connect ?? defaultConnect)();
	if (!connection) return fallback(null);
	let info: { version: string; fingerprint: string; bundleFingerprint: string | null } | null;
	try {
		info = await connection.client.docsInfo(INFO_TIMEOUT_MS);
	} catch {
		return fallback(`Could not reach ${connection.url} for its docs; showing the docs bundled with this CLI (platform ${bundledVersion}).`);
	}
	if (!info) return fallback(null); // a platform from before GET /api/v1/docs
	const platform = { url: connection.url, version: info.version };
	// Same content as the bundle: nothing to fetch. A platform that predates `bundleFingerprint`
	// can only be compared by version.
	if (info.bundleFingerprint ? info.bundleFingerprint === bundledFingerprint : info.version === bundledVersion)
		return fallback(null, platform);

	const key = (info.bundleFingerprint ?? info.fingerprint).replace(/[^A-Za-z0-9_-]/g, '');
	const cacheDir = deps.cacheDir ?? join(configDirectory(), 'docs-cache');
	const cacheFile = join(cacheDir, `${key}.json.gz`);
	let docs: BundledDocs | null = null;
	try {
		const cached: unknown = JSON.parse(gunzipSync(await readFile(cacheFile)).toString('utf8'));
		if (isBundle(cached)) docs = cached;
		else await rm(cacheFile, { force: true }); // written by a broken run: drop it and fetch again
	} catch {
		await rm(cacheFile, { force: true }).catch(() => {});
	}
	if (!docs) {
		try {
			const fetched = await connection.client.docsBundle(BUNDLE_TIMEOUT_MS);
			if (isBundle(fetched.bundle)) {
				docs = fetched.bundle;
				await mkdir(cacheDir, { recursive: true, mode: 0o700 });
				const temp = `${cacheFile}.${process.pid}.tmp`;
				await writeFile(temp, gzipSync(JSON.stringify(docs)), { mode: 0o600 });
				await rename(temp, cacheFile);
			}
		} catch {
			// fall back below; a failed cache write still leaves `docs` usable
		}
	}
	if (docs) return { library: new DocsLibrary(docs), kind: 'platform', docsVersion: info.version, platform, notice: null };
	return fallback(
		newerVersion(info.version, bundledVersion)
			? `Warning: ${connection.url} runs platform ${info.version}, newer than the docs bundled with this CLI (${bundledVersion}), and its docs could not be fetched. Pages may describe older behaviour.`
			: `Note: ${connection.url} serves different docs from the ones bundled with this CLI, and they could not be fetched; showing the bundled docs (platform ${bundledVersion}).`,
		platform,
	);
}

const isString = (value: unknown): value is string => typeof value === 'string';

/** Deep shape check, so a bad response or cache file can never break `yoal docs` later. */
export function isBundle(value: unknown): value is BundledDocs {
	if (typeof value !== 'object' || value === null || !Array.isArray((value as BundledDocs).sections)) return false;
	return (value as BundledDocs).sections.every(
		(section) =>
			isString(section?.id) &&
			isString(section.title) &&
			Array.isArray(section.pages) &&
			section.pages.every(
				(page) =>
					isString(page?.slug) &&
					isString(page.title) &&
					isString(page.description) &&
					Array.isArray(page.sections) &&
					page.sections.every(
						(part) =>
							isString(part?.anchor) && isString(part.heading) && typeof part.depth === 'number' && isString(part.markdown),
					),
			),
	);
}
