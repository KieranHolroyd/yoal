/**
 * Local preview: builds the page, serves it, and rebuilds when a source file changes.
 * `bun src/dev.ts` (SITE_PORT, default 4322).
 */
import { existsSync, statSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildSite } from './build.ts';

const APP_DIR = resolve(import.meta.dir, '..');
const OUT = join(APP_DIR, '.dev-dist');
const port = Number(process.env.SITE_PORT ?? 4322);

let building: Promise<void> | null = null;

function rebuild(reason: string) {
	building = buildSite({ outDir: OUT, siteUrl: null, docsUrl: process.env.SITE_DOCS_URL ?? null })
		.then((result) => console.log(`[site] ${reason}: built in ${result.ms} ms`))
		.catch((error) => console.error(`[site] build failed (${reason}):\n${error.message ?? error}`));
	return building;
}

await rebuild('start');
watch(join(APP_DIR, 'src'), { recursive: true }, (_event, file) => void rebuild(`changed ${file}`));

Bun.serve({
	port,
	async fetch(request) {
		await building;
		const path = decodeURIComponent(new URL(request.url).pathname);
		const target = join(OUT, path === '/' ? 'index.html' : path);
		if (!target.startsWith(OUT)) return new Response('Bad path', { status: 400 });
		if (existsSync(target) && statSync(target).isFile()) return new Response(Bun.file(target));
		return new Response('Not found', { status: 404 });
	}
});

console.log(`[site] serving on http://localhost:${port}`);
