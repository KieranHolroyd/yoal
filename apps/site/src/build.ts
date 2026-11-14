/**
 * Build Yoal's public front page: plain static files that deploy anywhere, including to Yoal
 * itself (`yoal deploy dist --project yoal-site`).
 *
 *   bun src/build.ts [--out dist] [--site-url https://yoal.dev] [--docs-url https://docs.yoal.dev]
 *
 * `--site-url` (or SITE_URL) adds a canonical link, `sitemap.xml` and `robots.txt`.
 * `--docs-url` (or SITE_DOCS_URL) is where the "Docs" links point; without it they point at the
 * docs Markdown on GitHub.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { renderPage } from './page.ts';

const APP_DIR = resolve(import.meta.dir, '..');
const REPO_ROOT = resolve(APP_DIR, '..', '..');
const REPO_URL = 'https://github.com/KieranHolroyd/yoal';
const DEFAULT_DOCS_URL = `${REPO_URL}/tree/main/packages/docs/content`;

export interface BuildOptions {
	outDir: string;
	siteUrl: string | null;
	docsUrl: string | null;
}

const hash = (data: string | Uint8Array) =>
	createHash('sha256').update(data).digest('hex').slice(0, 10);

function write(path: string, data: string | Uint8Array) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, data);
}

/** The MCP tool count, read from the README's tool table so the page can't drift from it. */
export function countTools(readme: string): number {
	const start = readme.indexOf('## For agents');
	const end = readme.indexOf('### In-dashboard', start);
	if (start === -1 || end === -1) return 0;
	const rows = readme
		.slice(start, end)
		.split('\n')
		.filter((line) => line.startsWith('| ') && !line.startsWith('| Area'));
	const names = new Set(rows.flatMap((row) => row.match(/`[a-z_]+`/g) ?? []));
	return names.size;
}

export async function buildSite(options: BuildOptions): Promise<{ outDir: string; ms: number }> {
	const started = performance.now();
	const out = resolve(options.outDir);
	const siteUrl = options.siteUrl ? options.siteUrl.replace(/\/*$/, '/') : null;

	rmSync(out, { recursive: true, force: true });
	mkdirSync(join(out, 'assets'), { recursive: true });

	const fonts: Record<'sans' | 'mono', string> = { sans: '', mono: '' };
	for (const [key, pkg, file] of [
		['sans', 'geist', 'geist-latin-wght-normal.woff2'],
		['mono', 'geist-mono', 'geist-mono-latin-wght-normal.woff2']
	] as const) {
		const bytes = readFileSync(
			join(APP_DIR, 'node_modules', '@fontsource-variable', pkg, 'files', file)
		);
		const name = `assets/${pkg}.${hash(bytes)}.woff2`;
		write(join(out, name), bytes);
		fonts[key] = `/${name}`;
	}

	const css = readFileSync(join(APP_DIR, 'src/site.css'), 'utf8')
		.replace('__FONT_SANS__', fonts.sans)
		.replace('__FONT_MONO__', fonts.mono);
	const cssName = `assets/site.${hash(css)}.css`;
	write(join(out, cssName), css);

	copyFileSync(join(REPO_ROOT, 'apps/control-plane/src/lib/assets/favicon.svg'), join(out, 'favicon.svg'));

	let version = '0.0.0';
	try {
		version = readFileSync(join(REPO_ROOT, 'VERSION'), 'utf8').trim();
	} catch {
		// Not fatal: the badge just shows 0.0.0.
	}

	const toolCount = countTools(readFileSync(join(REPO_ROOT, 'README.md'), 'utf8'));
	if (toolCount === 0) throw new Error('could not count MCP tools in README.md');

	write(
		join(out, 'index.html'),
		renderPage({
			assets: { css: `/${cssName}`, favicon: '/favicon.svg', fonts: [fonts.sans] },
			version,
			repoUrl: REPO_URL,
			docsUrl: options.docsUrl ?? DEFAULT_DOCS_URL,
			siteUrl,
			toolCount
		})
	);

	write(join(out, 'yoal.json'), JSON.stringify({ trailingSlash: 'never' }, null, 2) + '\n');
	if (siteUrl) {
		write(
			join(out, 'sitemap.xml'),
			`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${siteUrl}</loc></url>\n</urlset>\n`
		);
		write(join(out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${siteUrl}sitemap.xml\n`);
	} else {
		write(join(out, 'robots.txt'), 'User-agent: *\nAllow: /\n');
	}

	return { outDir: out, ms: Math.round(performance.now() - started) };
}

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	if (index !== -1) return process.argv[index + 1];
	const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
	return inline?.slice(name.length + 3);
}

if (import.meta.main) {
	try {
		const result = await buildSite({
			outDir: arg('out') ?? join(APP_DIR, 'dist'),
			siteUrl: arg('site-url') ?? process.env.SITE_URL ?? null,
			docsUrl: arg('docs-url') ?? process.env.SITE_DOCS_URL ?? null
		});
		console.log(`Built the front page into ${result.outDir} in ${result.ms} ms`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
