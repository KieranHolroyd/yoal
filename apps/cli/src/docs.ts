import { gunzipSync } from 'node:zlib';
import { bundledDocs } from './docs-bundle.ts' with { type: 'macro' };

/**
 * The Yoal user docs, bundled into the CLI at build time (see `docs-bundle.ts`), with a small
 * full-text search for `yoal docs`. Slugs, anchors and result fields match the MCP `search_docs` /
 * `read_docs` tools, so an agent can move between the two without translating anything.
 *
 * Search is BM25 over page sections with field weights (heading 10, page title 4, body 1, as the
 * platform's FTS5 index uses), a light suffix stemmer ("deploying" finds "deploy"), stop words
 * dropped from natural-language questions, and prefix matches ("install" finds "installer"). A section's score
 * scales with the share of query words it contains, so sections matching every word rank first.
 */

export interface BundledSection {
	anchor: string;
	heading: string;
	depth: number;
	markdown: string;
}

export interface BundledPage {
	slug: string;
	title: string;
	description: string;
	sections: BundledSection[];
}

export interface BundledDocs {
	sections: { id: string; title: string; pages: BundledPage[] }[];
}

export interface DocsSearchResult {
	slug: string;
	anchor: string;
	/** `slug#anchor` (or just the slug for a page's introduction): what `yoal docs read` takes. */
	ref: string;
	page: string;
	section: string;
	heading: string;
	/** Excerpt with matched words wrapped in `**…**`. */
	snippet: string;
	score: number;
}

export interface DocsReadResult {
	slug: string;
	anchor: string;
	ref: string;
	title: string;
	description: string;
	section: string;
	/** The section's Markdown (with its subsections), or the whole page. */
	markdown: string;
	/** Every section on the page, to read more selectively. */
	sections: { anchor: string; heading: string; depth: number }[];
	prev: string | null;
	next: string | null;
}

export interface DocsOutlineSection {
	id: string;
	title: string;
	pages: { slug: string; title: string; description: string }[];
}

export interface DocsContextResult {
	query: string;
	sections: (DocsSearchResult & { markdown: string })[];
	/** True when the character budget cut the last section short or left results out. */
	truncated: boolean;
}

export class DocsLibrary {
	readonly docs: BundledDocs;
	private index: SearchIndex | null = null;

	constructor(docs: BundledDocs) {
		this.docs = docs;
	}

	pages(): (BundledPage & { section: string })[] {
		return this.docs.sections.flatMap((section) => section.pages.map((page) => ({ ...page, section: section.title })));
	}

	outline(sectionFilter?: string): DocsOutlineSection[] {
		const wanted = sectionFilter ? this.matchSection(sectionFilter) : null;
		return this.docs.sections
			.filter((section) => !wanted || section.id === wanted)
			.map((section) => ({
				id: section.id,
				title: section.title,
				pages: section.pages.map(({ slug, title, description }) => ({ slug, title, description })),
			}));
	}

	/** A docs section id from its id or title (case-insensitive), or throw with the choices. */
	matchSection(raw: string): string {
		const wanted = raw.trim().toLowerCase();
		const hit = this.docs.sections.find(
			(section) => section.id === wanted || section.title.toLowerCase() === wanted,
		);
		if (!hit) {
			throw new DocsNotFound(`No docs section "${raw}".`, [
				`Sections: ${this.docs.sections.map((section) => section.id).join(', ')}`,
			]);
		}
		return hit.id;
	}

