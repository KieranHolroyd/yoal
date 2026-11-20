import { CoreError } from '@yoal/core';
import type { RequestHandler } from './$types';
import { json, route } from '#lib/server/api.js';
import { docsDatabase } from '#lib/server/docs.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** One docs page as Markdown, or one section of it with `?anchor=` (HA-PLAN F5; MCP `read_docs`). */
export const GET: RequestHandler = (event) =>
	route(async () => {
		requirePrincipal(event);
		const slug = event.params.slug.replace(/\/+$/, '');
		const anchor = event.url.searchParams.get('anchor') ?? undefined;
		const page = await docsDatabase.read(slug, anchor);
		if (!page)
			throw new CoreError(
				'not_found',
				anchor ? `No section "${anchor}" on docs page "${slug}".` : `No docs page "${slug}".`,
				404,
			);
		const { version } = await docsDatabase.info();
		return json({ version, ...page }, 200, { 'cache-control': 'no-store' });
	});
