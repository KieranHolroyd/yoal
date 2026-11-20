import { createHash } from 'node:crypto';
import { SECTIONS } from './manifest.ts';
import { splitPage, type PageSection } from './sections.ts';

/**
 * Every docs page split into sections, grouped by docs section: the shape `yoal docs` searches.
 * The CLI bundles one at build time, and the control plane serves the one it shipped with at
 * `GET /api/v1/docs/bundle`, so a CLI logged in to a newer platform reads that platform's docs
 * (HA-PLAN F5) with the same search and output.
 */
export interface DocsBundlePage {
	slug: string;
	title: string;
	description: string;
	sections: PageSection[];
}

export interface DocsBundle {
	sections: { id: string; title: string; pages: DocsBundlePage[] }[];
}

/** Build the bundle from page sources keyed by slug (`readContent()` or `filesBySlug()`). */
export function buildDocsBundle(sources: Record<string, string>): DocsBundle {
	return {
		sections: SECTIONS.map((section) => ({
			id: section.id,
			title: section.title,
			pages: section.pages
				.filter((slug) => sources[slug] !== undefined)
				.map((slug) => ({ slug, ...splitPage(sources[slug]!) })),
		})).filter((section) => section.pages.length > 0),
	};
}

/**
 * sha256 over every section of a bundle, in order (first 16 hex chars). The CLI computes it for
 * the docs it bundles and the platform for the docs it serves, so `yoal docs` can tell whether
 * they are the same docs whatever the version numbers say: a build from a branch keeps the
 * release's version while its docs change.
 */
export function docsBundleFingerprint(bundle: DocsBundle): string {
	const hash = createHash('sha256');
	for (const section of bundle.sections)
		for (const page of section.pages)
			for (const part of page.sections) hash.update(`${page.slug}#${part.anchor}\n${part.markdown}\n`);
	return hash.digest('hex').slice(0, 16);
}