	search(query: string, options: { limit?: number; section?: string } = {}): DocsSearchResult[] {
		const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 8)), 50);
		const sectionId = options.section ? this.matchSection(options.section) : null;
		this.index ??= buildIndex(this.docs);
		return this.index.search(query, limit, sectionId);
	}

	/**
	 * A page, or one section of it (with its subsections). `ref` takes `slug`, `slug#anchor`,
	 * `/slug/`, `docs/slug.md` or a full docs URL; `anchor` overrides any `#anchor` in `ref`.
	 */
	read(ref: string, anchor?: string): DocsReadResult {
		const parsed = parseRef(ref);
		const wanted = (anchor ?? parsed.anchor).trim().replace(/^#/, '');
		const all = this.pages();
		const index = all.findIndex((page) => page.slug === parsed.slug);
		if (index === -1) throw new DocsNotFound(`No docs page "${parsed.slug}".`, this.suggestPages(parsed.slug));
		const page = all[index]!;
		let markdown: string;
		if (wanted) {
			const at = page.sections.findIndex((section) => section.anchor === wanted);
			if (at === -1) {
				throw new DocsNotFound(`No section "${wanted}" on docs page "${page.slug}".`, [
					`Sections: ${page.sections.filter((s) => s.anchor).map((s) => s.anchor).join(', ')}`,
				]);
			}
			markdown = withSubsections(page.sections, at)
				.map((section) => section.markdown)
				.join('\n\n');
		} else {
			markdown = page.sections.map((section) => section.markdown).join('\n\n');
		}
		return {
			slug: page.slug,
			anchor: wanted,
			ref: wanted ? `${page.slug}#${wanted}` : page.slug,
			title: page.title,
			description: page.description,
			section: page.section,
			markdown,
			sections: page.sections
				.filter((section) => section.anchor)
				.map(({ anchor: id, heading, depth }) => ({ anchor: id, heading, depth })),
			prev: all[index - 1]?.slug ?? null,
			next: all[index + 1]?.slug ?? null,
		};
	}

	/**
	 * The full Markdown of the best matches for `query`, best first, within `maxChars`: what an
	 * agent needs in its context to answer a question, in one call. An h2 brings its h3s along, and
	 * no section is repeated.
	 */
	context(query: string, options: { limit?: number; section?: string; maxChars?: number } = {}): DocsContextResult {
		const limit = options.limit ?? 5;
		const maxChars = Math.max(500, options.maxChars ?? 20_000);
		const hits = this.search(query, { limit: Math.min(limit * 2, 50), section: options.section });
		const chosen: DocsContextResult['sections'] = [];
		const covered = new Set<string>();
		let used = 0;
		let truncated = false;
		for (const hit of hits) {
			if (chosen.length >= limit) break;
			if (covered.has(hit.ref)) continue;
			const page = this.pages().find((candidate) => candidate.slug === hit.slug)!;
			const at = page.sections.findIndex((section) => section.anchor === hit.anchor);
			const refOf = (part: BundledSection) => (part.anchor ? `${hit.slug}#${part.anchor}` : hit.slug);
			// An h2 brings its h3s, minus any already included on their own.
			const parts = (hit.anchor ? withSubsections(page.sections, at) : [page.sections[at]!]).filter(
				(part, index) => index === 0 || !covered.has(refOf(part)),
			);
			for (const part of parts) covered.add(refOf(part));
			let markdown = parts.map((part) => part.markdown).join('\n\n');
			if (!hit.anchor) markdown = `${page.description}\n\n${markdown}`.trim();
			const remaining = maxChars - used;
			if (remaining < 200) {
				truncated = true;
				break;
			}
			if (markdown.length > remaining) {
				markdown = `${markdown.slice(0, remaining).trimEnd()}\n\n[… cut to fit; read the rest with \`yoal docs read ${hit.ref}\`]`;
				truncated = true;
			}
			used += markdown.length;
			chosen.push({ ...hit, markdown });
		}
		return { query, sections: chosen, truncated };
	}

	/** Pages whose slug or title shares words with what was asked for. */
	private suggestPages(raw: string): string[] {
		const words = raw.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
		const scored = this.pages()
			.map((page) => {
				const hay = `${page.slug} ${page.title}`.toLowerCase();
				return { slug: page.slug, score: words.filter((word) => hay.includes(word) || hay.includes(stem(word))).length };
			})
			.filter((page) => page.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, 5);
		const hints = scored.length ? [`Did you mean: ${scored.map((page) => page.slug).join(', ')}`] : [];
		return [...hints, 'List every page with `yoal docs list`, or search with `yoal docs search <words>`.'];
	}
}

export class DocsNotFound extends Error {
	readonly suggestions: string[];
	constructor(message: string, suggestions: string[] = []) {
		super(message);
		this.name = 'DocsNotFound';
		this.suggestions = suggestions;
	}
}

let loaded: DocsLibrary | null = null;

/** The docs bundled into this build, decoded on first use. */
export function bundledLibrary(): DocsLibrary {
	loaded ??= new DocsLibrary(JSON.parse(gunzipSync(Buffer.from(bundledDocs(), 'base64')).toString('utf8')) as BundledDocs);
	return loaded;
}

