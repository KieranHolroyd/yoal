import type { RequestHandler } from './$types';
import { json, route } from '#lib/server/api.js';
import { docsDatabase } from '#lib/server/docs.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * The user docs this platform version shipped with (HA-PLAN F5), the same content as MCP
 * `search_docs` / `read_docs`. Without `q`: version, fingerprint and the table of contents.
 * With `q`: ranked sections (`limit`, `section` optional). Any signed-in caller may read them;
 * the version is not shown to anonymous visitors.
 */
export const GET: RequestHandler = (event) =>
	route(async () => {
		requirePrincipal(event);
		const params = event.url.searchParams;
		const info = await docsDatabase.info();
		const query = params.get('q')?.trim();
		if (!query) return json({ ...info, sections: docsDatabase.outline() }, 200, { 'cache-control': 'no-store' });
		const limit = Math.min(50, Math.max(1, Number.parseInt(params.get('limit') ?? '8', 10) || 8));
		const results = await docsDatabase.search(query.slice(0, 200), { limit, section: params.get('section') ?? undefined });
		return json({ version: info.version, query, results }, 200, { 'cache-control': 'no-store' });
	});
