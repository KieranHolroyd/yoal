/**
 * Bun macro: runs at build time (`bun build`, and when Bun transpiles `docs.ts` for tests or
 * `bun run`), never in the published CLI. It reads the user docs from `packages/docs/content`,
 * splits every page into the same sections the dashboard and MCP `read_docs` use, and returns
 * them as one gzip+base64 string that `docs.ts` inlines, so `yoal docs` works offline, without
 * signing in, and always matches the CLI version it shipped with. Gzip keeps ~1 MB of Markdown
 * to roughly a third of that in `dist/yoal.js`.
 */
import { gzipSync } from 'node:zlib';
import { readContent } from '../../../packages/docs/src/disk.ts';
import { SECTIONS } from '../../../packages/docs/src/manifest.ts';
import { splitPage } from '../../../packages/docs/src/sections.ts';
import type { BundledDocs } from './docs.ts';

export function bundledDocs(): string {
	const sources = readContent();
	const docs: BundledDocs = {
		sections: SECTIONS.map((section) => ({
			id: section.id,
			title: section.title,
			pages: section.pages
				.filter((slug) => sources[slug] !== undefined)
				.map((slug) => ({ slug, ...splitPage(sources[slug]!) })),
		})).filter((section) => section.pages.length > 0),
	};
	return gzipSync(JSON.stringify(docs), { level: 9 }).toString('base64');
}