/** `slug`, `slug#anchor`, `/slug/`, `docs/slug.md`, `https://host/docs/slug#anchor` → parts. */
export function parseRef(raw: string): { slug: string; anchor: string } {
	let value = raw.trim();
	try {
		if (/^https?:\/\//i.test(value)) {
			const url = new URL(value);
			value = `${url.pathname}${url.hash}`;
		}
	} catch {
		// Not a URL after all; treat it as a slug.
	}
	const hashAt = value.indexOf('#');
	const path = hashAt === -1 ? value : value.slice(0, hashAt);
	const anchor = hashAt === -1 ? '' : value.slice(hashAt + 1);
	const slug = path
		.replace(/^\/+|\/+$/g, '')
		.replace(/^docs\//, '')
		.replace(/\.md$/, '')
		.toLowerCase();
	return { slug, anchor };
}

function withSubsections(sections: BundledSection[], at: number): BundledSection[] {
	const start = sections[at]!;
	const parts = [start];
	if (start.depth !== 2) return parts;
	for (const part of sections.slice(at + 1)) {
		if (part.depth === 3) parts.push(part);
		else break;
	}
	return parts;
}

// ---- search -------------------------------------------------------------------------------

const STOP_WORDS = new Set(
	(
		'a an and are as at be by can could do does doing for from get got how i if in into is it its me my of on or ' +
		'should so that the their them then there these this to use using want was we what when where which who why ' +
		'will with would you your yoal'
	).split(' '),
);

/** Lower-case words of letters, digits and `_`. */
function words(text: string): string[] {
	return text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
}

/**
 * A light suffix stemmer, enough that plurals and -ing/-ed forms meet: "databases" and
 * "database", "deploying" and "deployed" and "deploy", "policies" and "policy".
 */
export function stem(word: string): string {
	let w = word;
	if (w.length <= 3 || /\d/.test(w)) return w;
	if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
	else if (w.endsWith('sses')) w = w.slice(0, -2);
	else if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
	if (w.endsWith('ing') && w.length > 5) w = undouble(w.slice(0, -3));
	else if (w.endsWith('ed') && w.length > 4) w = undouble(w.slice(0, -2));
	if (w.endsWith('e') && w.length > 4) w = w.slice(0, -1);
	return w;
}

function undouble(w: string): string {
	return /([^aeiouylsz])\1$/.test(w) ? w.slice(0, -1) : w;
}

const FIELD_WEIGHTS = [10, 4, 1] as const; // heading, page title (+ parent heading), body
const K1 = 1.2;
const B = 0.75;

interface IndexedSection {
	slug: string;
	anchor: string;
	page: string;
	section: string;
	sectionId: string;
	heading: string;
	body: string;
	/** term → frequency per field [heading, page, body]. */
	terms: Map<string, [number, number, number]>;
	lengths: [number, number, number];
}

interface SearchIndex {
	search(query: string, limit: number, sectionId: string | null): DocsSearchResult[];
}

function buildIndex(docs: BundledDocs): SearchIndex {
	const rows: IndexedSection[] = [];
	const documentFrequency = new Map<string, number>();
	const vocabulary = new Set<string>();

	for (const group of docs.sections) {
		for (const page of group.pages) {
			let parentHeading = '';
			for (const part of page.sections) {
				const heading = part.anchor ? part.heading : page.title;
				if (part.depth === 2) parentHeading = part.heading;
				// An h3 is found by its parent's heading too ("Attach a domain" under "Custom domains").
				const context = part.depth === 3 ? `${page.title} ${parentHeading}` : page.title;
				// The heading line is indexed as the heading, not again as body text.
				const bodyMarkdown = part.anchor ? part.markdown.replace(/^#{2,3}[^\n]*\n?/, '') : `${page.description}\n\n${part.markdown}`;
				const body = plainText(bodyMarkdown);
				const fields = [words(heading), words(context), words(body)].map((list) => list.map(stem));
				const terms = new Map<string, [number, number, number]>();
				fields.forEach((list, field) => {
					for (const term of list) {
						let counts = terms.get(term);
						if (!counts) terms.set(term, (counts = [0, 0, 0]));
						counts[field]!++;
					}
				});
				for (const term of terms.keys()) {
					documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
					vocabulary.add(term);
				}
				rows.push({
					slug: page.slug,
					anchor: part.anchor,
					page: page.title,
					section: group.title,
					sectionId: group.id,
					heading,
					body,
					terms,
					lengths: [fields[0]!.length, fields[1]!.length, fields[2]!.length],
				});
			}
		}
	}

	const total = rows.length;
	const averages = [0, 1, 2].map((field) => rows.reduce((sum, row) => sum + row.lengths[field]!, 0) / Math.max(1, total));
	const vocabularyList = [...vocabulary];

	/** Each query word as the set of index terms it matches, including as a prefix. */
	const expand = (query: string): { raw: string; terms: Set<string> }[] => {
		const all = words(query);
		const meaningful = all.filter((word) => !STOP_WORDS.has(word));
		const chosen = (meaningful.length ? meaningful : all).slice(0, 12);
		return chosen.map((raw, index) => {
			const base = stem(raw);
			const terms = new Set([base]);
			// The last word as typed so far, and longer words as a stem ("install" → "installation").
			if (raw.length >= (index === chosen.length - 1 ? 3 : 5)) {
				for (const term of vocabularyList) if (term.startsWith(base) || term.startsWith(raw)) terms.add(term);
			}
			return { raw, terms };
		});
	};

	const idf = (terms: Set<string>): number => {
		// Sections containing any of the terms, approximated by the most common one (an upper bound
		// would need a per-section union; the difference is negligible for ranking).
		let df = 0;
		for (const term of terms) df = Math.max(df, documentFrequency.get(term) ?? 0);
		return Math.log(1 + (total - df + 0.5) / (df + 0.5));
	};

	return {
		search(query, limit, sectionId) {
			const expanded = expand(query);
			if (expanded.length === 0) return [];
			const weights = expanded.map((entry) => idf(entry.terms));
			const scored: { row: IndexedSection; score: number; matched: number }[] = [];
			for (const row of rows) {
				if (sectionId && row.sectionId !== sectionId) continue;
				let score = 0;
				let matched = 0;
				expanded.forEach((entry, i) => {
					const tf: [number, number, number] = [0, 0, 0];
					for (const term of entry.terms) {
						const counts = row.terms.get(term);
						if (!counts) continue;
						tf[0] += counts[0];
						tf[1] += counts[1];
						tf[2] += counts[2];
					}
					if (tf[0] + tf[1] + tf[2] === 0) return;
					matched++;
					for (let field = 0; field < 3; field++) {
						const f = tf[field]!;
						if (!f) continue;
						const norm = 1 - B + (B * row.lengths[field]!) / Math.max(1, averages[field]!);
						score += FIELD_WEIGHTS[field]! * weights[i]! * ((f * (K1 + 1)) / (f + K1 * norm));
					}
				});
				if (matched > 0) scored.push({ row, score, matched });
			}
			// Sections with more of the words rank higher: the score scales with the share of words
			// matched, so a section matching every word beats one that only matches a common word
			// often, but a strong heading match on most of the words can still win.
			for (const entry of scored) entry.score *= (entry.matched / expanded.length) ** 2;
			scored.sort((a, b) => b.score - a.score);
			const allTerms = new Set(expanded.flatMap((entry) => [...entry.terms]));
			return scored.slice(0, limit).map(({ row, score }) => ({
				slug: row.slug,
				anchor: row.anchor,
				ref: row.anchor ? `${row.slug}#${row.anchor}` : row.slug,
				page: row.page,
				section: row.section,
				heading: row.heading,
				snippet: snippet(row.body, allTerms),
				score: Math.round(score * 1000) / 1000,
			}));
		},
	};
}

/** Markdown → roughly plain text for indexing and excerpts. Code is kept: commands are searchable. */
function plainText(markdown: string): string {
	return markdown
		.replace(/^```.*$/gm, '')
		.replace(/^>\s?\[![A-Z]+\]\s*$/gm, '')
		.replace(/^\s*(?:[>#|]+|[*+-](?=\s))\s?/gm, '')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[`*|]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** The ~32-word window with the most distinct matched terms, matches in `**…**`. */
function snippet(body: string, terms: Set<string>, size = 32): string {
	const tokens = body.split(' ').filter(Boolean);
	if (tokens.length === 0) return '';
	const termOf = tokens.map((token) => {
		for (const word of words(token)) {
			const stemmed = stem(word);
			if (terms.has(stemmed) || terms.has(word)) return stemmed;
		}
		return null;
	});
	let bestStart = 0;
	let bestScore = -1;
	for (let start = 0; start < Math.max(1, tokens.length - size + 1); start++) {
		const distinct = new Set(termOf.slice(start, start + size).filter(Boolean));
		// Prefer windows that start on a match, a little, so the excerpt leads with it.
		const score = distinct.size * 2 + (termOf[start] ? 1 : 0);
		if (score > bestScore) {
			bestScore = score;
			bestStart = start;
		}
	}
	// Back up a few words for context, but not before the start.
	const start = Math.max(0, bestStart - 4);
	const end = Math.min(tokens.length, start + size);
	const text = tokens
		.slice(start, end)
		.map((token, offset) => (termOf[start + offset] ? `**${token}**` : token))
		.join(' ');
	return `${start > 0 ? '…' : ''}${text}${end < tokens.length ? '…' : ''}`;
}
