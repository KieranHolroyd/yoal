import { Marked } from 'marked';
import { parseFrontmatter } from './frontmatter.ts';

/**
 * A page split into its readable sections (the introduction, then one per h2/h3) without
 * rendering any HTML or loading the highlighter. Anchors, headings and Markdown match what
 * `renderDoc(...).sections` produces (a test holds them together), so a slug + anchor means the
 * same section in the dashboard, over MCP (`read_docs`) and in the CLI (`yoal docs read`), which
 * bundles these at build time.
 */

export interface PageSection {
	/** Heading anchor, or `''` for the page's introduction. */
	anchor: string;
	heading: string;
	/** Heading depth (2 or 3); 0 for the introduction. */
	depth: number;
	/** The section's Markdown source, heading included. */
	markdown: string;
}

export interface SplitPage {
	title: string;
	description: string;
	sections: PageSection[];
}

/** GitHub-style heading anchors; the same rule as `slugifyHeading` in render.ts. */
function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/<[^>]*>/g, '')
		.replace(/&[a-z]+;|&#\d+;/g, '')
		.replace(/[^\p{L}\p{N}\s_-]/gu, '')
		.trim()
		.replace(/\s/g, '-');
}

function stripTags(html: string): string {
	return html
		.replace(/<[^>]*>/g, '')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&');
}

export function splitPage(source: string): SplitPage {
	const { frontmatter, body } = parseFrontmatter(source);
	const marked = new Marked({ gfm: true, async: false });
	const sections: PageSection[] = [];
	let current: PageSection = { anchor: '', heading: frontmatter.title, depth: 0, markdown: '' };
	const seenIds = new Map<string, number>();
	for (const token of marked.lexer(body)) {
		if (token.type === 'heading' && (token.depth === 2 || token.depth === 3)) {
			if (current.markdown.trim() || current.anchor === '') sections.push(current);
			const text = stripTags(marked.parseInline(token.text) as string);
			const base = slugify(text) || 'section';
			const seen = seenIds.get(base) ?? 0;
			seenIds.set(base, seen + 1);
			current = { anchor: seen === 0 ? base : `${base}-${seen}`, heading: text, depth: token.depth, markdown: token.raw };
			continue;
		}
		current.markdown += token.raw;
	}
	sections.push(current);
	for (const section of sections) section.markdown = section.markdown.trim();
	return { title: frontmatter.title, description: frontmatter.description, sections };
}
