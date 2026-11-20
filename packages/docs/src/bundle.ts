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
