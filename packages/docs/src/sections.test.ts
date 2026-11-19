import { expect, test } from 'bun:test';
import { readContent } from './disk.ts';
import { renderDoc } from './render.ts';
import { splitPage } from './sections.ts';

const opts = { isPage: () => true, href: (slug: string) => `/${slug}` };

test('splitPage matches the renderer’s sections on every page (anchors are shared with MCP and the CLI)', async () => {
	for (const [slug, source] of Object.entries(readContent())) {
		const rendered = await renderDoc(source, opts);
		const split = splitPage(source);
		expect({ slug, sections: split.sections }).toEqual({
			slug,
			sections: rendered.sections.map(({ anchor, heading, depth, markdown }) => ({ anchor, heading, depth, markdown }))
		});
		expect(split.title).toBe(rendered.title);
	}
});

test('splitPage numbers repeated headings and keeps the introduction', () => {
	const page = splitPage('---\ntitle: T\ndescription: D\n---\n\nIntro.\n\n## A `b`\n\nx\n\n## A b\n\ny');
	expect(page.sections.map((s) => [s.anchor, s.heading, s.depth])).toEqual([
		['', 'T', 0],
		['a-b', 'A b', 2],
		['a-b-1', 'A b', 2]
	]);
	expect(page.sections[0]!.markdown).toBe('Intro.');
});
