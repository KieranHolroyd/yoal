/**
 * Bun macro: runs at build time (`bun build`, and when Bun transpiles `docs.ts` for tests or
 * `bun run`), never in the published CLI. It reads the user docs from `packages/docs/content`,
 * splits every page into the same sections the dashboard and MCP `read_docs` use, and returns
 * them as one gzip+base64 string that `docs.ts` inlines, so `yoal docs` works offline, without
 * signing in, and always matches the CLI version it shipped with. Gzip keeps ~1 MB of Markdown
 * to roughly a third of that in `dist/yoal.js`.
 */
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { buildDocsBundle } from '../../../packages/docs/src/bundle.ts';
import { readContent } from '../../../packages/docs/src/disk.ts';
import type { BundledDocs } from './docs.ts';

export function bundledDocs(): string {
	const docs: BundledDocs = buildDocsBundle(readContent());
	return gzipSync(JSON.stringify(docs), { level: 9 }).toString('base64');
}

/**
 * The platform version these docs came from (repository-root `VERSION` at build time). The CLI
 * has its own version number, so this is what `yoal docs` compares with the platform it is
 * logged in to (HA-PLAN F5).
 */
export function bundledDocsPlatformVersion(): string {
	return readFileSync(new URL('../../../VERSION', import.meta.url), 'utf8').trim();
}
