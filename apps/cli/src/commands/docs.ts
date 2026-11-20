import pkg from '../../package.json' with { type: 'json' };
import { parseArgs, type FlagSpec, type ParsedArgs } from '../args.ts';
import { DocsNotFound, parseRef, type DocsLibrary, type DocsReadResult } from '../docs.ts';
import { resolveDocsSource, type DocsSource } from '../docs-source.ts';
import { CliError, UsageError } from '../errors.ts';
import { printJson } from '../output.ts';

/**
 * `yoal docs`: the Yoal user documentation from the terminal, for people and especially for AI
 * coding agents. The docs are bundled into the CLI (no network, no sign-in needed). When the CLI
 * is logged in to a platform running a different version, it reads that platform's own docs
 * instead (`docs-source.ts`, HA-PLAN F5). Slugs, anchors and JSON fields are the same as the MCP
 * `search_docs` / `read_docs` tools (packages/docs/content is the single source).
 */

const usage = `Usage: yoal docs [command] [options]

Search and read the Yoal documentation. The docs are bundled into this CLI (${pkg.version}), so
nothing needs a network connection or \`yoal login\`. When you are logged in to a platform that
runs a different version, yoal docs reads that platform's own docs (cached locally) so they match
what is running; --bundled uses the bundled docs regardless.

Commands:
  list [--section <id>]          Table of contents: every page's slug and what it covers (default)
  search <words…>                Ranked sections: ref (slug#anchor), heading, excerpt
  read <ref> [--outline]         A page, or one section, as Markdown; --outline lists its sections
  context <question…>            Full Markdown of the best-matching sections, in one go
  <words…>                       Shorthand: a page ref reads it, anything else searches

Options:
  -n, --limit <n>        search: results (default 8, max 50); context: sections (default 5)
  -s, --section <id>     Only one docs section, by id or title, e.g. data or "Self-hosting"
      --max-chars <n>    context: stop after about this many characters (default 20000)
      --outline          read: list the page's sections (anchors) instead of its text
      --json             JSON output (same fields as the MCP search_docs/read_docs tools)
      --bundled          Use the docs bundled with this CLI, never the platform's
  -h, --help             Show this help

Refs:
  A ref is a page slug, optionally with a section anchor: \`data/databases\` or
  \`data/databases#connections-and-tls\`. Search results print refs, and links inside the docs are
  refs too: a link to \`/compute/scaling#autoscaling\` reads with
  \`yoal docs read compute/scaling#autoscaling\`. Dashboard docs URLs work as well.

For AI agents:
  1. \`yoal docs context "<the user's question>"\` returns the relevant docs text in one call.
     Answer from it, and cite refs so the user can open the same page in the dashboard (/docs/<slug>).
  2. To explore instead: \`yoal docs search <words>\`, then \`yoal docs read <ref>\` on the best hit.
     Use \`read <slug> --outline\` first on long pages and read only the sections you need.
  3. \`yoal docs list\` shows what exists. Prefer specific nouns in queries (\`custom domain dns\`,
     \`db restore point in time\`); questions work too, filler words are ignored.
  4. CLI command reference lives under the \`cli\` section (\`yoal docs list -s cli\`); every
     command also has \`yoal <command> --help\`.
  Exit codes: 0 found (a search with no hits prints a hint and still exits 0; check
  \`results\` in --json), 1 unknown page, section or usage error.

Examples:
  yoal docs search custom domain
  yoal docs read deploying/domains-and-environments#attach-a-domain
  yoal docs read data/databases --outline
  yoal docs context "how do I restore a database to a point in time" --max-chars 8000
  yoal docs list --section self-hosting --json`;

