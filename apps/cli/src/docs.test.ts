import { describe, expect, test } from 'bun:test';
import { ALL_SLUGS } from '../../../packages/docs/src/manifest.ts';
import { bundledLibrary, DocsLibrary, DocsNotFound, parseRef, stem, type BundledDocs } from './docs.ts';

const fixture: BundledDocs = {
	sections: [
		{
			id: 'deploying',
			title: 'Deploying',
			pages: [
				{
					slug: 'deploying/domains',
					title: 'Domains',
					description: 'Attach your own hostname.',
					sections: [
						{ anchor: '', heading: 'Domains', depth: 0, markdown: 'Every project gets a default hostname.' },
						{ anchor: 'custom-domains', heading: 'Custom domains', depth: 2, markdown: '## Custom domains\n\nA custom domain is your own hostname.' },
						{ anchor: 'attach-a-domain', heading: 'Attach a domain', depth: 3, markdown: '### Attach a domain\n\nSelect Add domain and enter the hostname.' },
						{ anchor: 'check-status', heading: 'Check status', depth: 3, markdown: '### Check status\n\nA pending domain is checked every 10 minutes.' },
						{ anchor: 'environments', heading: 'Environments', depth: 2, markdown: '## Environments\n\nStaging and production pointers.' },
					],
				},
			],
		},
		{
			id: 'data',
			title: 'Data services',
			pages: [
				{
					slug: 'data/databases',
					title: 'Databases',
					description: 'Managed PostgreSQL.',
					sections: [
						{ anchor: '', heading: 'Databases', depth: 0, markdown: 'Create a database.' },
						{ anchor: 'backups', heading: 'Backups', depth: 2, markdown: '## Backups\n\nDatabases are backed up nightly; restore a backup into a new database.' },
					],
				},
			],
		},
	],
};

const library = new DocsLibrary(fixture);

describe('stem', () => {
	test('plurals and -ing/-ed forms meet', () => {
		expect(stem('databases')).toBe(stem('database'));
		expect(stem('deploying')).toBe(stem('deploy'));
		expect(stem('deployed')).toBe(stem('deploy'));
		expect(stem('policies')).toBe(stem('policy'));
		expect(stem('running')).toBe('run');
		expect(stem('access')).toBe('access');
		expect(stem('status')).toBe('status');
	});
});

describe('parseRef', () => {
	test('accepts slugs, anchors, paths and dashboard URLs', () => {
		expect(parseRef('data/databases')).toEqual({ slug: 'data/databases', anchor: '' });
		expect(parseRef('/data/databases#backups')).toEqual({ slug: 'data/databases', anchor: 'backups' });
		expect(parseRef('docs/data/databases.md')).toEqual({ slug: 'data/databases', anchor: '' });
		expect(parseRef('https://control.example.com/docs/data/databases/#backups')).toEqual({
			slug: 'data/databases',
			anchor: 'backups',
		});
	});
});

describe('search', () => {
	test('ranks heading matches first, ignores filler words and stems', () => {
		// "Attach a domain" matches every word: "add" in its body, "custom" through its parent h2.
		const results = library.search('how do I add a custom domain');
		expect(results.slice(0, 2).map((result) => result.ref)).toEqual([
			'deploying/domains#attach-a-domain',
			'deploying/domains#custom-domains',
		]);
		expect(results[1]!.snippet).toContain('**custom**');
	});

	test('matches word forms and prefixes', () => {
		expect(library.search('backed up databases')[0]!.ref).toBe('data/databases#backups');
		expect(library.search('envir')[0]!.ref).toBe('deploying/domains#environments');
	});

	test('filters by section id or title, and refuses unknown sections', () => {
		expect(library.search('hostname', { section: 'data' })).toEqual([]);
		expect(library.search('database', { section: 'Data services' }).length).toBeGreaterThan(0);
		expect(() => library.search('x', { section: 'nope' })).toThrow(DocsNotFound);
	});

	test('returns nothing for words that appear nowhere', () => {
		expect(library.search('zzzqqq')).toEqual([]);
	});
});

describe('read', () => {
	test('a whole page, with its sections and neighbours', () => {
		const page = library.read('deploying/domains');
		expect(page.markdown.startsWith('Every project gets a default hostname.')).toBe(true);
		expect(page.sections.map((section) => section.anchor)).toEqual([
			'custom-domains',
			'attach-a-domain',
			'check-status',
			'environments',
		]);
		expect(page.prev).toBeNull();
		expect(page.next).toBe('data/databases');
	});

	test('an h2 section brings its h3s; an h3 stands alone', () => {
		const h2 = library.read('deploying/domains#custom-domains');
		expect(h2.markdown).toContain('### Attach a domain');
		expect(h2.markdown).not.toContain('## Environments');
		expect(library.read('deploying/domains', 'check-status').markdown).toBe(
			'### Check status\n\nA pending domain is checked every 10 minutes.',
		);
	});

	test('unknown pages and sections suggest where to look', () => {
		try {
			library.read('deploying/domain');
			throw new Error('expected a miss');
		} catch (error) {
			expect(error).toBeInstanceOf(DocsNotFound);
			expect((error as DocsNotFound).suggestions[0]).toContain('deploying/domains');
		}
		expect(() => library.read('data/databases#nope')).toThrow('No section "nope"');
	});
});

describe('context', () => {
	test('returns full sections, never the same text twice, within the budget', () => {
		const result = library.context('custom domain attach', { limit: 5 });
		const refs = result.sections.map((section) => section.ref);
		expect(refs.slice(0, 2)).toEqual(['deploying/domains#attach-a-domain', 'deploying/domains#custom-domains']);
		expect(new Set(refs).size).toBe(refs.length);
		const text = result.sections.map((section) => section.markdown).join('\n');
		expect(text.match(/### Attach a domain/g)?.length).toBe(1);
		expect(result.truncated).toBe(false);

		const small = library.context('custom domain', { maxChars: 500 });
		expect(small.sections.reduce((total, section) => total + section.markdown.length, 0)).toBeLessThan(700);
	});
});

describe('bundled docs', () => {
	test('carry every published page from packages/docs, in manifest order', () => {
		const bundled = bundledLibrary();
		const slugs = bundled.pages().map((page) => page.slug);
		expect(slugs).toEqual(ALL_SLUGS.filter((slug) => slugs.includes(slug)));
		expect(slugs.length).toBeGreaterThan(40);
		expect(bundled.search('custom domain')[0]!.slug).toBe('deploying/domains-and-environments');
		expect(bundled.read('cli/deploying').markdown.length).toBeGreaterThan(1000);
	});
});