const flags: FlagSpec = {
	limit: { type: 'string', short: 'n' },
	section: { type: 'string', short: 's' },
	'max-chars': { type: 'string' },
	outline: { type: 'boolean' },
	json: { type: 'boolean' },
	bundled: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const SUBCOMMANDS: Record<string, 'list' | 'search' | 'read' | 'context'> = {
	list: 'list',
	ls: 'list',
	toc: 'list',
	search: 'search',
	find: 'search',
	read: 'read',
	show: 'read',
	cat: 'read',
	context: 'context',
	ctx: 'context',
};

export async function docsCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	const source = await resolveDocsSource({ bundledOnly: args.boolean('bundled') });
	if (source.notice) console.error(source.notice);
	const library = source.library;
	const [first, ...rest] = args.positionals;
	let command = first === undefined ? 'list' : SUBCOMMANDS[first];
	let operands = first === undefined ? [] : rest;
	if (!command) {
		// `yoal docs data/databases` reads; `yoal docs custom domains` searches.
		command = args.positionals.length === 1 && isPageRef(library, first!) ? 'read' : 'search';
		operands = args.positionals;
	}

	try {
		switch (command) {
			case 'list':
				if (operands.length > 0) throw new UsageError(`\`yoal docs list\` takes no arguments.\n\n${usage}`);
				return list(source, args);
			case 'search':
				return search(source, args, operands);
			case 'read':
				return read(source, args, operands);
			case 'context':
				return context(source, args, operands);
		}
	} catch (error) {
		if (error instanceof DocsNotFound)
			throw new CliError(error.message, { code: 'not_found', suggestions: error.suggestions });
		throw error;
	}
}

function isPageRef(library: DocsLibrary, value: string): boolean {
	const { slug } = parseRef(value);
	return library.pages().some((page) => page.slug === slug);
}

function list(source: DocsSource, args: ParsedArgs): void {
	const library = source.library;
	const outline = library.outline(args.string('section'));
	if (args.boolean('json')) {
		printJson({ version: pkg.version, docs: docsMeta(source), sections: outline });
		return;
	}
	const width = Math.max(...outline.flatMap((section) => section.pages.map((page) => page.slug.length)));
	const pages = outline.reduce((total, section) => total + section.pages.length, 0);
	console.log(`${describeSource(source)}: ${pages} pages. Read one with \`yoal docs read <slug>\`.`);
	for (const section of outline) {
		console.log('');
		console.log(`${section.title} (${section.id})`);
		for (const page of section.pages) console.log(`  ${page.slug.padEnd(width)}  ${page.description}`);
	}
	console.log('');
	console.log('Search: yoal docs search <words>   Answer a question: yoal docs context "<question>"');
}

function search(source: DocsSource, args: ParsedArgs, operands: string[]): void {
	const library = source.library;
	const query = operands.join(' ').trim();
	if (!query) throw new UsageError(`Missing search words.\n\nExample: yoal docs search custom domain`);
	const results = library.search(query, { limit: positiveInt(args, 'limit', 8), section: args.string('section') });
	const hint = results.length
		? 'Read one in full with `yoal docs read <ref>`.'
		: 'No matches. Try fewer or different words, or browse with `yoal docs list`.';
	if (args.boolean('json')) {
		printJson({ version: pkg.version, docs: docsMeta(source), query, results, hint });
		return;
	}
	if (results.length === 0) {
		console.log(hint);
		return;
	}
	results.forEach((result, index) => {
		if (index > 0) console.log('');
		const where = result.anchor ? `${result.page} › ${result.heading}` : result.page;
		console.log(`${index + 1}. ${where}  [${result.section}]`);
		console.log(`   ref: ${result.ref}`);
		if (result.snippet) console.log(`   ${result.snippet}`);
	});
	console.log('');
	console.log(hint);
}

function read(source: DocsSource, args: ParsedArgs, operands: string[]): void {
	const library = source.library;
	if (operands.length === 0)
		throw new UsageError('Missing page ref, e.g. `yoal docs read data/databases#connections-and-tls`.');
	if (operands.length > 2) throw new UsageError(`Too many arguments.\n\n${usage}`);
	// `read <slug> <anchor>` works too.
	const page = library.read(operands[0]!, operands[1]);
	if (args.boolean('outline')) return outline(source, page, args);
	if (args.boolean('json')) {
		printJson({ version: pkg.version, docs: docsMeta(source), ...page });
		return;
	}
	const heading = page.anchor ? page.sections.find((section) => section.anchor === page.anchor)?.heading : undefined;
	console.log(`# ${heading ? `${page.title} › ${heading}` : page.title}`);
	console.log('');
	if (!page.anchor && page.description) {
		console.log(page.description);
		console.log('');
	}
	console.log(`ref: ${page.ref} · ${page.section} · platform ${source.docsVersion} docs`);
	console.log('');
	console.log(page.markdown);
	if (!page.anchor) {
		const links = [page.prev && `previous: ${page.prev}`, page.next && `next: ${page.next}`].filter(Boolean);
		if (links.length) {
			console.log('');
			console.log(`---\n${links.join(' · ')}`);
		}
	}
}

function outline(source: DocsSource, page: DocsReadResult, args: ParsedArgs): void {
	if (args.boolean('json')) {
		const { markdown: _markdown, ...rest } = page;
		printJson({ version: pkg.version, docs: docsMeta(source), ...rest });
		return;
	}
	console.log(`# ${page.title}`);
	if (page.description) console.log(page.description);
	console.log('');
	console.log(`${page.slug}  (whole page, ${page.markdown.length.toLocaleString('en-US')} characters)`);
	for (const section of page.sections) {
		console.log(`${section.depth === 3 ? '    ' : '  '}${page.slug}#${section.anchor}  ${section.heading}`);
	}
	console.log('');
	console.log('Read a section with `yoal docs read <ref>`; a ## section includes its ### subsections.');
}

function context(source: DocsSource, args: ParsedArgs, operands: string[]): void {
	const library = source.library;
	const query = operands.join(' ').trim();
	if (!query) throw new UsageError('Missing question, e.g. `yoal docs context "how do I add a custom domain"`.');
	const result = library.context(query, {
		limit: positiveInt(args, 'limit', 5),
		section: args.string('section'),
		maxChars: positiveInt(args, 'max-chars', 20_000),
	});
	if (args.boolean('json')) {
		printJson({ version: pkg.version, docs: docsMeta(source), ...result });
		return;
	}
	if (result.sections.length === 0) {
		console.log('No matching docs. Try fewer or different words, or browse with `yoal docs list`.');
		return;
	}
	console.log(`Yoal docs (platform ${source.docsVersion}) for: ${query}`);
	console.log(`${result.sections.length} sections, best match first. Each starts with its ref; cite refs in answers.`);
	for (const section of result.sections) {
		console.log('');
		console.log(`<!-- ref: ${section.ref} -->`);
		if (!section.anchor) console.log(`## ${section.page}\n`);
		console.log(section.markdown);
	}
	if (result.truncated) {
		console.log('');
		console.log('[Output limited by --max-chars; read more with `yoal docs read <ref>` or raise --max-chars.]');
	}
}

function positiveInt(args: ParsedArgs, name: string, fallback: number): number {
	const raw = args.string(name);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) throw new UsageError(`--${name} must be a whole number of at least 1.`);
	return value;
}


/** Where the docs came from, for `--json` output: agents can tell bundled docs from the platform's. */
function docsMeta(source: DocsSource): { source: DocsSource['kind']; platformVersion: string; platform: string | null } {
	return { source: source.kind, platformVersion: source.docsVersion, platform: source.platform?.url ?? null };
}

function describeSource(source: DocsSource): string {
	return source.kind === 'platform'
		? `Yoal docs from ${source.platform!.url} (platform ${source.docsVersion})`
		: `Yoal docs, bundled with yoal ${pkg.version} (platform ${source.docsVersion})`;
}
